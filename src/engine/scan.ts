/**
 * The scan pipeline — E1 through E4 against live market data, as a value.
 *
 * This exists so there is exactly ONE implementation of the scan ordering.
 * `scan.ts` printed it and the driver would have needed it again; two copies of
 * "rank, then gate on regime, then evaluate entries" is precisely the kind of
 * duplication that drifts, and the drift would be invisible — the script would
 * keep reporting what the engine no longer does, which is worse than having no
 * script at all.
 *
 * So this returns both the `ScanResult` the engine consumes and the diagnostics
 * the script prints. The script renders; it does not re-derive.
 *
 * Two things the pipeline must get right and nothing downstream can fix:
 *
 *   - **Open positions are priced even when they fall out of E1.** An
 *     instrument whose volume dries up drops out of the universe, but a
 *     position in it still has to be managed, and the engine refuses to manage
 *     a position it cannot price. Their market data is fetched explicitly.
 *   - **Cooldowns are passed into E4.** The script has none and over-reports by
 *     design; the engine holds them and must not.
 */

import type { Config } from '../config.js';
import { atr } from '../signal/indicators.js';
import { OkxMarketData, confirmedOnly, type Candle } from '../market/okx.js';
import { evaluateEntry, type EntryCandidate, type RejectedCandidate } from '../signal/entry.js';
import {
  assessRegime,
  rankByMomentum,
  regimeIsFavourable,
  selectUniverseWithRejections,
  takeExtremes,
  type UniverseRejection,
  type Direction,
  type RankedInstrument,
  type RegimeVerdict,
} from '../signal/scanner.js';
import type { FeedFreshness } from '../execution/guarded.js';
import type { ScanResult } from './loop.js';

/** Enough history for ADX(14), which needs roughly 2x its period plus slack. */
const CANDLE_LIMIT = 120;

/** 4h history for the multi-timeframe conviction component. */
const HTF_CANDLE_LIMIT = 60;

/**
 * Concurrency for market-data fetches. A universe scan hits HTTP 429
 * immediately without pacing, and the client's own gate is per-request, not
 * per-batch.
 */
const BATCH = 8;

export class ScanPipelineError extends Error {
  override readonly name = 'ScanPipelineError';
}

/** A candidate that reached the regime gate, kept with the side it was ranked for. */
export interface Assessed {
  readonly ranked: RankedInstrument;
  readonly direction: Direction;
  readonly rankIndex: number;
  readonly verdict: RegimeVerdict;
}

/** Everything the observability script needs to render, plus the engine's input. */
export interface ScanDiagnostics {
  readonly result: ScanResult;
  readonly liveUsdtPerps: number;
  readonly universeSize: number;
  readonly ranked: readonly RankedInstrument[];
  readonly assessed: readonly Assessed[];
  readonly rejected: readonly RejectedCandidate[];
  readonly regimePassing: number;
  readonly regimeConsidered: number;
  /**
   * Why each instrument failed E1.
   *
   * Reported because the reasons are not interchangeable. An instrument dropped
   * for volume can be recovered by loosening a threshold; one dropped for
   * minimum size cannot be recovered at all at this account size, and the count
   * of those is the honest measure of how much of the venue we can actually
   * reach. Breadth is the strategy's central assumption and this is the only
   * number that tests it.
   */
  readonly universeRejections: readonly UniverseRejection[];
}

export interface ScanOptions {
  readonly config: Config;
  readonly market: OkxMarketData;
  /**
   * Instruments that must be priced regardless of whether they pass E1 —
   * the engine's open positions. Omitting one makes the engine throw rather
   * than manage it blind, which is correct but avoidable here.
   */
  readonly mustPrice?: readonly string[];
  /** Cooldown expiry per instrument. The engine supplies it; the script does not. */
  readonly cooldowns?: ReadonlyMap<string, number>;
  readonly nowMs?: number;
}

