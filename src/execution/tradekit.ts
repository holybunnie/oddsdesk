/**
 * Route B execution adapter — OKX Agent Trade Kit, USDT perpetuals, over the
 * `okx` CLI.
 *
 * Everything here is shaped by facts measured from the CLI on 2026-08-09, not
 * from its documentation:
 *
 *   - With `--json`, stdout is the bare `data` payload (usually an array) and
 *     nothing else. The "Update available" banner goes to stderr, so it cannot
 *     corrupt a parse.
 *   - On failure the CLI exits non-zero, writes the OKX error and code to
 *     stderr, and leaves stdout EMPTY. So exit code is the error signal; an
 *     empty stdout with exit 0 would be a different, unexpected condition.
 *   - Sizes for SWAP are in CONTRACTS, not coins. BTC-USDT-SWAP has
 *     ctVal 0.01 BTC, lotSz 0.01, minSz 0.01.
 *   - `tickSz` and `lotSz` give the decimal scales; they are read per
 *     instrument, never assumed.
 *
 * Two refusals are structural rather than advisory:
 *
 *   1. `submitOrder` throws while stop custody is `unverified`. The Part IX
 *      kill test has not been run, so whether a stop survives process death is
 *      unknown, and Law 2 says a plausible answer is worse than none. `flatten`
 *      deliberately still works — closing risk must outlive every other gate.
 *   2. A routeB order with no stop is refused here as well as in
 *      GuardedExecutor. The duplicate check is intentional: this is the last
 *      place before the venue, and H2 admits no stopless entry.
 */

import { execFile } from 'node:child_process';
import {
  ExecutionError,
  NotVerifiedError,
  type ExecutionAdapter,
  type Instrument,
  type OrderRequest,
  type OrderResult,
  type Position,
  type RouteId,
  type VenueProfile,
} from './adapter.js';

const VENUE = 'okx-tradekit';

/**
 * Internal scale for quote-currency amounts (fees, balances) in USDT.
 *
 * This is a representation choice, not a venue fact: it is the precision we
 * carry, and `toMinorUnits` throws if the venue ever reports more than this
 * rather than rounding it away silently.
 */
const QUOTE_DECIMALS = 8;

/** A CLI invocation and its captured result. */
export interface CliResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number;
}

/** Injected so the adapter is testable without a venue or credentials. */
export type CliRunner = (args: readonly string[]) => Promise<CliResult>;

/** Prove the credential profile's environment before constructing a trader. */
export async function assertTradingEnvironment(runner: CliRunner, expected: 'live' | 'demo'): Promise<void> {
  const result = await runner(['--env', 'account', 'balance']);
  if (result.code !== 0) {
    throw new ExecutionError(VENUE, `environment preflight failed: ${result.stderr.trim() || result.stdout.trim() || '(no output)'}`);
  }
  let payload: unknown;
  try {
    payload = JSON.parse(result.stdout);
  } catch (cause) {
    throw new ExecutionError(VENUE, 'environment preflight returned invalid JSON', { cause });
  }
  const env = typeof payload === 'object' && payload !== null ? (payload as { env?: unknown }).env : undefined;
  if (env !== expected) {
    throw new ExecutionError(
      VENUE,
      `trading profile resolved to ${JSON.stringify(env)}, expected ${expected}; refusing to start`,
    );
  }
}

export interface TradeKitOptions {
  /** CLI profile. The competition account is `okx-sub`; the level-1 main account rejects perps. */
  readonly profile: string;
  readonly runner: CliRunner;
  /**
   * From the runtime profile, never a literal at a call site. Stays
   * 'unverified' until the Part IX kill test has been run AND observed.
   */
  readonly stopCustody: VenueProfile['stopCustody'];
  /** Isolated always: cross lets one position consume the equity backing every other. */
  readonly marginMode: 'isolated' | 'cross';
  /** The account's position mode. Determines whether posSide is required. */
  readonly positionMode: 'long_short_mode' | 'net_mode';
}

/**
 * Default runner: `okx --profile <p> --json <args...>`.
 *
 * execFile with an argv array, never a shell — an instrument id or client order
 * id must not be able to become a command. The IPv4 pin is applied here because
 * the box egresses IPv6 by default and the API key whitelists a v4 address; the
 * failure without it is a 401 that reads like a credential problem.
 */
