import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { loadConfig, type Config } from '../config.js';
import { Ledger } from '../ledger.js';
import { KillSwitch } from '../kill-switch.js';
import type { OkxMarketData } from '../market/okx.js';
import { Driver } from './driver.js';
import type { CycleReport, Engine } from './loop.js';
import { EngineState, trackNewPosition } from './state.js';
import type { ScanDiagnostics, ScanOptions } from './scan.js';

const NOW = Date.UTC(2026, 7, 12, 9, 0, 0);

const emptyReport: CycleReport = {
  stage: 1,
  governor: 'normal',
  phase: 'open',
  equityUsdt: 400,
  peakEquityUsdt: 400,
  exits: [],
  outcomes: [],
  signals: { generated: 0, delivered: 0, rejected: 0 },
  standDownReason: null,
};

/**
 * The driver's job is scheduling and failure policy, not scanning. `runScan` is
 * covered against a stubbed venue in scan.test.ts; here it is replaced whole so
 * the tests speak only about cycles.
 */
class TestDriver extends Driver {
  scanImpl: (options: ScanOptions) => Promise<ScanDiagnostics> = async () => diagnostics();
  cycleImpl: () => Promise<CycleReport> = async () => emptyReport;
  concurrent = 0;
  maxConcurrent = 0;

  override async runOnce(): Promise<{ report: CycleReport; scan: ScanDiagnostics }> {
    this.concurrent += 1;
    this.maxConcurrent = Math.max(this.maxConcurrent, this.concurrent);
    try {
      const scan = await this.scanImpl({} as ScanOptions);
      const report = await this.cycleImpl();
      return { report, scan };
    } finally {
      this.concurrent -= 1;
    }
  }
}

function diagnostics(): ScanDiagnostics {
  return {
    result: {
      candidates: [],
      regimeFavourable: true,
      lastPrices: new Map(),
      atrByInstrument: new Map(),
      feeds: [],
    },
    liveUsdtPerps: 423,
    universeSize: 79,
    ranked: [],
    assessed: [],
    rejected: [],
    regimePassing: 0,
    regimeConsidered: 0,
    universeRejections: [],
  };
}

let dir: string;
let config: Config;
let seq = 0;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'driver-'));
  config = loadConfig('config/default.yaml');
});

function build(overrides: { intervalSeconds?: number } = {}) {
  const state = new EngineState(join(dir, `state-${seq++}.json`));
  const ledger = new Ledger(join(dir, `ledger-${seq}.db`));
  const killSwitch = new KillSwitch(join(dir, `kill-${seq}.jsonl`));
  const engine = { runCycle: async () => emptyReport } as unknown as Engine;

  const driver = new TestDriver({
    config,
    engine,
    state,
    market: {} as OkxMarketData,
    ledger,
    killSwitch,
    intervalSeconds: overrides.intervalSeconds ?? 60,
    sleep: async () => {}, // Tests must not wait in real time.
    now: () => NOW,
  });

  return { driver, state, ledger, killSwitch };
}

describe('scheduling', () => {
  it('never runs two cycles at once', async () => {
    // setInterval would start a second cycle while the first is reconciling,
    // and two cycles reading the same position book double-size a candidate.
    const { driver } = build();
    let cycles = 0;
    driver.cycleImpl = async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      cycles += 1;
      if (cycles >= 3) driver.stop();
      return emptyReport;
    };

    await driver.run();

    expect(driver.maxConcurrent).toBe(1);
    expect(cycles).toBe(3);
  });

  it('finishes the cycle in flight when asked to stop', async () => {
    // Not an abort: interrupting mid-cycle can leave a position opened but
    // untracked, the one inconsistency the state file cannot repair.
    const { driver } = build();
    let finished = false;
    driver.cycleImpl = async () => {
      driver.stop();
      await new Promise((resolve) => setTimeout(resolve, 5));
      finished = true;
      return emptyReport;
    };

    const result = await driver.run();

    expect(finished).toBe(true);
    expect(result.cycles).toBe(1);
    expect(result.haltedBecause).toBeNull();
  });
});

