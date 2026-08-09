import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { loadConfig, type Config } from '../config.js';
import { Ledger } from '../ledger.js';
import { KillSwitch } from '../kill-switch.js';
import type { EntryCandidate } from '../signal/entry.js';
import type { Instrument, OrderResult, Position } from '../execution/adapter.js';
import type { CopyExecutor, ExecutionOutcome } from '../execution/copy.js';
import type { GuardedExecutor } from '../execution/guarded.js';
import {
  Engine,
  correlationGroupFor,
  openRiskUsdt,
  signalIdFor,
  type ScanResult,
  type SignalPublisher,
} from './loop.js';
import { EngineState, trackNewPosition, withObservedPrice } from './state.js';

const NOW = Date.UTC(2026, 7, 12, 9, 0, 0);

const btc: Instrument = { symbol: 'BTC-USDT-SWAP', priceDecimals: 1, sizeDecimals: 2, contractValue: 0.01 };
const sol: Instrument = { symbol: 'SOL-USDT-SWAP', priceDecimals: 3, sizeDecimals: 2, contractValue: 1 };
const instruments = new Map([
  [btc.symbol, btc],
  [sol.symbol, sol],
]);

function candidate(overrides: Partial<EntryCandidate> = {}): EntryCandidate {
  return {
    instId: 'BTC-USDT-SWAP',
    direction: 'long',
    breakoutLevel: 64_500,
    lastClose: 64_750,
    entryBandLow: 64_700,
    entryBandHigh: 64_800,
    stopPrice: 64_000,
    targetPrice: 67_200,
    atr: 400,
    conviction: { momentum: 0.9, trendStrength: 0.8, volume: 0.7, multiTimeframe: 0.8, total: 85 },
    validUntilMs: NOW + 3_600_000,
    ...overrides,
  };
}

function scanOf(candidates: readonly EntryCandidate[], overrides: Partial<ScanResult> = {}): ScanResult {
  return {
    candidates,
    regimeFavourable: true,
    lastPrices: new Map([
      [btc.symbol, 64_750],
      [sol.symbol, 150],
    ]),
    atrByInstrument: new Map([
      [btc.symbol, 400],
      [sol.symbol, 4],
    ]),
    feeds: [{ name: 'ohlc', lastUpdateMs: NOW }],
    ...overrides,
  };
}

class FakeGuard {
  readonly flattened: string[] = [];
  reconciled: readonly Position[] = [];
  readonly venue = 'okx-tradekit';

  async reconcile(expected: readonly Position[]): Promise<readonly Position[]> {
    this.reconciled = expected;
    return expected;
  }
  async flatten(instrument: Instrument, reason: string): Promise<OrderResult> {
    this.flattened.push(`${instrument.symbol}:${reason}`);
    return {
      clientOrderId: '',
      venueOrderId: 'F1',
      status: 'accepted',
      filledSize: 0n,
      averagePrice: null,
      feePaid: null,
      stopResting: false,
      raw: {},
    };
  }
}

class FakeCopyExecutor {
  readonly executed: string[] = [];
  outcome: (text: string) => ExecutionOutcome = () => ({
    status: 'submitted',
    signalId: 'S',
    venueOrderId: 'V1',
    size: 24n,
  });

  async execute(text: string): Promise<ExecutionOutcome> {
    this.executed.push(text);
    return this.outcome(text);
  }
}

class FakePublisher implements SignalPublisher {
  readonly published: string[] = [];
  fail = false;
  async publish(text: string): Promise<void> {
    if (this.fail) throw new Error('ASP delivery timed out');
    this.published.push(text);
  }
}

let dir: string;
let baseConfig: Config;
let stateSeq = 0;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'engine-'));
  baseConfig = loadConfig('config/default.yaml');
});