export function okxCliRunner(profile: string, timeoutMs = 20_000): CliRunner {
  return async (args) =>
    new Promise((resolve, reject) => {
      execFile(
        'okx',
        ['--profile', profile, '--json', ...args],
        {
          timeout: timeoutMs,
          maxBuffer: 16 * 1024 * 1024,
          env: { ...process.env, NODE_OPTIONS: '--dns-result-order=ipv4first' },
        },
        (error, stdout, stderr) => {
          if (error && typeof (error as { code?: unknown }).code !== 'number') {
            // Spawn failure or timeout — not a venue rejection. Never a result.
            reject(new ExecutionError(VENUE, `okx CLI did not run: ${error.message}`, { cause: error }));
            return;
          }
          resolve({
            stdout,
            stderr,
            code: error ? ((error as { code?: number }).code ?? 1) : 0,
          });
        },
      );
    });
}

/**
 * Exact decimal string -> minor units. Never via Number: 0.07 * 1e8 is
 * 7000000.000000001, and a size that rounds up is a size the venue rejects or,
 * worse, fills larger than intended.
 */
export function toMinorUnits(decimal: string, decimals: number): bigint {
  const match = /^(-?)(\d+)(?:\.(\d*))?$/.exec(decimal.trim());
  if (match === null) {
    throw new ExecutionError(VENUE, `cannot parse ${JSON.stringify(decimal)} as a decimal`);
  }
  const [, sign = '', whole = '0', fraction = ''] = match;

  // Excess precision means our scale is wrong — from a tickSz that changed, or
  // fills reported finer than the tick. Truncating would quietly corrupt a
  // price, so this surfaces as a discovery instead.
  const significant = fraction.replace(/0+$/, '');
  if (significant.length > decimals) {
    throw new ExecutionError(
      VENUE,
      `${decimal} carries ${significant.length} decimals but the scale is ${decimals} — ` +
        'refusing to truncate a venue value',
    );
  }

  const padded = fraction.padEnd(decimals, '0').slice(0, decimals);
  return BigInt(`${sign}${whole}${padded}`);
}

/** Minor units -> exact decimal string, for handing back to the CLI. */
export function fromMinorUnits(value: bigint, decimals: number): string {
  const negative = value < 0n;
  const digits = (negative ? -value : value).toString().padStart(decimals + 1, '0');
  const whole = digits.slice(0, digits.length - decimals);
  const fraction = decimals === 0 ? '' : digits.slice(digits.length - decimals).replace(/0+$/, '');
  return `${negative ? '-' : ''}${whole}${fraction === '' ? '' : `.${fraction}`}`;
}

/** Decimal places implied by a venue step string, e.g. "0.001" -> 3, "1" -> 0. */
export function decimalsOf(step: string): number {
  const match = /^\d+(?:\.(\d+))?$/.exec(step.trim());
  if (match === null) {
    throw new ExecutionError(VENUE, `cannot derive a scale from step ${JSON.stringify(step)}`);
  }
  return (match[1] ?? '').replace(/0+$/, '').length;
}

/**
 * OKX rejects a clOrdId that is not alphanumeric and 1-32 chars. Signal ids
 * carry hyphens, so this is a real collision — caught here rather than as a
 * live rejection on the first order of the competition.
 */
export function assertValidClientOrderId(clientOrderId: string): void {
  if (!/^[A-Za-z0-9]{1,32}$/.test(clientOrderId)) {
    throw new ExecutionError(
      VENUE,
      `clOrdId ${JSON.stringify(clientOrderId)} must be 1-32 alphanumeric characters ` +
        '(no hyphens) — the venue rejects anything else',
    );
  }
}

type Row = Readonly<Record<string, unknown>>;

type InstrumentSpec = Pick<Instrument, 'priceDecimals' | 'sizeDecimals' | 'contractValue' | 'maxLeverage'>;

/** Required string field. OKX omits nothing but empties plenty, and '' is not a value. */
function str(row: Row, key: string): string {
  const value = row[key];
  if (typeof value !== 'string' || value === '') {
    throw new ExecutionError(VENUE, `field ${key} missing or empty in ${JSON.stringify(row)}`);
  }
  return value;
}

