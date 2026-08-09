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
    scaleOutPrice: 66_400,
    targetPrice: 67_200,
    expectedFundingCostFraction: 0,
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
    fundingRates: new Map([
      [btc.symbol, 0],
      [sol.symbol, 0],
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
  readonly statuses: string[] = [];
  fail = false;
  async publish(text: string): Promise<void> {
    if (this.fail) throw new Error('ASP delivery timed out');
    this.published.push(text);
  }
  async publishStatus(text: string): Promise<void> {
    this.statuses.push(text);
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
    now?: number;
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
    now: () => overrides.now ?? NOW,
  });

  return { engine, state, ledger, killSwitch, guard, copy, publisher, config };
}

describe('correlationGroupFor', () => {
  it('groups by policy, and pools every unlisted symbol into one bucket', () => {
    expect(correlationGroupFor(baseConfig, 'BTC-USDT-SWAP')).toBe('majors');
    expect(correlationGroupFor(baseConfig, 'SOL-USDT-SWAP')).toBe('layer1');
  });

  it('makes the memecoin complex count as ONE group, not five', () => {
    // The reversal of an earlier decision, pinned as a test because the earlier
    // behaviour was defensible in the abstract and wrong here. A live scan
    // produced BOME, PEOPLE, PARTI, NEIRO and ESP — five long candidates, none
    // of them in any hand-written group. Under per-symbol bucketing each one
    // satisfied a cap of two on its own, so the cap permitted all five: one
    // trade wearing five hats, while the book reported itself diversified.
    const complex = ['BOME', 'PEOPLE', 'PARTI', 'NEIRO', 'ESP'].map((base) =>
      correlationGroupFor(baseConfig, `${base}-USDT-SWAP`),
    );

    expect(new Set(complex).size).toBe(1);
    expect(complex[0]).toBe('HIGHBETA_ALT');
  });
});

