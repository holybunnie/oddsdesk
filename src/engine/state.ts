/**
 * The state the engine loop owns, which nothing else can.
 *
 * Every other module in the signal path is a pure function of its inputs, which
 * is why they are exhaustively testable. That purity has a cost: three pieces of
 * knowledge are inherently temporal, and someone has to hold them.
 *
 *   1. **Cooldowns.** E4 accepts a `cooldownUntilMs` but cannot know it — it
 *      sees one candidate at one instant. `scan.ts` passes none and therefore
 *      over-reports. The engine must not.
 *   2. **Position history.** E5 needs the entry price, the ORIGINAL stop, the
 *      extreme reached since entry, and when the position opened. The venue
 *      reports none of these: it knows the current size and mark, not what R
 *      means for this trade.
 *   3. **Peak equity.** The drawdown governor measures from the peak, so the
 *      peak has to outlive the process that observed it.
 *   4. **Signals already acted on.** The copy executor deduplicates redelivered
 *      signals, and an in-memory set loses that on restart — which is when a
 *      redelivery is most likely, because whatever restarted us may also have
 *      interrupted a delivery acknowledgement.
 *
 * All three survive restart. A cooldown that resets on restart is not a
 * cooldown — it is an invitation to re-enter the instrument that just stopped
 * us out, at exactly the moment a crash makes a restart likely. The extreme
 * since entry is worse: losing it silently loosens every trailing stop back to
 * its entry-time value, which is the one move `ratchetStop` exists to forbid.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { PositionState, Side } from '../signal/exits.js';

export class EngineStateError extends Error {
  override readonly name = 'EngineStateError';
}

/**
 * A tracked position: what E5 needs, plus the venue linkage.
 *
 * `highWaterPrice`/`lowWaterPrice` are the Chandelier anchors. They are updated
 * every cycle from observed price and never move backwards, because the anchor
 * is the extreme SINCE ENTRY — anchoring to current price would loosen the stop
 * on every pullback.
 */
export interface TrackedPosition extends PositionState {
  readonly signalId: string;
  readonly highWaterPrice: number;
  readonly lowWaterPrice: number;
  /**
   * Size submitted to the venue, in minor units, as a DECIMAL STRING.
   *
   * A string because JSON cannot carry a bigint, and this snapshot must survive
   * a restart. The reconciler compares this against venue truth, so a fabricated
   * or rounded value here would report divergence on every cycle and trip the
   * kill switch — which is why it is the submitted size, not a derived one.
   */
  readonly venueSize: string;
}

interface Snapshot {
  readonly positions: readonly TrackedPosition[];
  readonly cooldowns: Readonly<Record<string, number>>;
  readonly peakEquityUsdt: number;
  /** Signal ids already acted on, with the time they were recorded. */
  readonly actedSignals: Readonly<Record<string, number>>;
}

const EMPTY: Snapshot = { positions: [], cooldowns: {}, peakEquityUsdt: 0, actedSignals: {} };

/**
 * How long an acted-on signal id is remembered.
 *
 * Unbounded growth would eventually make every restart slower and the state
 * file larger without limit. Two weeks covers the whole competition window with
 * room to spare, so within the only period that matters the journal is
 * effectively permanent — the expiry exists so the file cannot grow forever in
 * a longer-lived deployment, not as a real forgetting policy.
 */
const SIGNAL_MEMORY_MS = 14 * 24 * 3_600_000;

/**
 * Durable engine state.
 *
 * Written atomically via rename. A partial write here is worse than no state at
 * all: it would either resurrect a closed position or, by truncating the
 * cooldown map, permit the re-entry the cooldown exists to prevent.
 */
export class EngineState {
  readonly #path: string;
  #positions = new Map<string, TrackedPosition>();
  #cooldowns = new Map<string, number>();
  #actedSignals = new Map<string, number>();
  #peakEquityUsdt = 0;

