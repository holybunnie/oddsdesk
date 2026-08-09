/**
 * The copy executor — deliberately the dumbest process in the system.
 *
 * Law 6 says every trade must trace to a published signal. That is only
 * structurally true if the thing that places orders cannot form an opinion of
 * its own. So this module has NO strategy logic and NO discretion: it reads
 * numbers out of a published signal, checks a fixed list of preconditions, and
 * either submits exactly what the text says or refuses and says why.
 *
 * Concretely, the things it must never do:
 *
 *   - Recompute an entry, stop or target. If the text is unparseable it refuses;
 *     it never falls back to a market order or to a price it derived itself.
 *   - Re-run sizing. The published `size %` is authoritative, because it is what
 *     a follower reading the signal would act on. All the risk mathematics
 *     happened upstream in `computeSize()` before publication.
 *   - Skip anything quietly. Every call returns an `ExecutionOutcome` naming
 *     what happened, so a signal that was not traded is distinguishable from one
 *     that was never seen — the same absence-of-evidence failure `SignalCycle`
 *     exists to catch on the publication side.
 *
 * It is still gated. Orders leave through `GuardedExecutor`, never an adapter,
 * and `requireMaxLeverage()` is consulted here too, so a copy executor pointed
 * at a config whose Part IX verification has not been done refuses to trade at
 * all rather than sizing off an unverified stop mechanism.
 */

import { competitionPhase, entriesPermitted, requireMaxLeverage, type Config } from '../config.js';
import { assertAboveEligibilityFloor } from '../risk.js';
import {
  formatPrice,
  validateSignal,
  type SignalPlan,
  type ValidationContext,
} from '../signal/publish.js';
import type { Direction } from '../signal/scanner.js';
import type { Instrument, OrderRequest, Position } from './adapter.js';
import type { FeedFreshness, GuardedExecutor } from './guarded.js';

export class CopyExecutorError extends Error {
  override readonly name = 'CopyExecutorError';
}

/** Quote-currency scale, matching the adapter's balance reporting. */
const QUOTE_DECIMALS = 8;

/**
 * The signal text, parsed back into numbers.
 *
 * This is the exact inverse of `formatSignal`, and the round trip is pinned by
 * a test. If the two ever drift, every published signal becomes unexecutable at
 * once — which is loud, and much better than a parser that copes by guessing.
 */
export interface ParsedSignal {
  readonly signalId: string;
  readonly instId: string;
  readonly direction: Direction;
  readonly leverage: number;
  readonly entryLow: number;
  readonly entryHigh: number;
  readonly stopPrice: number;
  readonly scaleOutPrice: number;
  readonly targetPrice: number;
  readonly sizePercent: number;
  /** Absolute expiry, read from the text rather than inferred from delivery. */
  readonly validUntilMs: number;
  /** Set when the signal declares itself a pyramid add. */
  readonly addIndex: number | null;
}

/**
 * Matches only the exact shape `formatSignal` emits. Deliberately rigid: a
 * lenient parser turns a formatting bug into a mis-priced order instead of a
 * refusal, and a mis-priced order is the failure this whole module exists to
 * make impossible.
 */
const SIGNAL_PATTERN =
  /^(\S+) \| (LONG|SHORT) (\d+(?:\.\d+)?)x \| Entry (\d+(?:\.\d+)?)-(\d+(?:\.\d+)?) \| SL (\d+(?:\.\d+)?) \| TP1 (\d+(?:\.\d+)?) \| TP2 (\d+(?:\.\d+)?) \| Position (\d+(?:\.\d+)?)% \| Valid (\S+) \| (?:ADD (\d+) \| )?(\S+)$/;

