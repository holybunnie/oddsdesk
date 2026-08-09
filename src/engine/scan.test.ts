import { describe, expect, it } from 'vitest';
import { loadConfig } from '../config.js';
import type { Candle, InstrumentSpec, OkxMarketData, TickerSnapshot } from '../market/okx.js';
import { runScan } from './scan.js';

const config = loadConfig('config/default.yaml');
const HOUR = 3_600_000;
const NOW = Date.UTC(2026, 7, 12, 9, 0, 0);

/**
 * A rising series with real bar-to-bar variation, enough history for ADX(14)
 * and the 24-bar breakout.
 *
 * The oscillation is not decoration: a perfectly smooth ramp has zero return
 * variance, which fails E2's minimum realised volatility, so the regime gate
 * stands the engine down and E4 never runs at all.
 */
function candles(count: number, lastOpenTimeMs: number, base = 100): Candle[] {
  return Array.from({ length: count }, (_, i) => {
    const close = base * (1 + i * 0.004) * (1 + 0.006 * Math.sin(i * 1.7));
    return {
      openTimeMs: lastOpenTimeMs - (count - 1 - i) * HOUR,
      open: close * 0.999,
      high: close * 1.004,
      low: close * 0.996,
      close,
      volume: 1000 + i * 10,
      quoteVolume: (1000 + i * 10) * close,
      confirmed: true,
    };
  });
}

function spec(instId: string): InstrumentSpec {
  return {
    instId,
    state: 'live',
    tickSz: 0.001,
    lotSz: 0.01,
    minSz: 0.01,
    ctVal: 1,
  } as unknown as InstrumentSpec;
}

function ticker(instId: string): TickerSnapshot {
  return {
    instId,
    last: 100,
    bid: 99.999,
    ask: 100.001,
    quoteVolume24h: 500_000_000,
  } as unknown as TickerSnapshot;
}

interface StubOptions {
  readonly symbols: readonly string[];
  readonly lastOpenTimeMs?: number;
}

function stubMarket(options: StubOptions): { market: OkxMarketData; fetched: string[] } {
  const fetched: string[] = [];
  const lastOpenTimeMs = options.lastOpenTimeMs ?? NOW - HOUR;

  const market = {
    instruments: async () => options.symbols.map(spec),
    tickers: async () => options.symbols.map(ticker),
    candles: async (instId: string) => {
      fetched.push(instId);
      return candles(120, lastOpenTimeMs);
    },
    fundingRate: async () => 0,
  } as unknown as OkxMarketData;

  return { market, fetched };
}

describe('feed freshness', () => {
  it('measures from when the bar CLOSED, not when it opened', async () => {
    // A confirmed 1h bar is up to an hour old by construction. Measuring from
    // the open would make every healthy feed look an hour stale and refuse
    // every order at the guard.
    const lastOpenTimeMs = NOW - HOUR;
    const { market } = stubMarket({ symbols: ['AAA-USDT-SWAP'], lastOpenTimeMs });

    const scan = await runScan({ config, market, nowMs: NOW });
    const feed = scan.result.feeds[0];

    expect(feed?.lastUpdateMs).toBe(lastOpenTimeMs + HOUR);
    expect(NOW - (feed?.lastUpdateMs ?? 0)).toBeLessThanOrEqual(
      config.risk.maxFeedStalenessSeconds * 1000,
    );
  });

  it('reports the worst feed, not the average', async () => {
    // One instrument stuck on an old bar is a stale feed even when the rest are
    // current; averaging would hide exactly the case the gate exists for.
    const { market } = stubMarket({ symbols: ['AAA-USDT-SWAP'], lastOpenTimeMs: NOW - 10 * HOUR });

    const scan = await runScan({ config, market, nowMs: NOW });

    expect(NOW - (scan.result.feeds[0]?.lastUpdateMs ?? 0)).toBeGreaterThan(
      config.risk.maxFeedStalenessSeconds * 1000,
    );
  });
});

describe('pricing coverage', () => {
  it('prices every instrument it fetched, not just the candidates', async () => {
    // A candidate-only map is exactly the gap that makes the engine throw when
    // it tries to manage an open position.
    const { market } = stubMarket({ symbols: ['AAA-USDT-SWAP', 'BBB-USDT-SWAP'] });

    const scan = await runScan({ config, market, nowMs: NOW });

    expect(scan.result.lastPrices.size).toBe(2);
    expect(scan.result.atrByInstrument.size).toBe(2);
  });

  it('fetches an instrument named in mustPrice even when E1 rejected it', async () => {
    const { market, fetched } = stubMarket({ symbols: ['AAA-USDT-SWAP'] });

    const scan = await runScan({
      config,
      market,
      mustPrice: ['GONE-USDT-SWAP'],
      nowMs: NOW,
    });

    expect(fetched).toContain('GONE-USDT-SWAP');
    expect(scan.result.lastPrices.has('GONE-USDT-SWAP')).toBe(true);
  });
});

describe('cooldowns', () => {
  it('passes them into E4, which the stateless script cannot', async () => {
    // scan.ts over-reports by design because it holds no history. The engine
    // does hold it, and a candidate inside its cooldown must be rejected for
    // that reason rather than silently sized.
    // Enough symbols that the top decile is several instruments, so E2 can
    // reach its minimum-passing threshold and E4 actually runs.
    const symbols = Array.from({ length: 40 }, (_, i) => `S${i}-USDT-SWAP`);
    const { market } = stubMarket({ symbols });

    const withCooldown = await runScan({
      config,
      market,
      cooldowns: new Map(symbols.map((s) => [s, NOW + HOUR])),
      nowMs: NOW,
    });

    const cooled = withCooldown.rejected.filter((r) =>
      r.reasons.some((reason) => /cooldown/.test(reason)),
    );
    expect(cooled.length).toBeGreaterThan(0);
  });
});
