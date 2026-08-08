/**
 * E1-E3 — universe, regime gate, cross-sectional ranking.
 *
 * The order matters and is not arbitrary:
 *
 *   E1 narrows 423 listed perps to those actually tradable at this size
 *   E2 rejects instruments in chop BEFORE any ranking happens
 *   E3 ranks only survivors, and trades only the extremes
 *
 * E2 runs before E3 deliberately. Ranking first and filtering second would rank
 * chop against trend and hand back the best-looking bad instrument — capital is
 * destroyed by failed attempts in chop, not by the one big loser.
 */

import type { Config } from '../config.js';
import type { Candle, InstrumentSpec, TickerSnapshot } from '../market/okx.js';
import { adx, atr, normalisedMomentum, realizedVolatility, volumeTrend } from './indicators.js';

export type Direction = 'long' | 'short';

export interface UniverseMember {
  readonly instId: string;
  readonly spec: InstrumentSpec;
  readonly ticker: TickerSnapshot;
  readonly spreadBps: number;
}

export interface RegimeVerdict {
  readonly instId: string;
  readonly passed: boolean;
  /** Every reason it failed. Plural because the daily report wants all of them. */
  readonly failures: readonly string[];
  readonly adx: number;
  readonly realizedVol: number;
  readonly volumeTrend: number;
}

export interface RankedInstrument {
  readonly instId: string;
  /** Mean of the per-lookback ATR-normalised momentum values. */
  readonly momentumScore: number;
  readonly perLookback: Readonly<Record<number, number>>;
  readonly adx: number;
  readonly atr: number;
  readonly lastClose: number;
}

export class ScannerError extends Error {
  override readonly name = 'ScannerError';
}

/** Base symbol of a USDT perp, e.g. "BTC-USDT-SWAP" -> "BTC". */
export function baseSymbol(instId: string): string {
  const [base] = instId.split('-');
  if (base === undefined || base === '') {
    throw new ScannerError(`cannot derive a base symbol from "${instId}"`);
  }
  return base;
}

/**
 * E1 — the tradable universe.
 *
 * Filters on liquidity actually observed right now, not on a list frozen into
 * an API key. Breadth is the strategy: a single-market trend follower has poor
 * odds and a fifty-market one has good odds, so these thresholds should admit
 * tens of instruments.
 */
export function selectUniverse(
  config: Config,
  instruments: readonly InstrumentSpec[],
  tickers: readonly TickerSnapshot[],
): readonly UniverseMember[] {
  const excluded = new Set(config.universe.excludeSymbols);
  const tickerById = new Map(tickers.map((t) => [t.instId, t]));

  const members: UniverseMember[] = [];

  for (const spec of instruments) {
    if (!spec.instId.endsWith('-USDT-SWAP')) continue;
    if (spec.state !== 'live') continue;
    if (excluded.has(baseSymbol(spec.instId))) continue;

    const ticker = tickerById.get(spec.instId);
    // No ticker means no live two-sided market. Skipping is correct; defaulting
    // the spread to zero would admit an instrument we cannot price.
    if (ticker === undefined) continue;

    if (ticker.quoteVolume24h < config.universe.minQuoteVolume24hUsdt) continue;

    if (ticker.bid <= 0 || ticker.ask <= 0 || ticker.ask < ticker.bid) continue;
    const mid = (ticker.bid + ticker.ask) / 2;
    const spreadBps = ((ticker.ask - ticker.bid) / mid) * 10_000;
    if (spreadBps > config.universe.maxSpreadBps) continue;

    members.push({ instId: spec.instId, spec, ticker, spreadBps });
  }

  return members;
}

/**
 * E2 — the regime gate, per instrument.
 *
 * `fundingRate` is the current rate for this instrument; `direction` is the
 * side being considered. Funding working against the intended direction is both
 * a carrying cost and a crowding signal, so it is tested directionally rather
 * than as an absolute magnitude.
 */
