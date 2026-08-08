/**
 * Append-only, hash-chained decision ledger.
 *
 * Law 4: every decision leaves a receipt — including refusals. A trade that was
 * declined by the risk-token gate, the drawdown governor or the conviction gate
 * is as much a decision as one that was placed, and on day four the refusals are
 * the entries that explain the equity curve.
 *
 * The chain exists so tampering and corruption are detectable rather than
 * assumed-absent: each row commits to its predecessor's hash. verifyChain()
 * walks the whole ledger and is cheap enough to run at every startup.
 */

import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import Database from 'better-sqlite3';

export type LedgerAction =
  | 'order_submitted'
  | 'order_filled'
  | 'order_rejected'
  | 'order_cancelled'
  | 'position_opened'
  | 'position_closed'
  | 'stop_attached'
  | 'refusal'
  | 'halt'
  | 'resume'
  | 'stage_change'
  | 'reconciliation'
  | 'probe_result'
  | 'signal_published'
  | 'signal_rejected'
  | 'alert';

/**
 * Money crosses this boundary as a decimal string, never a float. Callers hold
 * bigint minor units; the string preserves them exactly through SQLite and JSON.
 */
export interface LedgerEntry {
  readonly action: LedgerAction;
  readonly engine: string;
  readonly venue: string | null;
  readonly instrument: string | null;
  readonly signal: string | null;
  /** Decimal string in venue quote units, e.g. "0.0842". */
  readonly price: string | null;
  /** Decimal string. Size, not notional. */
  readonly size: string | null;
  /** Decimal string. Absent for entries where no stop applies. */
  readonly stop: string | null;
  /** Why this happened. Mandatory — an entry without a reason is not a receipt. */
  readonly reason: string;
  /** Anything structured worth keeping: raw venue responses, probe output. */
  readonly detail?: Readonly<Record<string, unknown>>;
}

export interface LedgerRow extends LedgerEntry {
  readonly seq: number;
  readonly timestampMs: number;
  readonly prevHash: string;
  readonly hash: string;
}

export class LedgerIntegrityError extends Error {
  override readonly name = 'LedgerIntegrityError';
}

/** Genesis predecessor for the first row. */
const GENESIS_HASH = '0'.repeat(64);

interface RawRow {
  seq: number;
  timestamp_ms: number;
  action: string;
  engine: string;
  venue: string | null;
  instrument: string | null;
  signal: string | null;
  price: string | null;
  size: string | null;
  stop: string | null;
  reason: string;
  detail: string | null;
  prev_hash: string;
  hash: string;
}

/**
 * Hash covers every field that matters plus the predecessor, so a row cannot be
 * edited, reordered or removed without breaking the chain from that point on.
 */
function computeHash(
  seq: number,
  timestampMs: number,
  entry: LedgerEntry,
  detailJson: string | null,
  prevHash: string,
): string {
  const payload = JSON.stringify([
    seq,
    timestampMs,
    entry.action,
    entry.engine,
    entry.venue,
    entry.instrument,
    entry.signal,
    entry.price,
    entry.size,
    entry.stop,
    entry.reason,
    detailJson,
    prevHash,
  ]);
  return createHash('sha256').update(payload, 'utf8').digest('hex');
}

export class Ledger {
  readonly #db: Database.Database;

