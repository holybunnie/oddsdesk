/**
 * Live scan — runs E1 through E4 against the real venue and prints what the
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
  type RankedInstrument,
  type RegimeVerdict,
} from '../signal/scanner.js';
import { evaluateEntry } from '../signal/entry.js';

/** Enough history for ADX(14), which needs roughly 2x its period plus slack. */
const CANDLE_LIMIT = 120;

/** 4h history for the multi-timeframe conviction component. */
const HTF_CANDLE_LIMIT = 60;

/** A candidate that reached the regime gate, kept with the side it was ranked for. */
interface Assessed {
  readonly ranked: RankedInstrument;
  readonly direction: Direction;
  readonly rankIndex: number;
  readonly verdict: RegimeVerdict;
}

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

  const rankIndexOf = new Map(ranked.map((r, i) => [r.instId, i]));
  const assessed: Assessed[] = [];
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

  const assess = (candidate: RankedInstrument, direction: Direction): void => {
    const verdict = check(candidate.instId, direction);
    const rankIndex = rankIndexOf.get(candidate.instId);
    if (rankIndex === undefined) {
      throw new Error(`${candidate.instId} is an extreme but carries no rank`);
    }
    verdicts.push(verdict);
    assessed.push({ ranked: candidate, direction, rankIndex, verdict });
    report(candidate.instId, candidate.momentumScore, verdict);
  };

  console.log('LONG candidates (strongest momentum):');
  for (const candidate of extremes.longs) assess(candidate, 'long');

  console.log('\nSHORT candidates (weakest momentum):');
  for (const candidate of extremes.shorts) assess(candidate, 'short');

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

  if (!favourable) return;

  // E4 runs only on candidates that cleared E2. Evaluating the failures too
  // would print entries the engine would never take, which is exactly the
  // partial-picture-that-reads-as-complete this script must not produce.
  const eligible = assessed.filter((a) => a.verdict.passed);
  console.log(`\nE4 entry gate: ${eligible.length} candidates, conviction threshold ${config.signals.minConviction}\n`);

  const nowMs = Date.now();
  let accepted = 0;

  for (const item of eligible) {
    const candles1h = candlesByInstrument.get(item.ranked.instId);
    if (candles1h === undefined) throw new Error(`missing 1h candles for ${item.ranked.instId}`);

    const candles4h = confirmedOnly(
      await market.candles(item.ranked.instId, '4H', HTF_CANDLE_LIMIT),
    );

    const verdict = evaluateEntry(config, {
      ranked: item.ranked,
      direction: item.direction,
      candles1h,
      candles4h,
      volumeTrendValue: item.verdict.volumeTrend,
      universeSize: ranked.length,
      rankIndex: item.rankIndex,
      nowMs,
      // No cooldown state here: this script is stateless and holds no position
      // history. The live engine supplies it; a scan intentionally over-reports
      // rather than silently hiding a candidate it cannot reason about.
    });

    const symbol = item.ranked.instId.replace('-USDT-SWAP', '').padEnd(10);

    if (!verdict.accepted) {
      const score = verdict.rejection.conviction?.total;
      console.log(
        `  --    ${symbol} ${item.direction.padEnd(5)} ` +
          `conviction ${score === undefined ? 'n/a' : score.toFixed(1)}`,
      );
      for (const reason of verdict.rejection.reasons) console.log(`         - ${reason}`);
      continue;
    }

    accepted += 1;
    const c = verdict.candidate;
    console.log(
      `  ENTRY ${symbol} ${c.direction.padEnd(5)} conviction ${c.conviction.total.toFixed(1)}`,
    );
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
    `\n${accepted} entry signal(s) from ${eligible.length} eligible candidates. ` +
      `Target is ~${config.signals.targetTradesPerDay}/day across all scans.`,
  );
  if (accepted > config.signals.targetTradesPerDay) {
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
