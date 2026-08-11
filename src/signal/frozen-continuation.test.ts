import { describe, expect, it } from 'vitest';
import type { Candle } from '../market/okx.js';
import {
  evaluateFrozenContinuation,
  FROZEN_MAJOR_INST_IDS,
  type FrozenMarketState,
} from './frozen-continuation.js';

const HOUR_MS = 3_600_000;
const NOW = Date.UTC(2026, 7, 10, 14);

function falling(count: number, stepHours: number): Candle[] {
  const result = Array.from({ length: count }, (_, index) => {
    const close = 200 * Math.exp(-0.004 * index) * (1 + 0.008 * Math.sin(index * 1.7));
    return {
      openTimeMs: NOW - (count - index) * stepHours * HOUR_MS,
      open: close * 1.002,
      high: close * 1.01,
      low: close * 0.99,
      close,
      volume: 1_000,
      quoteVolume: close * 1_000,
      confirmed: true,
    } satisfies Candle;
  });
  const previous = result.at(-2)!;
  result[result.length - 1] = { ...result.at(-1)!, close: previous.close * 0.98, low: previous.close * 0.97 };
  return result;
}

function rising(count: number, stepHours: number): Candle[] {
  const result = Array.from({ length: count }, (_, index) => {
    const close = 200 * Math.exp(0.004 * index) * (1 + 0.008 * Math.sin(index * 1.7));
    return {
      openTimeMs: NOW - (count - index) * stepHours * HOUR_MS,
      open: close * 0.998,
      high: close * 1.01,
      low: close * 0.99,
      close,
      volume: 1_000,
      quoteVolume: close * 1_000,
      confirmed: true,
    } satisfies Candle;
  });
  const previous = result.at(-2)!;
  result[result.length - 1] = { ...result.at(-1)!, close: previous.close * 1.02, high: previous.close * 1.03 };
  return result;
}

function states(): FrozenMarketState[] {
  return FROZEN_MAJOR_INST_IDS.map((instId) => ({
    instId,
    candles1h: falling(120, 1),
    candles4h: falling(70, 4),
    binanceCandles1h: falling(120, 1),
    binanceCandles4h: falling(70, 4),
  }));
}

function longStates(): FrozenMarketState[] {
  return FROZEN_MAJOR_INST_IDS.map((instId) => ({
    instId,
    candles1h: rising(120, 1),
    candles4h: rising(70, 4),
    binanceCandles1h: rising(120, 1),
    binanceCandles4h: rising(70, 4),
  }));
}

describe('frozen short continuation', () => {
  it('emits one short with the frozen 2ATR stop and 3R target', () => {
    const decision = evaluateFrozenContinuation(states(), NOW);
    expect(decision.regimeFavourable).toBe(true);
    expect(decision.directionalBreadth).toBe(6);
    expect(decision.trend).toBe('short');
    expect(decision.candidate?.direction).toBe('short');
    const candidate = decision.candidate!;
    const risk = candidate.stopPrice - candidate.entryBandLow;
    expect(candidate.entryBandLow - candidate.targetPrice).toBeCloseTo(3 * risk, 10);
    // No scale-out at all: this is a single 3R target. It previously published
    // TP1 == TP2, which the publication gate refused, so the policy generated
    // signals it could never deliver.
    expect(candidate.scaleOutPrice).toBeUndefined();
  });

  it('emits the mirrored long with the stop below and the target above', () => {
    const decision = evaluateFrozenContinuation(longStates(), NOW);
    expect(decision.regimeFavourable).toBe(true);
    expect(decision.trend).toBe('long');
    expect(decision.directionalBreadth).toBe(6);
    expect(decision.candidate?.direction).toBe('long');
    const candidate = decision.candidate!;
    expect(candidate.stopPrice).toBeLessThan(candidate.entryBandLow);
    expect(candidate.targetPrice).toBeGreaterThan(candidate.entryBandLow);
    const risk = candidate.entryBandLow - candidate.stopPrice;
    expect(candidate.targetPrice - candidate.entryBandLow).toBeCloseTo(3 * risk, 10);
  });

  it('stands down on breadth when BTC flips against the rest of the book', () => {
    // BTC turning up licenses the long side, but the other five majors are
    // still short, so long breadth is 1/6 and the floor rejects it.
    const input = states();
    const btc = input[0]!;
    input[0] = { ...btc, candles4h: rising(70, 4), binanceCandles4h: rising(70, 4) };
    const decision = evaluateFrozenContinuation(input, NOW);
    expect(decision.regimeFavourable).toBe(false);
    expect(decision.candidate).toBeUndefined();
    expect(decision.trend).toBe('long');
    expect(decision.reason).toMatch(/breadth 1\/6/);
  });

  it('stands down when the two venues disagree on BTC itself', () => {
    const input = states();
    const btc = input[0]!;
    input[0] = { ...btc, binanceCandles4h: rising(70, 4) };
    const decision = evaluateFrozenContinuation(input, NOW);
    expect(decision.regimeFavourable).toBe(false);
    expect(decision.candidate).toBeUndefined();
    expect(decision.trend).toBe('mixed');
    expect(decision.reason).toMatch(/disagrees across venues/);
  });

  it('does not re-emit an instrument during cooldown', () => {
    const decision = evaluateFrozenContinuation(states(), NOW, new Map(FROZEN_MAJOR_INST_IDS.map((id) => [id, NOW + HOUR_MS])));
    expect(decision.candidate).toBeUndefined();
  });
});