  constructor(path: string) {
    const absolute = resolve(path);
    mkdirSync(dirname(absolute), { recursive: true });

    this.#db = new Database(absolute);
    // WAL survives process death mid-write, which is the failure this ledger
    // exists to be readable after.
    this.#db.pragma('journal_mode = WAL');
    this.#db.pragma('synchronous = FULL');

    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS ledger (
        seq          INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp_ms INTEGER NOT NULL,
        action       TEXT    NOT NULL,
        engine       TEXT    NOT NULL,
        venue        TEXT,
        instrument   TEXT,
        signal       TEXT,
        price        TEXT,
        size         TEXT,
        stop         TEXT,
        reason       TEXT    NOT NULL,
        detail       TEXT,
        prev_hash    TEXT    NOT NULL,
        hash         TEXT    NOT NULL UNIQUE
      );
      CREATE INDEX IF NOT EXISTS idx_ledger_ts     ON ledger(timestamp_ms);
      CREATE INDEX IF NOT EXISTS idx_ledger_engine ON ledger(engine, timestamp_ms);
      CREATE INDEX IF NOT EXISTS idx_ledger_action ON ledger(action, timestamp_ms);
    `);

    // Append-only is enforced in the database, not by convention in the code
    // above it. Any UPDATE or DELETE raises, including one issued by hand.
    this.#db.exec(`
      CREATE TRIGGER IF NOT EXISTS ledger_no_update
        BEFORE UPDATE ON ledger
        BEGIN SELECT RAISE(ABORT, 'ledger is append-only: UPDATE refused'); END;
      CREATE TRIGGER IF NOT EXISTS ledger_no_delete
        BEFORE DELETE ON ledger
        BEGIN SELECT RAISE(ABORT, 'ledger is append-only: DELETE refused'); END;
    `);
  }

  /** Hash of the most recent row, or the genesis hash on an empty ledger. */
  #tipHash(): string {
    const row = this.#db
      .prepare<[], { hash: string }>('SELECT hash FROM ledger ORDER BY seq DESC LIMIT 1')
      .get();
    return row?.hash ?? GENESIS_HASH;
  }

  /**
   * Append one entry and return the committed row.
   *
   * Wrapped in an IMMEDIATE transaction so two processes appending concurrently
   * cannot both read the same tip and fork the chain.
   */
  append(entry: LedgerEntry, timestampMs: number = Date.now()): LedgerRow {
    if (entry.reason.trim() === '') {
      throw new LedgerIntegrityError('ledger entry requires a reason — an entry without one is not a receipt');
    }

    const detailJson = entry.detail === undefined ? null : JSON.stringify(entry.detail);

    const txn = this.#db.transaction((): LedgerRow => {
      const prevHash = this.#tipHash();

      const nextSeqRow = this.#db
        .prepare<[], { next: number }>("SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM ledger")
        .get();
      if (nextSeqRow === undefined) {
        throw new LedgerIntegrityError('could not determine next ledger sequence');
      }
      const seq = nextSeqRow.next;

      const hash = computeHash(seq, timestampMs, entry, detailJson, prevHash);

      this.#db
        .prepare(
          `INSERT INTO ledger
             (seq, timestamp_ms, action, engine, venue, instrument, signal,
              price, size, stop, reason, detail, prev_hash, hash)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          seq,
          timestampMs,
          entry.action,
          entry.engine,
          entry.venue,
          entry.instrument,
          entry.signal,
          entry.price,
          entry.size,
          entry.stop,
          entry.reason,
          detailJson,
          prevHash,
          hash,
        );

      return { ...entry, seq, timestampMs, prevHash, hash };
    });

    return txn.immediate();
  }

  /**
   * Walk the chain and recompute every hash.
   *
   * Run this at startup. A ledger that cannot be verified must halt the agent —
   * if the receipts are unreliable, nothing built on top of them is trustworthy.
   */
  verifyChain(): { verified: number } {
    const rows = this.#db
      .prepare<[], RawRow>('SELECT * FROM ledger ORDER BY seq ASC')
      .all();

    let expectedPrev = GENESIS_HASH;
    let expectedSeq = 1;

    for (const row of rows) {
      if (row.seq !== expectedSeq) {
        throw new LedgerIntegrityError(
          `ledger sequence gap: expected seq ${expectedSeq}, found ${row.seq}`,
        );
      }
      if (row.prev_hash !== expectedPrev) {
        throw new LedgerIntegrityError(
          `ledger chain broken at seq ${row.seq}: prev_hash does not match predecessor`,
        );
      }

      const entry: LedgerEntry = {
        action: row.action as LedgerAction,
        engine: row.engine,
        venue: row.venue,
        instrument: row.instrument,
        signal: row.signal,
        price: row.price,
        size: row.size,
        stop: row.stop,
        reason: row.reason,
      };
      const recomputed = computeHash(row.seq, row.timestamp_ms, entry, row.detail, row.prev_hash);

      if (recomputed !== row.hash) {
        throw new LedgerIntegrityError(
          `ledger row ${row.seq} has been altered: stored hash does not match its contents`,
        );
      }

      expectedPrev = row.hash;
      expectedSeq += 1;
    }

    return { verified: rows.length };
  }

  /** Most recent entries, newest first. For the daily report and post-mortems. */
  recent(limit: number): readonly LedgerRow[] {
    const rows = this.#db
      .prepare<[number], RawRow>('SELECT * FROM ledger ORDER BY seq DESC LIMIT ?')
      .all(limit);
    return rows.map(toLedgerRow);
  }

  /** Entries for one engine since a timestamp. Feeds the attribution step. */
  forEngineSince(engine: string, sinceMs: number): readonly LedgerRow[] {
    const rows = this.#db
      .prepare<[string, number], RawRow>(
        'SELECT * FROM ledger WHERE engine = ? AND timestamp_ms >= ? ORDER BY seq ASC',
      )
      .all(engine, sinceMs);
    return rows.map(toLedgerRow);
  }

  close(): void {
    this.#db.close();
  }
}

function toLedgerRow(row: RawRow): LedgerRow {
  return {
    seq: row.seq,
    timestampMs: row.timestamp_ms,
    prevHash: row.prev_hash,
    hash: row.hash,
    action: row.action as LedgerAction,
    engine: row.engine,
    venue: row.venue,
    instrument: row.instrument,
    signal: row.signal,
    price: row.price,
    size: row.size,
    stop: row.stop,
    reason: row.reason,
    ...(row.detail === null ? {} : { detail: JSON.parse(row.detail) as Record<string, unknown> }),
  };
}
