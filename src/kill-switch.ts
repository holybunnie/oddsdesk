/**
 * Kill switch — an append-only file, checked every tick, trippable by any process.
 *
 * A file rather than an in-process flag on purpose: it must be trippable from an
 * SSH session, from the watchdog, from a cron job, or by a human at 3am who
 * cannot attach a debugger. It must also survive the agent dying — a kill switch
 * that forgets it was tripped when the process restarts is not a kill switch.
 *
 * Tripping is one-way. Clearing requires deliberate human action (delete the
 * file), which is exactly the friction it should have.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export type KillScope = 'all' | 'routeA' | 'routeB';

export interface KillRecord {
  readonly timestampMs: number;
  readonly scope: KillScope;
  readonly trippedBy: string;
  readonly reason: string;
}

export class KillSwitchTripped extends Error {
  override readonly name = 'KillSwitchTripped';
  readonly records: readonly KillRecord[];

  constructor(scope: KillScope, records: readonly KillRecord[]) {
    const reasons = records.map((r) => `${r.trippedBy}: ${r.reason}`).join('; ');
    super(`kill switch is tripped for scope "${scope}" — ${reasons}`);
    this.records = records;
  }
}

export class KillSwitch {
  readonly #path: string;

  constructor(path: string) {
    this.#path = resolve(path);
    mkdirSync(dirname(this.#path), { recursive: true });
  }

  get path(): string {
    return this.#path;
  }

  /**
   * Trip the switch. Append-only: every trip is preserved, so the first cause is
   * still readable after later ones pile on.
   */
  trip(scope: KillScope, trippedBy: string, reason: string, timestampMs = Date.now()): void {
    if (reason.trim() === '') {
      throw new Error('kill switch requires a reason');
    }
    const record: KillRecord = { timestampMs, scope, trippedBy, reason };
    appendFileSync(this.#path, `${JSON.stringify(record)}\n`, 'utf8');
  }

  /** Every trip record on file, oldest first. */
  records(): readonly KillRecord[] {
    if (!existsSync(this.#path)) return [];

    const raw = readFileSync(this.#path, 'utf8');
    const records: KillRecord[] = [];

    for (const [index, line] of raw.split('\n').entries()) {
      const trimmed = line.trim();
      if (trimmed === '') continue;

      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch (cause) {
        // A malformed line means someone touched the file. Treat it as tripped:
        // an unreadable kill switch must fail closed, never open.
        throw new Error(
          `kill switch file ${this.#path} has an unparseable record at line ${index + 1} — ` +
            'treating as tripped. Inspect the file by hand before clearing.',
          { cause },
        );
      }

      records.push(parsed as KillRecord);
    }

    return records;
  }

  /** Records that apply to a scope. An 'all' trip applies to every scope. */
  recordsFor(scope: KillScope): readonly KillRecord[] {
    return this.records().filter((r) => r.scope === 'all' || r.scope === scope);
  }

  isTripped(scope: KillScope): boolean {
    return this.recordsFor(scope).length > 0;
  }

  /**
   * Call this before anything that risks money. Throws if tripped.
   *
   * Deliberately a throw and not a boolean: a caller can forget to check a
   * boolean and carry on, which is the exact silent-degradation failure Law 3
   * exists to prevent.
   */
  assertClear(scope: KillScope): void {
    const records = this.recordsFor(scope);
    if (records.length > 0) {
      throw new KillSwitchTripped(scope, records);
    }
  }
}
