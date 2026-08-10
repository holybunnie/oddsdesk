/**
 * Six-major indicator entry candidate.
 *
 * This is intentionally separate from the cross-sectional E1-E4 path. It is
 * an experiment for BTC/ETH/SOL/XRP/DOGE/BNB, not a silent change to the live
 * strategy. Risk sizing and E5 exits remain shared with the main pipeline.
 */

import type { Config } from '../config.js';
import type { Candle } from '../market/okx.js';
import { atr, highestHigh, lowestLow } from './indicators.js';
import { expectedFundingCostFraction, type EntryCandidate, type EntryVerdict } from './entry.js';
import { initialStopFor } from './exits.js';
import type { Direction } from './scanner.js';

const MACD_FAST = 12;
const MACD_SLOW = 26;
const MACD_SIGNAL = 9;
const RSI_PERIOD = 14;
const HIGHER_FAST = 20;
const HIGHER_SLOW = 50;
const PULLBACK_EMA = 20;

export interface MajorSignal {
  readonly direction: Direction | undefined;
  readonly macd: number;
  readonly macdSignal: number;
  readonly previousMacd: number;
  readonly previousMacdSignal: number;
  readonly rsi: number;
  readonly higherFastEma: number;
  readonly higherSlowEma: number;
}

export class MajorSignalError extends Error {
  override readonly name = 'MajorSignalError';
}

function assertEnough(values: readonly number[], needed: number, what: string): void {
  if (values.length < needed) throw new MajorSignalError(`${what} needs ${needed} values, received ${values.length}`);
}

function emaSeries(values: readonly number[], period: number): readonly number[] {
  assertEnough(values, period, `EMA(${period})`);
  const result = Array<number>(values.length).fill(Number.NaN);
  let value = values.slice(0, period).reduce((sum, item) => sum + item, 0) / period;
  result[period - 1] = value;
  const alpha = 2 / (period + 1);
  for (let index = period; index < values.length; index += 1) {
    const current = values[index];
    if (current === undefined) throw new MajorSignalError('EMA input contains a hole');
    value = (current - value) * alpha + value;
    result[index] = value;
  }
  return result;
}

function closes(candles: readonly Candle[]): readonly number[] {
  return candles.map((candle) => candle.close);
}

function rsi(candles: readonly Candle[], period: number): number {
  const values = closes(candles);
  assertEnough(values, period + 1, `RSI(${period})`);
  let gains = 0;
  let losses = 0;
  for (let index = 1; index <= period; index += 1) {
    const change = (values[index] ?? 0) - (values[index - 1] ?? 0);
    if (change >= 0) gains += change;
    else losses -= change;
  }
  let averageGain = gains / period;
  let averageLoss = losses / period;
  for (let index = period + 1; index < values.length; index += 1) {
    const change = (values[index] ?? 0) - (values[index - 1] ?? 0);
    const gain = Math.max(change, 0);
    const loss = Math.max(-change, 0);
    averageGain = (averageGain * (period - 1) + gain) / period;
    averageLoss = (averageLoss * (period - 1) + loss) / period;
  }
  if (averageLoss === 0) return 100;
  const value = 100 - 100 / (1 + averageGain / averageLoss);
  if (!Number.isFinite(value)) throw new MajorSignalError(`RSI(${period}) was not finite`);
  return value;
}

function macdState(candles: readonly Candle[]): {
  readonly macd: number;
  readonly macdSignal: number;
  readonly previousMacd: number;
  readonly previousMacdSignal: number;
} {
  const values = closes(candles);
  assertEnough(values, MACD_SLOW + MACD_SIGNAL + 1, 'MACD');
  const fast = emaSeries(values, MACD_FAST);
  const slow = emaSeries(values, MACD_SLOW);
  const line: number[] = [];
  for (let index = 0; index < values.length; index += 1) {
    if (Number.isFinite(fast[index]) && Number.isFinite(slow[index])) {
      line.push((fast[index] ?? 0) - (slow[index] ?? 0));
    }
  }
  const signal = emaSeries(line, MACD_SIGNAL);
  const currentIndex = signal.length - 1;
  const previousIndex = signal.length - 2;
  const currentSignal = signal[currentIndex];
  const previousSignal = signal[previousIndex];
  const currentLine = line[currentIndex];
  const previousLine = line[previousIndex];
  if (![currentSignal, previousSignal, currentLine, previousLine].every(Number.isFinite)) {
    throw new MajorSignalError('MACD did not produce two complete signal readings');
  }
  return {
    macd: currentLine as number,
    macdSignal: currentSignal as number,
    previousMacd: previousLine as number,
    previousMacdSignal: previousSignal as number,
  };
}

