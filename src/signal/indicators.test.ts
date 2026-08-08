import { describe, expect, it } from 'vitest';
import type { Candle } from '../market/okx.js';
import {
  IndicatorError,
  atr,
  highestHigh,
  logReturns,
  lowestLow,
  normalisedMomentum,
  realizedVolatility,
  volumeTrend,
} from './indicators.js';

/**
 * Candles are constructed here rather than fetched. This is indicator
 * arithmetic, so a pure input with a known answer is the only way to prove the
 * formula — a live fetch would test the venue, not the maths. The scanner's
 * integration test does hit the real venue.
 */
const candle = (
  open: number,
  high: number,
  low: number,
  close: number,
  quoteVolume = 1_000,
): Candle => ({
  openTimeMs: 0,
  open,
  high,
  low,
  close,
  volume: quoteVolume / close,
  quoteVolume,
  confirmed: true,
});

/** Flat series: every bar identical except a constant range. */
const flat = (count: number, range = 2): readonly Candle[] =>
  Array.from({ length: count }, () => candle(100, 100 + range / 2, 100 - range / 2, 100));

describe('ATR', () => {
  it('equals the constant true range on a flat series', () => {
    // Every bar has high-low = 2 and no gaps, so TR is 2 everywhere and any
    // smoothing of a constant is that constant.
    expect(atr(flat(30, 2), 14)).toBeCloseTo(2, 10);
  });

  it('rises when range expands', () => {
    const calm = flat(30, 2);
    const stormy = [...calm, candle(100, 120, 80, 110)];
    expect(atr(stormy, 14)).toBeGreaterThan(atr(calm, 14));
  });

  it('throws rather than returning a partial value on short history', () => {
    // An ATR from four bars is not slightly wrong, it is a different number —
    // and it would flow straight into stop distance and position size.
    expect(() => atr(flat(5), 14)).toThrow(IndicatorError);
  });
});

describe('log returns and realized volatility', () => {
  it('computes zero volatility on a constant series', () => {
    expect(realizedVolatility(flat(40), 24)).toBeCloseTo(0, 12);
  });

  it('produces one fewer return than candles', () => {
    expect(logReturns(flat(10))).toHaveLength(9);
  });

  it('rises with dispersion', () => {
    const choppy: Candle[] = [];
    for (let i = 0; i < 40; i += 1) {
      const price = i % 2 === 0 ? 100 : 108;
      choppy.push(candle(price, price + 1, price - 1, price));
    }
    expect(realizedVolatility(choppy, 24)).toBeGreaterThan(0.05);
  });
});

describe('normalised momentum', () => {
  it('expresses price change in ATR units', () => {
    // Drift 1 per bar with a constant true range of 2 over 10 bars: the close
    // is 10 higher and ATR is 2, so momentum is 5 ATRs.
    const trending: Candle[] = [];
    for (let i = 0; i < 40; i += 1) {
      const price = 100 + i;
      trending.push(candle(price, price + 1, price - 1, price));
    }
    expect(normalisedMomentum(trending, 10, 14)).toBeCloseTo(5, 1);
  });

  it('makes a slow large-cap and a fast alt comparable', () => {
    // Identical ATR-relative moves at very different absolute scales must rank
    // equally — otherwise the book fills with whatever is merely most volatile.
    const slow: Candle[] = [];
    const fast: Candle[] = [];
    for (let i = 0; i < 40; i += 1) {
      const s = 60_000 + i * 100;
      slow.push(candle(s, s + 100, s - 100, s));
      const f = 2 + i * 0.02;
      fast.push(candle(f, f + 0.02, f - 0.02, f));
    }
    expect(normalisedMomentum(slow, 10, 14)).toBeCloseTo(normalisedMomentum(fast, 10, 14), 6);
  });
});

describe('volume trend', () => {
  it('reports expansion above 1 and contraction below', () => {
    const rising = [...flat(12, 2).map((c) => ({ ...c, quoteVolume: 100 })), ...flat(12, 2).map((c) => ({ ...c, quoteVolume: 300 }))];
    expect(volumeTrend(rising, 12)).toBeCloseTo(3, 6);

    const falling = [...flat(12, 2).map((c) => ({ ...c, quoteVolume: 300 })), ...flat(12, 2).map((c) => ({ ...c, quoteVolume: 100 }))];
    expect(volumeTrend(falling, 12)).toBeCloseTo(1 / 3, 6);
  });
});

describe('breakout levels', () => {
  it('excludes the current bar so a breakout is measured against history', () => {
    const series = [...flat(24, 2), candle(100, 130, 99, 129)];
    // The 130 high belongs to the current bar and must not raise its own level,
    // otherwise nothing can ever break out.
    expect(highestHigh(series, 24)).toBeCloseTo(101, 10);
    expect(lowestLow(series, 24)).toBeCloseTo(99, 10);
  });
});
