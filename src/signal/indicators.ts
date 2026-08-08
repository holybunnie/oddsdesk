/**
 * Indicators.
 *
 * All Wilder-smoothed indicators use Wilder's original recursion, not an EMA
 * approximation — ADX(14) computed with a standard EMA is a different series
 * and would shift the regime gate's threshold meaningfully.
 *
 * Every function throws on insufficient data rather than returning a partial
 * result. An ATR computed from four bars is not a small inaccuracy, it is a
 * different number, and it would flow straight into stop distance and therefore
 * into position size.
 */

import type { Candle } from '../market/okx.js';

export class IndicatorError extends Error {
  override readonly name = 'IndicatorError';
}

function assertEnough(candles: readonly Candle[], needed: number, what: string): void {
  if (candles.length < needed) {
    throw new IndicatorError(`${what} needs ${needed} candles, received ${candles.length}`);
  }
}

/** True range for bar i, which requires bar i-1's close. */
function trueRange(current: Candle, previous: Candle): number {
  return Math.max(
    current.high - current.low,
    Math.abs(current.high - previous.close),
    Math.abs(current.low - previous.close),
  );
}

/**
 * Wilder's ATR. Seeded with a simple mean of the first `period` true ranges,
 * then smoothed recursively.
 */
export function atr(candles: readonly Candle[], period: number): number {
  assertEnough(candles, period + 1, `ATR(${period})`);

  const ranges: number[] = [];
  for (let i = 1; i < candles.length; i += 1) {
    const current = candles[i];
    const previous = candles[i - 1];
    if (current === undefined || previous === undefined) {
      throw new IndicatorError('candle series contains a hole');
    }
    ranges.push(trueRange(current, previous));
  }

  const seed = ranges.slice(0, period);
  let value = seed.reduce((a, b) => a + b, 0) / period;

  for (const range of ranges.slice(period)) {
    value = (value * (period - 1) + range) / period;
  }

  if (!Number.isFinite(value) || value <= 0) {
    throw new IndicatorError(`ATR(${period}) produced a non-positive value (${value})`);
  }
  return value;
}

/**
 * Wilder's ADX — trend strength irrespective of direction.
 *
 * Needs roughly 2x period of history because ADX is a smoothed average of DX,
 * which is itself built from smoothed DI values.
 */
export function adx(candles: readonly Candle[], period: number): number {
  assertEnough(candles, period * 2 + 1, `ADX(${period})`);

  const plusDM: number[] = [];
  const minusDM: number[] = [];
  const ranges: number[] = [];

  for (let i = 1; i < candles.length; i += 1) {
    const current = candles[i];
    const previous = candles[i - 1];
    if (current === undefined || previous === undefined) {
      throw new IndicatorError('candle series contains a hole');
    }

    const upMove = current.high - previous.high;
    const downMove = previous.low - current.low;

    // Only the larger move counts, and only if it is positive. Both can be zero.
    plusDM.push(upMove > downMove && upMove > 0 ? upMove : 0);
    minusDM.push(downMove > upMove && downMove > 0 ? downMove : 0);
    ranges.push(trueRange(current, previous));
  }

  const wilderSmooth = (series: readonly number[]): number[] => {
    const out: number[] = [];
    let running = series.slice(0, period).reduce((a, b) => a + b, 0);
    out.push(running);
    for (let i = period; i < series.length; i += 1) {
      const next = series[i];
      if (next === undefined) throw new IndicatorError('smoothing series contains a hole');
      running = running - running / period + next;
      out.push(running);
    }
    return out;
  };

  const smoothedTr = wilderSmooth(ranges);
  const smoothedPlus = wilderSmooth(plusDM);
  const smoothedMinus = wilderSmooth(minusDM);

  const dx: number[] = [];
  for (let i = 0; i < smoothedTr.length; i += 1) {
    const tr = smoothedTr[i];
    const plus = smoothedPlus[i];
    const minus = smoothedMinus[i];
    if (tr === undefined || plus === undefined || minus === undefined) {
      throw new IndicatorError('smoothed series length mismatch');
    }
    if (tr === 0) {
      // A flat bar range means no directional information, not zero trend.
      continue;
    }
    const plusDi = (100 * plus) / tr;
    const minusDi = (100 * minus) / tr;
    const sum = plusDi + minusDi;
    if (sum === 0) continue;
    dx.push((100 * Math.abs(plusDi - minusDi)) / sum);
  }

  if (dx.length < period) {
    throw new IndicatorError(`ADX(${period}) produced only ${dx.length} DX values, needs ${period}`);
  }

  let value = dx.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (const d of dx.slice(period)) {
    value = (value * (period - 1) + d) / period;
  }

  if (!Number.isFinite(value)) {
    throw new IndicatorError('ADX produced a non-finite value');
  }
  return value;
}

