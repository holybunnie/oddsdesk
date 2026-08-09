import type { Instrument, Position } from '../execution/adapter.js';
import type { KillSwitch } from '../kill-switch.js';
import { readHeartbeat, type HeartbeatRecord } from './heartbeat.js';

export interface WatchdogVenue {
  openPositions(): Promise<readonly Position[]>;
  flatten(instrument: Instrument): Promise<unknown>;
}

export interface PositionWatchdogOptions {
  readonly venue: WatchdogVenue;
  readonly killSwitch: KillSwitch;
  readonly heartbeatPath: string;
  readonly staleAfterMs: number;
  readonly maxFlattenAttempts?: number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
  /** External Telegram/Discord/systemd bridge; called for every watchdog event. */
  readonly onAlert?: (message: string) => void | Promise<void>;
}

export interface WatchdogResult {
  readonly healthy: boolean;
  readonly heartbeat: HeartbeatRecord | null;
  readonly staleByMs: number;
  readonly positionsSeen: number;
  readonly positionsFlattened: number;
  readonly failures: readonly string[];
}

export class WatchdogError extends Error {
  override readonly name = 'WatchdogError';
}

/**
 * Client-held-stop watchdog. It is deliberately a one-check object so systemd,
 * a test, or another supervisor owns the timer and restart policy.
 */
export class PositionWatchdog {
  readonly #options: PositionWatchdogOptions;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #now: () => number;

  constructor(options: PositionWatchdogOptions) {
    if (!Number.isFinite(options.staleAfterMs) || options.staleAfterMs <= 0) {
      throw new WatchdogError(`staleAfterMs must be positive and finite, got ${options.staleAfterMs}`);
    }
    this.#options = options;
    this.#sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.#now = options.now ?? (() => Date.now());
  }

  async check(): Promise<WatchdogResult> {
    const now = this.#now();
    let heartbeat: HeartbeatRecord | null = null;
    let staleByMs = Number.POSITIVE_INFINITY;
    try {
      heartbeat = readHeartbeat(this.#options.heartbeatPath);
      staleByMs = now - heartbeat.writtenAtMs;
    } catch (error) {
      await this.#alert(`WATCHDOG heartbeat unavailable: ${(error as Error).message}`);
    }

    if (heartbeat !== null && staleByMs <= this.#options.staleAfterMs) {
      return { healthy: true, heartbeat, staleByMs, positionsSeen: 0, positionsFlattened: 0, failures: [] };
    }

    const reason = heartbeat === null
      ? 'heartbeat missing or malformed'
      : `heartbeat stale by ${(staleByMs / 1000).toFixed(1)}s (limit ${this.#options.staleAfterMs / 1000}s)`;
    if (!this.#options.killSwitch.isTripped('routeB')) {
      this.#options.killSwitch.trip('routeB', 'watchdog', reason, now);
    }
    await this.#alert(`WATCHDOG stale: ${reason}; flattening client-held positions`);

    let positions: readonly Position[] = [];
    const failures: string[] = [];
    try {
      positions = await this.#options.venue.openPositions();
    } catch (error) {
      const message = `cannot read venue positions: ${(error as Error).message}`;
      failures.push(message);
      await this.#alert(`WATCHDOG ALERT: ${message}`);
    }

    let positionsFlattened = 0;
    const attempts = this.#options.maxFlattenAttempts ?? 3;
    for (const position of positions) {
      let flattened = false;
      for (let attempt = 1; attempt <= attempts; attempt += 1) {
        try {
          await this.#options.venue.flatten(position.instrument);
          positionsFlattened += 1;
          flattened = true;
          await this.#alert(`WATCHDOG flattened ${position.instrument.symbol} on attempt ${attempt}`);
          break;
        } catch (error) {
          const message = `${position.instrument.symbol} flatten attempt ${attempt}/${attempts} failed: ${(error as Error).message}`;
          if (attempt === attempts) {
            failures.push(message);
            await this.#alert(`WATCHDOG ALERT: ${message}`);
          } else {
            await this.#sleep(250 * 2 ** (attempt - 1));
          }
        }
      }
      if (!flattened) continue;
    }

    return {
      healthy: false,
      heartbeat,
      staleByMs,
      positionsSeen: positions.length,
      positionsFlattened,
      failures,
    };
  }

  async #alert(message: string): Promise<void> {
    await this.#options.onAlert?.(message);
  }
}