function build(
  overrides: {
    config?: Config;
    equity?: number;
    rankCushion?: boolean | null;
    guard?: FakeGuard;
    copy?: FakeCopyExecutor;
    publisher?: FakePublisher;
  } = {},
) {
  const config: Config = overrides.config ?? {
    ...baseConfig,
    execution: { ...baseConfig.execution, maxLeverage: 5 },
  };
  // Each build gets its own state file: sharing one would leak a position
  // opened by an earlier engine into a later one's portfolio heat.
  const state = new EngineState(join(dir, `state-${stateSeq++}.json`));
  const ledger = new Ledger(join(dir, 'ledger.db'));
  const killSwitch = new KillSwitch(join(dir, 'kill.jsonl'));
  const guard = overrides.guard ?? new FakeGuard();
  const copy = overrides.copy ?? new FakeCopyExecutor();
  const publisher = overrides.publisher ?? new FakePublisher();

  const engine = new Engine({
    config,
    state,
    ledger,
    killSwitch,
    executor: guard as unknown as GuardedExecutor,
    copyExecutor: copy as unknown as CopyExecutor,
    publisher,
    instruments,
    readEquity: async () => overrides.equity ?? 400,
    readRankCushion: async () => overrides.rankCushion ?? null,
    now: () => NOW,
  });

  return { engine, state, ledger, killSwitch, guard, copy, publisher, config };
}

describe('correlationGroupFor', () => {
  it('groups by policy, and gives an unlisted symbol its own bucket', () => {
    // A single shared "other" bucket would make two unrelated small caps count
    // as a correlated pair and refuse a trade we cannot justify refusing.
    expect(correlationGroupFor(baseConfig, 'BTC-USDT-SWAP')).toBe('majors');
    expect(correlationGroupFor(baseConfig, 'SOL-USDT-SWAP')).toBe('layer1');
    expect(correlationGroupFor(baseConfig, 'FARTCOIN-USDT-SWAP')).toBe('ungrouped:FARTCOIN');
    expect(correlationGroupFor(baseConfig, 'AAA-USDT-SWAP')).not.toBe(
      correlationGroupFor(baseConfig, 'BBB-USDT-SWAP'),
    );
  });
});

describe('openRiskUsdt', () => {
  it('measures USDT at risk, not a price distance', () => {
    // 24 lots at scale 2 is 0.24 contracts; at 0.01 BTC each that is 0.0024 BTC.
    // Times an 800 stop distance = 1.92 USDT. Using the bare 800 instead reads
    // as hundreds of percent of portfolio heat and refuses every later trade.
    expect(
      openRiskUsdt(btc, { entryPrice: 64_800, currentStop: 64_000, remainingFraction: 1, venueSize: '24' }),
    ).toBeCloseTo(1.92, 6);
  });

  it('discounts what has already been scaled out', () => {
    expect(
      openRiskUsdt(btc, { entryPrice: 64_800, currentStop: 64_000, remainingFraction: 0.75, venueSize: '24' }),
    ).toBeCloseTo(1.44, 6);
  });
});

describe('signalIdFor', () => {
  it('is sortable and survives the client-order-id stripping', () => {
    const id = signalIdFor(candidate(), NOW);
    expect(id).toBe('S-260812090000-BTC-L');
    expect(id.replace(/[^A-Za-z0-9]/g, '').length).toBeLessThanOrEqual(32);
  });
});

