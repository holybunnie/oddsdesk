/**
 * Binance USDⓈ-M public market data client.
 *
 * This client is deliberately limited to historical OHLCV.  It is a second
 * signal venue, never an execution venue: order prices, fills, instrument
 * specs, and funding costs remain sourced from OKX.
 */

import type { Candle } from './okx.js';

export class BinanceMarketDataError extends Error {
  override readonly name = 'BinanceMarketDataError';
}

export type BinanceInterval = '1h' | '4h';

export interface BinanceMarketDataOptions {
  readonly fetchImpl?: typeof fetch;
  readonly baseUrl?: string;
  readonly timeoutMs?: number;
  readonly minRequestIntervalMs?: number;
  readonly maxRetries?: number;
}

const BINANCE_BASE = 'https://fapi.binance.com';
const HOUR_MS = 3_600_000;

function numberField(value: unknown, field: string, context: string): number {
  if (typeof value !== 'string' && typeof value !== 'number') {
    throw new BinanceMarketDataError(`${context}: ${field} is not numeric`);
  }
  const result = Number(value);
  if (!Number.isFinite(result)) throw new BinanceMarketDataError(`${context}: ${field} is not finite`);
  return result;
}

function intervalMs(interval: BinanceInterval): number {
  return interval === '1h' ? HOUR_MS : 4 * HOUR_MS;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export class BinanceMarketData {
  readonly #fetch: typeof fetch;
  readonly #base: string;
  readonly #timeoutMs: number;
  readonly #minIntervalMs: number;
  readonly #maxRetries: number;
  #gate: Promise<void> = Promise.resolve();
  #lastRequestAt = 0;

  constructor(options: BinanceMarketDataOptions = {}) {
    this.#fetch = options.fetchImpl ?? fetch;
    this.#base = options.baseUrl ?? BINANCE_BASE;
    this.#timeoutMs = options.timeoutMs ?? 10_000;
    this.#minIntervalMs = options.minRequestIntervalMs ?? 100;
    this.#maxRetries = options.maxRetries ?? 4;
  }

  async #pace(): Promise<void> {
    const turn = this.#gate.then(async () => {
      const wait = this.#lastRequestAt + this.#minIntervalMs - Date.now();
      if (wait > 0) await sleep(wait);
      this.#lastRequestAt = Date.now();
    });
    this.#gate = turn;
    return turn;
  }

  async #getKlines(
    symbol: string,
    interval: BinanceInterval,
    startTimeMs: number,
    endTimeMs: number,
    limit: number,
  ): Promise<readonly unknown[]> {
    const url = new URL('/fapi/v1/klines', this.#base);
    url.searchParams.set('symbol', symbol);
    url.searchParams.set('interval', interval);
    url.searchParams.set('startTime', String(startTimeMs));
    url.searchParams.set('endTime', String(endTimeMs));
    url.searchParams.set('limit', String(limit));

    let lastError: unknown;
    for (let attempt = 0; attempt <= this.#maxRetries; attempt += 1) {
      await this.#pace();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
      try {
        const response = await this.#fetch(url.toString(), { signal: controller.signal });
        if (!response.ok) {
          const error = new BinanceMarketDataError(`request to ${url.pathname} returned HTTP ${response.status}`);
          if (response.status !== 429 && response.status < 500) throw error;
          lastError = error;
          if (attempt === this.#maxRetries) throw error;
          await sleep(250 * 2 ** attempt);
          continue;
        }
        const body: unknown = await response.json();
        if (!Array.isArray(body)) throw new BinanceMarketDataError('Binance kline response is not an array');
        return body;
      } catch (cause) {
        if (cause instanceof BinanceMarketDataError && !cause.message.includes('HTTP 429') && !cause.message.includes('HTTP 5')) {
          throw cause;
        }
        lastError = cause;
        if (attempt === this.#maxRetries) {
          throw new BinanceMarketDataError(`request to ${url.pathname} failed`, { cause });
        }
        await sleep(250 * 2 ** attempt);
      } finally {
        clearTimeout(timer);
      }
    }
    throw new BinanceMarketDataError(`request to /fapi/v1/klines failed`, { cause: lastError });
  }

  /**
   * Fetch oldest-first, de-duplicated Binance USDⓈ-M klines.
   * Binance's maximum page is 1,500 rows, so pagination is explicit.
   */
  async historyCandles(
    symbol: string,
    interval: BinanceInterval,
    fromMs: number,
    toMs: number,
    limit = 1500,
  ): Promise<readonly Candle[]> {
    if (!/^[A-Z0-9]+$/.test(symbol) || symbol.length < 5) {
      throw new BinanceMarketDataError(`invalid Binance symbol ${symbol}`);
    }
    if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || fromMs > toMs) {
      throw new BinanceMarketDataError(`invalid candle history range ${fromMs}..${toMs}`);
    }
    const pageSize = Math.min(Math.max(Math.trunc(limit), 1), 1500);
    const step = intervalMs(interval);
    const rows: unknown[] = [];
    const seen = new Set<number>();
    let cursor = fromMs;

    for (;;) {
      const page = await this.#getKlines(symbol, interval, cursor, toMs, pageSize);
      if (page.length === 0) break;
      let newestOpen = cursor - step;
      for (const raw of page) {
        if (!Array.isArray(raw) || raw.length < 8) {
          throw new BinanceMarketDataError(`invalid kline row for ${symbol}`);
        }
        const openTimeMs = numberField(raw[0], 'openTime', `kline ${symbol}`);
        const closeTimeMs = numberField(raw[6], 'closeTime', `kline ${symbol}`);
        newestOpen = Math.max(newestOpen, openTimeMs);
        if (openTimeMs < fromMs || openTimeMs > toMs || seen.has(openTimeMs)) continue;
        seen.add(openTimeMs);
        rows.push({
          openTimeMs,
          open: numberField(raw[1], 'open', `kline ${symbol}`),
          high: numberField(raw[2], 'high', `kline ${symbol}`),
          low: numberField(raw[3], 'low', `kline ${symbol}`),
          close: numberField(raw[4], 'close', `kline ${symbol}`),
          volume: numberField(raw[5], 'volume', `kline ${symbol}`),
          quoteVolume: numberField(raw[7], 'quoteVolume', `kline ${symbol}`),
          confirmed: closeTimeMs < Date.now(),
        } satisfies Candle);
      }
      if (page.length < pageSize || newestOpen >= toMs) break;
      const nextCursor = newestOpen + step;
      if (nextCursor <= cursor) throw new BinanceMarketDataError(`kline pagination did not advance for ${symbol}`);
      cursor = nextCursor;
    }

    return rows
      .sort((a, b) => (a as { openTimeMs: number }).openTimeMs - (b as { openTimeMs: number }).openTimeMs) as Candle[];
  }
}

