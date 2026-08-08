/**
 * Live scan — runs E1 through E3 against the real venue and prints what the
 * signal engine currently sees.
 *
 * This is the observability tool for the daily procedure and the acceptance
 * test for the scanner: "ranking reproducible from recorded data" means being
 * able to run this and read the same numbers the engine acted on.
 *
 * Read-only. It places no orders and needs no credentials.
 */

import { loadConfig } from '../config.js';
import { OkxMarketData, confirmedOnly, type Candle } from '../market/okx.js';
import {
  assessRegime,
  rankByMomentum,
  regimeIsFavourable,
  selectUniverse,
  takeExtremes,
  type Direction,
  type RegimeVerdict,
} from '../signal/scanner.js';

/** Enough history for ADX(14), which needs roughly 2x its period plus slack. */
const CANDLE_LIMIT = 120;

async function main(): Promise<void> {
  const config = loadConfig('config/default.yaml');
  const market = new OkxMarketData();

  const [instruments, tickers] = await Promise.all([market.instruments('SWAP'), market.tickers('SWAP')]);

  const universe = selectUniverse(config, instruments, tickers);
  console.log(`E1 universe: ${universe.length} instruments`);
  console.log(
    `   from ${instruments.filter((i) => i.instId.endsWith('-USDT-SWAP') && i.state === 'live').length} live USDT perps`,
  );
  console.log(
    `   filters: >= $${(config.universe.minQuoteVolume24hUsdt / 1e6).toFixed(0)}M 24h volume, ` +
      `spread <= ${config.universe.maxSpreadBps}bps`,
  );

  if (universe.length === 0) {
    console.log('\nNo instruments passed E1. Nothing to rank.');
    return;
  }

  // Fetch candles and funding concurrently, but in bounded batches so a
  // 400-instrument universe cannot open 400 sockets at once.
  const candlesByInstrument = new Map<string, readonly Candle[]>();
  const fundingByInstrument = new Map<string, number>();
  const BATCH = 8;

  for (let i = 0; i < universe.length; i += BATCH) {
    const batch = universe.slice(i, i + BATCH);
    await Promise.all(
      batch.map(async (member) => {
        const [candles, funding] = await Promise.all([
          market.candles(member.instId, '1H', CANDLE_LIMIT),
          market.fundingRate(member.instId),
        ]);
        const closed = confirmedOnly(candles);
        candlesByInstrument.set(member.instId, closed);
        fundingByInstrument.set(member.instId, funding);
      }),
    );
  }

  // Rank first so the regime gate can be evaluated against the side each
  // instrument is actually a candidate for.
  const ranked = rankByMomentum(config, candlesByInstrument);
  const extremes = takeExtremes(config, ranked);

  const verdicts: RegimeVerdict[] = [];
  const check = (instId: string, direction: Direction): RegimeVerdict => {
    const candles = candlesByInstrument.get(instId);
    const funding = fundingByInstrument.get(instId);
    if (candles === undefined || funding === undefined) {
      throw new Error(`missing market data for ${instId}`);
    }
    return assessRegime(config, instId, candles, funding, direction);
  };

  console.log(`\nE3 ranking: ${ranked.length} instruments by ATR-normalised momentum`);
  console.log(`   taking the top and bottom ${(config.ranking.decileFraction * 100).toFixed(0)}%\n`);

  console.log('LONG candidates (strongest momentum):');
  for (const candidate of extremes.longs) {
    const verdict = check(candidate.instId, 'long');
    verdicts.push(verdict);
    report(candidate.instId, candidate.momentumScore, verdict);
  }

  console.log('\nSHORT candidates (weakest momentum):');
  for (const candidate of extremes.shorts) {
    const verdict = check(candidate.instId, 'short');
    verdicts.push(verdict);
    report(candidate.instId, candidate.momentumScore, verdict);
  }

  const passing = verdicts.filter((v) => v.passed).length;
  const favourable = regimeIsFavourable(config, verdicts);

  console.log(
    `\nE2 regime: ${passing}/${verdicts.length} candidates pass ` +
      `(need ${config.signals.minInstrumentsPassingRegime})`,
  );
  console.log(
    favourable
      ? 'REGIME FAVOURABLE — the engine would look for entries among the passing candidates.'
      : 'REGIME UNFAVOURABLE — the engine stands down. Standing down is a valid output.',
  );
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
