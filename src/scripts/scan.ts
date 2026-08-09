/**
 * Live scan — runs E1 through E4 against the real venue and prints what the
 * signal engine currently sees.
 *
 * This is the observability tool for the daily procedure and the acceptance
 * test for the scanner: "ranking reproducible from recorded data" means being
 * able to run this and read the same numbers the engine acted on.
 *
 * It RENDERS the pipeline; it does not re-implement it. `runScan()` is the same
 * function the driver calls, so this script cannot drift into reporting
 * something the engine no longer does — which would be worse than no script.
 *
 * Read-only. It places no orders and needs no credentials. It is also
 * stateless, so it passes no cooldowns and deliberately over-reports; the live
 * engine supplies them.
 */

import { loadConfig } from '../config.js';
import { runScan } from '../engine/scan.js';
import { OkxMarketData } from '../market/okx.js';
import type { RegimeVerdict } from '../signal/scanner.js';

async function main(): Promise<void> {
  const config = loadConfig('config/default.yaml');
  const market = new OkxMarketData();

  const scan = await runScan({ config, market });
  const { result } = scan;

  console.log(`E1 universe: ${scan.universeSize} instruments`);
  console.log(`   from ${scan.liveUsdtPerps} live USDT perps`);
  console.log(
    `   filters: >= $${(config.universe.minQuoteVolume24hUsdt / 1e6).toFixed(0)}M 24h volume, ` +
      `spread <= ${config.universe.maxSpreadBps}bps`,
  );

  if (scan.universeSize === 0) {
    console.log('\nNo instruments passed E1. Nothing to rank.');
    return;
  }

  console.log(`\nE3 ranking: ${scan.ranked.length} instruments by ATR-normalised momentum`);
  console.log(`   taking the top and bottom ${(config.ranking.decileFraction * 100).toFixed(0)}%\n`);

  console.log('LONG candidates (strongest momentum):');
  for (const item of scan.assessed.filter((a) => a.direction === 'long')) {
    report(item.ranked.instId, item.ranked.momentumScore, item.verdict);
  }

  console.log('\nSHORT candidates (weakest momentum):');
  for (const item of scan.assessed.filter((a) => a.direction === 'short')) {
    report(item.ranked.instId, item.ranked.momentumScore, item.verdict);
  }

  console.log(
    `\nE2 regime: ${scan.regimePassing}/${scan.regimeConsidered} candidates pass ` +
      `(need ${config.signals.minInstrumentsPassingRegime})`,
  );
  console.log(
    result.regimeFavourable
      ? 'REGIME FAVOURABLE — the engine would look for entries among the passing candidates.'
      : 'REGIME UNFAVOURABLE — the engine stands down. Standing down is a valid output.',
  );

  if (!result.regimeFavourable) return;

  const eligible = scan.assessed.filter((a) => a.verdict.passed).length;
  console.log(`\nE4 entry gate: ${eligible} candidates, conviction threshold ${config.signals.minConviction}\n`);

  for (const rejection of scan.rejected) {
    const symbol = rejection.instId.replace('-USDT-SWAP', '').padEnd(10);
    const score = rejection.conviction?.total;
    console.log(
      `  --    ${symbol} ${rejection.direction.padEnd(5)} ` +
        `conviction ${score === undefined ? 'n/a' : score.toFixed(1)}`,
    );
    for (const reason of rejection.reasons) console.log(`         - ${reason}`);
  }

  for (const c of result.candidates) {
    const symbol = c.instId.replace('-USDT-SWAP', '').padEnd(10);
    console.log(`  ENTRY ${symbol} ${c.direction.padEnd(5)} conviction ${c.conviction.total.toFixed(1)}`);
    console.log(
      `         band ${fmt(c.entryBandLow)} - ${fmt(c.entryBandHigh)}  ` +
        `stop ${fmt(c.stopPrice)}  target ${fmt(c.targetPrice)}  ` +
        `(broke ${fmt(c.breakoutLevel)}, atr ${fmt(c.atr)})`,
    );
    console.log(
      `         components: mom ${pct(c.conviction.momentum)} adx ${pct(c.conviction.trendStrength)} ` +
        `vol ${pct(c.conviction.volume)} 4h ${pct(c.conviction.multiTimeframe)}`,
    );
  }

  // Frequency sanity check. The gate exists to make trading rare; a scan that
  // fires broadly is a tuning signal, not a good day.
  console.log(
    `\n${result.candidates.length} entry signal(s) from ${eligible} eligible candidates. ` +
      `Target is ~${config.signals.targetTradesPerDay}/day across all scans.`,
  );
  if (result.candidates.length > config.signals.targetTradesPerDay) {
    console.log('NOTE: more signals in one scan than the daily target — the threshold may be too loose.');
  }
}

/** Significant-figure formatting: perps range from 0.00001 to 100000. */
function fmt(value: number): string {
  if (!Number.isFinite(value)) return String(value);
  const magnitude = Math.abs(value);
  const decimals = magnitude >= 1000 ? 1 : magnitude >= 1 ? 4 : 8;
  return value.toFixed(decimals);
}

function pct(fraction: number): string {
  return `${(fraction * 100).toFixed(0)}%`;
}

function report(instId: string, momentum: number, verdict: RegimeVerdict): void {
  const mark = verdict.passed ? 'PASS' : 'fail';
  console.log(
    `  ${mark}  ${instId.replace('-USDT-SWAP', '').padEnd(10)} ` +
      `mom ${momentum >= 0 ? '+' : ''}${momentum.toFixed(2)} ATR  ` +
      `adx ${verdict.adx.toFixed(1)}  vol ${(verdict.realizedVol * 100).toFixed(2)}%  ` +
      `volTrend ${verdict.volumeTrend.toFixed(2)}x`,
  );
  for (const failure of verdict.failures) {
    console.log(`         - ${failure}`);
  }
}

main().catch((error: unknown) => {
  // Law 3: a scan that fails must be loud and must not print a partial picture
  // that reads like a complete one.
  console.error('SCAN FAILED:', error);
  process.exitCode = 1;
});