/** Optional string field: '' and absent both mean "the venue did not report one". */
function optionalStr(row: Row, key: string): string | null {
  const value = row[key];
  return typeof value === 'string' && value !== '' ? value : null;
}

export class TradeKitAdapter implements ExecutionAdapter {
  readonly venue = VENUE;
  readonly route: RouteId = 'routeB';

  readonly #options: TradeKitOptions;
  /** Instrument specs, cached per describeVenue() call so scales stay consistent. */
  readonly #specs = new Map<string, InstrumentSpec>();

  constructor(options: TradeKitOptions) {
    this.#options = options;
  }

  get stopCustody(): VenueProfile['stopCustody'] {
    return this.#options.stopCustody;
  }

  /** Run a CLI command and parse its JSON payload, or throw with the venue's own words. */
  async #call(args: readonly string[]): Promise<unknown> {
    const result = await this.#options.runner(args);

    if (result.code !== 0) {
      const detail = result.stderr.trim() || result.stdout.trim() || '(no output)';
      throw new ExecutionError(VENUE, `okx ${args.join(' ')} failed (exit ${result.code}): ${detail}`);
    }

    const text = result.stdout.trim();
    if (text === '') {
      // Exit 0 with no payload is not "no results" — the CLI prints [] for that.
      throw new ExecutionError(VENUE, `okx ${args.join(' ')} exited 0 but produced no output`);
    }