describe('failure policy', () => {
  it('survives a transient failure and keeps trading', async () => {
    // The ASP must never go down. An engine that exits on the first HTTP hiccup
    // fails the eligibility requirement it was built to satisfy.
    const { driver, killSwitch } = build();
    let cycles = 0;
    driver.cycleImpl = async () => {
      cycles += 1;
      if (cycles === 1) throw new Error('HTTP 429 from the venue');
      if (cycles >= 3) driver.stop();
      return emptyReport;
    };

    const result = await driver.run();

    expect(result.haltedBecause).toBeNull();
    expect(killSwitch.records()).toHaveLength(0);
  });

  it('trips the kill switch after three consecutive failures', async () => {
    // One failure is the venue; three in a row is us. The pattern is the
    // evidence, and it is not visible in any single error.
    const { driver, killSwitch } = build();
    driver.cycleImpl = async () => {
      throw new Error('state file is corrupt');
    };

    const result = await driver.run();

    expect(result.cycles).toBe(3);
    expect(result.haltedBecause).toMatch(/3 consecutive failed cycles/);
    expect(killSwitch.records()[0]?.scope).toBe('routeB');
  });

  it('resets the failure count after a good cycle', async () => {
    // Otherwise three failures spread over a fortnight would halt the agent.
    const { driver } = build();
    let cycles = 0;
    driver.cycleImpl = async () => {
      cycles += 1;
      if (cycles === 1 || cycles === 2 || cycles === 4 || cycles === 5) {
        throw new Error('transient');
      }
      if (cycles >= 7) driver.stop();
      return emptyReport;
    };

    const result = await driver.run();

    expect(result.haltedBecause).toBeNull();
  });

  it('records every failed cycle in the ledger before deciding', async () => {
    const { driver, ledger } = build();
    driver.cycleImpl = async () => {
      throw new Error('venue unreachable');
    };

    await driver.run();
    const alerts = ledger.recent(20).filter((row) => row.action === 'alert');

    expect(alerts).toHaveLength(3);
    expect(alerts[0]?.reason).toMatch(/venue unreachable/);
  });
});

describe('what the driver hands the scan', () => {
  it('fetches an open position even when it fell out of the E1 universe', async () => {
    // An instrument whose volume dries up leaves the universe, but a position
    // in it still has to be managed, and the engine refuses to manage a
    // position it cannot price.
    const fetched: string[] = [];
    const market = {
      instruments: async () => [],
      tickers: async () => [],
      candles: async (instId: string) => {
        fetched.push(instId);
        return [];
      },
      fundingRate: async () => 0,
    } as unknown as OkxMarketData;

    const state = new EngineState(join(dir, 'must-price.json'));
    state.open(
      trackNewPosition({
        instId: 'ILLIQUID-USDT-SWAP',
        signalId: 'S-1',
        side: 'long',
        entryPrice: 1,
        initialStop: 0.9,
        openedAtMs: NOW,
        venueSize: 1n,
      }),
    );

    const driver = new Driver({
      config,
      engine: { runCycle: async () => emptyReport } as unknown as Engine,
      state,
      market,
      ledger: new Ledger(join(dir, 'must-price.db')),
      killSwitch: new KillSwitch(join(dir, 'must-price.jsonl')),
      intervalSeconds: 60,
      now: () => NOW,
    });

    await driver.runOnce();

    expect(fetched).toContain('ILLIQUID-USDT-SWAP');
  });

  it('hands active cooldowns to the scan so E4 sees them', async () => {
    // scan.ts is stateless and over-reports by design. The engine is the only
    // thing that knows, so it must not rely on having remembered to pass them.
    const state = new EngineState(join(dir, 'cooldown-pass.json'));
    state.close('BTC-USDT-SWAP', NOW + 3_600_000);

    expect([...state.activeCooldowns(NOW).keys()]).toEqual(['BTC-USDT-SWAP']);
  });
});

describe('the durable signal journal', () => {
  it('remembers acted-on signals across a restart', async () => {
    // An in-memory set loses dedupe exactly when a redelivery is most likely:
    // whatever restarted us may also have interrupted an acknowledgement.
    const path = join(dir, 'journal.json');
    const first = new EngineState(path);
    first.signalJournal(() => NOW).record('S-2608091200-BTC-L');

    const second = new EngineState(path);
    const journal = second.signalJournal(() => NOW);

    expect(journal.has('S-2608091200-BTC-L')).toBe(true);
    expect(journal.has('S-2608091200-ETH-L')).toBe(false);
  });

  it('forgets an entry old enough that the competition is long over', async () => {
    // Bounded so the state file cannot grow forever. Two weeks covers the whole
    // trading window, so within the period that matters it never forgets.
    const path = join(dir, 'journal-prune.json');
    const state = new EngineState(path);
    state.signalJournal(() => NOW).record('S-OLD');
    state.signalJournal(() => NOW + 15 * 24 * 3_600_000).record('S-NEW');

    const reloaded = new EngineState(path).signalJournal(() => NOW);
    expect(reloaded.has('S-OLD')).toBe(false);
    expect(reloaded.has('S-NEW')).toBe(true);
  });
});

describe('active cooldowns', () => {
  it('returns those in force and drops those that expired', () => {
    const state = new EngineState(join(dir, 'cooldowns.json'));
    state.close('BTC-USDT-SWAP', NOW + 3_600_000);
    state.close('ETH-USDT-SWAP', NOW - 1000);

    const active = state.activeCooldowns(NOW);

    expect([...active.keys()]).toEqual(['BTC-USDT-SWAP']);
    expect(active.get('BTC-USDT-SWAP')).toBe(NOW + 3_600_000);
  });
});