  constructor(path: string) {
    this.#path = resolve(path);
    mkdirSync(dirname(this.#path), { recursive: true });
    this.#load();
  }

  #load(): void {
    let raw: string;
    try {
      raw = readFileSync(this.#path, 'utf8');
    } catch {
      return; // No file yet is a legitimate cold start.
    }

    let parsed: Snapshot;
    try {
      parsed = { ...EMPTY, ...(JSON.parse(raw) as Snapshot) };
    } catch (cause) {
      // Unparseable state is NOT a cold start. Starting fresh would silently
      // drop live positions and cooldowns, so this must be looked at by hand.
      throw new EngineStateError(
        `engine state at ${this.#path} is unreadable — refusing to start with an empty book. ` +
          'Inspect the file; a cold start must be an explicit decision, never a fallback.',
        { cause },
      );
    }

    this.#positions = new Map(parsed.positions.map((p) => [p.instId, p]));
    this.#cooldowns = new Map(Object.entries(parsed.cooldowns));
    this.#actedSignals = new Map(Object.entries(parsed.actedSignals ?? {}));
    this.#peakEquityUsdt = parsed.peakEquityUsdt;
  }

  #persist(): void {
    const snapshot: Snapshot = {
      positions: [...this.#positions.values()],
      cooldowns: Object.fromEntries(this.#cooldowns),
      peakEquityUsdt: this.#peakEquityUsdt,
      actedSignals: Object.fromEntries(this.#actedSignals),
    };
    const temporary = `${this.#path}.tmp`;
    writeFileSync(temporary, JSON.stringify(snapshot, null, 2), 'utf8');
    renameSync(temporary, this.#path);
  }

  positions(): readonly TrackedPosition[] {
    return [...this.#positions.values()];
  }

  position(instId: string): TrackedPosition | undefined {
    return this.#positions.get(instId);
  }

  open(position: TrackedPosition): void {
    if (this.#positions.has(position.instId)) {
      throw new EngineStateError(`already tracking a position on ${position.instId}`);
    }
    this.#positions.set(position.instId, position);
    this.#persist();
  }

  update(position: TrackedPosition): void {
    if (!this.#positions.has(position.instId)) {
      throw new EngineStateError(`not tracking a position on ${position.instId}`);
    }
    this.#positions.set(position.instId, position);
    this.#persist();
  }

  close(instId: string, cooldownUntilMs: number): void {
    this.#positions.delete(instId);
    this.#cooldowns.set(instId, cooldownUntilMs);
    this.#persist();
  }

  /** Cooldown expiry for an instrument, or undefined if it is not cooling down. */
  cooldownUntil(instId: string, nowMs: number): number | undefined {
    const until = this.#cooldowns.get(instId);
    if (until === undefined) return undefined;
    if (until <= nowMs) {
      this.#cooldowns.delete(instId);
      this.#persist();
      return undefined;
    }
    return until;
  }

  /**
   * Cooldowns still in force, expired ones dropped.
   *
   * Returned as a map rather than a list so a caller cannot iterate the
   * instruments without also holding the expiry it has to respect.
   */
  activeCooldowns(nowMs: number): ReadonlyMap<string, number> {
    const active = new Map<string, number>();
    let expired = false;
    for (const [instId, until] of this.#cooldowns) {
      if (until <= nowMs) {
        this.#cooldowns.delete(instId);
        expired = true;
      } else {
        active.set(instId, until);
      }
    }
    if (expired) this.#persist();
    return active;
  }

  /**
   * Record observed equity and return the peak.
   *
   * The peak only ever rises. Letting it fall would reset the drawdown
   * measurement at the worst possible moment — mid-drawdown — which is exactly
   * when the governor is supposed to be tightening.
   */
  observeEquity(equityUsdt: number): number {
    if (equityUsdt > this.#peakEquityUsdt) {
      this.#peakEquityUsdt = equityUsdt;
      this.#persist();
    }
    return this.#peakEquityUsdt;
  }

  get peakEquityUsdt(): number {
    return this.#peakEquityUsdt;
  }

  /**
   * A durable `SignalJournal` for the copy executor.
   *
   * Structurally typed against `copy.ts`'s interface rather than importing it,
   * so the execution layer keeps no dependency on engine state.
   */
  signalJournal(now: () => number = () => Date.now()): {
    has(signalId: string): boolean;
    record(signalId: string): void;
  } {
    return {
      has: (signalId) => this.#actedSignals.has(signalId),
      record: (signalId) => {
        const nowMs = now();
        this.#actedSignals.set(signalId, nowMs);
        // Pruned on write, so the file cannot grow without bound and no
        // separate sweep has to be remembered.
        for (const [id, at] of this.#actedSignals) {
          if (nowMs - at > SIGNAL_MEMORY_MS) this.#actedSignals.delete(id);
        }
        this.#persist();
      },
    };
  }
}

/**
 * Advance a tracked position's Chandelier anchors with a newly observed price.
 *
 * Extremes only widen. This is the same one-way property as `ratchetStop`, one
 * level down: if the anchor could retreat, the stop derived from it would
 * loosen, and no amount of care in `evaluateExit` would prevent it.
 */
export function withObservedPrice(position: TrackedPosition, price: number): TrackedPosition {
  if (!Number.isFinite(price) || price <= 0) {
    throw new EngineStateError(`cannot observe a price of ${price} on ${position.instId}`);
  }
  return {
    ...position,
    highWaterPrice: Math.max(position.highWaterPrice, price),
    lowWaterPrice: Math.min(position.lowWaterPrice, price),
  };
}

/** A freshly opened position, with both anchors seeded at the entry price. */
export function trackNewPosition(input: {
  instId: string;
  signalId: string;
  side: Side;
  entryPrice: number;
  initialStop: number;
  openedAtMs: number;
  venueSize: bigint;
}): TrackedPosition {
  return {
    instId: input.instId,
    signalId: input.signalId,
    side: input.side,
    entryPrice: input.entryPrice,
    initialStop: input.initialStop,
    currentStop: input.initialStop,
    remainingFraction: 1,
    openedAtMs: input.openedAtMs,
    scaledOut: false,
    highWaterPrice: input.entryPrice,
    lowWaterPrice: input.entryPrice,
    venueSize: input.venueSize.toString(),
  };
}