export async function runScan(options: ScanOptions): Promise<ScanDiagnostics> {
  const { config, market } = options;
  const nowMs = options.nowMs ?? Date.now();
  const cooldowns = options.cooldowns ?? new Map<string, number>();

  const [instruments, tickers] = await Promise.all([market.instruments('SWAP'), market.tickers('SWAP')]);
  const liveUsdtPerps = instruments.filter(
    (i) => i.instId.endsWith('-USDT-SWAP') && i.state === 'live',
  ).length;

  const { members: universe, rejections } = selectUniverseWithRejections(config, instruments, tickers);

  // Open positions join the fetch list even when E1 rejected them. A position
  // whose instrument lost liquidity still has to be managed to the exit.
  const toFetch = new Set(universe.map((m) => m.instId));
  for (const instId of options.mustPrice ?? []) toFetch.add(instId);

  const candlesByInstrument = new Map<string, readonly Candle[]>();
  const fundingByInstrument = new Map<string, number>();
  const fetchList = [...toFetch];

  for (let i = 0; i < fetchList.length; i += BATCH) {
    await Promise.all(
      fetchList.slice(i, i + BATCH).map(async (instId) => {
        const [candles, funding] = await Promise.all([
          market.candles(instId, '1H', CANDLE_LIMIT),
          market.fundingRate(instId),
        ]);
        candlesByInstrument.set(instId, confirmedOnly(candles));
        fundingByInstrument.set(instId, funding);
      }),
    );
  }

  // Last price and ATR for EVERYTHING fetched, not just the candidates. The
  // engine needs these for open positions, and a candidate-only map is exactly
  // the gap that makes it throw.
  const lastPrices = new Map<string, number>();
  const atrByInstrument = new Map<string, number>();
  let oldestCandleMs = Number.POSITIVE_INFINITY;

  for (const [instId, candles] of candlesByInstrument) {
    const last = candles.at(-1);
    if (last === undefined) continue;
    lastPrices.set(instId, last.close);
    atrByInstrument.set(instId, atr(candles, config.ranking.atrPeriod));
    // The staleness gate wants the WORST feed, not the average: one instrument
    // stuck on an old bar is a stale feed even if the rest are current.
    oldestCandleMs = Math.min(oldestCandleMs, last.openTimeMs);
  }

  const feeds: readonly FeedFreshness[] = [
    {
      name: 'okx-1h-candles',
      // A confirmed 1h bar is up to an hour old by construction, so freshness is
      // measured from when the bar CLOSED, not when it opened. Measuring from
      // the open would make every healthy feed look an hour stale.
      lastUpdateMs: Number.isFinite(oldestCandleMs) ? oldestCandleMs + 3_600_000 : 0,
    },
  ];

  // Rank first, so the regime gate is evaluated against the side each
  // instrument is actually a candidate for.
  const universeCandles = new Map<string, readonly Candle[]>();
  for (const member of universe) {
    const candles = candlesByInstrument.get(member.instId);
    if (candles !== undefined && candles.length > 0) universeCandles.set(member.instId, candles);
  }

  const ranked = rankByMomentum(config, universeCandles);
  const extremes = takeExtremes(config, ranked);
  const rankIndexOf = new Map(ranked.map((r, i) => [r.instId, i]));

  const assessed: Assessed[] = [];
  const verdicts: RegimeVerdict[] = [];

  const assess = (candidate: RankedInstrument, direction: Direction): void => {
    const candles = candlesByInstrument.get(candidate.instId);
    const funding = fundingByInstrument.get(candidate.instId);
    const rankIndex = rankIndexOf.get(candidate.instId);
    if (candles === undefined || funding === undefined || rankIndex === undefined) {
      throw new ScanPipelineError(`${candidate.instId} is an extreme but carries no market data or rank`);
    }
    const verdict = assessRegime(config, candidate.instId, candles, funding, direction);
    verdicts.push(verdict);
    assessed.push({ ranked: candidate, direction, rankIndex, verdict });
  };

  for (const candidate of extremes.longs) assess(candidate, 'long');
  for (const candidate of extremes.shorts) assess(candidate, 'short');

  const regimePassing = verdicts.filter((v) => v.passed).length;
  const regimeFavourable = regimeIsFavourable(config, verdicts);

  const candidates: EntryCandidate[] = [];
  const rejected: RejectedCandidate[] = [];

  // E4 runs only on candidates that cleared E2. Evaluating the failures too
  // would produce entries the engine would never take.
  if (regimeFavourable) {
    const eligible = assessed.filter((a) => a.verdict.passed);

    for (let i = 0; i < eligible.length; i += BATCH) {
      await Promise.all(
        eligible.slice(i, i + BATCH).map(async (item) => {
          const candles1h = candlesByInstrument.get(item.ranked.instId);
          if (candles1h === undefined) {
            throw new ScanPipelineError(`missing 1h candles for ${item.ranked.instId}`);
          }
          const candles4h = confirmedOnly(await market.candles(item.ranked.instId, '4H', HTF_CANDLE_LIMIT));
          const cooldownUntilMs = cooldowns.get(item.ranked.instId);
          const fundingRate = fundingByInstrument.get(item.ranked.instId);
          if (fundingRate === undefined) {
            throw new ScanPipelineError(`no funding rate for ${item.ranked.instId} — cannot price carry`);
          }

          const verdict = evaluateEntry(config, {
            ranked: item.ranked,
            direction: item.direction,
            candles1h,
            candles4h,
            volumeTrendValue: item.verdict.volumeTrend,
            universeSize: ranked.length,
            rankIndex: item.rankIndex,
            fundingRate,
            nowMs,
            ...(cooldownUntilMs === undefined ? {} : { cooldownUntilMs }),
          });

          if (verdict.accepted) candidates.push(verdict.candidate);
          else rejected.push(verdict.rejection);
        }),
      );
    }
  }

  return {
    result: { candidates, regimeFavourable, lastPrices, atrByInstrument, feeds },
    liveUsdtPerps,
    universeSize: universe.length,
    ranked,
    assessed,
    rejected,
    regimePassing,
    regimeConsidered: verdicts.length,
    universeRejections: rejections,
  };
}
