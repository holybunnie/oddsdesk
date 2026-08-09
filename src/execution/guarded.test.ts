/**
 * Gates are proven here by driving each one to an actual refusal (Law 7).
 *
 * The adapter below is a test double, confined to this file and never exported.
 * It is not a stub standing in for a venue in a production path — the real
 * adapters must hit real venues, and their acceptance tests are integration
 * tests against those venues. What is being tested here is the guard, and the
 * guard's job is to refuse before an adapter is ever reached.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Ledger } from '../ledger.js';
import { KillSwitch } from '../kill-switch.js';
import {
  RiskTokenBlocked,
  type ExecutionAdapter,
  type Instrument,
  type OrderRequest,
  type OrderResult,
  type Position,
  type RiskTokenGate,
  type VenueProfile,
} from './adapter.js';
import { GuardedExecutor, MissingStopError, StaleFeedError, type FeedFreshness } from './guarded.js';

const instrument: Instrument = { symbol: 'BTC-USDT-SWAP', priceDecimals: 2, sizeDecimals: 6, contractValue: 0.01 };

class RecordingAdapter implements ExecutionAdapter {
  readonly venue = 'test-venue';
  readonly route = 'routeB' as const;
  submitted: OrderRequest[] = [];
  positions: Position[] = [];
  stopResting = true;
  filledSize = 1_000_000n;

  describeVenue(): Promise<VenueProfile> {
    throw new Error('not used in guard tests');
  }
  submitOrder(request: OrderRequest): Promise<OrderResult> {
    this.submitted.push(request);
    return Promise.resolve({
      clientOrderId: request.clientOrderId,
      venueOrderId: 'v-1',
      status: 'filled',
      filledSize: this.filledSize,
      averagePrice: 6_120_000n,
      feePaid: 120n,
      stopResting: this.stopResting,
      raw: { ok: true },
    });
  }
  cancelOrder(): Promise<void> {
    return Promise.resolve();
  }
  openPositions(): Promise<readonly Position[]> {
    return Promise.resolve(this.positions);
  }
  openOrders(): Promise<readonly OrderResult[]> {
    return Promise.resolve([]);
  }
  flatten(): Promise<OrderResult> {
    return Promise.resolve({
      clientOrderId: 'flat',
      venueOrderId: 'v-flat',
      status: 'filled',
      filledSize: this.filledSize,
      averagePrice: 6_100_000n,
      feePaid: 100n,
      stopResting: false,
      raw: { flattened: true },
    });
  }
  availableBalance(): Promise<bigint> {
    return Promise.resolve(150_000_000n);
  }
}

const cleanGate: RiskTokenGate = { assertClean: () => Promise.resolve() };
const blockingGate: RiskTokenGate = {
  assertClean: (i) => Promise.reject(new RiskTokenBlocked(i.symbol, ['honeypot', 'unverified contract'])),
};

const NOW = 1_760_000_000_000;
const freshFeed: FeedFreshness[] = [{ name: 'spot', lastUpdateMs: NOW - 1_000 }];

let dir: string;
let ledger: Ledger;
let killSwitch: KillSwitch;
let adapter: RecordingAdapter;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'oddsdesk-exec-'));
  ledger = new Ledger(join(dir, 'ledger.sqlite'));
  killSwitch = new KillSwitch(join(dir, 'kill-switch'));
  adapter = new RecordingAdapter();
});

afterEach(() => {
  ledger.close();
  rmSync(dir, { recursive: true, force: true });
});

function executor(gate: RiskTokenGate = cleanGate): GuardedExecutor {
  return new GuardedExecutor({
    adapter,
    ledger,
    killSwitch,
    riskGate: gate,
    maxFeedStalenessSeconds: 30,
    now: () => NOW,
  });
}

const order = (overrides: Partial<OrderRequest> = {}): OrderRequest => ({
  route: 'routeB',
  engine: 'H1',
  instrument,
  side: 'buy',
  type: 'limit',
  limitPrice: 6_120_000n,
  size: 1_000_000n,
  stopPrice: 6_090_000n,
  targetPrice: 6_210_000n,
  reason: 'momentum long, confidence 82',
  clientOrderId: 'c-1',
  ...overrides,
});

describe('gates refuse before the venue is reached', () => {
  it('submits when every gate is clean', async () => {
    const result = await executor().submitOrder(order(), freshFeed);
    expect(result.status).toBe('filled');
    expect(adapter.submitted).toHaveLength(1);
  });

  it('refuses when the kill switch is tripped, without calling the venue', async () => {
    killSwitch.trip('routeB', 'operator', 'manual halt');
    await expect(executor().submitOrder(order(), freshFeed)).rejects.toThrow(/kill switch is tripped/);
    expect(adapter.submitted).toHaveLength(0);
  });

  it('lets a routeA order through while routeB is tripped', async () => {
    killSwitch.trip('routeB', 'operator', 'leverage unverified');
    const result = await executor().submitOrder(
      order({ route: 'routeA', stopPrice: null, targetPrice: null }),
      freshFeed,
    );
    expect(result.status).toBe('filled');
  });

  it('refuses on a stale feed', async () => {
    const stale: FeedFreshness[] = [{ name: 'spot', lastUpdateMs: NOW - 45_000 }];
    await expect(executor().submitOrder(order(), stale)).rejects.toThrow(StaleFeedError);
    expect(adapter.submitted).toHaveLength(0);
  });

  it('refuses when the risk-token gate blocks', async () => {
    await expect(executor(blockingGate).submitOrder(order(), freshFeed)).rejects.toThrow(RiskTokenBlocked);
    expect(adapter.submitted).toHaveLength(0);
  });

  it('refuses a stopless routeB entry', async () => {
    await expect(executor().submitOrder(order({ stopPrice: null }), freshFeed)).rejects.toThrow(
      MissingStopError,
    );
    expect(adapter.submitted).toHaveLength(0);
  });

  it('allows a stopless routeA entry — defined risk, nothing to attach', async () => {
    const result = await executor().submitOrder(
      order({ route: 'routeA', stopPrice: null, targetPrice: null }),
      freshFeed,
    );
    expect(result.status).toBe('filled');
  });
});

describe('receipts', () => {
  it('records every refusal, not only fills', async () => {
    killSwitch.trip('routeB', 'operator', 'manual halt');
    await expect(executor().submitOrder(order(), freshFeed)).rejects.toThrow();

    const refusals = ledger.recent(10).filter((r) => r.action === 'refusal');
    expect(refusals).toHaveLength(1);
    expect(refusals[0]?.reason).toMatch(/^kill_switch:/);
  });

  it('writes the intent before submission so a timeout still leaves a trace', async () => {
    await executor().submitOrder(order(), freshFeed);
    const actions = ledger.recent(10).map((r) => r.action);
    // Newest first: fill, then the pre-submission intent.
    expect(actions).toEqual(['order_filled', 'order_submitted']);
  });

  it('keeps the chain intact across a mix of refusals and fills', async () => {
    await executor().submitOrder(order(), freshFeed);
    await expect(executor(blockingGate).submitOrder(order({ clientOrderId: 'c-2' }), freshFeed)).rejects.toThrow();
    await executor().submitOrder(order({ clientOrderId: 'c-3' }), freshFeed);
    expect(() => ledger.verifyChain()).not.toThrow();
  });
});

describe('a leveraged fill without a resting stop', () => {
  it('trips routeB and throws', async () => {
    adapter.stopResting = false;
    await expect(executor().submitOrder(order(), freshFeed)).rejects.toThrow(/without a resting stop/);
    // The naked position must halt further routeB risk immediately.
    expect(killSwitch.isTripped('routeB')).toBe(true);
    expect(killSwitch.isTripped('routeA')).toBe(false);
  });
});

describe('reconciliation', () => {
  const position = (size: bigint): Position => ({
    instrument,
    side: 'long',
    size,
    entryPrice: 6_120_000n,
    markPrice: 6_130_000n,
    unrealisedPnlQuote: 100n,
    stopPrice: 6_090_000n,
    stopRestingOnVenue: true,
  });

  it('passes when local state matches the venue', async () => {
    adapter.positions = [position(1_000_000n)];
    await executor().reconcile([position(1_000_000n)]);
    expect(killSwitch.isTripped('all')).toBe(false);
  });

  it('halts everything on a size mismatch', async () => {
    adapter.positions = [position(2_000_000n)];
    await executor().reconcile([position(1_000_000n)]);
    expect(killSwitch.isTripped('all')).toBe(true);
  });

  it('halts on a position the venue has and we do not', async () => {
    adapter.positions = [position(1_000_000n)];
    await executor().reconcile([]);
    expect(killSwitch.isTripped('all')).toBe(true);
  });

  it('halts on a position we expect and the venue does not have', async () => {
    adapter.positions = [];
    await executor().reconcile([position(1_000_000n)]);
    expect(killSwitch.isTripped('all')).toBe(true);
  });
});

describe('flatten', () => {
  it('still works when the kill switch has halted everything', async () => {
    // Closing risk must remain available after every gate has shut. A kill
    // switch that blocked the exit would strand the position it was protecting.
    killSwitch.trip('all', 'governor', 'drawdown stop for competition');
    const result = await executor().flatten(instrument, 'competition stop reached');
    expect(result.status).toBe('filled');
  });
});