describe('the cycle publishes before it executes', () => {
  it('runs size -> publish -> execute, and executes the published text', async () => {
    // Law 6 is structural only if the executor receives the TEXT, never the
    // plan. This asserts the one direction that matters.
    const { engine, publisher, copy } = build();
    const report = await engine.runCycle(scanOf([candidate()]));

    expect(publisher.published).toHaveLength(1);
    expect(copy.executed).toEqual(publisher.published);
    expect(report.signals).toEqual({ generated: 1, delivered: 1, rejected: 0 });
    expect(report.outcomes[0]?.status).toBe('submitted');
  });

  it('does not trade a signal whose delivery failed', async () => {
    // A trade whose signal never arrived is untraceable to a signal, which is a
    // rule breach rather than an inefficiency.
    const publisher = new FakePublisher();
    publisher.fail = true;
    const { engine, copy } = build({ publisher });
    const report = await engine.runCycle(scanOf([candidate()]));

    expect(copy.executed).toHaveLength(0);
    expect(report.signals).toEqual({ generated: 1, delivered: 0, rejected: 1 });
    expect(report.outcomes[0]).toMatchObject({ status: 'refused' });
  });

  it('sizes the second candidate against a book that includes the first', async () => {
    // Without carrying the new position into the running heat, three candidates
    // in one cycle would each be sized as though the account were flat.
    const { engine, publisher } = build();
    await engine.runCycle(
      scanOf([
        candidate(),
        candidate({
          instId: 'SOL-USDT-SWAP',
          entryBandLow: 149,
          entryBandHigh: 150,
          stopPrice: 145,
          targetPrice: 165,
          conviction: { ...candidate().conviction, total: 80 },
        }),
      ]),
    );

    expect(publisher.published).toHaveLength(2);
    // Both were sized, and heat did not blow past the cap on the second.
    expect(sizeOf(publisher.published[1] ?? '')).toBeGreaterThan(0);
  });

  it('takes the strongest conviction first when slots are finite', async () => {
    // Position slots and heat are finite, so consideration order allocates
    // capital. Scan order would allocate it alphabetically.
    const { engine, publisher } = build();
    await engine.runCycle(
      scanOf([
        candidate({ instId: 'SOL-USDT-SWAP', conviction: { ...candidate().conviction, total: 78 } }),
        candidate({ conviction: { ...candidate().conviction, total: 95 } }),
      ]),
    );

    expect(publisher.published[0]).toContain('BTC-USDT-SWAP');
  });
});

describe('gates on new entries', () => {
  it('stands down when the regime is unfavourable', async () => {
    const { engine, publisher } = build();
    const report = await engine.runCycle(scanOf([candidate()], { regimeFavourable: false }));

    expect(report.standDownReason).toMatch(/regime unfavourable/);
    expect(publisher.published).toHaveLength(0);
  });

  it('stands down when the kill switch is tripped', async () => {
    const { engine, killSwitch, publisher } = build();
    killSwitch.trip('routeB', 'test', 'stop custody unverified');
    const report = await engine.runCycle(scanOf([candidate()]));

    expect(report.standDownReason).toMatch(/kill switch/);
    expect(publisher.published).toHaveLength(0);
  });

  it('refuses to run at all while maxLeverage is unset', async () => {
    const config = { ...baseConfig, execution: { ...baseConfig.execution, maxLeverage: undefined } };
    const { engine } = build({ config });

    await expect(engine.runCycle(scanOf([candidate()]))).rejects.toThrow(/maxLeverage is not set/);
  });

  it('does not re-enter an instrument inside its cooldown', async () => {
    // The engine is the only thing that knows the cooldown, so it must not rely
    // on having remembered to pass it into E4.
    const { engine, state, publisher } = build();
    state.close('BTC-USDT-SWAP', NOW + 3_600_000);
    const report = await engine.runCycle(scanOf([candidate()]));

    expect(publisher.published).toHaveLength(0);
    expect(report.outcomes[0]).toMatchObject({ reason: expect.stringMatching(/cooldown/) });
  });

  it('records a risk refusal rather than dropping the candidate silently', async () => {
    // 1:1 payoff is below the 3:1 minimum. The refusal must appear in the
    // outcomes, not vanish.
    const { engine, publisher } = build();
    const report = await engine.runCycle(scanOf([candidate({ targetPrice: 65_500 })]));

    expect(publisher.published).toHaveLength(0);
    expect(report.outcomes[0]).toMatchObject({ status: 'refused' });
  });
});