/** Parse a published entry signal. Throws rather than returning a partial reading. */
export function parseSignal(config: Config, text: string): ParsedSignal {
  const header = config.publishing.perpHeader;
  if (!text.startsWith(header)) {
    throw new CopyExecutorError(
      `signal does not begin with the exact header ${JSON.stringify(header)} — refusing to act on it`,
    );
  }

  const body = text.slice(header.length).trim();
  const match = SIGNAL_PATTERN.exec(body);
  if (match === null) {
    throw new CopyExecutorError(`signal body does not match the published format: ${JSON.stringify(body)}`);
  }

  const [
    ,
    instId,
    side,
    leverage,
    entryLow,
    entryHigh,
    stopPrice,
    scaleOutPrice,
    targetPrice,
    sizePercent,
    validUntil,
    addIndex,
    signalId,
  ] = match as unknown as readonly string[];

  const validUntilMs = Date.parse(validUntil as string);
  if (Number.isNaN(validUntilMs)) {
    throw new CopyExecutorError(`signal validity ${JSON.stringify(validUntil)} is not a parseable instant`);
  }

  const parsed: ParsedSignal = {
    signalId: signalId as string,
    instId: instId as string,
    direction: side === 'LONG' ? 'long' : 'short',
    leverage: Number(leverage),
    entryLow: Number(entryLow),
    entryHigh: Number(entryHigh),
    stopPrice: Number(stopPrice),
    scaleOutPrice: Number(scaleOutPrice),
    targetPrice: Number(targetPrice),
    sizePercent: Number(sizePercent),
    validUntilMs,
    addIndex: addIndex === undefined ? null : Number(addIndex),
  };

  // Leverage and size are the same quantity published twice. They agreed when
  // the signal was built; if they disagree now, the text was altered in transit
  // or the two formatters have drifted. Either way the numbers cannot both be
  // trusted, and this executor's whole purpose is to refuse rather than pick one.
  const implied = Number((parsed.sizePercent / 100).toFixed(2));
  if (parsed.leverage !== implied) {
    throw new CopyExecutorError(
      `signal states ${parsed.leverage}x but a position of ${parsed.sizePercent}% implies ${implied}x — ` +
        'the published leverage and size disagree',
    );
  }

  return parsed;
}

/** A published exit action, parsed back. The inverse of `formatExitSignal`. */
export interface ParsedExitSignal {
  readonly exitId: string;
  readonly refSignalId: string;
  readonly instId: string;
  readonly direction: Direction;
  readonly action: { readonly kind: 'close'; readonly percent: number } | { readonly kind: 'stop'; readonly to: number };
  readonly price: number;
}

const EXIT_PATTERN =
  /^(\S+) \| EXIT (LONG|SHORT) \| (?:CLOSE (\d+(?:\.\d+)?)%|SL (\d+(?:\.\d+)?)) \| @(\d+(?:\.\d+)?) \| ref (\S+) \| (\S+)$/;

/**
 * Parse a published exit signal.
 *
 * We never act on these ourselves — our own exits are executed directly, and the
 * published text is the record of what already happened. It exists so the round
 * trip is pinned by a test and so a subscriber's agent has a defined grammar to
 * implement against. A format we publish but cannot read back is a format we
 * have no evidence anyone else can read either.
 */
export function parseExitSignal(config: Config, text: string): ParsedExitSignal {
  const header = config.publishing.perpHeader;
  if (!text.startsWith(header)) {
    throw new CopyExecutorError(`exit signal does not begin with the header ${JSON.stringify(header)}`);
  }

  const match = EXIT_PATTERN.exec(text.slice(header.length).trim());
  if (match === null) {
    throw new CopyExecutorError(`exit signal does not match the published format: ${JSON.stringify(text)}`);
  }

  const [, instId, side, closePercent, stopTo, price, refSignalId, exitId] = match as unknown as readonly string[];

  return {
    exitId: exitId as string,
    refSignalId: refSignalId as string,
    instId: instId as string,
    direction: side === 'LONG' ? 'long' : 'short',
    action:
      closePercent === undefined
        ? { kind: 'stop', to: Number(stopTo) }
        : { kind: 'close', percent: Number(closePercent) },
    price: Number(price),
  };
}

/**
 * Remembers which signals have been acted on.
 *
 * A duplicate delivery must not open a second position — the ASP delivery path
 * has retries, so this is an expected event rather than a defensive nicety.
 * Deduplication is belt and braces with the deterministic client order id
 * below: this catches a redelivery within the process, and the venue's own
 * clOrdId uniqueness catches one that survives a restart.
 */
export interface SignalJournal {
  has(signalId: string): boolean;
  record(signalId: string): void;
}

export class InMemorySignalJournal implements SignalJournal {
  readonly #seen = new Set<string>();
  has(signalId: string): boolean {
    return this.#seen.has(signalId);
  }
  record(signalId: string): void {
    this.#seen.add(signalId);
  }
}

