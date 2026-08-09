/**
 * E4 — entry trigger and conviction gate.
 *
 * A candidate must clear three independent hurdles, and the order is deliberate
 * because each is cheaper than the next:
 *
 *   1. it survived E1 (liquidity) and E2 (regime) and sits in an E3 extreme
 *   2. price has actually broken the N-period extreme on the confirmed 1h bar
 *   3. the composite conviction score clears the threshold
 *
 * The gate exists to make trading RARE. Qwen averaged ~83 conviction across
 * 22-36 trades in 17 days and won; the models that died overtraded. If this
 * module is producing far more than ~2 signals a day, the threshold is too
 * loose — that is a tuning signal, not a good day.
 *
 * Conviction decides WHETHER to trade and never how much (Law 9). Nothing in
 * this file touches position size.
 */

import type { Config } from '../config.js';
import type { Candle } from '../market/okx.js';
import { atr, highestHigh, lowestLow, normalisedMomentum } from './indicators.js';
import { initialStopFor } from './exits.js';
import type { Direction, RankedInstrument } from './scanner.js';

export class EntryError extends Error {
  override readonly name = 'EntryError';
}

export interface ConvictionBreakdown {
  readonly momentum: number;
  readonly trendStrength: number;
  readonly volume: number;
  readonly multiTimeframe: number;
  /** Weighted total, 0-100. */
  readonly total: number;
}

export interface EntryCandidate {
  readonly instId: string;
  readonly direction: Direction;
  /** The N-period extreme that was broken. */
  readonly breakoutLevel: number;
  readonly lastClose: number;
  /** Limit band [low, high]. Orders rest inside it; we never chase. */
  readonly entryBandLow: number;
  readonly entryBandHigh: number;
  readonly stopPrice: number;
  /** TP1 — where E5 takes 25% off, at +`scaleOutAtR`R. */
  readonly scaleOutPrice: number;
  /** TP2 — the screening target, at the minimum payoff ratio NET of carry. */
  readonly targetPrice: number;
  /** Expected funding paid over the hold, as a fraction of notional. */
  readonly expectedFundingCostFraction: number;
  readonly atr: number;
  readonly conviction: ConvictionBreakdown;
  readonly validUntilMs: number;
}

export interface RejectedCandidate {
  readonly instId: string;
  readonly direction: Direction;
  readonly reasons: readonly string[];
  /** Present when the candidate got far enough to be scored. */
  readonly conviction?: ConvictionBreakdown;
}

export type EntryVerdict =
  | { readonly accepted: true; readonly candidate: EntryCandidate }
  | { readonly accepted: false; readonly rejection: RejectedCandidate };