    try {
      return JSON.parse(text);
    } catch (cause) {
      throw new ExecutionError(VENUE, `okx ${args.join(' ')} produced unparseable JSON`, { cause });
    }
  }

  async #rows(args: readonly string[]): Promise<readonly Row[]> {
    const payload = await this.#call(args);
    if (!Array.isArray(payload)) {
      throw new ExecutionError(VENUE, `okx ${args.join(' ')} returned a non-array payload`);
    }
    return payload as readonly Row[];
  }

  #spec(symbol: string): InstrumentSpec {
    const spec = this.#specs.get(symbol);
    if (spec === undefined) {
      throw new ExecutionError(
        VENUE,
        `no discovered spec for ${symbol} — call describeVenue() before trading it`,
      );
    }
    return spec;
  }

  async describeVenue(): Promise<VenueProfile> {
    const [instrumentRows, feeRows] = await Promise.all([
      this.#rows(['market', 'instruments', '--instType', 'SWAP']),
      this.#rows(['account', 'fees', '--instType', 'SWAP']),
    ]);

    const instruments: Instrument[] = [];
    const minOrderSize: Record<string, bigint> = {};
    let venueMaxLeverage = 0;

    this.#specs.clear();
    for (const row of instrumentRows) {
      // Non-live instruments have empty spec fields; parsing them strictly
      // would throw on a `preopen` listing we were never going to trade.
      if (optionalStr(row, 'state') !== 'live') continue;
      const symbol = str(row, 'instId');
      if (!symbol.endsWith('-USDT-SWAP')) continue;

      const priceDecimals = decimalsOf(str(row, 'tickSz'));
      const sizeDecimals = decimalsOf(str(row, 'lotSz'));

      // ctVal is the coins-per-contract multiplier. SWAP sizes are quoted in
      // contracts, so an order sized in coins is wrong by exactly this factor.
      const rawCtVal = optionalStr(row, 'ctVal');
      const contractValue = rawCtVal === null ? null : Number(rawCtVal);
      if (contractValue !== null && !(Number.isFinite(contractValue) && contractValue > 0)) {
        throw new ExecutionError(VENUE, `${symbol} reported an unusable ctVal ${JSON.stringify(rawCtVal)}`);
      }

      const lever = optionalStr(row, 'lever');
      const maxLeverage = lever === null ? undefined : Number(lever);
      if (maxLeverage !== undefined && !(Number.isFinite(maxLeverage) && maxLeverage > 0)) {
        throw new ExecutionError(VENUE, `${symbol} reported an unusable leverage ceiling ${JSON.stringify(lever)}`);
      }
      const instrument: Instrument = {
        symbol,
        priceDecimals,
        sizeDecimals,
        contractValue,
        ...(maxLeverage === undefined ? {} : { maxLeverage }),
      };
      instruments.push(instrument);
      minOrderSize[symbol] = toMinorUnits(str(row, 'minSz'), sizeDecimals);
      this.#specs.set(symbol, {
        priceDecimals,
        sizeDecimals,
        contractValue,
        ...(maxLeverage === undefined ? {} : { maxLeverage }),
      });

      if (lever !== null) venueMaxLeverage = Math.max(venueMaxLeverage, Number(lever));
    }

    if (instruments.length === 0) {
      throw new ExecutionError(VENUE, 'discovered no live USDT perpetuals — refusing an empty profile');
    }

    const fee = feeRows[0];
    if (fee === undefined) {
      throw new ExecutionError(VENUE, 'account fees returned no rows; fee rates must be measured');
    }
    // OKX reports fees as negative when charged to the account. We carry them
    // as positive costs, so the sign is normalised here, once.
    const maker = Math.abs(Number(str(fee, 'maker')));
    const taker = Math.abs(Number(str(fee, 'taker')));
    if (!Number.isFinite(maker) || !Number.isFinite(taker)) {
      throw new ExecutionError(VENUE, `unparseable fee rates: maker=${fee['maker']} taker=${fee['taker']}`);
    }

    return {
      venue: VENUE,
      discoveredAtMs: Date.now(),
      instruments,
      takerFee: taker,
      makerFee: maker,
      minOrderSize,
      // The venue's cap, not our policy cap. config.requireMaxLeverage() is the
      // one that governs sizing and it stays unset until Part IX. Omitted
      // entirely rather than defaulted when the venue did not report one.
      ...(venueMaxLeverage > 0 ? { maxLeverage: venueMaxLeverage } : {}),
      stopCustody: this.#options.stopCustody,
    };
  }

  async submitOrder(request: OrderRequest): Promise<OrderResult> {
    if (this.#options.stopCustody === 'unverified') {
      throw new NotVerifiedError(
        VENUE,
        'stop custody is unverified — the Part IX kill test has not been observed, so whether a ' +
          'stop survives process death is unknown. Refusing to open a leveraged position.',
      );
    }
    if (this.#options.stopCustody === 'none') {
      throw new NotVerifiedError(VENUE, 'venue provides no stop capability — routeB must not trade');
    }
    if (request.stopPrice === null) {
      throw new ExecutionError(VENUE, `refusing a stopless entry on ${request.instrument.symbol}`);
    }
    if (request.type === 'limit' && request.limitPrice === null) {
      throw new ExecutionError(VENUE, 'a limit order requires a limit price');
    }
    if (request.type === 'market' && request.limitPrice !== null) {
      throw new ExecutionError(VENUE, 'a market order must not carry a limit price');
    }
    if (request.size <= 0n) {
      throw new ExecutionError(VENUE, `order size must be positive, got ${request.size}`);
    }
    assertValidClientOrderId(request.clientOrderId);

    const { symbol } = request.instrument;
    const { priceDecimals, sizeDecimals } = request.instrument;

    const args = [
      'swap',
      'place',
      '--instId',
      symbol,
      '--side',
      request.side,
      '--ordType',
      request.type,
      '--sz',
      fromMinorUnits(request.size, sizeDecimals),
      '--tdMode',
      this.#options.marginMode,
      '--clOrdId',
      request.clientOrderId,
      // Stop attached to the entry, so there is no window in which the position
      // exists without one. Trigger on mark price: `last` is wickable on a thin
      // book, which turns a stop into a liquidity accident.
      '--slTriggerPx',
      fromMinorUnits(request.stopPrice, priceDecimals),
      '--slOrdPx',
      '-1', // -1 means "close at market once triggered"
      '--slTriggerPxType',
      'mark',
    ];

    if (request.limitPrice !== null) {
      args.push('--px', fromMinorUnits(request.limitPrice, priceDecimals));
    }
    if (request.targetPrice !== null) {
      args.push(
        '--tpTriggerPx',
        fromMinorUnits(request.targetPrice, priceDecimals),
        '--tpOrdPx',
        '-1',
        '--tpTriggerPxType',
        'mark',
      );
    }
    if (this.#options.positionMode === 'long_short_mode') {
      args.push('--posSide', request.side === 'buy' ? 'long' : 'short');
    }

    const rows = await this.#rows(args);
    const row = rows[0];
    if (row === undefined) {
      throw new ExecutionError(VENUE, `swap place returned no rows for ${request.clientOrderId}`);
    }

    // sCode is per-order and can report a rejection while the command exits 0.
    // Treating exit 0 as success would report a rejected order as accepted.
    const sCode = optionalStr(row, 'sCode');
    if (sCode !== null && sCode !== '0') {
      return {
        clientOrderId: request.clientOrderId,
        venueOrderId: optionalStr(row, 'ordId') ?? '',
        status: 'rejected',
        filledSize: 0n,
        averagePrice: null,
        feePaid: null,
        stopResting: false,
        raw: row,
      };
    }

    return {
      clientOrderId: request.clientOrderId,
      venueOrderId: str(row, 'ordId'),
      status: 'accepted',
      filledSize: 0n,
      averagePrice: null,
      feePaid: null,
      // NOT a claim that the stop is resting. `swap place` acknowledges the
      // order, not the attached algo; only openPositions(), which reads the
      // algo book back, can answer that. Reporting true here would defeat the
      // GuardedExecutor check that trips the kill switch on a naked fill.
      stopResting: false,
      raw: row,
    };
  }

  async cancelOrder(venueOrderId: string): Promise<void> {
    // The CLI needs instId to cancel, so the caller's order id alone is not
    // enough; find it in the open book first rather than guessing.
    const open = await this.#rows(['swap', 'orders']);
    const match = open.find((row) => optionalStr(row, 'ordId') === venueOrderId);
    if (match === undefined) {
      throw new ExecutionError(VENUE, `order ${venueOrderId} is not in the open book; not cancelling`);
    }
    await this.#call(['swap', 'cancel', str(match, 'instId'), '--ordId', venueOrderId]);
  }

  async openPositions(): Promise<readonly Position[]> {
    const [positionRows, algoRows] = await Promise.all([
      this.#rows(['account', 'positions', '--instType', 'SWAP']),
      this.#rows(['swap', 'algo', 'orders']),
    ]);

    // A resting stop is one that is actually in the algo book. Anything else is
    // an assumption, and this value decides whether the watchdog panics.
    //
    // Keyed by instrument AND side: in hedge mode both a long and a short can be
    // open on one instId, and keying by instId alone would report the short's
    // stop as the long's — a naked position that looks protected, which is the
    // exact state the watchdog exists to catch.
    const restingStops = new Map<string, string>();
    for (const row of algoRows) {
      const trigger = optionalStr(row, 'slTriggerPx');
      const instId = optionalStr(row, 'instId');
      if (trigger !== null && instId !== null) {
        restingStops.set(stopKey(instId, optionalStr(row, 'posSide')), trigger);
      }
    }

    const positions: Position[] = [];
    for (const row of positionRows) {
      const symbol = str(row, 'instId');
      const size = str(row, 'pos');
      if (Number(size) === 0) continue; // flat rows linger after a close

      const { priceDecimals, sizeDecimals, contractValue, maxLeverage } = this.#spec(symbol);
      const instrument: Instrument = {
        symbol,
        priceDecimals,
        sizeDecimals,
        contractValue,
        ...(maxLeverage === undefined ? {} : { maxLeverage }),
      };
      const posSide = optionalStr(row, 'posSide');
      const magnitude = size.startsWith('-') ? size.slice(1) : size;
      const side =
        posSide === 'long' || posSide === 'short'
          ? posSide
          : size.startsWith('-')
            ? 'short'
            : 'long';

      // Side-specific first; the net-mode key only matches when the venue
      // reported no side, so a hedge-mode miss stays a miss rather than
      // borrowing the other leg's stop.
      const stop = restingStops.get(stopKey(symbol, side)) ?? restingStops.get(stopKey(symbol, null)) ?? null;
      positions.push({
        instrument,
        side,
        size: toMinorUnits(magnitude, sizeDecimals),
        entryPrice: toMinorUnits(str(row, 'avgPx'), priceDecimals),
        markPrice: toMinorUnits(str(row, 'markPx'), priceDecimals),
        unrealisedPnlQuote: toMinorUnits(str(row, 'upl'), QUOTE_DECIMALS),
        stopPrice: stop === null ? null : toMinorUnits(stop, priceDecimals),
        stopRestingOnVenue: stop !== null,
      });
    }
    return positions;
  }

  async openOrders(): Promise<readonly OrderResult[]> {
    const rows = await this.#rows(['swap', 'orders']);
    return rows.map((row) => {
      const symbol = str(row, 'instId');
      const { priceDecimals, sizeDecimals } = this.#spec(symbol);
      const filled = optionalStr(row, 'accFillSz');
      const average = optionalStr(row, 'avgPx');
      const fee = optionalStr(row, 'fee');

      return {
        clientOrderId: optionalStr(row, 'clOrdId') ?? '',
        venueOrderId: str(row, 'ordId'),
        status: mapOrderState(optionalStr(row, 'state')),
        filledSize: filled === null ? 0n : toMinorUnits(filled, sizeDecimals),
        averagePrice: average === null ? null : toMinorUnits(average, priceDecimals),
        // OKX reports fee negative when charged; carried as a positive cost.
        feePaid: fee === null ? null : abs(toMinorUnits(fee, QUOTE_DECIMALS)),
        stopResting: optionalStr(row, 'slTriggerPx') !== null,
        raw: row,
      };
    });
  }

  /**
   * Close at market. Deliberately does NOT check stop custody: closing risk has
   * to stay available after every other gate has shut, and it is the action the
   * watchdog takes when something has already gone wrong.
   */
  async flatten(instrument: Instrument): Promise<OrderResult> {
    const args = [
      'swap',
      'close',
      '--instId',
      instrument.symbol,
      '--mgnMode',
      this.#options.marginMode,
      // Cancel any resting algo orders on the way out; leaving a stop behind on
      // a flat position can open a NEW position when it triggers.
      '--autoCxl',
    ];
    if (this.#options.positionMode === 'long_short_mode') {
      const positions = await this.openPositions();
      const held = positions.find((p) => p.instrument.symbol === instrument.symbol);
      if (held === undefined) {
        throw new ExecutionError(VENUE, `no open position on ${instrument.symbol} to flatten`);
      }
      args.push('--posSide', held.side);
    }

    const rows = await this.#rows(args);
    const row = rows[0] ?? {};
    return {
      clientOrderId: '',
      venueOrderId: optionalStr(row, 'ordId') ?? '',
      status: 'accepted',
      filledSize: 0n,
      averagePrice: null,
      feePaid: null,
      stopResting: false,
      raw: row,
    };
  }

  async availableBalance(): Promise<bigint> {
    const rows = await this.#rows(['account', 'balance', 'USDT']);
    const account = rows[0];
    if (account === undefined) {
      throw new ExecutionError(VENUE, 'account balance returned no rows');
    }
    const details = account['details'];
    if (!Array.isArray(details)) {
      throw new ExecutionError(VENUE, 'account balance carried no details array');
    }
    const usdt = (details as readonly Row[]).find((row) => optionalStr(row, 'ccy') === 'USDT');
    if (usdt === undefined) {
      throw new ExecutionError(VENUE, 'no USDT line in the account balance');
    }
    // availEq is free collateral; eq includes what is already margining a
    // position. Sizing off eq would double-commit the same USDT.
    return toMinorUnits(str(usdt, 'availEq'), QUOTE_DECIMALS);
  }
}

/**
 * Algo-book key. `net` and an absent side are the same thing — net mode, one
 * position per instrument — and collapse to the bare symbol.
 */
function stopKey(symbol: string, posSide: string | null): string {
  return posSide === null || posSide === '' || posSide === 'net' ? symbol : `${symbol}|${posSide}`;
}

function abs(value: bigint): bigint {
  return value < 0n ? -value : value;
}

/** OKX order states -> the adapter's vocabulary. An unknown state is not a guess. */
export function mapOrderState(state: string | null): OrderResult['status'] {
  switch (state) {
    case 'live':
      return 'accepted';
    case 'filled':
      return 'filled';
    case 'partially_filled':
      return 'partially_filled';
    case 'canceled':
    case 'mmp_canceled':
      return 'cancelled';
    default:
      throw new ExecutionError(VENUE, `unrecognised order state ${JSON.stringify(state)}`);
  }
}