/**
 * Signal id -> client order id.
 *
 * OKX takes 1-32 alphanumerics, and signal ids carry hyphens. Stripping is
 * deterministic, so the same signal always maps to the same clOrdId and a
 * redelivery after a restart is rejected by the venue as a duplicate. The
 * stripping is not injective (`a-b` and `ab` collide), which is safe only
 * because signal ids are timestamped and never differ by punctuation alone.
 */
export function clientOrderIdFor(signalId: string): string {
  const stripped = signalId.replace(/[^A-Za-z0-9]/g, '');
  if (stripped === '' || stripped.length > 32) {
    throw new CopyExecutorError(
      `signal id ${JSON.stringify(signalId)} yields the unusable client order id ` +
        `${JSON.stringify(stripped)} — it must be 1-32 characters once punctuation is removed`,
    );
  }
  return stripped;
}

/** Read-only account view. The executor reads here and writes only through the guard. */
export interface AccountView {
  availableBalance(): Promise<bigint>;
  openPositions(): Promise<readonly Position[]>;
}

export type ExecutionOutcome =
  | { readonly status: 'submitted'; readonly signalId: string; readonly venueOrderId: string; readonly size: bigint }
  | { readonly status: 'duplicate'; readonly signalId: string }
  | { readonly status: 'refused'; readonly signalId: string | null; readonly reason: string };

export interface CopyExecutorDeps {
  readonly config: Config;
  readonly executor: GuardedExecutor;
  readonly account: AccountView;
  /** Instrument specs from `describeVenue()`. An unknown symbol is a refusal, never a guess. */
  readonly instruments: ReadonlyMap<string, Instrument>;
  readonly journal: SignalJournal;
  /**
   * How long after delivery a signal may still be acted on. A signal executed
   * an hour late is executed at a price the publisher never saw.
   */
  readonly maxSignalAgeMs: number;
  readonly now?: () => number;
}

export class CopyExecutor {
  readonly #config: Config;
  readonly #executor: GuardedExecutor;
  readonly #account: AccountView;
  readonly #instruments: ReadonlyMap<string, Instrument>;
  readonly #journal: SignalJournal;
  readonly #maxSignalAgeMs: number;
  readonly #now: () => number;

  constructor(deps: CopyExecutorDeps) {
    this.#config = deps.config;
    this.#executor = deps.executor;
    this.#account = deps.account;
    this.#instruments = deps.instruments;
    this.#journal = deps.journal;
    this.#maxSignalAgeMs = deps.maxSignalAgeMs;
    this.#now = deps.now ?? (() => Date.now());
  }

