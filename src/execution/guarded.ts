/**
 * GuardedExecutor — the only path to a venue.
 *
 * Engines never hold an ExecutionAdapter. They hold this. Every gate that must
 * run before money moves runs here, in a fixed order, and none of them can be
 * skipped by an adapter, forgotten by an engine, or disabled by a flag:
 *
 *   1. kill switch          — trippable by any process, checked every submit
 *   2. feed staleness       — a dead feed returning its last value drains the
 *                             account for a day before anyone notices
 *   3. risk-token gate      — blocking, not advisory
 *   4. stop requirement     — Route B admits no stopless entry (H2)
 *   5. ledger receipt       — written BEFORE submission, so an order that
 *                             vanishes into a timeout still left a receipt
 *
 * Order matters. The ledger write is last among the checks and first among the
 * effects: everything that can refuse has refused by then, and anything that
 * happens afterwards is recorded whether it succeeds or not.
 */

import type { Ledger } from '../ledger.js';
import type { KillSwitch } from '../kill-switch.js';
import {
  ExecutionError,
  type ExecutionAdapter,
  type Instrument,
  type OrderRequest,
  type OrderResult,
  type Position,
  type RiskTokenGate,
} from './adapter.js';

export class StaleFeedError extends Error {
  override readonly name = 'StaleFeedError';
}

export class MissingStopError extends Error {
  override readonly name = 'MissingStopError';
}

/**
 * Freshness of whatever price feed the calling engine depends on.
 *
 * Supplied by the caller rather than read here, because "the feed" differs per
 * engine — P1 depends on a sub-second spot stream, H1 on OHLC. The guard does
 * not need to know which; it needs to know when it was last good.
 */
export interface FeedFreshness {
  readonly name: string;
  readonly lastUpdateMs: number;
}

export interface GuardedExecutorDeps {
  readonly adapter: ExecutionAdapter;
  readonly ledger: Ledger;
  readonly killSwitch: KillSwitch;
  readonly riskGate: RiskTokenGate;
  /** From config.risk.maxFeedStalenessSeconds. */
  readonly maxFeedStalenessSeconds: number;
  /** Injected for testability; defaults to wall clock. */
  readonly now?: () => number;
}

export class GuardedExecutor {
  readonly #adapter: ExecutionAdapter;
  readonly #ledger: Ledger;
  readonly #killSwitch: KillSwitch;
  readonly #riskGate: RiskTokenGate;
  readonly #maxStalenessMs: number;
  readonly #now: () => number;

  constructor(deps: GuardedExecutorDeps) {
    this.#adapter = deps.adapter;
    this.#ledger = deps.ledger;
    this.#killSwitch = deps.killSwitch;
    this.#riskGate = deps.riskGate;
    this.#maxStalenessMs = deps.maxFeedStalenessSeconds * 1000;
    this.#now = deps.now ?? (() => Date.now());
  }

  get venue(): string {
    return this.#adapter.venue;
  }

