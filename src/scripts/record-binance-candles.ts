/**
 * Add Binance USDⓈ-M OHLCV to an existing OKX replay dataset.
 *
 * Binance is intentionally appended as signal-only data.  The original OKX
 * candles, specs, spreads, and funding are copied unchanged and remain the
 * execution truth for every normal replay.
 *
 * Usage:
 *   npm run record-binance-candles -- \
 *     var/backtest/majors-540d.json \
 *     --out var/backtest/majors-540d-multivenue.json
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { loadReplayDataset } from '../backtest/replay.js';
import { BinanceMarketData } from '../market/binance.js';
import { confirmedOnly } from '../market/okx.js';
import { baseSymbol } from '../signal/scanner.js';

const DAY_MS = 86_400_000;

function valueAfter(flag: string, fallback: string): string {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] ?? fallback : fallback;
}

function requestedSymbols(): readonly string[] {
  const raw = valueAfter('--symbols', '').trim();
  if (raw === '') return [];
  const symbols = raw.split(',').map((item) => item.trim().toUpperCase()).filter(Boolean);
  if (new Set(symbols).size !== symbols.length) throw new Error('--symbols contains duplicates');
  return symbols;
}

async function main(): Promise<void> {
  const input = process.argv.find((arg) => !arg.startsWith('-') && arg.endsWith('.json'));
  if (input === undefined) throw new Error('provide an OKX replay dataset JSON path');
  const output = valueAfter('--out', input.replace(/\.json$/u, '-multivenue.json'));
  const symbols = requestedSymbols();
  const dataset = loadReplayDataset(input);
  const fromMs = dataset.replayFromMs;
  const toMs = dataset.replayToMs;
  if (fromMs === undefined || toMs === undefined) throw new Error('dataset needs replayFromMs and replayToMs');

  const members = symbols.length === 0
    ? dataset.instruments
    : dataset.instruments.filter((instrument) => symbols.includes(baseSymbol(instrument.instId)));
  const missing = symbols.filter((symbol) => !members.some((instrument) => baseSymbol(instrument.instId) === symbol));
  if (missing.length > 0) throw new Error(`requested symbols are not in the dataset: ${missing.join(', ')}`);
  console.log(`adding Binance USDⓈ-M OHLCV for ${members.length} instruments`);
  console.log(`range ${new Date(fromMs).toISOString()} → ${new Date(toMs).toISOString()}`);

  const market = new BinanceMarketData({ minRequestIntervalMs: 100 });
  const records: unknown[] = [];
  for (const instrument of dataset.instruments) {
    if (!members.includes(instrument)) {
      records.push(instrument);
      continue;
    }
    const symbol = `${baseSymbol(instrument.instId)}USDT`;
    const [candles1h, candles4h] = await Promise.all([
      market.historyCandles(symbol, '1h', fromMs - 14 * DAY_MS, toMs),
      market.historyCandles(symbol, '4h', fromMs - 14 * DAY_MS, toMs),
    ]);
    const binanceCandles1h = confirmedOnly(candles1h);
    const binanceCandles4h = confirmedOnly(candles4h);
    console.log(`  ${instrument.instId.padEnd(24)} Binance ${symbol.padEnd(12)} 1h=${binanceCandles1h.length} 4h=${binanceCandles4h.length}`);
    records.push({
      ...instrument,
      binanceSymbol: symbol,
      binanceCandles1h,
      binanceCandles4h,
    });
  }

  const result = {
    recordedAtMs: Date.now(),
    fromMs,
    toMs,
    initialEquityUsdt: dataset.initialEquityUsdt,
    dataSources: {
      execution: 'OKX candles, instrument specs, spreads, and fills',
      signalSupplement: 'Binance USDⓈ-M klines; never used for execution or funding',
      funding: 'OKX funding field currently present in the input dataset; replace with the exact OKX historical import before promotion',
    },
    instruments: records,
  };
  const absolute = resolve(output);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, JSON.stringify(result), 'utf8');
  console.log(`wrote combined dataset to ${absolute}`);
}

main().catch((error: unknown) => {
  console.error('BINANCE RECORD FAILED:', error);
  process.exitCode = 1;
});