/**
 * Direction is produced only on a fresh 1h MACD cross, aligned to the 4h EMA
 * trend, with RSI between 30 and 70. The bounds are deliberately symmetric and
 * standard; they are not fitted to the recorded sample.
 */
export function majorSignal(candles1h: readonly Candle[], candles4h: readonly Candle[]): MajorSignal {
  const macd = macdState(candles1h);
  const higherValues = closes(candles4h);
  const higherFast = emaSeries(higherValues, HIGHER_FAST).at(-1);
  const higherSlow = emaSeries(higherValues, HIGHER_SLOW).at(-1);
  const currentRsi = rsi(candles1h, RSI_PERIOD);
  if (higherFast === undefined || higherSlow === undefined) throw new MajorSignalError('higher timeframe EMA missing');

  const bullishCross = macd.previousMacd <= macd.previousMacdSignal && macd.macd > macd.macdSignal;
  const bearishCross = macd.previousMacd >= macd.previousMacdSignal && macd.macd < macd.macdSignal;
  const rsiAcceptable = currentRsi > 30 && currentRsi < 70;
  const direction = rsiAcceptable
    ? bullishCross && higherFast > higherSlow
      ? 'long'
      : bearishCross && higherFast < higherSlow
        ? 'short'
        : undefined
    : undefined;

  return {
    direction,
    ...macd,
    rsi: currentRsi,
    higherFastEma: higherFast,
    higherSlowEma: higherSlow,
  };
}

function conviction(): EntryCandidate['conviction'] {
  // The major candidate has no cross-sectional rank or volume gate. The
  // indicator alignment itself is the gate; this field remains fully populated
  // so the shared publisher, ledger, and risk interfaces stay unchanged.
  return { momentum: 1, trendStrength: 1, volume: 1, multiTimeframe: 1, total: 100 };
}

function buildMajorCandidate(
  config: Config,
  instId: string,
  direction: Direction,
  candles1h: readonly Candle[],
  fundingRate: number,
  nowMs: number,
): EntryVerdict {
  const adverseFunding = direction === 'long' ? fundingRate : -fundingRate;
  if (adverseFunding > config.regime.maxAdverseFundingRate) {
    return {
      accepted: false,
      rejection: { instId, direction, reasons: [`funding against ${direction} exceeds the configured limit`] },
    };
  }

  const reference = candles1h.at(-1)?.close;
  if (reference === undefined) throw new MajorSignalError(`no latest 1h close for ${instId}`);
  const atrValue = atr(candles1h, config.exits.atrPeriod);
  const bandWidth = config.entry.bandAtrFraction * atrValue;
  // The shared executor receives a one-sided maker band, with the confirmed
  // close as the executable reference for an indicator entry.
  const entryBandLow = direction === 'long' ? reference - bandWidth : reference;
  const entryBandHigh = direction === 'long' ? reference : reference + bandWidth;
  const stopPrice = initialStopFor(config, direction, reference, atrValue);
  const riskDistance = Math.abs(reference - stopPrice);
  const fundingCostDistance = reference * expectedFundingCostFraction(config, fundingRate, direction);
  const targetDistance = config.risk.minTargetStopRatio * riskDistance + fundingCostDistance;
  const targetPrice = direction === 'long' ? reference + targetDistance : reference - targetDistance;
  const scaleOutDistance = config.exits.scaleOutAtR * riskDistance;
  const scaleOutPrice = direction === 'long' ? reference + scaleOutDistance : reference - scaleOutDistance;

  if (stopPrice <= 0 || scaleOutPrice <= 0 || targetPrice <= 0) {
    return { accepted: false, rejection: { instId, direction, reasons: ['computed order levels are not tradable'] } };
  }

  return {
    accepted: true,
    candidate: {
      instId,
      direction,
      breakoutLevel: reference,
      lastClose: reference,
      entryBandLow,
      entryBandHigh,
      stopPrice,
      scaleOutPrice,
      targetPrice,
      expectedFundingCostFraction: fundingCostDistance / reference,
      atr: atrValue,
      conviction: conviction(),
      validUntilMs: nowMs + config.entry.validityHours * 3_600_000,
    },
  };
}

/**
 * Pullback direction: the 4h trend is established, the previous 1h bar
 * touched the 1h EMA(20), and the current confirmed bar reclaimed it in the
 * trend direction. RSI remains between 30 and 70. This is one fixed rule set,
 * not a parameter search.
 */