  /**
   * Submit an order through every gate.
   *
   * Refusals are recorded before they are thrown. A refusal that leaves no
   * receipt is indistinguishable from an engine that never fired, and on day
   * four that difference is the whole post-mortem.
   */
  async submitOrder(request: OrderRequest, feeds: readonly FeedFreshness[]): Promise<OrderResult> {
    const refuse = (code: string, message: string, error: Error): never => {
      this.#ledger.append({
        action: 'refusal',
        engine: request.engine,
        venue: this.#adapter.venue,
        instrument: request.instrument.symbol,
        signal: request.reason,
        price: request.limitPrice === null ? null : request.limitPrice.toString(),
        size: request.size.toString(),
        stop: request.stopPrice === null ? null : request.stopPrice.toString(),
        reason: `${code}: ${message}`,
      });
      throw error;
    };

    // 1. Kill switch, per route. A routeB trip must not stop routeA.
    try {
      this.#killSwitch.assertClear(request.route);
    } catch (error) {
      return refuse('kill_switch', (error as Error).message, error as Error);
    }

    // 2. Feed staleness. Checked for every feed the engine declared it needs.
    const now = this.#now();
    for (const feed of feeds) {
      const ageMs = now - feed.lastUpdateMs;
      if (ageMs > this.#maxStalenessMs) {
        const message = `feed "${feed.name}" is ${(ageMs / 1000).toFixed(1)}s stale (limit ${
          this.#maxStalenessMs / 1000
        }s)`;
        return refuse('stale_feed', message, new StaleFeedError(message));
      }
    }

    // 3. Risk-token gate. Blocking, in the execution path.
    try {
      await this.#riskGate.assertClean(request.instrument);
    } catch (error) {
      return refuse('risk_token', (error as Error).message, error as Error);
    }

    // 4. Stop requirement. Route B is leveraged and liquidatable, so a stop is
    //    mandatory. Route A positions are defined-risk — the maximum loss is the
    //    premium paid and no stop exists to attach.
    if (request.route === 'routeB' && request.stopPrice === null) {
      const message = `refusing stopless ${request.instrument.symbol} entry on routeB`;
      return refuse('no_stop', message, new MissingStopError(message));
    }

    // 5. Receipt BEFORE submission. If the venue call times out and we never
    //    learn the outcome, the intent is still on record and reconciliation has
    //    something to match against.
    this.#ledger.append({
      action: 'order_submitted',
      engine: request.engine,
      venue: this.#adapter.venue,
      instrument: request.instrument.symbol,
      signal: request.reason,
      price: request.limitPrice === null ? null : request.limitPrice.toString(),
      size: request.size.toString(),
      stop: request.stopPrice === null ? null : request.stopPrice.toString(),
      reason: request.reason,
      detail: { clientOrderId: request.clientOrderId, type: request.type, side: request.side },
    });

    let result: OrderResult;
    try {
      result = await this.#adapter.submitOrder(request);
    } catch (error) {
      this.#ledger.append({
        action: 'order_rejected',
        engine: request.engine,
        venue: this.#adapter.venue,
        instrument: request.instrument.symbol,
        signal: request.reason,
        price: null,
        size: request.size.toString(),
        stop: null,
        reason: `venue call failed: ${(error as Error).message}`,
        detail: { clientOrderId: request.clientOrderId },
      });
      throw error;
    }

    this.#ledger.append({
      action: result.status === 'rejected' ? 'order_rejected' : 'order_filled',
      engine: request.engine,
      venue: this.#adapter.venue,
      instrument: request.instrument.symbol,
      signal: request.reason,
      price: result.averagePrice === null ? null : result.averagePrice.toString(),
      size: result.filledSize.toString(),
      stop: request.stopPrice === null ? null : request.stopPrice.toString(),
      reason: `venue status ${result.status}`,
      detail: {
        clientOrderId: request.clientOrderId,
        venueOrderId: result.venueOrderId,
        stopResting: result.stopResting,
        feePaid: result.feePaid === null ? null : result.feePaid.toString(),
        raw: result.raw,
      },
    });

    // A leveraged fill whose stop is not actually resting on the venue is a
    // naked position. Surface it immediately and trip routeB — this is the
    // exact condition the Part IX kill test exists to rule out, and if it shows
    // up in live trading the verification was wrong.
    if (request.route === 'routeB' && result.filledSize > 0n && !result.stopResting) {
      this.#killSwitch.trip(
        'routeB',
        'guarded-executor',
        `filled ${request.instrument.symbol} but no stop is resting on the venue`,
      );
      throw new ExecutionError(
        this.#adapter.venue,
        `order filled without a resting stop on ${request.instrument.symbol} — routeB tripped`,
      );
    }

    return result;
  }

  /**
   * Reconcile local expectations against venue truth.
   *
   * Divergence halts new orders rather than attempting a repair: an automated
   * fix built on a wrong picture of the book is how a small discrepancy becomes
   * a large one.
   */
  async reconcile(expected: readonly Position[]): Promise<readonly Position[]> {
    const actual = await this.#adapter.openPositions();

    const key = (p: Position) => `${p.instrument.symbol}:${p.side}`;
    const actualByKey = new Map(actual.map((p) => [key(p), p]));
    const expectedByKey = new Map(expected.map((p) => [key(p), p]));

    const divergences: string[] = [];

    for (const [k, exp] of expectedByKey) {
      const act = actualByKey.get(k);
      if (act === undefined) {
        divergences.push(`${k}: expected size ${exp.size} but venue has no position`);
      } else if (act.size !== exp.size) {
        divergences.push(`${k}: expected size ${exp.size}, venue reports ${act.size}`);
      }
    }
    for (const [k, act] of actualByKey) {
      if (!expectedByKey.has(k)) {
        divergences.push(`${k}: venue reports an unexpected position of size ${act.size}`);
      }
    }

    this.#ledger.append({
      action: 'reconciliation',
      engine: 'reconciler',
      venue: this.#adapter.venue,
      instrument: null,
      signal: null,
      price: null,
      size: null,
      stop: null,
      reason:
        divergences.length === 0
          ? `reconciled ${actual.length} position(s), no divergence`
          : `DIVERGENCE: ${divergences.join(' | ')}`,
      detail: { expectedCount: expected.length, actualCount: actual.length, divergences },
    });

    if (divergences.length > 0) {
      this.#killSwitch.trip(
        'all',
        'reconciler',
        `position divergence against ${this.#adapter.venue}: ${divergences.join(' | ')}`,
      );
    }

    return actual;
  }

  /**
   * Flatten bypasses the kill switch by design.
   *
   * Every gate above exists to stop new risk being taken. Closing risk is the
   * one action that must remain available when everything else has halted —
   * a kill switch that also blocked the exit would strand the position it was
   * tripped to protect.
   */
  async flatten(instrument: Instrument, reason: string): Promise<OrderResult> {
    const result = await this.#adapter.flatten(instrument);
    this.#ledger.append({
      action: 'position_closed',
      engine: 'flatten',
      venue: this.#adapter.venue,
      instrument: instrument.symbol,
      signal: null,
      price: result.averagePrice === null ? null : result.averagePrice.toString(),
      size: result.filledSize.toString(),
      stop: null,
      reason,
      detail: { venueOrderId: result.venueOrderId, status: result.status },
    });
    return result;
  }
}