/** Log returns between consecutive closes. */
export function logReturns(candles: readonly Candle[]): number[] {
  assertEnough(candles, 2, 'log returns');
  const out: number[] = [];
  for (let i = 1; i < candles.length; i += 1) {
    const current = candles[i];
    const previous = candles[i - 1];
    if (current === undefined || previous === undefined) {
      throw new IndicatorError('candle series contains a hole');
    }
    if (previous.close <= 0) {
      throw new IndicatorError('candle close is non-positive; cannot take a log return');
    }
    out.push(Math.log(current.close / previous.close));
  }
  return out;
}

/**
 * Realized volatility as the standard deviation of log returns over the last
 * `lookback` bars, expressed per bar. The regime gate wants a band, not an
 * annualised headline, so no scaling is applied here.
 */
export function realizedVolatility(candles: readonly Candle[], lookback: number): number {
  assertEnough(candles, lookback + 1, `realized volatility(${lookback})`);

  const returns = logReturns(candles).slice(-lookback);
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance = returns.reduce((sum, r) => sum + (r - mean) ** 2, 0) / (returns.length - 1);
  return Math.sqrt(variance);
}

/**
 * Volatility-adjusted momentum: price change over `lookback` bars expressed in
 * ATR units.
 *
 * This is what makes a 3% move in BTC and a 12% move in a high-beta alt
 * comparable. Ranking on raw percentage change would fill the book with
 * whatever is most volatile rather than whatever is trending hardest.
 */
export function normalisedMomentum(
  candles: readonly Candle[],
  lookback: number,
  atrPeriod: number,
): number {
  assertEnough(candles, Math.max(lookback + 1, atrPeriod + 1), `normalised momentum(${lookback})`);

  const last = candles[candles.length - 1];
  const past = candles[candles.length - 1 - lookback];
  if (last === undefined || past === undefined) {
    throw new IndicatorError('candle series is shorter than the lookback');
  }

  return (last.close - past.close) / atr(candles, atrPeriod);
}

/**
 * Volume trend: recent mean quote volume over the previous mean.
 *
 * Above 1 means expanding participation. A breakout on contracting volume is
 * the classic false break, which is why E2 requires expansion rather than
 * merely "enough" volume.
 */
export function volumeTrend(candles: readonly Candle[], window: number): number {
  assertEnough(candles, window * 2, `volume trend(${window})`);

  const recent = candles.slice(-window);
  const prior = candles.slice(-window * 2, -window);

  const mean = (rows: readonly Candle[]): number =>
    rows.reduce((sum, c) => sum + c.quoteVolume, 0) / rows.length;

  const priorMean = mean(prior);
  if (priorMean <= 0) {
    throw new IndicatorError('prior-window volume is zero; cannot compute a volume trend');
  }

  return mean(recent) / priorMean;
}

/** Highest high over the last `lookback` bars, excluding the current bar. */
export function highestHigh(candles: readonly Candle[], lookback: number): number {
  assertEnough(candles, lookback + 1, `highest high(${lookback})`);
  const window = candles.slice(-lookback - 1, -1);
  return Math.max(...window.map((c) => c.high));
}

/** Lowest low over the last `lookback` bars, excluding the current bar. */
export function lowestLow(candles: readonly Candle[], lookback: number): number {
  assertEnough(candles, lookback + 1, `lowest low(${lookback})`);
  const window = candles.slice(-lookback - 1, -1);
  return Math.min(...window.map((c) => c.low));
}
