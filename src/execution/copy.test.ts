import { describe, expect, it } from 'vitest';
import { loadConfig, type Config } from '../config.js';
import { formatSignal, type SignalPlan } from '../signal/publish.js';
import type { Instrument, OrderRequest, OrderResult, Position } from './adapter.js';
import type { FeedFreshness, GuardedExecutor } from './guarded.js';
import {
  CopyExecutor,
  CopyExecutorError,
  InMemorySignalJournal,
  clientOrderIdFor,
  contractsFor,
  parseSignal,
  priceToMinor,
  type AccountView,
} from './copy.js';

const baseConfig = loadConfig('config/default.yaml');

/**
 * maxLeverage is deliberately unset in the real config until the Part IX kill
 * test. Tests that need a tradeable executor set it explicitly, and one test
 * below asserts that leaving it unset stops everything.
 */
function configWith(overrides: { maxLeverage?: number } = {}): Config {
  return {
    ...baseConfig,
    execution: { ...baseConfig.execution, maxLeverage: overrides.maxLeverage ?? 5 },
  };
}

const btc: Instrument = {
  symbol: 'BTC-USDT-SWAP',
  priceDecimals: 1,
  sizeDecimals: 2,
  contractValue: 0.01,
};

const instruments = new Map([[btc.symbol, btc]]);

const plan: SignalPlan = {
  signalId: 'S-2608091200-BTC-L',
  instId: 'BTC-USDT-SWAP',
  direction: 'long',
  entryLow: 64700,
  entryHigh: 64800,
  stopPrice: 64000,
  targetPrice: 67200,
  sizePercent: 40,
  validUntilMs: 2_000_000,
};

const NOW = 1_000_000;
const feeds: readonly FeedFreshness[] = [{ name: 'ohlc', lastUpdateMs: NOW }];

/** Records what reached the guard, so the test can assert on the actual order. */
class FakeGuard {
  readonly submitted: OrderRequest[] = [];
  result: Partial<OrderResult> = {};

  async submitOrder(request: OrderRequest): Promise<OrderResult> {
    this.submitted.push(request);
    return {
      clientOrderId: request.clientOrderId,
      venueOrderId: 'V1',
      status: 'accepted',
      filledSize: 0n,
      averagePrice: null,
      feePaid: null,
      stopResting: false,
      raw: {},
      ...this.result,
    };
  }

  get last(): OrderRequest {
    const order = this.submitted.at(-1);
    if (order === undefined) throw new Error('nothing was submitted');
    return order;
  }
}

class FakeAccount implements AccountView {
  balance = 40_000_000_000n; // 400 USDT at 8 decimals
  positions: Position[] = [];
  async availableBalance(): Promise<bigint> {
    return this.balance;
  }
  async openPositions(): Promise<readonly Position[]> {
    return this.positions;
  }
}

function makeExecutor(
  overrides: {
    config?: Config;
    guard?: FakeGuard;
    account?: FakeAccount;
    instruments?: ReadonlyMap<string, Instrument>;
  } = {},
) {
  const guard = overrides.guard ?? new FakeGuard();
  const account = overrides.account ?? new FakeAccount();
  const executor = new CopyExecutor({
    config: overrides.config ?? configWith(),
    executor: guard as unknown as GuardedExecutor,
    account,
    instruments: overrides.instruments ?? instruments,
    journal: new InMemorySignalJournal(),
    maxSignalAgeMs: 5 * 60_000,
    now: () => NOW,
  });
  return { executor, guard, account };
}

const text = (config: Config = configWith(), p: SignalPlan = plan) => formatSignal(config, p);

