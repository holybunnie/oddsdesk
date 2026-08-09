/**
 * OKX public market data client.
 *
 * Public endpoints only — no credentials, no signing. Order placement lives
 * behind the execution adapter; this module is read-only by construction so a
 * bug here can move no money.
 *
 * Law 3 shapes every method: a malformed response throws rather than returning
 * a partial structure. A candle array with a missing close, or a ticker with an
 * unparseable volume, is a data-integrity failure — silently coercing it to 0
 * would put a fabricated price into the regime gate and the sizing maths.
 */

export class MarketDataError extends Error {
  override readonly name = 'MarketDataError';
}

export interface Candle {
  readonly openTimeMs: number;
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
  /** Base-currency volume for the bar. */
  readonly volume: number;
  /** Quote-currency (USDT) volume for the bar. */
  readonly quoteVolume: number;
  /**
   * Whether the bar has closed. OKX returns the in-progress bar as confirm=0.
   * Signals must never be computed on an unconfirmed bar — it repaints.
   */
  readonly confirmed: boolean;
}

export interface InstrumentSpec {
  readonly instId: string;
  /** Contract value in base currency — size is in contracts, not coins. */
  readonly contractValue: number;
  readonly lotSize: number;
  readonly minSize: number;
  readonly tickSize: number;
  readonly state: string;
  /** Venue-reported leverage ceiling for this instrument, when exposed. */
  readonly maxLeverage?: number;
}

export interface TickerSnapshot {
  readonly instId: string;
  readonly last: number;
  readonly bid: number;
  readonly ask: number;
  /** 24h volume in quote currency (USDT). */
  readonly quoteVolume24h: number;
}

/** Bar sizes used by the engines. OKX spells these exactly. */
export type Bar = '1H' | '4H' | '1D';

const OKX_BASE = 'https://www.okx.com';

interface OkxEnvelope {
  code: string;
  msg: string;
  data: unknown;
}

/**
 * Parse a numeric field that must be present and finite.
 *
 * Deliberately strict: OKX returns numbers as strings, and an empty string
 * coerced by Number() becomes 0. A price or volume of 0 read as real would
 * corrupt every downstream calculation, so absence is an error, not a zero.
 */
function num(value: unknown, field: string, context: string): number {
  if (typeof value !== 'string' && typeof value !== 'number') {
    throw new MarketDataError(`${context}: field "${field}" is ${typeof value}, expected string or number`);
  }
  if (value === '') {
    throw new MarketDataError(`${context}: field "${field}" is empty`);
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new MarketDataError(`${context}: field "${field}" is not finite (got ${String(value)})`);
  }
  return parsed;
}

function str(value: unknown, field: string, context: string): string {
  if (typeof value !== 'string' || value === '') {
    throw new MarketDataError(`${context}: field "${field}" is missing or not a string`);
  }
  return value;
}

export interface OkxMarketDataOptions {
  /** Injected so tests and the daemon can share one implementation. */
  readonly fetchImpl?: typeof fetch;
  readonly baseUrl?: string;
  readonly timeoutMs?: number;
  /**
   * Minimum spacing between requests. OKX rate-limits per endpoint and returns
   * HTTP 429; a universe scan of ~90 instruments will hit that immediately
   * without pacing.
   */
  readonly minRequestIntervalMs?: number;
  readonly maxRetries?: number;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export interface FundingPoint {
  readonly timestampMs: number;
  /** Signed as OKX reports it: positive means longs pay shorts. */
  readonly fundingRate: number;
}

export class OkxMarketData {
  readonly #fetch: typeof fetch;
  readonly #base: string;
  readonly #timeoutMs: number;
  readonly #minIntervalMs: number;
  readonly #maxRetries: number;
  /** Serialises pacing across concurrent callers. */
  #gate: Promise<void> = Promise.resolve();
  #lastRequestAt = 0;

  constructor(options: OkxMarketDataOptions = {}) {
    this.#fetch = options.fetchImpl ?? fetch;
    this.#base = options.baseUrl ?? OKX_BASE;
    this.#timeoutMs = options.timeoutMs ?? 10_000;
    // OKX documents a 20-request/2-second limit for historical candles. A
    // 120ms floor stays below that limit even when several callers queue at
    // once; the old 60ms default could burst at ~16.7 requests/sec.
    this.#minIntervalMs = options.minRequestIntervalMs ?? 120;
    this.#maxRetries = options.maxRetries ?? 4;
  }

