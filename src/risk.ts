/**
 * Risk engine — sizing, stage determination, and the drawdown governor.
 *
 * This module is the alpha, not a safety feature. Four of six Alpha Arena models
 * finished between -30% and -63%; the post-mortem on the worst of them found
 * arbitrary position sizing, some trades at 5% of capital and others at 40%.
 *
 * Three properties are structural here rather than advisory:
 *
 *  1. H3 — sizing is computed by ONE function with NO override parameter. The
 *     agent must be structurally incapable of varying risk per trade. Confidence
 *     decides *whether* to trade, never *how much*.
 *  2. H2 — no trade is entered without a defined stop and a target at >=3:1.
 *     A setup that cannot offer that ratio is not a trade.
 *  3. The governor measures from PEAK equity, not from start. Giving back an
 *     unrealised gain is the failure mode Stage 3 exists to prevent —
 *     DeepSeek hit +125% mid-competition and finished at +4.89%.
 */

import type { Config, Stage } from './config.js';
import { drawdownBandForStage, requireMaxLeverage, riskFractionForStage } from './config.js';

export type GovernorAction = 'normal' | 'halveSizing' | 'flatAndHalt' | 'stopForCompetition';

export class RiskRefusal extends Error {
  override readonly name = 'RiskRefusal';
  /** Machine-readable so the ledger records *which* gate refused, not just that one did. */
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export interface EquityState {
  /** Current account equity in USDT, including unrealised mark-to-market. */
  readonly equityUsdt: number;
  /** Highest equity ever observed. The governor measures from here. */
  readonly peakEquityUsdt: number;
}

/**
 * Stage is determined by equity and rank, never by feel.
 *
 * Stage 3 requires top-3 on combined score WITH cushion, established from the
 * live leaderboard distributions — it is not a target you declare, it is a
 * position you hold. Passing `null` for the rank input means rank data is
 * unavailable or stale, in which case Stage 3 cannot be entered: defending a
 * rank you cannot currently measure is guessing.
 */
export function determineStage(
  config: Config,
  equity: EquityState,
  topThreeWithCushion: boolean | null,
): Stage {
  if (topThreeWithCushion === true) return 3;

  const startEquity = config.capital.principalBaseUsdt;
  if (equity.equityUsdt >= startEquity * config.risk.stage2EquityMultiple) return 2;

  return 1;
}

/** Drawdown from peak as a fraction. Zero when at or above the peak. */
export function drawdownFromPeak(equity: EquityState): number {
  if (equity.peakEquityUsdt <= 0) {
    throw new RiskRefusal('invalid_peak', 'peak equity must be positive to measure drawdown');
  }
  const dd = (equity.peakEquityUsdt - equity.equityUsdt) / equity.peakEquityUsdt;
  return dd > 0 ? dd : 0;
}

/**
 * What the governor requires right now, given the stage-aware bands.
 *
 * Stage 1 runs looser deliberately: too-tight stops in the hunting phase mean
 * never surviving long enough to find the one trend that matters. Stage 3 runs
 * tight because the job has flipped from earning to defending.
 */
export function governorAction(config: Config, equity: EquityState, stage: Stage): GovernorAction {
  const dd = drawdownFromPeak(equity);
  const band = drawdownBandForStage(config, stage);

  if (dd >= band.stopForCompetition) return 'stopForCompetition';
  if (dd >= band.flatAndHalt12h) return 'flatAndHalt';
  if (dd >= band.halveSizing) return 'halveSizing';
  return 'normal';
}

/**
 * An open position's contribution to portfolio heat.
 *
 * `riskUsdt` is what is still at risk *now* — distance from the current stop,
 * not the original one. A position trailed to breakeven contributes zero heat,
 * which is what makes room for the next trade honestly rather than by fiat.
 */
export interface OpenRisk {
  readonly instrument: string;
  readonly correlationGroup: string;
  readonly riskUsdt: number;
  /**
   * Which way the position faces.
   *
   * Required, not optional. The directional cap is only meaningful if every
   * open position declares a side, and a default would let a caller that
   * forgot to supply one quietly disable the cap for that position — which is
   * precisely the position it would then fail to count.
   */
  readonly side: 'long' | 'short';
}

export interface SizingRequest {
  readonly stage: Stage;
  readonly equity: EquityState;
  /** Every currently open position. Empty array means flat. */
  readonly openRisk: readonly OpenRisk[];
  readonly correlationGroup: string;
  /** Entry price in quote units. */
  readonly entryPrice: number;
  /** Stop price in quote units. Mandatory — H2 admits no stopless entry. */
  readonly stopPrice: number;
  /** Target price in quote units. Mandatory — the >=3:1 test needs it. */
  readonly targetPrice: number;
  readonly side: 'long' | 'short';
  /** Measured per-instrument ceiling; the policy cap is still mandatory. */
  readonly instrumentMaxLeverage?: number;
  /**
   * Which rung of the pyramid ladder this is, or undefined for a fresh entry.
   *
   * Note what this is NOT: a multiplier. The caller declares WHICH add it is
   * and policy decides how big that add may be, so there is still no path by
   * which a caller chooses its own size. Law 9 survives — `computeSize` keeps
   * its arity of two, and a test asserts it.
   */
  readonly pyramidAddIndex?: number;
}

export interface SizingResult {
  /** Position size in instrument units. */
  readonly size: number;
  /** Notional at entry, in USDT. Derived, never chosen. */
  readonly notionalUsdt: number;
  /** USDT at risk if the stop fills exactly. Equals equity * riskFraction. */
  readonly riskUsdt: number;
  readonly riskFraction: number;
  readonly targetStopRatio: number;
  readonly governor: GovernorAction;
  /**
   * Realised leverage. EMERGENT — it falls out of stop distance and is never
   * chosen. maxLeverage is a cap that rejects the trade, never a target.
   */
  readonly leverage: number;
  /** Portfolio heat after this position is added, as a fraction of equity. */
  readonly heatAfter: number;
}

/**
 * The ONLY sizing function. There is deliberately no override parameter, no
 * confidence input, and no multiplier argument — H3 requires that every trade
 * risk the identical percentage of equity for a given stage.
 *
 * Risk is a fraction of equity; notional is DERIVED from stop distance. Sizing
 * off notional instead is how a wide stop quietly becomes a large loss.
 */
export function computeSize(config: Config, request: SizingRequest): SizingResult {
  const { stage, equity, entryPrice, stopPrice, targetPrice, side, openRisk, correlationGroup } = request;

  if (!Number.isFinite(entryPrice) || entryPrice <= 0) {
    throw new RiskRefusal('bad_entry', `entry price must be a positive finite number, got ${entryPrice}`);
  }
  if (!Number.isFinite(stopPrice) || stopPrice <= 0) {
    throw new RiskRefusal('no_stop', `stop price must be a positive finite number, got ${stopPrice}`);
  }
  if (!Number.isFinite(targetPrice) || targetPrice <= 0) {
    throw new RiskRefusal('no_target', `target price must be a positive finite number, got ${targetPrice}`);
  }

  // Direction sanity. A "stop" on the wrong side of entry is not a stop, and a
  // target on the wrong side is not a target — both are almost always a sign
  // conflated somewhere upstream, and both would size catastrophically.
  if (side === 'long' && stopPrice >= entryPrice) {
    throw new RiskRefusal('stop_wrong_side', `long stop ${stopPrice} must sit below entry ${entryPrice}`);
  }
  if (side === 'short' && stopPrice <= entryPrice) {
    throw new RiskRefusal('stop_wrong_side', `short stop ${stopPrice} must sit above entry ${entryPrice}`);
  }
  if (side === 'long' && targetPrice <= entryPrice) {
    throw new RiskRefusal('target_wrong_side', `long target ${targetPrice} must sit above entry ${entryPrice}`);
  }
  if (side === 'short' && targetPrice >= entryPrice) {
    throw new RiskRefusal('target_wrong_side', `short target ${targetPrice} must sit below entry ${entryPrice}`);
  }

  const stopDistance = Math.abs(entryPrice - stopPrice);
  const targetDistance = Math.abs(targetPrice - entryPrice);

  const targetStopRatio = targetDistance / stopDistance;
  const minRatio = config.risk.minTargetStopRatio;
  if (targetStopRatio < minRatio) {
    throw new RiskRefusal(
      'payoff_ratio',
      `target/stop ratio ${targetStopRatio.toFixed(2)} is below the required ${minRatio}:1 — ` +
        'if the setup cannot offer it, it is not a trade',
    );
  }

  const governor = governorAction(config, equity, stage);
  if (governor === 'stopForCompetition' || governor === 'flatAndHalt') {
    throw new RiskRefusal(
      'governor_halt',
      `drawdown governor is at "${governor}" (${(drawdownFromPeak(equity) * 100).toFixed(1)}% ` +
        `from peak, stage ${stage}) — no new positions`,
    );
  }

  // Position count and correlation limits. Crypto perps correlate around 0.8,
  // so three longs is one trade wearing three hats — these caps are what stop a
  // "diversified" book being a single concentrated bet.
  // An add is not a new position — it is more of one that already counts
  // against every cap below. Re-applying them would make the second add
  // impossible for the arithmetic reason that the first one succeeded.
  const isAdd = (request.pyramidAddIndex ?? 0) > 0;

  if (!isAdd && openRisk.length >= config.risk.maxConcurrentPositions) {
    throw new RiskRefusal(
      'max_positions',
      `already holding ${openRisk.length} positions (limit ${config.risk.maxConcurrentPositions})`,
    );
  }

  const inGroup = openRisk.filter((p) => p.correlationGroup === correlationGroup).length;
  if (!isAdd && inGroup >= config.risk.maxPositionsPerCorrelationGroup) {
    throw new RiskRefusal(
      'correlation_group',
      `already holding ${inGroup} positions in correlation group "${correlationGroup}" ` +
        `(limit ${config.risk.maxPositionsPerCorrelationGroup})`,
    );
  }

  // Directional concentration. The group cap above catches instruments we
  // classified as related; this catches the ones we did not. E3 selects momentum
  // extremes, and the extremes are usually one complex moving together — so a
  // book that satisfies every group cap can still be a single bet placed three
  // times, which is exactly the shape that empties an account in a reversal.
  const sameSide = openRisk.filter((p) => p.side === side).length;
  if (!isAdd && sameSide >= config.risk.maxPositionsPerSide) {
    throw new RiskRefusal(
      'directional_cap',
      `already holding ${sameSide} ${side} positions (limit ${config.risk.maxPositionsPerSide}) — ` +
        'a third position on the same side is concentration, not diversification',
    );
  }

  const baseFraction = riskFractionForStage(config, stage);
  const governed = governor === 'halveSizing' ? baseFraction / 2 : baseFraction;

  // E6. The ladder multiple comes from POLICY, indexed by which add this is —
  // the caller says "this is add 2", never "size this at 0.6". Index 0 of the
  // ladder is the initial entry, so a fresh entry multiplies by 1.0 and the
  // arithmetic below is unchanged for every non-pyramid trade.
  const addIndex = request.pyramidAddIndex ?? 0;
  if (addIndex > 0) {
    if (!config.pyramiding.enabled) {
      throw new RiskRefusal('pyramiding_disabled', 'pyramiding is disabled — refusing to size an add');
    }
    if (stage !== 2) {
      throw new RiskRefusal('pyramid_stage', `pyramiding arms only in stage 2, not stage ${stage}`);
    }
    if (addIndex > config.pyramiding.maxAdds) {
      throw new RiskRefusal(
        'pyramid_max_adds',
        `add ${addIndex} exceeds the ${config.pyramiding.maxAdds}-add limit`,
      );
    }
  }
  const ladderMultiple = config.pyramiding.addSizeMultiples[addIndex];
  if (ladderMultiple === undefined) {
    throw new RiskRefusal('pyramid_ladder', `no size multiple defined for rung ${addIndex}`);
  }

  const riskFraction = governed * ladderMultiple;

  const riskUsdt = equity.equityUsdt * riskFraction;
  if (riskUsdt <= 0) {
    throw new RiskRefusal('no_equity', `equity ${equity.equityUsdt} leaves nothing to risk`);
  }

  // Portfolio heat. Measured against risk still live on open positions, so a
  // position trailed to breakeven frees capacity honestly rather than by fiat.
  const existingHeatUsdt = openRisk.reduce((sum, p) => sum + p.riskUsdt, 0);
  const heatAfter = (existingHeatUsdt + riskUsdt) / equity.equityUsdt;
  if (heatAfter > config.risk.maxPortfolioHeat) {
    throw new RiskRefusal(
      'portfolio_heat',
      `portfolio heat would reach ${(heatAfter * 100).toFixed(2)}% against a ` +
        `${(config.risk.maxPortfolioHeat * 100).toFixed(2)}% cap`,
    );
  }

  const size = riskUsdt / stopDistance;
  const notionalUsdt = size * entryPrice;

  // Leverage is an OUTPUT. The cap rejects a pathological stop-distance
  // calculation — a stop placed a hair from entry produces enormous size at
  // identical nominal risk, and that is precisely what the cap is for.
  const leverage = notionalUsdt / equity.equityUsdt;
  const policyMaxLeverage = requireMaxLeverage(config);
  if (
    request.instrumentMaxLeverage !== undefined &&
    (!Number.isFinite(request.instrumentMaxLeverage) || request.instrumentMaxLeverage <= 0)
  ) {
    throw new RiskRefusal(
      'instrument_leverage_unknown',
      `instrument max leverage must be positive and finite, got ${request.instrumentMaxLeverage}`,
    );
  }
  const maxLeverage = Math.min(policyMaxLeverage, request.instrumentMaxLeverage ?? Number.POSITIVE_INFINITY);
  if (leverage > maxLeverage) {
    throw new RiskRefusal(
      'leverage_cap',
      `stop distance implies ${leverage.toFixed(2)}x leverage against a ${maxLeverage}x cap — ` +
        'the stop is too tight for this risk fraction, not a reason to raise the cap',
    );
  }

  return { size, notionalUsdt, riskUsdt, riskFraction, targetStopRatio, governor, leverage, heatAfter };
}

/**
 * Never add to a loser.
 *
 * Gemini's failure was sitting in deep drawdown holding six losing shorts while
 * writing about its conviction. Conviction after a stop is breached is not
 * conviction, it is a bug.
 */
export function assertNotAddingToLoser(
  side: 'long' | 'short',
  entryPrice: number,
  currentPrice: number,
): void {
  const losing = side === 'long' ? currentPrice < entryPrice : currentPrice > entryPrice;
  if (losing) {
    throw new RiskRefusal(
      'add_to_loser',
      `refusing to add to a losing ${side} (entry ${entryPrice}, current ${currentPrice}) — never add to a loser`,
    );
  }
}

/**
 * Working equity must never cross the eligibility floor. Below 300 USDT the
 * entry is ineligible regardless of how good the book looks, which makes this a
 * harder constraint than any drawdown band.
 */
export function assertAboveEligibilityFloor(config: Config, equityUsdt: number): void {
  const floor = config.capital.eligibilityFloorUsdt;
  if (equityUsdt < floor) {
    throw new RiskRefusal(
      'eligibility_floor',
      `equity ${equityUsdt.toFixed(2)} USDT is below the ${floor} USDT eligibility floor`,
    );
  }
}