/** Clamp to [0, 1]. Score components are fractions before weighting. */
function unit(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

/**
 * Whether the confirmed 1h bar broke the N-period extreme.
 *
 * `highestHigh`/`lowestLow` exclude the current bar, so a bar cannot break its
 * own level — without that exclusion every bar is a breakout and the trigger
 * fires constantly.
 */
export function hasBrokenOut(
  config: Config,
  candles: readonly Candle[],
  direction: Direction,
): { broken: boolean; level: number; lastClose: number } {
  const lookback = config.entry.breakoutLookback;
  const last = candles[candles.length - 1];
  if (last === undefined) {
    throw new EntryError('cannot evaluate a breakout on an empty candle series');
  }

  const level = direction === 'long' ? highestHigh(candles, lookback) : lowestLow(candles, lookback);
  const broken = direction === 'long' ? last.close > level : last.close < level;

  return { broken, level, lastClose: last.close };
}

/**
 * Composite conviction, 0-100.
 *
 * Each component saturates. An ADX of 80 is not twice as tradable as 40 — it is
 * usually late — and an unbounded component would let one extreme reading drag
 * a mediocre candidate over the threshold on its own.
 */
export function scoreConviction(
  config: Config,
  ranked: RankedInstrument,
  direction: Direction,
  universeSize: number,
  rankIndex: number,
  volumeTrendValue: number,
  higherTimeframeMomentum: number,
): ConvictionBreakdown {
  const weights = config.entry.convictionWeights;

  // Momentum: position within the ranking, measured from the relevant end.
  // Rank 0 of 80 for a long is the strongest instrument in the universe.
  const positionFromEnd = direction === 'long' ? rankIndex : universeSize - 1 - rankIndex;
  const momentum = universeSize <= 1 ? 1 : unit(1 - positionFromEnd / (universeSize - 1));

  // Trend strength: how far ADX sits above the regime floor, saturating.
  const adxFloor = config.regime.minAdx;
  const adxRange = Math.max(config.entry.adxSaturation - adxFloor, 1e-9);
  const trendStrength = unit((ranked.adx - adxFloor) / adxRange);

  // Volume: expansion beyond the regime floor, saturating.
  const volFloor = config.regime.minVolumeTrend;
  const volRange = Math.max(config.entry.volumeTrendSaturation - volFloor, 1e-9);
  const volume = unit((volumeTrendValue - volFloor) / volRange);

  // Multi-timeframe: does the 4h agree with the direction being taken? Binary
  // by design — a higher timeframe either confirms or it does not, and grading
  // it finely would import noise from a slower series.
  const agrees = direction === 'long' ? higherTimeframeMomentum > 0 : higherTimeframeMomentum < 0;
  const multiTimeframe = agrees ? 1 : 0;

  const total =
    100 *
    (weights.momentum * momentum +
      weights.trendStrength * trendStrength +
      weights.volume * volume +
      weights.multiTimeframe * multiTimeframe);

  return { momentum, trendStrength, volume, multiTimeframe, total };
}

export interface EntryInputs {
  readonly ranked: RankedInstrument;
  readonly direction: Direction;
  readonly candles1h: readonly Candle[];
  readonly candles4h: readonly Candle[];
  readonly volumeTrendValue: number;
  readonly universeSize: number;
  readonly rankIndex: number;
  readonly nowMs: number;
  /** Instruments still inside a post-stop cooldown, with their expiry. */
  readonly cooldownUntilMs?: number;
  /**
   * Current funding rate, signed as the venue reports it.
   *
   * Required. E2 already reads this as a crowding filter; E4 needs it as a COST,
   * and making it optional would let a caller that forgot it produce a signal
   * priced as though carry were free — which is the failure this field exists
   * to prevent, arriving silently.
   */
  readonly fundingRate: number;
}

/**
 * Expected funding paid over the trade, as a fraction of notional.
 *
 * Funding is not merely a signal about crowding — it is money, charged every
 * window for as long as the position is open. The hold band runs to
 * `maxHoldHours`, so the honest worst case is the number of windows that fits
 * inside it. Assuming the worst case rather than an average is deliberate: a
 * trade must clear its payoff hurdle on the carry it might actually pay, not on
 * the carry it would pay if closed early.
 *
 * Only ADVERSE funding is charged. Funding in our favour is real income, but
 * pricing a trade on income that inverts the moment the crowd rotates is how a
 * cost model becomes an optimistic one.
 */
export function expectedFundingCostFraction(config: Config, fundingRate: number, direction: Direction): number {
  if (!config.regime.fundingCharged) return 0;
  if (!Number.isFinite(fundingRate)) {
    throw new EntryError(`funding rate must be finite to price carry, got ${fundingRate}`);
  }

  // Longs pay when funding is positive, shorts when it is negative.
  const adverse = direction === 'long' ? fundingRate : -fundingRate;
  if (adverse <= 0) return 0;

  const windows = Math.ceil(config.exits.maxHoldHours / config.regime.fundingWindowHours);
  return adverse * windows;
}

/**
 * Evaluate one candidate and either produce a tradable entry or an explained
 * rejection.
 *
 * Rejections carry every reason rather than short-circuiting on the first,
 * because the daily attribution needs to see whether the gate is rejecting for
 * one dominant cause — which is how you learn the threshold is misplaced.
 */
export function evaluateEntry(config: Config, inputs: EntryInputs): EntryVerdict {
  const { ranked, direction, candles1h, candles4h, nowMs } = inputs;
  const reasons: string[] = [];

  // Cooldown: no re-entry on an instrument for a period after it stopped out.
  // Re-entering immediately is how one choppy instrument bleeds an account.
  if (inputs.cooldownUntilMs !== undefined && nowMs < inputs.cooldownUntilMs) {
    const minutes = (inputs.cooldownUntilMs - nowMs) / 60_000;
    reasons.push(`in post-stop cooldown for another ${minutes.toFixed(0)} minutes`);
  }

  const breakout = hasBrokenOut(config, candles1h, direction);
  if (!breakout.broken) {
    reasons.push(
      `no breakout: close ${breakout.lastClose} has not cleared the ` +
        `${config.entry.breakoutLookback}-bar ${direction === 'long' ? 'high' : 'low'} of ${breakout.level}`,
    );
  }

  const higherTimeframeMomentum = normalisedMomentum(candles4h, 6, config.ranking.atrPeriod);

  const conviction = scoreConviction(
    config,
    ranked,
    direction,
    inputs.universeSize,
    inputs.rankIndex,
    inputs.volumeTrendValue,
    higherTimeframeMomentum,
  );

  if (conviction.total < config.signals.minConviction) {
    reasons.push(
      `conviction ${conviction.total.toFixed(1)} below the ${config.signals.minConviction} threshold`,
    );
  }

  if (reasons.length > 0) {
    return { accepted: false, rejection: { instId: ranked.instId, direction, reasons, conviction } };
  }

  const atrValue = atr(candles1h, config.exits.atrPeriod);
  const reference = breakout.lastClose;

  // Limit band around the breakout level. Resting inside it keeps us maker;
  // chasing a runaway breakout at market is how DeepSeek's fee advantage is
  // given away one trade at a time.
  const bandWidth = config.entry.bandAtrFraction * atrValue;
  const entryBandLow = direction === 'long' ? breakout.level : reference - bandWidth;
  const entryBandHigh = direction === 'long' ? reference + bandWidth : breakout.level;

  // The order is placed at the far edge of the published band, not at the
  // signal-time close. TP1 and TP2 must be derived from that executable price.
  // The stop remains anchored to the confirmed close, while the wider realised
  // risk from the band edge is used in the payoff and sizing math. Using the
  // close for all three made E4 look 3:1 but fall below 3:1 after copy.ts placed
  // at entryBandHigh/Low — a published-vs-placed mismatch.
  const entryPrice = direction === 'long' ? reference + bandWidth : reference - bandWidth;
  // Keep the original stop anchor at the confirmed close. The order may fill
  // slightly inside the band, so the realised risk is measured from the
  // executable edge below rather than pretending the close was the fill.
  const stopPrice = initialStopFor(config, direction, reference, atrValue);
  const riskDistance = Math.abs(entryPrice - stopPrice);

  // Carry. Expressed as a price distance so it can be added to the target: the
  // trade must clear the payoff ratio on the move NET of funding, not gross.
  //
  // Without this, funding was a filter and never a cost. At the old 0.0005
  // threshold and a 36h hold, an "acceptable" trade paid up to 0.25% of notional
  // — against a 6% total fee budget spread over ~40 trades, that is 1.7 trades
  // of budget consumed by one position, while the fee tracker reported 2 bps
  // maker and looked healthy. The cost was real and invisible in every number
  // the system produced.
  const fundingCostDistance = entryPrice * expectedFundingCostFraction(config, inputs.fundingRate, direction);

  // Target at the minimum acceptable payoff ratio, pushed out by the carry. If a
  // setup cannot offer it, it is not a trade — and unlike the gross version this
  // can genuinely fail to be offerable, which is the point: an expensive-to-hold
  // instrument now needs a bigger move to qualify rather than qualifying anyway.
  const targetDistance = config.risk.minTargetStopRatio * riskDistance + fundingCostDistance;
  const targetPrice = direction === 'long' ? entryPrice + targetDistance : entryPrice - targetDistance;

  // Where 25% actually comes off. E5 scales out at +2R and trails the rest, so
  // this — not the target above — is the first thing that happens to a winner,
  // and publishing the target as though it were the plan is what made the old
  // signal describe a trade we never took.
  const scaleOutDistance = config.exits.scaleOutAtR * riskDistance;
  const scaleOutPrice = direction === 'long' ? entryPrice + scaleOutDistance : entryPrice - scaleOutDistance;

  if (scaleOutPrice <= 0) {
    return {
      accepted: false,
      rejection: {
        instId: ranked.instId,
        direction,
        reasons: [`scale-out level computed at ${scaleOutPrice}, which is not a tradable level`],
        conviction,
      },
    };
  }

  if (targetPrice <= 0) {
    return {
      accepted: false,
      rejection: {
        instId: ranked.instId,
        direction,
        reasons: [`target price computed at ${targetPrice}, which is not a tradable level`],
        conviction,
      },
    };
  }

  return {
    accepted: true,
    candidate: {
      instId: ranked.instId,
      direction,
      breakoutLevel: breakout.level,
      lastClose: breakout.lastClose,
      entryBandLow,
      entryBandHigh,
      stopPrice,
      scaleOutPrice,
      targetPrice,
      expectedFundingCostFraction: fundingCostDistance / entryPrice,
      atr: atrValue,
      conviction,
      validUntilMs: nowMs + config.entry.validityHours * 3_600_000,
    },
  };
}
