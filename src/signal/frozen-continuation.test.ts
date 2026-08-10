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

function states(): FrozenMarketState[] {
  return FROZEN_MAJOR_INST_IDS.map((instId) => ({
    instId,
    candles1h: falling(120, 1),
    candles4h: falling(70, 4),
    binanceCandles1h: falling(120, 1),
    binanceCandles4h: falling(70, 4),
  }));
}

describe('frozen short continuation', () => {
  it('emits one short with the frozen 2ATR stop and 3R target', () => {
    const decision = evaluateFrozenContinuation(states(), NOW);
    expect(decision.regimeFavourable).toBe(true);
    expect(decision.shortBreadth).toBe(6);
    expect(decision.candidate?.direction).toBe('short');
    const candidate = decision.candidate!;
    const risk = candidate.stopPrice - candidate.entryBandLow;
    expect(candidate.entryBandLow - candidate.targetPrice).toBeCloseTo(3 * risk, 10);
    expect(candidate.scaleOutPrice).toBe(candidate.targetPrice);
  });

  it('stands down when BTC is not in a dual-venue short trend', () => {
    const input = states();
    const btc = input[0]!;
    const rising = [...btc.candles4h].reverse().map((candle, index) => ({ ...candle, openTimeMs: btc.candles4h[index]!.openTimeMs }));
    input[0] = { ...btc, candles4h: rising, binanceCandles4h: rising };
    const decision = evaluateFrozenContinuation(input, NOW);
    expect(decision.regimeFavourable).toBe(false);
    expect(decision.candidate).toBeUndefined();
    expect(decision.reason).toMatch(/BTC/);
  });

  it('does not re-emit an instrument during cooldown', () => {
    const decision = evaluateFrozenContinuation(states(), NOW, new Map(FROZEN_MAJOR_INST_IDS.map((id) => [id, NOW + HOUR_MS])));
    expect(decision.candidate).toBeUndefined();
  });
});