describe('the governor', () => {
  it('halves the published size rather than sizing differently from the signal', async () => {
    // What we publish is what we place, at every stage including this one.
    const full = build();
    await full.engine.runCycle(scanOf([candidate()]));
    const fullSize = sizeOf(full.publisher.published[0] ?? '');

    // 400 peak, then 320: a 20% drawdown, inside stage 1's halveSizing band
    // (0.18) and short of flatAndHalt (0.28).
    const halved = build({ equity: 320 });
    halved.state.observeEquity(400);
    const report = await halved.engine.runCycle(scanOf([candidate()]));

    expect(report.governor).toBe('halveSizing');
    expect(sizeOf(halved.publisher.published[0] ?? '')).toBeLessThan(fullSize);
  });

  it('flattens and stands down at the flatAndHalt band', async () => {
    const { engine, state, guard, publisher } = build({ equity: 280 });
    state.observeEquity(400); // 30% drawdown
    state.open(
      trackNewPosition({
        instId: 'BTC-USDT-SWAP',
        signalId: 'S-OLD',
        side: 'long',
        entryPrice: 64_000,
        initialStop: 63_000,
        openedAtMs: NOW - 3_600_000,
        venueSize: 24n,
      }),
    );

    const report = await engine.runCycle(scanOf([candidate()]));

    expect(report.governor).toBe('flatAndHalt');
    expect(guard.flattened.some((f) => f.startsWith('BTC-USDT-SWAP'))).toBe(true);
    expect(publisher.published).toHaveLength(0);
  });

  it('stops for the competition at the deepest band', async () => {
    const { engine, state } = build({ equity: 240 });
    state.observeEquity(400); // 40% drawdown
    const report = await engine.runCycle(scanOf([candidate()]));

    expect(report.governor).toBe('stopForCompetition');
    expect(report.standDownReason).toMatch(/stopped trading/);
  });
});

describe('exits run before entries, and run regardless', () => {
  function withOpenPosition(equity = 400) {
    const built = build({ equity });
    built.state.open(
      trackNewPosition({
        instId: 'BTC-USDT-SWAP',
        signalId: 'S-OLD',
        side: 'long',
        entryPrice: 64_000,
        initialStop: 63_000,
        openedAtMs: NOW - 3_600_000,
        venueSize: 24n,
      }),
    );
    return built;
  }

  it('manages open positions even when the kill switch has stopped new entries', async () => {
    // A halted engine that stops managing its book has not become safe; it has
    // become an abandoned book.
    const built = withOpenPosition();
    built.killSwitch.trip('routeB', 'test', 'halt');
    const report = await built.engine.runCycle(scanOf([candidate()]));

    expect(report.exits).toHaveLength(1);
    expect(report.standDownReason).toMatch(/kill switch/);
  });

  it('manages open positions even when the regime is unfavourable', async () => {
    const built = withOpenPosition();
    const report = await built.engine.runCycle(scanOf([], { regimeFavourable: false }));

    expect(report.exits).toHaveLength(1);
  });

  it('closes a position whose stop was hit and starts its cooldown', async () => {
    const built = withOpenPosition();
    const scan = scanOf([], { lastPrices: new Map([['BTC-USDT-SWAP', 62_500]]) });
    const report = await built.engine.runCycle(scan);

    expect(built.guard.flattened[0]).toMatch(/BTC-USDT-SWAP/);
    expect(built.state.position('BTC-USDT-SWAP')).toBeUndefined();
    expect(built.state.cooldownUntil('BTC-USDT-SWAP', NOW)).toBeGreaterThan(NOW);
    expect(report.exits[0]?.actions[0]?.kind).toBe('close_full');
  });

  it('refuses to manage a position it cannot price', async () => {
    // The alternative is trailing a stop off a stale number, which is exactly
    // the failure the feed-staleness gate exists to prevent one level up.
    const built = withOpenPosition();
    const scan = scanOf([], { lastPrices: new Map(), atrByInstrument: new Map() });

    await expect(built.engine.runCycle(scan)).rejects.toThrow(/refusing to manage it blind/);
  });

  it('reconciles the tracked size, not a placeholder', async () => {
    // A fabricated size would report divergence every cycle and trip the kill
    // switch on a book that is actually correct.
    const built = withOpenPosition();
    await built.engine.runCycle(scanOf([]));

    expect(built.guard.reconciled[0]?.size).toBe(24n);
  });
});

