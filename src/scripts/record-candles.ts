/**
 * Record a replay dataset from OKX public history.
 *
 * Usage:
 *   npx tsx src/scripts/record-candles.ts --days 90 --out var/backtest/okx-90d.json
 *
 * The current E1 universe is captured at record time. Historical spread is not
 * available in candle history, so the observed current spread is stored as an
 * explicit per-instrument assumption and reported by the replay.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { loadConfig } from '../config.js';
import { OkxMarketData } from '../market/okx.js';
import { selectUniverseWithRejections } from '../signal/scanner.js';

function valueAfter(flag: string, fallback: string): string {
  const index = process.argv.indexOf(flag);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  return value ?? fallback;
}

async function main(): Promise<void> {
  const days = Number(valueAfter('--days', '90'));
  const output = valueAfter('--out', 'var/backtest/okx-90d.json');
  if (!Number.isInteger(days) || days <= 0 || days > 365) throw new Error('--days must be an integer in 1..365');

  const config = loadConfig('config/default.yaml');
  const market = new OkxMarketData({ minRequestIntervalMs: 120 });
  const toMs = Math.floor((Date.now() - 3_600_000) / 3_600_000) * 3_600_000;
  const fromMs = toMs - days * 86_400_000;

  const [instruments, tickers] = await Promise.all([market.instruments('SWAP'), market.tickers('SWAP')]);
  const selected = selectUniverseWithRejections(config, instruments, tickers);
  console.log(`recording ${selected.members.length} E1 instruments from ${instruments.length} live swaps`);
  console.log(`range ${new Date(fromMs).toISOString()} → ${new Date(toMs).toISOString()}`);

  const records: unknown[] = [];
  const batchSize = 4;
  for (let i = 0; i < selected.members.length; i += batchSize) {
    const batch = selected.members.slice(i, i + batchSize);
    const rows = await Promise.all(batch.map(async (member) => {
      const [candles1h, candles4h, funding] = await Promise.all([
        market.historyCandles(member.instId, '1H', fromMs - 14 * 86_400_000, toMs),
        market.historyCandles(member.instId, '4H', fromMs - 14 * 86_400_000, toMs),
        market.fundingRateHistory(member.instId, fromMs, toMs),
      ]);
      console.log(`  ${member.instId.padEnd(24)} 1h=${candles1h.length} 4h=${candles4h.length} funding=${funding.length}`);
      return {
        instId: member.instId,
        spec: member.spec,
        spreadBps: member.spreadBps,
        candles1h,
        candles4h,
        funding,
      };
    }));
    records.push(...rows);
  }

  const dataset = {
    recordedAtMs: Date.now(),
    fromMs,
    toMs,
    initialEquityUsdt: config.capital.principalBaseUsdt,
    instruments: records,
  };
  const absolute = resolve(output);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, JSON.stringify(dataset), 'utf8');
  console.log(`wrote ${records.length} instruments to ${absolute}`);
  console.log(`E1 rejections: ${selected.rejections.length}`);
}

main().catch((error: unknown) => {
  console.error('RECORD FAILED:', error);
  process.exitCode = 1;
});