  /**
   * Act on one delivered signal.
   *
   * Returns an outcome rather than throwing for a refusal: a refusal is a normal
   * result here — most delivered signals will be refused for a mundane reason —
   * and the caller needs to record it, not handle an exception. Only a genuine
   * fault (the venue unreachable, the guard tripping the kill switch) throws.
   */
  async execute(text: string, deliveredAtMs: number, feeds: readonly FeedFreshness[]): Promise<ExecutionOutcome> {
    let parsed: ParsedSignal;
    try {
      parsed = parseSignal(this.#config, text);
    } catch (error) {
      return { status: 'refused', signalId: null, reason: (error as Error).message };
    }

    const refuse = (reason: string): ExecutionOutcome => ({
      status: 'refused',
      signalId: parsed.signalId,
      reason,
    });

    if (this.#journal.has(parsed.signalId)) {
      return { status: 'duplicate', signalId: parsed.signalId };
    }

    const instrument = this.#instruments.get(parsed.instId);
    if (instrument === undefined) {
      return refuse(`${parsed.instId} is not a discovered instrument; call describeVenue() first`);
    }

    // Re-run the publication gate on the way in. The text checks pass
    // tautologically — the numbers came from the text — but the geometry and
    // payoff checks do not, and those are the ones that matter: this is what
    // makes an altered or wrongly-published signal refused at the executor
    // rather than traded on trust.
    const nowMs = this.#now();

    // The competition window, checked here as well as in the engine. The engine
    // is the only component that decides to open a position, so its gate is the
    // one that matters — but this is the last refusal before the venue, and a
    // pre-start fill moves equity, does not score, and cannot be undone. The
    // same reasoning that puts `requireMaxLeverage` in two places puts this here.
    const phase = competitionPhase(this.#config, nowMs);
    if (!entriesPermitted(phase)) {
      return refuse(`competition phase is "${phase}" — no new position may be opened`);
    }

    // The published expiry is authoritative: it is what a subscriber reading the
    // signal would honour, and honouring something else would make our fills
    // diverge from our own published instruction. `maxSignalAgeMs` remains as a
    // second bound on how long a delivery may sit before it is acted on.
    if (nowMs >= parsed.validUntilMs) {
      return refuse(`signal expired at ${new Date(parsed.validUntilMs).toISOString()}`);
    }
    if (nowMs - deliveredAtMs > this.#maxSignalAgeMs) {
      return refuse(
        `signal was delivered ${((nowMs - deliveredAtMs) / 60_000).toFixed(1)} minutes ago, over the limit`,
      );
    }

    const plan: SignalPlan = {
      signalId: parsed.signalId,
      instId: parsed.instId,
      direction: parsed.direction,
      entryLow: parsed.entryLow,
      entryHigh: parsed.entryHigh,
      stopPrice: parsed.stopPrice,
      scaleOutPrice: parsed.scaleOutPrice,
      targetPrice: parsed.targetPrice,
      sizePercent: parsed.sizePercent,
      validUntilMs: parsed.validUntilMs,
    };
    const context: ValidationContext = {
      liveInstruments: new Set(this.#instruments.keys()),
      nowMs,
    };
    const validation = validateSignal(this.#config, text, plan, context);
    if (!validation.ok) {
      return refuse(`signal failed the publication gate on read-back: ${validation.reasons.join('; ')}`);
    }

    // Leverage. Consulted here as well as upstream so that a copy executor
    // running against a config whose Part IX verification has not been done
    // throws instead of trading — the refusal must not live in only one place.
    const maxLeverage = requireMaxLeverage(this.#config);

    const equityMinor = await this.#account.availableBalance();
    const equityUsdt = Number(equityMinor) / 10 ** QUOTE_DECIMALS;
    try {
      assertAboveEligibilityFloor(this.#config, equityUsdt);
    } catch (error) {
      return refuse((error as Error).message);
    }

    const positions = await this.#account.openPositions();
    const alreadyHeld = positions.some((p) => p.instrument.symbol === parsed.instId);

    // Pyramiding is an engine decision, expressed as a signal that SAYS it is an
    // add. The executor still forms no opinion: it reads the marker or it
    // refuses. Without the marker, a second delivery on a held instrument is
    // indistinguishable from a redelivery, and treating it as an add would let
    // a retry double the position.
    if (alreadyHeld && parsed.addIndex === null) {
      return refuse(`already holding ${parsed.instId}; the executor does not add to a position`);
    }
    if (!alreadyHeld && parsed.addIndex !== null) {
      return refuse(
        `signal declares itself add ${parsed.addIndex} but no ${parsed.instId} position is open`,
      );
    }
    if (!alreadyHeld && positions.length >= this.#config.risk.maxConcurrentPositions) {
      return refuse(
        `already holding ${positions.length} positions, at the ${this.#config.risk.maxConcurrentPositions} limit`,
      );
    }

    // The limit price is the far edge of the published band: the worst price
    // inside it. A limit order fills there or better, so this honours the band
    // exactly while giving up nothing — and it can never fill outside what was
    // published, which chasing with a market order would.
    const limitPrice = parsed.direction === 'long' ? parsed.entryHigh : parsed.entryLow;

    const instrumentMaxLeverage = instrument.maxLeverage;
    const effectiveMaxLeverage = Math.min(
      maxLeverage,
      instrumentMaxLeverage ?? Number.POSITIVE_INFINITY,
    );
    const notionalUsdt = equityUsdt * (parsed.sizePercent / 100);
    const leverage = notionalUsdt / equityUsdt;
    if (leverage > effectiveMaxLeverage) {
      return refuse(
        `published size ${parsed.sizePercent}% implies ${leverage.toFixed(2)}x, over the ` +
          `${effectiveMaxLeverage}x cap${instrumentMaxLeverage === undefined ? '' : ` for ${parsed.instId}`}`,
      );
    }

    const size = contractsFor(instrument, notionalUsdt, limitPrice);
    if (size <= 0n) {
      return refuse(
        `${parsed.sizePercent}% of ${equityUsdt.toFixed(2)} USDT rounds to zero contracts on ${parsed.instId}`,
      );
    }

    const request: OrderRequest = {
      route: 'routeB',
      engine: 'copy-executor',
      instrument,
      side: parsed.direction === 'long' ? 'buy' : 'sell',
      type: 'limit',
      limitPrice: priceToMinor(limitPrice, instrument.priceDecimals),
      size,
      stopPrice: priceToMinor(parsed.stopPrice, instrument.priceDecimals),
      // NO ATTACHED TAKE-PROFIT, deliberately.
      //
      // E5 has no target logic: it takes 25% off at +2R, moves to breakeven and
      // trails the remainder. A venue take-profit at TP2 would close the whole
      // position the moment price touched 3R — amputating the tail the strategy
      // exists to capture, and, worse, leaving the engine trailing a stop on a
      // position that no longer exists until the next reconcile found the
      // divergence and tripped the kill switch.
      //
      // The stop stays attached. It is the one order that must survive us.
      targetPrice: null,
      reason: parsed.signalId,
      clientOrderId: clientOrderIdFor(parsed.signalId),
    };

    // Recorded BEFORE submission. A signal whose order is lost to a timeout must
    // not be retried on the next delivery — the venue may well have it.
    this.#journal.record(parsed.signalId);

    const result = await this.#executor.submitOrder(request, feeds);
    if (result.status === 'rejected') {
      return refuse(`venue rejected the order: ${JSON.stringify(result.raw)}`);
    }

    return {
      status: 'submitted',
      signalId: parsed.signalId,
      venueOrderId: result.venueOrderId,
      size,
    };
  }
}

/**
 * Notional in USDT -> size in the venue's own units, rounded DOWN to the lot.
 *
 * Rounding down, always: rounding a size up spends more than the published
 * percentage said it would, which breaks the correspondence between the signal
 * and the trade that Law 6 rests on. Under-filling by less than one lot does not.
 */
export function contractsFor(instrument: Instrument, notionalUsdt: number, price: number): bigint {
  if (!Number.isFinite(price) || price <= 0) {
    throw new CopyExecutorError(`cannot size against a price of ${price}`);
  }
  // contractValue is null where the venue quotes size in the base asset, in
  // which case one "contract" is one coin.
  const coinsPerContract = instrument.contractValue ?? 1;
  if (!Number.isFinite(coinsPerContract) || coinsPerContract <= 0) {
    throw new CopyExecutorError(`${instrument.symbol} has an unusable contract value ${coinsPerContract}`);
  }

  const contracts = notionalUsdt / (price * coinsPerContract);
  const scale = 10 ** instrument.sizeDecimals;
  // Settle the representation error before flooring. An exact 0.24 contracts can
  // land on 23.999999999999996 lots, and a bare floor would then drop a whole
  // lot — on a minimum-size order that is the difference between a position and
  // a venue rejection.
  const lots = Number((contracts * scale).toFixed(9));
  return BigInt(Math.floor(lots));
}

/**
 * Published price -> minor units at the instrument's tick scale.
 *
 * Done on the decimal STRING, never by multiplying a float: 0.07 * 1e8 is
 * 7000000.000000001, and a price that drifts by one minor unit is a price the
 * venue rejects. Prices are published at five significant figures, which can be
 * finer than the tick on a cheap instrument, so a value below the tick scale is
 * snapped to the nearest tick rather than refused — the tick is smaller than
 * any stop distance we trade, and refusing would make cheap perps unexecutable.
 */
export function priceToMinor(value: number, decimals: number): bigint {
  const text = formatPrice(value);
  const [whole = '0', fraction = ''] = text.split('.');

  if (fraction.length <= decimals) {
    return BigInt(whole + fraction.padEnd(decimals, '0'));
  }

  const kept = BigInt(whole + fraction.slice(0, decimals));
  // Half-up on the first discarded digit, which is all that decides the tick.
  const roundUp = Number(fraction[decimals]) >= 5;
  return roundUp ? kept + 1n : kept;
}