describe('parseSignal', () => {
  it('round-trips every number that formatSignal published', () => {
    // These two functions are inverses. If they drift, every signal becomes
    // unexecutable at once — loud, and far better than a parser that guesses.
    const parsed = parseSignal(configWith(), text());

    expect(parsed).toEqual({
      signalId: plan.signalId,
      instId: plan.instId,
      direction: 'long',
      entryLow: plan.entryLow,
      entryHigh: plan.entryHigh,
      stopPrice: plan.stopPrice,
      targetPrice: plan.targetPrice,
      sizePercent: plan.sizePercent,
    });
  });

  it('round-trips a short and a sub-dollar price', () => {
    const config = configWith();
    const short: SignalPlan = {
      ...plan,
      signalId: 'S-2608091200-DOGE-S',
      instId: 'DOGE-USDT-SWAP',
      direction: 'short',
      entryLow: 0.21042,
      entryHigh: 0.21098,
      stopPrice: 0.21456,
      targetPrice: 0.19844,
      sizePercent: 12.5,
    };
    const parsed = parseSignal(config, formatSignal(config, short));

    expect(parsed.direction).toBe('short');
    expect(parsed.entryLow).toBe(0.21042);
    expect(parsed.targetPrice).toBe(0.19844);
    expect(parsed.sizePercent).toBe(12.5);
  });

  it('refuses text that does not carry the exact header', () => {
    expect(() => parseSignal(configWith(), 'LONG BTC-USDT-SWAP entry 1-2 stop 0.5 target 4 size 1% id X')).toThrow(
      /exact header/,
    );
  });

  it('refuses a body it cannot read literally, rather than filling in a default', () => {
    // "at market" is exactly the phrase the publication gate rejects. If it ever
    // reaches the executor, refusing is the only safe response — a fallback to a
    // market order would trade at a price nobody published.
    const config = configWith();
    for (const body of [
      'LONG BTC-USDT-SWAP entry at market stop 64000 target 67200 size 40% id S-1',
      'LONG BTC-USDT-SWAP entry 64700-64800 stop 64000 target 67200 size 40%',
      'SIDEWAYS BTC-USDT-SWAP entry 64700-64800 stop 64000 target 67200 size 40% id S-1',
      'LONG BTC-USDT-SWAP entry 64700-64800 stop 64000 target 67200 size 40% id S-1 and also buy ETH',
    ]) {
      expect(() => parseSignal(config, `${config.publishing.perpHeader} ${body}`)).toThrow(CopyExecutorError);
    }
  });
});

describe('clientOrderIdFor', () => {
  it('strips the punctuation OKX rejects, deterministically', () => {
    // Determinism is the point: the same signal always maps to the same clOrdId,
    // so a redelivery that survives a restart is rejected by the venue itself.
    expect(clientOrderIdFor('S-2608091200-BTC-L')).toBe('S2608091200BTCL');
    expect(clientOrderIdFor('S-2608091200-BTC-L')).toBe(clientOrderIdFor('S-2608091200-BTC-L'));
  });

  it('refuses an id that cannot become a usable clOrdId', () => {
    expect(() => clientOrderIdFor('---')).toThrow(CopyExecutorError);
    expect(() => clientOrderIdFor('S'.repeat(33))).toThrow(CopyExecutorError);
  });
});

describe('sizing', () => {
  it('converts a notional into contracts, not coins', () => {
    // BTC-USDT-SWAP is 0.01 BTC per contract. Sizing in coins would be a
    // hundredfold error that the venue would happily accept.
    // 160 USDT / (64800 * 0.01) = 0.2469 contracts -> 0.24 at lot scale 2.
    expect(contractsFor(btc, 160, 64_800)).toBe(24n);
  });

  it('rounds down, never up', () => {
    // Rounding up spends more than the published percentage said, which breaks
    // the signal-to-trade correspondence Law 6 rests on. Under-filling by less
    // than one lot does not.
    // 0.2499 contracts is 161.9352 USDT at this price; it must floor to 0.24.
    expect(contractsFor(btc, 161.9352, 64_800)).toBe(24n);
  });

  it('does not drop a whole lot to float error on an exact size', () => {
    // 0.24 contracts computes to 23.999999999999996 lots. A bare floor would
    // give 0.23, and on a minimum-size order that is the difference between a
    // position and a venue rejection.
    expect(contractsFor(btc, 0.24 * 64_800 * 0.01, 64_800)).toBe(24n);
  });

  it('treats a null contract value as one coin per unit', () => {
    const spot: Instrument = { ...btc, contractValue: null, sizeDecimals: 4 };
    expect(contractsFor(spot, 6_480, 64_800)).toBe(1_000n); // 0.1 coins
  });
});

