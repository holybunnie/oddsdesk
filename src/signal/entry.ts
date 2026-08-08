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
  readonly targetPrice: number;
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

  const stopPrice = initialStopFor(config, direction, reference, atrValue);
  const riskDistance = Math.abs(reference - stopPrice);

  // Target at the minimum acceptable payoff ratio. If a setup cannot offer it,
  // it is not a trade — and here it always can, because the target is derived
  // from the stop rather than read off a chart level.
  const targetDistance = config.risk.minTargetStopRatio * riskDistance;
  const targetPrice = direction === 'long' ? reference + targetDistance : reference - targetDistance;

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
      targetPrice,
      atr: atrValue,
      conviction,
      validUntilMs: nowMs + config.entry.validityHours * 3_600_000,
    },
  };
}
