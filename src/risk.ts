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
import { drawdownBandForStage, riskFractionForStage } from './config.js';

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

export interface SizingRequest {
  readonly stage: Stage;
  readonly equity: EquityState;
  /** Entry price in quote units. */
  readonly entryPrice: number;
  /** Stop price in quote units. Mandatory — H2 admits no stopless entry. */
  readonly stopPrice: number;
  /** Target price in quote units. Mandatory — the >=3:1 test needs it. */
  readonly targetPrice: number;
  readonly side: 'long' | 'short';
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
  const { stage, equity, entryPrice, stopPrice, targetPrice, side } = request;

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

  const baseFraction = riskFractionForStage(config, stage);
  const riskFraction = governor === 'halveSizing' ? baseFraction / 2 : baseFraction;

  const riskUsdt = equity.equityUsdt * riskFraction;
  if (riskUsdt <= 0) {
    throw new RiskRefusal('no_equity', `equity ${equity.equityUsdt} leaves nothing to risk`);
  }

  const size = riskUsdt / stopDistance;
  const notionalUsdt = size * entryPrice;

  return { size, notionalUsdt, riskUsdt, riskFraction, targetStopRatio, governor };
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
