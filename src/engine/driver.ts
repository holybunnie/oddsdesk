/**
 * The driver — what actually runs the agent.
 *
 * Everything below it is a value or a function. This is the only part that owns
 * a timer, a process, and the decision to keep going after something failed.
 * That last one is the whole design problem, and the answer is not "retry":
 *
 *   - A **transient** failure (a 429, a socket reset, one bad candle response)
 *     must not stop the agent. The competition runs for two weeks and the ASP
 *     must never go down; an engine that exits on the first HTTP hiccup fails
 *     the eligibility requirement it was built to satisfy.
 *   - A **structural** failure — unbalanced signal accounting, corrupt state,
 *     a tripped kill switch that keeps tripping — must stop it. Looping through
 *     a broken invariant is how a small fault becomes a fortnight of bad trades.
 *
 * So consecutive failures are counted, not just logged. A run of them trips the
 * kill switch and halts, because the difference between "the venue blipped" and
 * "we are broken" is not visible in any single error — only in the pattern.
 *
 * Cycles never overlap. `setInterval` would happily start a second cycle while
 * the first is still reconciling, and two cycles reading the same position book
 * would double-size the same candidate. The next cycle is scheduled after the
 * previous one finishes, always.
 */

import type { Config } from '../config.js';
import type { KillSwitch } from '../kill-switch.js';
import type { Ledger } from '../ledger.js';
import type { OkxMarketData } from '../market/okx.js';
import type { BinanceMarketData } from '../market/binance.js';
import type { Engine, CycleReport } from './loop.js';
import { runScan, type ScanDiagnostics } from './scan.js';
import type { EngineState } from './state.js';

export class DriverError extends Error {
  override readonly name = 'DriverError';
}

/**
 * Consecutive failed cycles before the driver trips the kill switch.
 *
 * Three rather than one: a single transient venue error must not halt a
 * fortnight of trading. Three rather than ten: by the tenth, a real fault has
 * had an hour of open positions going unmanaged.
 */
const MAX_CONSECUTIVE_FAILURES = 3;

export interface DriverDeps {
  readonly config: Config;
  readonly engine: Engine;
  readonly state: EngineState;
  readonly market: OkxMarketData;
  readonly binance?: BinanceMarketData;
  readonly ledger: Ledger;
  readonly killSwitch: KillSwitch;
  /** Seconds between the END of one cycle and the START of the next. */
  readonly intervalSeconds: number;
  /** Injected so tests do not wait in real time. */
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
  readonly onCycle?: (report: CycleReport, scan: ScanDiagnostics) => void;
}

export class Driver {
  readonly #deps: DriverDeps;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #now: () => number;
  #stopping = false;
  #consecutiveFailures = 0;

  constructor(deps: DriverDeps) {
    this.#deps = deps;
    this.#sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.#now = deps.now ?? (() => Date.now());
  }

  /**
   * Ask the driver to finish the current cycle and stop.
   *
   * Deliberately not an abort: interrupting a cycle mid-way could leave a
   * position opened but untracked, which is the one inconsistency the state
   * file cannot repair on its own.
   */
  stop(): void {
    this.#stopping = true;
  }

  get stopping(): boolean {
    return this.#stopping;
  }

  /** Run one scan-and-cycle. Exposed so it can be run once, for a dry run. */
  async runOnce(): Promise<{ report: CycleReport; scan: ScanDiagnostics }> {
    const nowMs = this.#now();
    const open = this.#deps.state.positions().map((p) => p.instId);

    // Cooldowns are read here and handed to E4. The engine checks them again
    // before sizing; this pass exists so a cooling-down instrument never
    // becomes a candidate in the first place, and so the scan report shows the
    // cooldown as the reason rather than a mysterious absence.
    const cooldowns = this.#deps.state.activeCooldowns(nowMs);

    const scan = await runScan({
      config: this.#deps.config,
      market: this.#deps.market,
      ...(this.#deps.binance === undefined ? {} : { binance: this.#deps.binance }),
      mustPrice: open,
      cooldowns,
      nowMs,
    });

    const report = await this.#deps.engine.runCycle(scan.result);
    return { report, scan };
  }

  /**
   * Run until stopped or halted.
   *
   * Returns rather than throwing when it halts: the caller is a process that
   * needs to exit non-zero and say why, and an exception would lose the
   * accumulated context in favour of the last error alone.
   */
  async run(): Promise<{ cycles: number; haltedBecause: string | null }> {
    let cycles = 0;

    while (!this.#stopping) {
      try {
        const { report, scan } = await this.runOnce();
        cycles += 1;
        this.#consecutiveFailures = 0;
        this.#deps.onCycle?.(report, scan);
      } catch (error) {
        cycles += 1;
        this.#consecutiveFailures += 1;
        const message = (error as Error).message;

        this.#deps.ledger.append({
          action: 'alert',
          engine: 'driver',
          venue: null,
          instrument: null,
          signal: null,
          price: null,
          size: null,
          stop: null,
          reason: `cycle failed (${this.#consecutiveFailures} consecutive): ${message}`,
        });

        if (this.#consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          // The pattern, not the individual error, is the evidence. One failure
          // is the venue; three in a row is us.
          const reason =
            `${this.#consecutiveFailures} consecutive failed cycles, last: ${message}`;
          this.#deps.killSwitch.trip('routeB', 'driver', reason);
          return { cycles, haltedBecause: reason };
        }
      }

      if (this.#stopping) break;
      await this.#sleep(this.#deps.intervalSeconds * 1000);
    }

    return { cycles, haltedBecause: null };
  }
}
