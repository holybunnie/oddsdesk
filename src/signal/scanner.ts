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
  /** USDT notional of one minimum-size order, at the current price. */
  readonly minNotionalUsdt: number;
}

/** Why an instrument was rejected by E1, for the scan report. */
export interface UniverseRejection {
  readonly instId: string;
  readonly reason: 'excluded' | 'no_ticker' | 'volume' | 'spread' | 'min_size';
  readonly detail: string;
}

/**
 * Notional of the smallest order the venue will accept on an instrument.
 *
 * `minSize` is in CONTRACTS, and one contract is `contractValue` of the base
 * asset — on BTC-USDT-SWAP that multiplier is 0.01, so reading minSize as coins
 * would misjudge the minimum by a hundredfold in the direction that admits an
 * instrument we cannot afford.
 */
export function minOrderNotionalUsdt(spec: InstrumentSpec, price: number): number {
  return spec.minSize * spec.contractValue * price;
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
  return selectUniverseWithRejections(config, instruments, tickers).members;
}

/**
 * E1 with its rejections retained.
 *
 * The counts matter as much as the survivors. Breadth is the strategy's central
 * assumption, and an instrument dropped for minimum size is a very different
 * fact about the venue than one dropped for volume — the first says our capital
 * cannot reach it at any threshold we might tune, and no amount of loosening the
 * volume filter will bring it back.
 */
export function selectUniverseWithRejections(
  config: Config,
  instruments: readonly InstrumentSpec[],
  tickers: readonly TickerSnapshot[],
): { members: readonly UniverseMember[]; rejections: readonly UniverseRejection[] } {
  const excluded = new Set(config.universe.excludeSymbols);
  const tickerById = new Map(tickers.map((t) => [t.instId, t]));

  const members: UniverseMember[] = [];
  const rejections: UniverseRejection[] = [];
  const reject = (instId: string, reason: UniverseRejection['reason'], detail: string): void => {
    rejections.push({ instId, reason, detail });
  };

  for (const spec of instruments) {
    if (!spec.instId.endsWith('-USDT-SWAP')) continue;
    if (spec.state !== 'live') continue;
    if (excluded.has(baseSymbol(spec.instId))) {
      reject(spec.instId, 'excluded', 'on the explicit exclusion list');
      continue;
    }

    const ticker = tickerById.get(spec.instId);
    // No ticker means no live two-sided market. Skipping is correct; defaulting
    // the spread to zero would admit an instrument we cannot price.
    if (ticker === undefined) {
      reject(spec.instId, 'no_ticker', 'no ticker, so no live two-sided market');
      continue;
    }

    if (ticker.quoteVolume24h < config.universe.minQuoteVolume24hUsdt) {
      reject(spec.instId, 'volume', `24h quote volume ${ticker.quoteVolume24h.toFixed(0)} USDT`);
      continue;
    }

    if (ticker.bid <= 0 || ticker.ask <= 0 || ticker.ask < ticker.bid) {
      reject(spec.instId, 'spread', 'crossed or empty book');
      continue;
    }
    const mid = (ticker.bid + ticker.ask) / 2;
    const spreadBps = ((ticker.ask - ticker.bid) / mid) * 10_000;
    if (spreadBps > config.universe.maxSpreadBps) {
      reject(spec.instId, 'spread', `${spreadBps.toFixed(2)} bps`);
      continue;
    }

    // Affordability. An instrument whose minimum order exceeds the smallest
    // notional we would place is not breadth — it is a venue rejection waiting
    // to happen, and because the signal is journalled before submission that
    // rejection is never retried. It would show up in the scan as a candidate
    // and never once as a position.
    const minNotionalUsdt = minOrderNotionalUsdt(spec, mid);
    if (minNotionalUsdt > config.universe.minTradableNotionalUsdt) {
      reject(
        spec.instId,
        'min_size',
        `minimum order is ${minNotionalUsdt.toFixed(2)} USDT, over the ` +
          `${config.universe.minTradableNotionalUsdt} USDT we would place`,
      );
      continue;
    }

    members.push({ instId: spec.instId, spec, ticker, spreadBps, minNotionalUsdt });
  }

  return { members, rejections };
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