describe('signal accounting', () => {
  it('does not mask a real fault when the accounting is sound', async () => {
    // The balance assertion runs in a finally, so it is capable of replacing the
    // exception on its way out. When the books are straight it must not: a
    // venue outage has to surface as a venue outage.
    const copy = new FakeCopyExecutor();
    copy.outcome = () => {
      throw new Error('venue unreachable');
    };
    const { engine } = build({ copy });

    await expect(engine.runCycle(scanOf([candidate()]))).rejects.toThrow(/venue unreachable/);
  });

  it('counts a delivered signal as settled even if execution then failed', async () => {
    // Delivery and execution are different events. The cycle accounts for
    // publication — conflating them would make an execution failure look like a
    // dropped signal and halt the engine for the wrong reason.
    const copy = new FakeCopyExecutor();
    copy.outcome = () => ({ status: 'refused', signalId: 'S', reason: 'venue rejected' });
    const { engine } = build({ copy });
    const report = await engine.runCycle(scanOf([candidate()]));

    expect(report.signals).toEqual({ generated: 1, delivered: 1, rejected: 0 });
    expect(report.outcomes[0]?.status).toBe('refused');
  });
});

/** Read the published size percentage back out of the signal text. */
function sizeOf(text: string): number {
  const match = /size ([\d.]+)%/.exec(text);
  if (match?.[1] === undefined) throw new Error(`no size in ${JSON.stringify(text)}`);
  return Number(match[1]);
}

describe('EngineState', () => {
  it('survives a restart with cooldowns, positions and the peak intact', async () => {
    // A cooldown that resets on restart is an invitation to re-enter the
    // instrument that just stopped us out, exactly when a crash makes a restart
    // likely.
    const path = join(dir, 'restart.json');
    const first = new EngineState(path);
    first.observeEquity(500);
    first.open(
      trackNewPosition({
        instId: 'SOL-USDT-SWAP',
        signalId: 'S-1',
        side: 'long',
        entryPrice: 150,
        initialStop: 145,
        openedAtMs: NOW,
        venueSize: 7n,
      }),
    );
    first.close('BTC-USDT-SWAP', NOW + 3_600_000);

    const second = new EngineState(path);
    expect(second.peakEquityUsdt).toBe(500);
    expect(second.position('SOL-USDT-SWAP')?.signalId).toBe('S-1');
    expect(second.cooldownUntil('BTC-USDT-SWAP', NOW)).toBe(NOW + 3_600_000);
  });

  it('refuses to start with an empty book when the state file is corrupt', async () => {
    const path = join(dir, 'corrupt.json');
    const { writeFileSync } = await import('node:fs');
    writeFileSync(path, '{ not json', 'utf8');

    expect(() => new EngineState(path)).toThrow(/refusing to start with an empty book/);
  });

  it('never lets the peak fall', () => {
    // Letting it fall would reset the drawdown measurement mid-drawdown, which
    // is when the governor is meant to be tightening.
    const state = new EngineState(join(dir, 'peak.json'));
    state.observeEquity(500);
    expect(state.observeEquity(300)).toBe(500);
  });

  it('only ever widens the Chandelier anchors', () => {
    // Same one-way property as ratchetStop, one level down: a retreating anchor
    // would loosen the stop derived from it.
    const position = trackNewPosition({
      instId: 'BTC-USDT-SWAP',
      signalId: 'S-1',
      side: 'long',
      entryPrice: 64_000,
      initialStop: 63_000,
      openedAtMs: NOW,
      venueSize: 24n,
    });

    const up = withObservedPrice(position, 68_000);
    const back = withObservedPrice(up, 65_000);

    expect(back.highWaterPrice).toBe(68_000);
    expect(back.lowWaterPrice).toBe(64_000);
  });

  it('expires a cooldown once it has passed', () => {
    const state = new EngineState(join(dir, 'cooldown.json'));
    state.close('BTC-USDT-SWAP', NOW + 1000);

    expect(state.cooldownUntil('BTC-USDT-SWAP', NOW)).toBe(NOW + 1000);
    expect(state.cooldownUntil('BTC-USDT-SWAP', NOW + 2000)).toBeUndefined();
  });
});