describe('openRiskUsdt', () => {
  it('measures USDT at risk, not a price distance', () => {
    // 24 lots at scale 2 is 0.24 contracts; at 0.01 BTC each that is 0.0024 BTC.
    // Times an 800 stop distance = 1.92 USDT. Using the bare 800 instead reads
    // as hundreds of percent of portfolio heat and refuses every later trade.
    expect(
      openRiskUsdt(btc, { entryPrice: 64_800, currentStop: 64_000, remainingFraction: 1, venueSize: '24' }, 'long'),
    ).toBeCloseTo(1.92, 6);
  });

  it('discounts what has already been scaled out', () => {
    expect(
      openRiskUsdt(btc, { entryPrice: 64_800, currentStop: 64_000, remainingFraction: 0.75, venueSize: '24' }, 'long'),
    ).toBeCloseTo(1.44, 6);
  });

  it('counts a stop above a long entry as zero remaining downside risk', () => {
    expect(
      openRiskUsdt(btc, { entryPrice: 64_800, currentStop: 65_000, remainingFraction: 1, venueSize: '24' }, 'long'),
    ).toBe(0);
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
          scaleOutPrice: 160,
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
    expect(publisher.statuses).toEqual(['[Perpetual Status] regime unfavourable — the engine stands down']);
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
  const match = /Position ([\d.]+)%/.exec(text);
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

describe('exits are published too', () => {
  /** An open long, tracked, with a stop already at breakeven. */
  const openLong = (state: EngineState, overrides: Record<string, unknown> = {}) => {
    state.open(
      trackNewPosition({
        instId: btc.symbol,
        signalId: 'S-260812080000-BTC-L',
        side: 'long',
        entryPrice: 64_000,
        initialStop: 63_000,
        openedAtMs: NOW - 3_600_000,
        venueSize: 24n,
        ...overrides,
      }),
    );
  };

  it('publishes a scale-out as a signal of its own', async () => {
    // Exits are trades. Roughly half of all fills are exits, and publishing
    // entries alone leaves half the book with no corresponding signal.
    const { engine, state, publisher } = build();
    openLong(state);

    // +2R: entry 64000, R = 1000, so 66000 triggers the scale-out.
    await engine.runCycle(scanOf([], { lastPrices: new Map([[btc.symbol, 66_000]]) }));

    const exits = publisher.published.filter((t) => t.includes('EXIT'));
    expect(exits.some((t) => t.includes('CLOSE 25%'))).toBe(true);
  });

  it('publishes a stop ratchet, which moves no size but changes the published risk', async () => {
    const { engine, state, publisher } = build();
    openLong(state);
    await engine.runCycle(scanOf([], { lastPrices: new Map([[btc.symbol, 66_000]]) }));

    expect(publisher.published.some((t) => /EXIT LONG \| SL /.test(t))).toBe(true);
  });

  it('publishes a full close, and references the entry it closes', async () => {
    // The reference is what makes the fill traceable to a signal. Without it an
    // auditor sees an exit fill with no corresponding published instruction.
    const { engine, state, publisher } = build();
    openLong(state);

    // Below the initial stop: a stop-out, which is terminal.
    await engine.runCycle(scanOf([], { lastPrices: new Map([[btc.symbol, 62_000]]) }));

    const close = publisher.published.find((t) => t.includes('CLOSE 100%'));
    expect(close).toBeDefined();
    expect(close).toContain('ref S-260812080000-BTC-L');
  });

  it('CLOSES THE POSITION EVEN IF PUBLISHING FAILS', async () => {
    // The asymmetry with entries, and the most important property here. An
    // entry that cannot be published is not traded. An exit that cannot be
    // published still happens: gating a close on the ASP being reachable would
    // mean a dead publisher leaves us holding a loser we are not allowed to cut.
    const publisher = new FakePublisher();
    publisher.fail = true;
    const { engine, state, guard } = build({ publisher });
    openLong(state);

    const report = await engine.runCycle(scanOf([], { lastPrices: new Map([[btc.symbol, 62_000]]) }));

    expect(guard.flattened).toHaveLength(1);
    expect(state.positions()).toHaveLength(0);
    expect(report.exits[0]?.actions[0]).toMatchObject({ kind: 'close_full' });
  });

  it('records a failed exit publish as an alert, so the gap is not silent', async () => {
    const publisher = new FakePublisher();
    publisher.fail = true;
    const { engine, state, ledger } = build({ publisher });
    openLong(state);
    await engine.runCycle(scanOf([], { lastPrices: new Map([[btc.symbol, 62_000]]) }));

    const alerts = ledger.recent(50).filter((row) => row.action === 'alert');
    expect(alerts.some((row) => row.reason.includes('Law 6 gap'))).toBe(true);
  });

  it('does not count exit signals in the entry cycle accounting', async () => {
    // SignalCycle's invariant is about ENTRY signals: generated == delivered +
    // rejected. Exits are published after the fact and have no "rejected" state
    // that leaves a position open, so counting them would break the invariant
    // that catches a dropped entry.
    const { engine, state } = build();
    openLong(state);
    const report = await engine.runCycle(scanOf([], { lastPrices: new Map([[btc.symbol, 66_000]]) }));

    expect(report.signals).toEqual({ generated: 0, delivered: 0, rejected: 0 });
  });

  it('publishes nothing when exit publication is switched off', async () => {
    const config: Config = {
      ...baseConfig,
      execution: { ...baseConfig.execution, maxLeverage: 5 },
      publishing: { ...baseConfig.publishing, publishExits: false },
    };
    const { engine, state, publisher } = build({ config });
    openLong(state);
    await engine.runCycle(scanOf([], { lastPrices: new Map([[btc.symbol, 62_000]]) }));

    expect(publisher.published).toHaveLength(0);
  });
});

describe('the competition clock gates entries', () => {
  const beforeStart = baseline().competition.startsAt - 3_600_000;
  const inEndgame = baseline().competition.endsAt - 30 * 3_600_000;
  const afterEnd = baseline().competition.endsAt + 3_600_000;

  it('opens no position before the competition starts', async () => {
    // A pre-start fill moves equity, does not score, and cannot be undone. It is
    // the only gate here whose breach no later decision can repair.
    const { engine, publisher, copy } = build({ now: beforeStart });
    const report = await engine.runCycle(scanOf([candidate({ validUntilMs: beforeStart + 3_600_000 })]));

    expect(publisher.published).toHaveLength(0);
    expect(copy.executed).toHaveLength(0);
    expect(report.standDownReason).toMatch(/has not started/);
    expect(report.phase).toBe('before');
  });

  it('opens no position inside the last 48 hours', async () => {
    // A trade opened here cannot reach its maximum hold before the snapshot, so
    // it is a coinflip resolved by the clock rather than by the strategy.
    const { engine, publisher } = build({ now: inEndgame });
    const report = await engine.runCycle(scanOf([candidate({ validUntilMs: inEndgame + 3_600_000 })]));

    expect(publisher.published).toHaveLength(0);
    expect(report.standDownReason).toMatch(/endgame/);
  });

  it('opens no position after the snapshot', async () => {
    const { engine, publisher } = build({ now: afterEnd });
    const report = await engine.runCycle(scanOf([candidate({ validUntilMs: afterEnd + 3_600_000 })]));

    expect(publisher.published).toHaveLength(0);
    expect(report.standDownReason).toMatch(/competition is over/);
  });

  it('still MANAGES open positions outside the trading window', async () => {
    // The same principle as the kill switch and the governor: an engine that
    // stops managing its book has not become safe, it has become an abandoned
    // book. Only entries are gated.
    const { engine, state, guard } = build({ now: inEndgame });
    state.open(
      trackNewPosition({
        instId: btc.symbol,
        signalId: 'S-260812080000-BTC-L',
        side: 'long',
        entryPrice: 64_000,
        initialStop: 63_000,
        openedAtMs: inEndgame - 3_600_000,
        venueSize: 24n,
      }),
    );

    await engine.runCycle(scanOf([], { lastPrices: new Map([[btc.symbol, 62_000]]) }));
    expect(guard.flattened).toHaveLength(1);
  });

  it('reports the phase on every cycle, so a quiet engine is explicable', async () => {
    const { engine } = build();
    const report = await engine.runCycle(scanOf([]));
    expect(report.phase).toBe('open');
  });
});

/** The unmodified config, for reading the competition clock in test setup. */
function baseline(): Config {
  return loadConfig('config/default.yaml');
}

describe('E7 — the fee budget', () => {
  /** A filled order carrying a venue-reported fee, in quote minor units. */
  const chargeFee = (ledger: Ledger, usdt: number) => {
    ledger.append({
      action: 'order_filled',
      engine: 'copy-executor',
      venue: 'okx-tradekit',
      instrument: btc.symbol,
      signal: 'S-1',
      price: '64000',
      size: '24',
      stop: '63000',
      reason: 'venue status filled',
      detail: { feePaid: String(Math.round(usdt * 1e8)) },
    });
  };

  it('reports costs on every cycle, so the budget is never invisible', async () => {
    const { engine, ledger } = build();
    chargeFee(ledger, 1.5);
    const report = await engine.runCycle(scanOf([]));

    expect(report.costs.tradingFeesUsdt).toBeCloseTo(1.5, 6);
    expect(report.costs.budgetUsdt).toBeCloseTo(19.2, 6);
    expect(report.costs.breached).toBe(false);
  });

  it('halts NEW ENTRIES once the budget is spent', async () => {
    // 6% of a 320 Principal Base is 19.20 USDT for the whole competition.
    const { engine, ledger, publisher, copy } = build();
    chargeFee(ledger, 20);
    const report = await engine.runCycle(scanOf([candidate()]));

    expect(report.costs.breached).toBe(true);
    expect(report.standDownReason).toMatch(/fee budget spent/);
    expect(publisher.published).toHaveLength(0);
    expect(copy.executed).toHaveLength(0);
  });

  it('still MANAGES open positions with the budget spent', async () => {
    // Fees are the price of taking positions, so the response to spending the
    // budget is to stop taking them — not to abandon the ones already paid for.
    const { engine, ledger, state, guard } = build();
    chargeFee(ledger, 20);
    state.open(
      trackNewPosition({
        instId: btc.symbol,
        signalId: 'S-260812080000-BTC-L',
        side: 'long',
        entryPrice: 64_000,
        initialStop: 63_000,
        openedAtMs: NOW - 3_600_000,
        venueSize: 24n,
      }),
    );

    await engine.runCycle(scanOf([], { lastPrices: new Map([[btc.symbol, 62_000]]) }));
    expect(guard.flattened).toHaveLength(1);
  });

  it('accrues funding against open positions and counts it toward the budget', async () => {
    // The half that was invisible before. A tracker that counted only fees
    // reported 2 bps maker and looked healthy while carry ate the budget.
    const { engine, state } = build({ now: Date.UTC(2026, 7, 12, 7, 59) });
    state.open(
      trackNewPosition({
        instId: btc.symbol,
        signalId: 'S-1',
        side: 'long',
        entryPrice: 64_000,
        initialStop: 63_000,
        openedAtMs: Date.UTC(2026, 7, 12, 0, 0),
        venueSize: 24n,
      }),
    );

    // First cycle sets the accrual mark without charging: a cold start must not
    // bill every funding window since the epoch.
    await engine.runCycle(
      scanOf([], {
        lastPrices: new Map([[btc.symbol, 64_000]]),
        fundingRates: new Map([[btc.symbol, 0.001]]),
      }),
    );
    expect(state.fundingPaidUsdt).toBe(0);
  });

  it('charges a funding window crossed between two cycles', async () => {
    const state = new EngineState(join(dir, `state-funding-${stateSeq++}.json`));
    state.open(
      trackNewPosition({
        instId: btc.symbol,
        signalId: 'S-1',
        side: 'long',
        entryPrice: 64_000,
        initialStop: 63_000,
        openedAtMs: Date.UTC(2026, 7, 12, 0, 0),
        venueSize: 24n,
      }),
    );
    // 0.24 contracts x 0.01 BTC x 64000 = 153.6 USDT notional, at 0.1% = 0.1536.
    state.accrueFunding(0, Date.UTC(2026, 7, 12, 7, 59));

    const ledger = new Ledger(join(dir, 'ledger-funding.db'));
    const engine = new Engine({
      config: { ...baseConfig, execution: { ...baseConfig.execution, maxLeverage: 5 } },
      state,
      ledger,
      killSwitch: new KillSwitch(join(dir, 'kill-funding.jsonl')),
      executor: new FakeGuard() as unknown as GuardedExecutor,
      copyExecutor: new FakeCopyExecutor() as unknown as CopyExecutor,
      publisher: new FakePublisher(),
      instruments,
      readEquity: async () => 400,
      readRankCushion: async () => null,
      now: () => Date.UTC(2026, 7, 12, 8, 1),
    });

    const report = await engine.runCycle(
      scanOf([], {
        lastPrices: new Map([[btc.symbol, 64_000]]),
        fundingRates: new Map([[btc.symbol, 0.001]]),
      }),
    );

    expect(state.fundingPaidUsdt).toBeCloseTo(0.1536, 6);
    expect(report.costs.fundingUsdt).toBeCloseTo(0.1536, 6);
  });

  it('does not charge the same window twice across consecutive cycles', async () => {
    // The accrual mark is half-open. Double-charging would make the budget bind
    // early, which looks exactly like a strategy that trades too much.
    const { engine, state } = build({ now: Date.UTC(2026, 7, 12, 8, 1) });
    state.open(
      trackNewPosition({
        instId: btc.symbol,
        signalId: 'S-1',
        side: 'long',
        entryPrice: 64_000,
        initialStop: 63_000,
        openedAtMs: Date.UTC(2026, 7, 12, 0, 0),
        venueSize: 24n,
      }),
    );
    const scan = scanOf([], {
      lastPrices: new Map([[btc.symbol, 64_000]]),
      fundingRates: new Map([[btc.symbol, 0.001]]),
    });

    await engine.runCycle(scan);
    const afterFirst = state.fundingPaidUsdt;
    await engine.runCycle(scan);

    expect(state.fundingPaidUsdt).toBe(afterFirst);
  });

  it('records R on a terminal close, so Part VIII can measure the payoff', async () => {
    const { engine, state, ledger } = build();
    state.open(
      trackNewPosition({
        instId: btc.symbol,
        signalId: 'S-260812080000-BTC-L',
        side: 'long',
        entryPrice: 64_000,
        initialStop: 63_000,
        openedAtMs: NOW - 3_600_000,
        venueSize: 24n,
      }),
    );

    await engine.runCycle(scanOf([], { lastPrices: new Map([[btc.symbol, 62_000]]) }));

    const closes = ledger.recent(50).filter((row) => row.action === 'position_closed');
    expect(closes[0]?.detail?.['terminal']).toBe(true);
    expect(closes[0]?.detail?.['rMultiple']).toBeCloseTo(-2, 6);
  });
});

describe('E6 — pyramiding through the whole cycle', () => {
  /** A BTC long at +3R with its stop at breakeven: armed for an add. */
  const armed = (state: EngineState) => {
    state.open(
      trackNewPosition({
        instId: btc.symbol,
        signalId: 'S-260812080000-BTC-L',
        side: 'long',
        entryPrice: 64_000,
        initialStop: 63_000,
        openedAtMs: NOW - 3_600_000,
        venueSize: 24n,
      }),
    );
    const held = state.position(btc.symbol);
    if (held === undefined) throw new Error('setup failed');
    state.update({ ...held, currentStop: 64_000, scaledOut: true, highWaterPrice: 67_000 });
  };

  /** Stage 2 needs equity at 2x the 320 Principal Base. */
  const stage2 = { equity: 700 };

  it('publishes an add as a signal that SAYS it is an add', async () => {
    // "Add to the BTC long you already have" is a different instruction from
    // "open a BTC long". A service publishing them identically would have half
    // its subscribers doing the wrong one.
    const { engine, state, publisher } = build(stage2);
    armed(state);

    await engine.runCycle(
      scanOf([candidate({ entryBandHigh: 67_000, entryBandLow: 66_900, stopPrice: 66_000, scaleOutPrice: 69_000, targetPrice: 71_000 })], {
        lastPrices: new Map([[btc.symbol, 67_000]]),
      }),
    );

    const entry = publisher.published.find((t) => !t.includes('EXIT'));
    expect(entry).toContain('ADD 1');
  });

  it('sizes the add off the STACK-WIDE stop, never a fresh one', async () => {
    // A new 2xATR stop below the existing one would widen risk across the whole
    // stack — the move ratchetStop exists to make impossible everywhere else.
    const { engine, state, publisher } = build(stage2);
    armed(state);

    await engine.runCycle(
      scanOf([candidate({ entryBandHigh: 67_000, entryBandLow: 66_900, stopPrice: 66_000, scaleOutPrice: 69_000, targetPrice: 71_000 })], {
        lastPrices: new Map([[btc.symbol, 67_000]]),
      }),
    );

    // E5 runs before entries, so by the time the add is sized the stack stop
    // has already trailed from breakeven (64000) to the Chandelier level
    // (67000 - 3 x 400 = 65800). The add inherits THAT, not the candidate's own
    // fresh 66000 stop — which sits below it and would widen the stack's risk.
    const entry = publisher.published.find((t) => !t.includes('EXIT')) ?? '';
    expect(entry).toContain('SL 65800');
    expect(entry).not.toContain('SL 66000');
  });

  it('counts the add on the position, so the ladder cannot run past maxAdds', async () => {
    const { engine, state } = build(stage2);
    armed(state);
    const scan = scanOf(
      [candidate({ entryBandHigh: 67_000, entryBandLow: 66_900, stopPrice: 66_000, scaleOutPrice: 69_000, targetPrice: 71_000 })],
      { lastPrices: new Map([[btc.symbol, 67_000]]) },
    );

    await engine.runCycle(scan);
    expect(state.position(btc.symbol)?.adds).toBe(1);

    await engine.runCycle(scan);
    expect(state.position(btc.symbol)?.adds).toBe(2);

    // Third attempt is past the limit.
    const report = await engine.runCycle(scan);
    expect(state.position(btc.symbol)?.adds).toBe(2);
    expect(reasonOf(report.outcomes[0])).toMatch(/at the 2 limit/);
  });

  it('grows the tracked venue size rather than opening a second position', async () => {
    const { engine, state } = build(stage2);
    armed(state);

    await engine.runCycle(
      scanOf([candidate({ entryBandHigh: 67_000, entryBandLow: 66_900, stopPrice: 66_000, scaleOutPrice: 69_000, targetPrice: 71_000 })], {
        lastPrices: new Map([[btc.symbol, 67_000]]),
      }),
    );

    expect(state.positions()).toHaveLength(1);
    expect(BigInt(state.position(btc.symbol)?.venueSize ?? '0')).toBeGreaterThan(24n);
  });

  it('refuses the add in stage 1, and says why', async () => {
    // Stage 1 is survival. Equity below 2x start keeps it there.
    const { engine, state, publisher } = build({ equity: 400 });
    armed(state);

    const report = await engine.runCycle(
      scanOf([candidate({ entryBandHigh: 67_000, entryBandLow: 66_900, stopPrice: 66_000, scaleOutPrice: 69_000, targetPrice: 71_000 })], {
        lastPrices: new Map([[btc.symbol, 67_000]]),
      }),
    );

    expect(publisher.published.filter((t) => !t.includes('EXIT'))).toHaveLength(0);
    expect(reasonOf(report.outcomes[0])).toMatch(/pyramid not armed/);
  });

  it('never opens the opposite side on an instrument it already holds', async () => {
    const { engine, state, publisher } = build(stage2);
    armed(state);

    const report = await engine.runCycle(
      scanOf(
        [
          candidate({
            direction: 'short',
            entryBandLow: 66_900,
            entryBandHigh: 67_000,
            stopPrice: 68_000,
            scaleOutPrice: 64_800,
            targetPrice: 64_000,
          }),
        ],
        { lastPrices: new Map([[btc.symbol, 67_000]]) },
      ),
    );

    expect(publisher.published.filter((t) => !t.includes('EXIT'))).toHaveLength(0);
    expect(reasonOf(report.outcomes[0])).toMatch(/refusing to open the opposite side/);
  });
});

/** The refusal reason, when the outcome carries one. */
function reasonOf(outcome: ExecutionOutcome | undefined): string {
  return outcome !== undefined && outcome.status === 'refused' ? outcome.reason : '';
}
