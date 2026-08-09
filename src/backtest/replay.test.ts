import { describe, expect, it } from 'vitest';
import { loadConfig, type Config } from '../config.js';
import type { Candle, InstrumentSpec } from '../market/okx.js';
import { replay, validateReplayDataset, type ReplayDataset } from './replay.js';

const baseConfig = loadConfig('config/default.yaml');
const HOUR = 3_600_000;
const START = Date.UTC(2026, 0, 1);

function studyConfig(overrides: Partial<Config> = {}): Config {
  return {
    ...baseConfig,
    ...overrides,
    universe: {
      ...baseConfig.universe,
      minQuoteVolume24hUsdt: 1,
      minTradableNotionalUsdt: 100_000,
      ...overrides.universe,
    },
    signals: {
      ...baseConfig.signals,
      minInstrumentsPassingRegime: 1,
      ...overrides.signals,
    },
    regime: {
      ...baseConfig.regime,
      minAdx: 10,
      minRealizedVol: 0.0001,
      maxRealizedVol: 0.03,
      minVolumeTrend: 0.9,
      ...overrides.regime,
    },
    entry: {
      ...baseConfig.entry,
      breakoutLookback: 12,
      ...overrides.entry,
    },
  };
}

function candle(openTimeMs: number, open: number, close: number): Candle {
  return {
    openTimeMs,
    open,
    high: Math.max(open, close) + 1,
    low: Math.min(open, close) - 1,
    close,
    volume: 1_000_000 / Math.max(close, 1),
    quoteVolume: 1_000_000,
    confirmed: true,
  };
}

function dataset(count = 240): ReplayDataset {
  const candles1h: Candle[] = [];
  let previous = 100;
  for (let i = 0; i < count; i += 1) {
    const close = i < 180 ? 100 + i * 2 : 460 - (i - 180) * 4;
    candles1h.push(candle(START + i * HOUR, previous, close));
    previous = close;
  }

  const candles4h: Candle[] = [];
  previous = 100;
  for (let i = 0; i < Math.ceil(count / 4); i += 1) {
    const oneHourIndex = Math.min(i * 4 + 3, count - 1);
    const close = oneHourIndex < 180 ? 100 + oneHourIndex * 2 : 460 - (oneHourIndex - 180) * 4;
    candles4h.push(candle(START + i * FOUR_HOUR, previous, close));
    previous = close;
  }

  const spec: InstrumentSpec = {
    instId: 'TEST-USDT-SWAP',
    contractValue: 1,
    lotSize: 0.01,
    minSize: 0.01,
    tickSize: 0.01,
    state: 'live',
  };
  return {
    initialEquityUsdt: 320,
    instruments: [{
      instId: spec.instId,
      spec,
      spreadBps: 1,
      candles1h,
      candles4h,
      defaultFundingRate: 0,
    }],
  };
}

const FOUR_HOUR = 4 * HOUR;

describe('historical replay', () => {
  it('rejects an unconfirmed candle instead of replaying a repaint', () => {
    const data = dataset(80);
    const candle0 = data.instruments[0]?.candles1h[0];
    if (candle0 === undefined) throw new Error('fixture is empty');
    const broken: ReplayDataset = {
      ...data,
      instruments: [{ ...data.instruments[0]!, candles1h: [{ ...candle0, confirmed: false }, ...data.instruments[0]!.candles1h.slice(1)] }],
    };
    expect(() => validateReplayDataset(broken)).toThrow(/unconfirmed/);
  });

  it('does not fill a signal on the same bar that generated it', () => {
    const data = dataset(120);
    const result = replay({
      config: studyConfig(),
      dataset: data,
      tradingFeeRateFraction: 0,
    });
    // The final bar can generate a candidate, but there is no next bar for a
    // limit fill. A same-bar fill would be look-ahead.
    expect(result.entries).toBe(0);
  });

  it('replays entry, stop/exit state and reports the requested metrics', () => {
    const result = replay({
      config: studyConfig(),
      dataset: dataset(),
      tradingFeeRateFraction: 0.0002,
      slippageBps: 1,
    });
    expect(result.scanCycles).toBeGreaterThan(100);
    expect(result.entries).toBeGreaterThan(0);
    expect(result.closedTrades).toBeGreaterThan(0);
    expect(Number.isFinite(result.finalEquityUsdt)).toBe(true);
    expect(result.maxDrawdownFraction).toBeGreaterThanOrEqual(0);
    expect(result.timeStopHitRate).toBeGreaterThanOrEqual(0);
    expect(result.assumptions.some((item) => item.includes('closed 1h/4h'))).toBe(true);
  });
});