  /**
   * Wait for this request's turn.
   *
   * Chained through a single promise so that N concurrent callers queue behind
   * each other rather than all reading the same "last request" timestamp and
   * firing together — which is exactly how a naive limiter still gets a 429.
   */
  async #pace(): Promise<void> {
    const turn = this.#gate.then(async () => {
      const wait = this.#lastRequestAt + this.#minIntervalMs - Date.now();
      if (wait > 0) await sleep(wait);
      this.#lastRequestAt = Date.now();
    });
    this.#gate = turn;
    return turn;
  }

  async #get(path: string, params: Readonly<Record<string, string>>): Promise<unknown[]> {
    let lastError: unknown;

    for (let attempt = 0; attempt <= this.#maxRetries; attempt += 1) {
      await this.#pace();
      try {
        return await this.#getOnce(path, params);
      } catch (error) {
        lastError = error;
        const retryable =
          error instanceof MarketDataError &&
          (error.message.includes('HTTP 429') || error.message.includes('HTTP 5'));
        if (!retryable || attempt === this.#maxRetries) throw error;

        // Exponential backoff. Rate limits are transient by definition, but a
        // retry loop that never gives up would mask a genuine outage.
        await sleep(250 * 2 ** attempt);
      }
    }

    throw lastError;
  }

  async #getOnce(path: string, params: Readonly<Record<string, string>>): Promise<unknown[]> {
    const url = new URL(path, this.#base);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);

    let response: Response;
    try {
      response = await this.#fetch(url.toString(), { signal: controller.signal });
    } catch (cause) {
      throw new MarketDataError(`request to ${url.pathname} failed`, { cause });
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      throw new MarketDataError(`request to ${url.pathname} returned HTTP ${response.status}`);
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch (cause) {
      throw new MarketDataError(`response from ${url.pathname} is not JSON`, { cause });
    }

    const envelope = body as OkxEnvelope;
    // OKX signals application errors with code "0" for success. A non-zero code
    // arrives with HTTP 200, so checking response.ok alone would sail past it.
    if (envelope.code !== '0') {
      throw new MarketDataError(
        `OKX returned code ${envelope.code} for ${url.pathname}: ${envelope.msg || '(no message)'}`,
      );
    }
    if (!Array.isArray(envelope.data)) {
      throw new MarketDataError(`OKX response for ${url.pathname} has no data array`);
    }

    return envelope.data;
  }

  /** All instruments of a type. Used to discover the tradable universe. */
  async instruments(instType: 'SWAP'): Promise<readonly InstrumentSpec[]> {
    const rows = await this.#get('/api/v5/public/instruments', { instType });

    const specs: InstrumentSpec[] = [];

    for (const raw of rows) {
      const row = raw as Record<string, unknown>;
      const instId = str(row['instId'], 'instId', 'instrument');
      const context = `instrument ${instId}`;
      const state = str(row['state'], 'state', context);

      // Instruments the venue has announced but not opened (state "preopen")
      // legitimately carry empty specs. They are not tradable, so skipping them
      // loses nothing — whereas throwing would let one unlaunched listing
      // abort discovery of the entire universe.
      //
      // The strictness stays where it matters: a LIVE instrument with a missing
      // contract value or tick size is a genuine data-integrity failure and
      // still throws, because sizing and rounding depend on those fields.
      if (state !== 'live') continue;

      const rawLeverage = row['lever'];
      const maxLeverage = rawLeverage === undefined || rawLeverage === ''
        ? undefined
        : num(rawLeverage, 'lever', context);
      if (maxLeverage !== undefined && maxLeverage <= 0) {
        throw new MarketDataError(`${context}: leverage ceiling must be positive, got ${maxLeverage}`);
      }

      specs.push({
        instId,
        contractValue: num(row['ctVal'], 'ctVal', context),
        lotSize: num(row['lotSz'], 'lotSz', context),
        minSize: num(row['minSz'], 'minSz', context),
        tickSize: num(row['tickSz'], 'tickSz', context),
        state,
        ...(maxLeverage === undefined ? {} : { maxLeverage }),
      });
    }

    return specs;
  }

  /** Live tickers for every instrument of a type. One request, whole universe. */
  async tickers(instType: 'SWAP'): Promise<readonly TickerSnapshot[]> {
    const rows = await this.#get('/api/v5/market/tickers', { instType });

    return rows.map((raw) => {
      const row = raw as Record<string, unknown>;
      const instId = str(row['instId'], 'instId', 'ticker');
      const context = `ticker ${instId}`;
      return {
        instId,
        last: num(row['last'], 'last', context),
        bid: num(row['bidPx'], 'bidPx', context),
        ask: num(row['askPx'], 'askPx', context),
        quoteVolume24h: num(row['volCcy24h'], 'volCcy24h', context),
      };
    });
  }

  /**
   * Current funding rate for one instrument.
   *
   * Positive means longs pay shorts. E2 tests this directionally: funding
   * against the intended side is both a carrying cost and a crowding signal.
   */
  async fundingRate(instId: string): Promise<number> {
    const rows = await this.#get('/api/v5/public/funding-rate', { instId });
    const row = rows[0] as Record<string, unknown> | undefined;
    if (row === undefined) {
      throw new MarketDataError(`no funding rate returned for ${instId}`);
    }
    return num(row['fundingRate'], 'fundingRate', `funding ${instId}`);
  }

  /**
   * Historical funding rates, oldest first.
   *
   * The endpoint returns newest first and uses `after` as the cursor for older
   * funding timestamps. Keeping this pagination here means a recorder cannot
   * accidentally backtest with the current rate repeated over 90 days.
   */
  async fundingRateHistory(
    instId: string,
    fromMs: number,
    toMs: number,
    limit = 400,
  ): Promise<readonly FundingPoint[]> {
    if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || fromMs > toMs) {
      throw new MarketDataError(`invalid funding history range ${fromMs}..${toMs} for ${instId}`);
    }

    const rows: unknown[] = [];
    let after: number | undefined;
    const pageSize = Math.min(Math.max(Math.trunc(limit), 1), 400);

    for (;;) {
      const page = await this.#get('/api/v5/public/funding-rate-history', {
        instId,
        limit: String(pageSize),
        ...(after === undefined ? {} : { after: String(after) }),
      });
      if (page.length === 0) break;
      rows.push(...page);

      const last = page.at(-1) as Record<string, unknown> | undefined;
      if (last === undefined) break;
      const oldest = num(last['fundingTime'], 'fundingTime', `funding history ${instId}`);
      if (oldest <= fromMs || page.length < pageSize) break;
      if (after !== undefined && oldest >= after) {
        throw new MarketDataError(`funding history pagination did not move backward for ${instId}`);
      }
      after = oldest;
    }

    return rows
      .map((raw) => {
        const row = raw as Record<string, unknown>;
        const timestampMs = num(row['fundingTime'], 'fundingTime', `funding history ${instId}`);
        return {
          timestampMs,
          fundingRate: num(row['fundingRate'], 'fundingRate', `funding history ${instId}`),
        } satisfies FundingPoint;
      })
      .filter((point) => point.timestampMs >= fromMs && point.timestampMs <= toMs)
      .sort((a, b) => a.timestampMs - b.timestampMs);
  }

  /**
   * Candles, oldest first.
   *
   * OKX returns newest first; this reverses so indicator code reads
   * chronologically, which is the direction every textbook formula assumes and
   * a very easy thing to get silently backwards.
   */
  async candles(instId: string, bar: Bar, limit = 200): Promise<readonly Candle[]> {
    const rows = await this.#get('/api/v5/market/candles', {
      instId,
      bar,
      limit: String(limit),
    });

    const candles = this.#parseCandles(instId, rows);

    return candles.reverse();
  }

  /**
   * Historical candles, oldest first, with explicit inclusive bounds.
   *
   * History is paged from newest to oldest. The caller gets a de-duplicated,
   * chronologically ordered series suitable for recording and replay.
   */
  async historyCandles(
    instId: string,
    bar: Bar,
    fromMs: number,
    toMs: number,
    limit = 300,
  ): Promise<readonly Candle[]> {
    if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || fromMs > toMs) {
      throw new MarketDataError(`invalid candle history range ${fromMs}..${toMs} for ${instId}`);
    }

    const rows: unknown[] = [];
    let after: number | undefined;
    const pageSize = Math.min(Math.max(Math.trunc(limit), 1), 300);

    for (;;) {
      const page = await this.#get('/api/v5/market/history-candles', {
        instId,
        bar,
        limit: String(pageSize),
        ...(after === undefined ? {} : { after: String(after) }),
      });
      if (page.length === 0) break;
      rows.push(...page);

      const last = page.at(-1);
      if (!Array.isArray(last)) throw new MarketDataError(`candle for ${instId} is not an array`);
      const oldest = num(last[0], 'ts', `candle history ${instId}`);
      if (oldest <= fromMs || page.length < pageSize) break;
      if (after !== undefined && oldest >= after) {
        throw new MarketDataError(`candle history pagination did not move backward for ${instId}`);
      }
      after = oldest;
    }

    const seen = new Set<number>();
    return this.#parseCandles(instId, rows)
      .filter((candle) => candle.openTimeMs >= fromMs && candle.openTimeMs <= toMs)
      .filter((candle) => {
        if (seen.has(candle.openTimeMs)) return false;
        seen.add(candle.openTimeMs);
        return true;
      })
      .sort((a, b) => a.openTimeMs - b.openTimeMs);
  }

  #parseCandles(instId: string, rows: readonly unknown[]): Candle[] {
    return rows.map((raw) => {
      if (!Array.isArray(raw)) {
        throw new MarketDataError(`candle for ${instId} is not an array`);
      }
      const context = `candle ${instId}`;
      return {
        openTimeMs: num(raw[0], 'ts', context),
        open: num(raw[1], 'open', context),
        high: num(raw[2], 'high', context),
        low: num(raw[3], 'low', context),
        close: num(raw[4], 'close', context),
        volume: num(raw[5], 'vol', context),
        quoteVolume: num(raw[7], 'volCcyQuote', context),
        confirmed: num(raw[8], 'confirm', context) === 1,
      } satisfies Candle;
    });
  }
}

/**
 * Drop the in-progress bar.
 *
 * An unconfirmed candle repaints until its interval closes, so a breakout
 * computed on it can un-happen. Every engine calls this before indicators.
 */
export function confirmedOnly(candles: readonly Candle[]): readonly Candle[] {
  return candles.filter((c) => c.confirmed);
}