export function majorPullbackDirection(
  candles1h: readonly Candle[],
  candles4h: readonly Candle[],
): Direction | undefined {
  const higher = emaSeries(closes(candles4h), HIGHER_FAST);
  const higherSlow = emaSeries(closes(candles4h), HIGHER_SLOW);
  const higherFastValue = higher.at(-1);
  const higherSlowValue = higherSlow.at(-1);
  const values = closes(candles1h);
  const oneHourEma = emaSeries(values, PULLBACK_EMA);
  const current = candles1h.at(-1);
  const previous = candles1h.at(-2);
  const currentEma = oneHourEma.at(-1);
  const previousEma = oneHourEma.at(-2);
  if (
    current === undefined || previous === undefined || currentEma === undefined || previousEma === undefined ||
    higherFastValue === undefined || higherSlowValue === undefined
  ) throw new MajorSignalError('pullback series is incomplete');

  const currentRsi = rsi(candles1h, RSI_PERIOD);
  if (!(currentRsi > 30 && currentRsi < 70)) return undefined;
  if (higherFastValue > higherSlowValue && previous.low <= previousEma && current.close > currentEma && current.close > previous.close) {
    return 'long';
  }
  if (higherFastValue < higherSlowValue && previous.high >= previousEma && current.close < currentEma && current.close < previous.close) {
    return 'short';
  }
  return undefined;
}

/** Fixed 1h Donchian-20 breakout in the established 4h EMA(20/50) direction. */
export function majorBreakoutDirection(
  candles1h: readonly Candle[],
  candles4h: readonly Candle[],
): Direction | undefined {
  const higherFast = emaSeries(closes(candles4h), HIGHER_FAST).at(-1);
  const higherSlow = emaSeries(closes(candles4h), HIGHER_SLOW).at(-1);
  const last = candles1h.at(-1);
  if (higherFast === undefined || higherSlow === undefined || last === undefined) {
    throw new MajorSignalError('breakout series is incomplete');
  }
  const upper = highestHigh(candles1h, 20);
  const lower = lowestLow(candles1h, 20);
  if (higherFast > higherSlow && last.close > upper) return 'long';
  if (higherFast < higherSlow && last.close < lower) return 'short';
  return undefined;
}

/** Build a shared E5-compatible candidate from a major indicator signal. */
export function evaluateMajorEntry(
  config: Config,
  instId: string,
  direction: Direction,
  candles1h: readonly Candle[],
  candles4h: readonly Candle[],
  fundingRate: number,
  nowMs: number,
  cooldownUntilMs?: number,
): EntryVerdict {
  if (cooldownUntilMs !== undefined && nowMs < cooldownUntilMs) {
    return { accepted: false, rejection: { instId, direction, reasons: ['in post-stop cooldown'] } };
  }

  const signal = majorSignal(candles1h, candles4h);
  if (signal.direction !== direction) {
    return { accepted: false, rejection: { instId, direction, reasons: ['no aligned MACD crossover'] } };
  }

  return buildMajorCandidate(config, instId, direction, candles1h, fundingRate, nowMs);
}

export function evaluateMajorPullbackEntry(
  config: Config,
  instId: string,
  direction: Direction,
  candles1h: readonly Candle[],
  candles4h: readonly Candle[],
  fundingRate: number,
  nowMs: number,
  cooldownUntilMs?: number,
): EntryVerdict {
  if (cooldownUntilMs !== undefined && nowMs < cooldownUntilMs) {
    return { accepted: false, rejection: { instId, direction, reasons: ['in post-stop cooldown'] } };
  }
  if (majorPullbackDirection(candles1h, candles4h) !== direction) {
    return { accepted: false, rejection: { instId, direction, reasons: ['no aligned EMA pullback reclaim'] } };
  }
  return buildMajorCandidate(config, instId, direction, candles1h, fundingRate, nowMs);
}

export function evaluateMajorBreakoutEntry(
  config: Config,
  instId: string,
  direction: Direction,
  candles1h: readonly Candle[],
  candles4h: readonly Candle[],
  fundingRate: number,
  nowMs: number,
  cooldownUntilMs?: number,
): EntryVerdict {
  if (cooldownUntilMs !== undefined && nowMs < cooldownUntilMs) {
    return { accepted: false, rejection: { instId, direction, reasons: ['in post-stop cooldown'] } };
  }
  if (majorBreakoutDirection(candles1h, candles4h) !== direction) {
    return { accepted: false, rejection: { instId, direction, reasons: ['no aligned Donchian breakout'] } };
  }
  return buildMajorCandidate(config, instId, direction, candles1h, fundingRate, nowMs);
}