describe('priceToMinor', () => {
  it('scales exactly, without float drift', () => {
    expect(priceToMinor(64_778, 1)).toBe(647_780n);
    expect(priceToMinor(0.07, 8)).toBe(7_000_000n);
    // 118000 must not become 118: trimming trailing zeros outside the fraction
    // publishes a price three orders of magnitude wrong.
    expect(priceToMinor(118_000, 1)).toBe(1_180_000n);
  });

  it('places at publication precision, not at a precision nobody published', () => {
    // Prices are published at five significant figures. Placing at 64778.3 when
    // the signal says 64778 would make the trade differ from its own record.
    expect(priceToMinor(64_778.3, 1)).toBe(priceToMinor(64_778, 1));
  });

  it('snaps a published price finer than the tick to the nearest tick', () => {
    // Five significant figures is finer than the tick on a cheap perp. Refusing
    // would make those instruments unexecutable; the tick is far smaller than
    // any stop distance we trade.
    expect(priceToMinor(0.21456, 4)).toBe(2_146n);
    expect(priceToMinor(0.21454, 4)).toBe(2_145n);
  });
});

describe('CopyExecutor', () => {
  it('submits exactly the prices the signal published', async () => {
    const { executor, guard } = makeExecutor();
    const outcome = await executor.execute(text(), NOW, feeds);

    expect(outcome.status).toBe('submitted');
    expect(guard.last.stopPrice).toBe(priceToMinor(plan.stopPrice, 1));
    expect(guard.last.targetPrice).toBe(priceToMinor(plan.targetPrice, 1));
    expect(guard.last.side).toBe('buy');
    expect(guard.last.type).toBe('limit');
    expect(guard.last.route).toBe('routeB');
  });

  it('places the limit at the far edge of the published band', async () => {
    // A limit fills there or better, so this honours the band exactly and can
    // never fill outside what was published — which chasing would.
    const { executor, guard } = makeExecutor();
    await executor.execute(text(), NOW, feeds);
    expect(guard.last.limitPrice).toBe(priceToMinor(plan.entryHigh, 1));

    const config = configWith();
    const short: SignalPlan = { ...plan, signalId: 'S-2-BTC-S', direction: 'short', stopPrice: 65500, targetPrice: 61700 };
    const shortRun = makeExecutor();
    await shortRun.executor.execute(formatSignal(config, short), NOW, feeds);
    expect(shortRun.guard.last.limitPrice).toBe(priceToMinor(plan.entryLow, 1));
    expect(shortRun.guard.last.side).toBe('sell');
  });

  it('carries the signal id into the order, so a fill traces back to it', async () => {
    // Law 6 is only provable if the venue-side record names the signal.
    const { executor, guard } = makeExecutor();
    await executor.execute(text(), NOW, feeds);

    expect(guard.last.reason).toBe(plan.signalId);
    expect(guard.last.clientOrderId).toBe(clientOrderIdFor(plan.signalId));
  });

  it('does not place a second order for a redelivered signal', async () => {
    const { executor, guard } = makeExecutor();
    await executor.execute(text(), NOW, feeds);
    const second = await executor.execute(text(), NOW, feeds);

    expect(second.status).toBe('duplicate');
    expect(guard.submitted).toHaveLength(1);
  });

  it('records the signal before submitting, so a lost order is not retried', async () => {
    // If the venue call times out we do not know whether the order landed.
    // Retrying on the next delivery risks a double position; the venue may well
    // already hold it.
    const guard = new FakeGuard();
    guard.submitOrder = async () => {
      throw new Error('socket hang up');
    };
    const { executor } = makeExecutor({ guard });

    await expect(executor.execute(text(), NOW, feeds)).rejects.toThrow(/socket hang up/);
    expect((await executor.execute(text(), NOW, feeds)).status).toBe('duplicate');
  });

  it('refuses everything while maxLeverage is unset', async () => {
    // The Part IX gate must not live in only one place. A copy executor pointed
    // at an unverified config trades nothing at all.
    const config = { ...baseConfig, execution: { ...baseConfig.execution, maxLeverage: undefined } };
    const { executor, guard } = makeExecutor({ config });

    await expect(executor.execute(text(), NOW, feeds)).rejects.toThrow(/maxLeverage is not set/);
    expect(guard.submitted).toHaveLength(0);
  });

  it('refuses a signal whose implied leverage is over the cap', async () => {
    const config = configWith({ maxLeverage: 2 });
    const { executor, guard } = makeExecutor({ config });
    const outcome = await executor.execute(formatSignal(config, { ...plan, sizePercent: 250 }), NOW, feeds);

    expect(outcome).toMatchObject({ status: 'refused', reason: expect.stringMatching(/over the 2x cap/) });
    expect(guard.submitted).toHaveLength(0);
  });

  it('refuses an instrument it has not discovered, rather than guessing its scale', async () => {
    const { executor } = makeExecutor({ instruments: new Map() });
    const outcome = await executor.execute(text(), NOW, feeds);

    expect(outcome).toMatchObject({ status: 'refused', reason: expect.stringMatching(/not a discovered instrument/) });
  });

  it('refuses to add to a position it already holds', async () => {
    // Pyramiding is an engine decision expressed as a new signal with its own
    // sizing, never something the executor infers from a second delivery.
    const account = new FakeAccount();
    account.positions = [
      {
        instrument: btc,
        side: 'long',
        size: 10n,
        entryPrice: 1n,
        markPrice: 1n,
        unrealisedPnlQuote: 0n,
        stopPrice: 1n,
        stopRestingOnVenue: true,
      },
    ];
    const { executor, guard } = makeExecutor({ account });
    const outcome = await executor.execute(text(), NOW, feeds);

    expect(outcome).toMatchObject({ status: 'refused', reason: expect.stringMatching(/does not add to a position/) });
    expect(guard.submitted).toHaveLength(0);
  });

  it('refuses once the concurrent position limit is reached', async () => {
    const account = new FakeAccount();
    account.positions = Array.from({ length: baseConfig.risk.maxConcurrentPositions }, (_, i) => ({
      instrument: { ...btc, symbol: `ALT${i}-USDT-SWAP` },
      side: 'long' as const,
      size: 10n,
      entryPrice: 1n,
      markPrice: 1n,
      unrealisedPnlQuote: 0n,
      stopPrice: 1n,
      stopRestingOnVenue: true,
    }));
    const { executor } = makeExecutor({ account });

    expect(await executor.execute(text(), NOW, feeds)).toMatchObject({
      status: 'refused',
      reason: expect.stringMatching(/at the 3 limit/),
    });
  });

  it('refuses below the eligibility floor', async () => {
    const account = new FakeAccount();
    account.balance = 29_000_000_000n; // 290 USDT, under the 300 floor
    const { executor, guard } = makeExecutor({ account });

    expect((await executor.execute(text(), NOW, feeds)).status).toBe('refused');
    expect(guard.submitted).toHaveLength(0);
  });

  it('refuses a signal older than the acting window', async () => {
    // A signal executed an hour late is executed at a price the publisher never
    // saw, which is a different trade from the one that was published.
    const { executor } = makeExecutor();
    const delivered = NOW - 10 * 60_000;
    const outcome = await executor.execute(text(), delivered, feeds);

    expect(outcome).toMatchObject({ status: 'refused', reason: expect.stringMatching(/expired/) });
  });

  it('re-runs the publication gate on read-back, catching an altered signal', async () => {
    // The text checks pass tautologically, but the geometry ones do not. An
    // altered stop is refused at the executor rather than traded on trust.
    const config = configWith();
    const tampered = formatSignal(config, plan).replace('stop 64000', 'stop 65000');
    const { executor, guard } = makeExecutor();
    const outcome = await executor.execute(tampered, NOW, feeds);

    expect(outcome).toMatchObject({ status: 'refused', reason: expect.stringMatching(/publication gate/) });
    expect(guard.submitted).toHaveLength(0);
  });

  it('never returns without saying what happened', async () => {
    // The absence of an outcome is the one failure with no other trace, which
    // is why every path returns a tagged result rather than falling through.
    const { executor } = makeExecutor();
    const outcomes = [
      await executor.execute('nonsense', NOW, feeds),
      await executor.execute(text(), NOW, feeds),
      await executor.execute(text(), NOW, feeds),
    ];

    expect(outcomes.map((o) => o.status)).toEqual(['refused', 'submitted', 'duplicate']);
  });

  it('reports a venue rejection as a refusal, not a submission', async () => {
    const guard = new FakeGuard();
    guard.result = { status: 'rejected', raw: { sCode: '51008' } };
    const { executor } = makeExecutor({ guard });

    expect(await executor.execute(text(), NOW, feeds)).toMatchObject({
      status: 'refused',
      reason: expect.stringMatching(/51008/),
    });
  });
});