export function assessRegime(
  config: Config,
  instId: string,
  candles1h: readonly Candle[],
  fundingRate: number,
  direction: Direction,
): RegimeVerdict {
  const { regime } = config;
  const failures: string[] = [];

  const adxValue = adx(candles1h, regime.adxPeriod);
  if (adxValue < regime.minAdx) {
    failures.push(`ADX ${adxValue.toFixed(1)} below ${regime.minAdx}`);
  }

  const vol = realizedVolatility(candles1h, regime.volLookback);
  if (vol < regime.minRealizedVol) {
    failures.push(`realized vol ${vol.toFixed(4)} below ${regime.minRealizedVol} — no follow-through`);
  }
  if (vol > regime.maxRealizedVol) {
    failures.push(`realized vol ${vol.toFixed(4)} above ${regime.maxRealizedVol} — stops get wicked`);
  }

  const volTrend = volumeTrend(candles1h, regime.volumeWindow);
  if (volTrend < regime.minVolumeTrend) {
    failures.push(`volume contracting (${volTrend.toFixed(2)}x) — classic false break`);
  }

  // Positive funding is paid by longs, negative by shorts.
  const adverseFunding = direction === 'long' ? fundingRate : -fundingRate;
  if (adverseFunding > regime.maxAdverseFundingRate) {
    failures.push(
      `funding ${(adverseFunding * 100).toFixed(4)}% against the ${direction} — carrying cost and crowding`,
    );
  }

  return {
    instId,
    passed: failures.length === 0,
    failures,
    adx: adxValue,
    realizedVol: vol,
    volumeTrend: volTrend,
  };
}

/**
 * Portfolio-level gate.
 *
 * If too few instruments pass, the regime is unfavourable and the agent stands
 * down. Standing down is a valid output — the models that kept trading through
 * the reference competition's chop finished at -56% and -62%.
 */
export function regimeIsFavourable(config: Config, verdicts: readonly RegimeVerdict[]): boolean {
  const passing = verdicts.filter((v) => v.passed).length;
  return passing >= config.signals.minInstrumentsPassingRegime;
}

/**
 * E3 — cross-sectional ranking by volatility-adjusted momentum.
 *
 * Multiple lookbacks are averaged so no single bar dominates, and each is
 * normalised by ATR so instruments of different volatility are comparable.
 */
export function rankByMomentum(
  config: Config,
  candlesByInstrument: ReadonlyMap<string, readonly Candle[]>,
): readonly RankedInstrument[] {
  const { lookbacksHours, atrPeriod } = config.ranking;
  const ranked: RankedInstrument[] = [];

  for (const [instId, candles] of candlesByInstrument) {
    const perLookback: Record<number, number> = {};
    for (const lookback of lookbacksHours) {
      perLookback[lookback] = normalisedMomentum(candles, lookback, atrPeriod);
    }

    const values = lookbacksHours.map((l) => perLookback[l] ?? 0);
    const momentumScore = values.reduce((a, b) => a + b, 0) / values.length;

    const last = candles[candles.length - 1];
    if (last === undefined) {
      throw new ScannerError(`no candles for ${instId}`);
    }

    ranked.push({
      instId,
      momentumScore,
      perLookback,
      adx: adx(candles, config.regime.adxPeriod),
      atr: atr(candles, atrPeriod),
      lastClose: last.close,
    });
  }

  // Strongest first. Longs come from the head, shorts from the tail.
  return ranked.sort((a, b) => b.momentumScore - a.momentumScore);
}

export interface Extremes {
  readonly longs: readonly RankedInstrument[];
  readonly shorts: readonly RankedInstrument[];
}

/**
 * Take only the extremes of the ranking.
 *
 * A decile of a 40-instrument universe is 4 candidates per side, which then
 * face the conviction gate and the position caps. The middle of the
 * distribution is not a weak signal, it is no signal.
 */
export function takeExtremes(config: Config, ranked: readonly RankedInstrument[]): Extremes {
  if (ranked.length === 0) return { longs: [], shorts: [] };

  const count = Math.max(1, Math.floor(ranked.length * config.ranking.decileFraction));

  const longs = ranked.slice(0, count);
  const shorts = [...ranked].reverse().slice(0, count);

  // Guard the degenerate case: in a tiny universe the head and tail can
  // overlap, which would produce a simultaneous long and short on one
  // instrument. Prefer taking nothing over taking both sides.
  const longIds = new Set(longs.map((r) => r.instId));
  const disjointShorts = shorts.filter((r) => !longIds.has(r.instId));

  return { longs, shorts: disjointShorts };
}
