import { describe, expect, it } from 'vitest';
import { BinanceMarketData } from './binance.js';

const HOUR = 3_600_000;
const START = Date.UTC(2026, 0, 1);

function row(openTimeMs: number, closeTimeMs: number): readonly unknown[] {
  return [openTimeMs, '100', '105', '95', '102', '12.5', closeTimeMs, '1275', 42, '6', '612', '0'];
}

describe('Binance USDⓈ-M market data', () => {
  it('paginates, parses, and orders klines without changing the venue role', async () => {
    const pages = [
      [row(START, START + HOUR - 1)],
      [row(START + HOUR, START + 2 * HOUR - 1)],
    ];
    const requests: string[] = [];
    const market = new BinanceMarketData({
      minRequestIntervalMs: 0,
      fetchImpl: async (input) => {
        requests.push(String(input));
        const page = pages.shift() ?? [];
        return new Response(JSON.stringify(page), { status: 200, headers: { 'content-type': 'application/json' } });
      },
    });

    const candles = await market.historyCandles('BTCUSDT', '1h', START, START + HOUR, 1);

    expect(candles).toHaveLength(2);
    expect(candles[0]).toMatchObject({ openTimeMs: START, close: 102, volume: 12.5, quoteVolume: 1275, confirmed: true });
    expect(candles[1]?.openTimeMs).toBe(START + HOUR);
    expect(requests).toHaveLength(2);
    expect(requests[0]).toContain('symbol=BTCUSDT');
    expect(requests[0]).toContain('interval=1h');
  });
});

