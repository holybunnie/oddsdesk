import { describe, expect, it } from 'vitest';
import { ExecutionError, NotVerifiedError, type Instrument, type OrderRequest } from './adapter.js';
import {
  TradeKitAdapter,
  assertValidClientOrderId,
  decimalsOf,
  fromMinorUnits,
  mapOrderState,
  toMinorUnits,
  type CliResult,
  type CliRunner,
  type TradeKitOptions,
} from './tradekit.js';

/** A CLI stub keyed by command prefix, recording every invocation. */
class FakeCli {
  readonly calls: string[][] = [];
  readonly #responses = new Map<string, CliResult>();

  on(prefix: string, payload: unknown, overrides: Partial<CliResult> = {}): this {
    this.#responses.set(prefix, {
      stdout: JSON.stringify(payload),
      stderr: '',
      code: 0,
      ...overrides,
    });
    return this;
  }

  fail(prefix: string, stderr: string, code = 1): this {
    this.#responses.set(prefix, { stdout: '', stderr, code });
    return this;
  }

  get runner(): CliRunner {
    return async (args) => {
      this.calls.push([...args]);
      const joined = args.join(' ');
      for (const [prefix, result] of this.#responses) {
        if (joined.startsWith(prefix)) return result;
      }
      throw new Error(`unstubbed CLI call: okx ${joined}`);
    };
  }

  /** The argv of the last call whose prefix matches. */
  lastCall(prefix: string): string[] {
    const match = [...this.calls].reverse().find((c) => c.join(' ').startsWith(prefix));
    if (match === undefined) throw new Error(`no call matching ${prefix}`);
    return match;
  }
}

const BTC_INSTRUMENT_ROW = {
  instId: 'BTC-USDT-SWAP',
  state: 'live',
  tickSz: '0.1',
  lotSz: '0.01',
  minSz: '0.01',
  ctVal: '0.01',
  lever: '100',
};

const FEE_ROW = { maker: '-0.0002', taker: '-0.0005', level: 'Lv1' };

const btc: Instrument = { symbol: 'BTC-USDT-SWAP', priceDecimals: 1, sizeDecimals: 2 };

function makeCli(): FakeCli {
  return new FakeCli()
    .on('market instruments', [
      BTC_INSTRUMENT_ROW,
      // preopen rows carry empty spec fields; parsing them strictly would throw.
      { instId: 'NEW-USDT-SWAP', state: 'preopen', tickSz: '', lotSz: '', minSz: '' },
      // A non-USDT perp: out of the accounting basis entirely.
      { instId: 'BTC-USD-SWAP', state: 'live', tickSz: '0.1', lotSz: '1', minSz: '1', lever: '50' },
    ])
    .on('account fees', [FEE_ROW]);
}

function makeAdapter(
  cli: FakeCli,
  overrides: Partial<TradeKitOptions> = {},
): TradeKitAdapter {
  return new TradeKitAdapter({
    profile: 'okx-sub',
    runner: cli.runner,
    stopCustody: 'venue-held',
    marginMode: 'isolated',
    positionMode: 'long_short_mode',
    ...overrides,
  });
}

const order = (overrides: Partial<OrderRequest> = {}): OrderRequest => ({
  route: 'routeB',
  engine: 'alphagate',
  instrument: btc,
  side: 'buy',
  type: 'limit',
  limitPrice: 647_783n, // 64778.3 at 1 decimal
  size: 5n, // 0.05 contracts at 2 decimals
  stopPrice: 640_000n,
  targetPrice: 670_000n,
  reason: 'E4 breakout',
  clientOrderId: 'S2608091200BTCL',
  ...overrides,
});

describe('minor-unit conversion', () => {
  it('converts exactly, without the float error that would resize an order', () => {
    // 0.07 * 1e8 is 7000000.000000001 in floating point. A size that rounds up
    // is a size the venue rejects, or fills larger than intended.
    expect(toMinorUnits('0.07', 8)).toBe(7_000_000n);
    expect(toMinorUnits('64778.3', 1)).toBe(647_783n);
    expect(toMinorUnits('0.01', 2)).toBe(1n);
    expect(toMinorUnits('-12.5', 8)).toBe(-1_250_000_000n);
    expect(toMinorUnits('100', 2)).toBe(10_000n);
  });

  it('accepts trailing zeros beyond the scale but refuses real precision loss', () => {
    expect(toMinorUnits('64778.300', 1)).toBe(647_783n);
    // The venue reporting finer than our scale means the scale is wrong.
    // Truncating would quietly corrupt a price, so it surfaces instead.
    expect(() => toMinorUnits('64778.35', 1)).toThrow(/refusing to truncate/);
  });

  it('refuses anything that is not a plain decimal', () => {
    for (const bad of ['', 'abc', '1e5', '1.2.3', 'NaN']) {
      expect(() => toMinorUnits(bad, 8)).toThrow(ExecutionError);
    }
  });

  it('round-trips back to a string the CLI accepts', () => {
    for (const [value, decimals] of [
      ['64778.3', 1],
      ['0.01', 2],
      ['100', 2],
      ['0.00067123', 8],
      ['-12.5', 8],
    ] as const) {
      expect(fromMinorUnits(toMinorUnits(value, decimals), decimals)).toBe(value);
    }
  });

  it('derives the scale from the venue step string', () => {
    expect(decimalsOf('0.1')).toBe(1);
    expect(decimalsOf('0.0001')).toBe(4);
    expect(decimalsOf('1')).toBe(0);
    expect(decimalsOf('10')).toBe(0);
    expect(() => decimalsOf('')).toThrow(ExecutionError);
  });
});

describe('client order ids', () => {
  it('rejects the hyphens our signal ids carry', () => {
    // Signal ids look like S-2608091200-BTC-L. OKX takes alphanumerics only, so
    // this collision has to surface here rather than on the first live order.
    expect(() => assertValidClientOrderId('S-2608091200-BTC-L')).toThrow(/alphanumeric/);
    expect(() => assertValidClientOrderId('')).toThrow(ExecutionError);
    expect(() => assertValidClientOrderId('a'.repeat(33))).toThrow(ExecutionError);
    expect(() => assertValidClientOrderId('S2608091200BTCL')).not.toThrow();
  });
});

describe('CLI error handling', () => {
  it('throws with the venue’s own words on a non-zero exit', async () => {
    const cli = makeCli().fail('account balance', 'Error: Insufficient balance.\nCode: 51008');
    await expect(makeAdapter(cli).availableBalance()).rejects.toThrow(/51008/);
  });

  it('treats exit 0 with no output as a fault, not as "no results"', async () => {
    // The CLI prints [] for an empty result set, so silence means something else.
    const cli = makeCli().on('account balance', null, { stdout: '' });
    await expect(makeAdapter(cli).availableBalance()).rejects.toThrow(/produced no output/);
  });

  it('throws rather than guessing when the payload is not JSON', async () => {
    const cli = makeCli().on('account balance', null, { stdout: 'Update available for okx-cli' });
    await expect(makeAdapter(cli).availableBalance()).rejects.toThrow(/unparseable JSON/);
  });
});

describe('describeVenue', () => {
  it('measures instruments and fees from the venue', async () => {
    const profile = await makeAdapter(makeCli()).describeVenue();

    expect(profile.instruments).toEqual([{ symbol: 'BTC-USDT-SWAP', priceDecimals: 1, sizeDecimals: 2 }]);
    expect(profile.minOrderSize['BTC-USDT-SWAP']).toBe(1n);
    expect(profile.venue).toBe('okx-tradekit');
  });

  it('normalises the venue’s negative fee convention to a positive cost', async () => {
    const profile = await makeAdapter(makeCli()).describeVenue();
    expect(profile.makerFee).toBe(0.0002);
    expect(profile.takerFee).toBe(0.0005);
  });

  it('skips non-live instruments whose spec fields are empty', async () => {
    const profile = await makeAdapter(makeCli()).describeVenue();
    expect(profile.instruments.map((i) => i.symbol)).not.toContain('NEW-USDT-SWAP');
  });

  it('reports the venue’s leverage cap, which is not our policy cap', async () => {
    // 100x is what OKX permits. config.requireMaxLeverage() is what governs
    // sizing, and it stays unset until the Part IX kill test.
    expect((await makeAdapter(makeCli()).describeVenue()).maxLeverage).toBe(100);
  });

  it('carries stop custody through unchanged rather than inferring it', async () => {
    const profile = await makeAdapter(makeCli(), { stopCustody: 'unverified' }).describeVenue();
    expect(profile.stopCustody).toBe('unverified');
  });

  it('refuses an empty profile instead of returning one', async () => {
    const cli = new FakeCli().on('market instruments', []).on('account fees', [FEE_ROW]);
    await expect(makeAdapter(cli).describeVenue()).rejects.toThrow(/no live USDT perpetuals/);
  });

  it('refuses a profile with no measured fees', async () => {
    const cli = new FakeCli().on('market instruments', [BTC_INSTRUMENT_ROW]).on('account fees', []);
    await expect(makeAdapter(cli).describeVenue()).rejects.toThrow(/fee rates must be measured/);
  });
});

describe('submitOrder — refusals', () => {
  it('refuses to open a position while stop custody is unverified', async () => {
    // Law 2: the Part IX kill test has not been observed, so whether a stop
    // survives process death is unknown. A plausible answer is worse than none.
    const adapter = makeAdapter(makeCli(), { stopCustody: 'unverified' });
    await expect(adapter.submitOrder(order())).rejects.toThrow(NotVerifiedError);
  });

  it('refuses entirely when the venue has no stop capability', async () => {
    const adapter = makeAdapter(makeCli(), { stopCustody: 'none' });
    await expect(adapter.submitOrder(order())).rejects.toThrow(NotVerifiedError);
  });

  it('refuses a stopless entry even though GuardedExecutor also checks', async () => {
    // The duplicate check is deliberate: this is the last place before the venue.
    const adapter = makeAdapter(makeCli());
    await expect(adapter.submitOrder(order({ stopPrice: null }))).rejects.toThrow(/stopless/);
  });

  it('refuses malformed order shapes', async () => {
    const adapter = makeAdapter(makeCli());
    await expect(adapter.submitOrder(order({ type: 'limit', limitPrice: null }))).rejects.toThrow(
      /requires a limit price/,
    );
    await expect(adapter.submitOrder(order({ type: 'market' }))).rejects.toThrow(
      /must not carry a limit price/,
    );
    await expect(adapter.submitOrder(order({ size: 0n }))).rejects.toThrow(/size must be positive/);
  });

  it('refuses an order id the venue would reject', async () => {
    const adapter = makeAdapter(makeCli());
    await expect(adapter.submitOrder(order({ clientOrderId: 'S-1' }))).rejects.toThrow(/alphanumeric/);
  });

  it('never reaches the venue when it refuses', async () => {
    const cli = makeCli();
    const adapter = makeAdapter(cli, { stopCustody: 'unverified' });
    await expect(adapter.submitOrder(order())).rejects.toThrow();
    expect(cli.calls).toHaveLength(0);
  });
});

describe('submitOrder — the order it builds', () => {
  const placed = { ordId: '1234567890', clOrdId: 'S2608091200BTCL', sCode: '0', sMsg: '' };

  it('attaches the stop to the entry, triggered on mark price', async () => {
    const cli = makeCli().on('swap place', [placed]);
    await makeAdapter(cli).submitOrder(order());
    const args = cli.lastCall('swap place');

    // No window in which the position exists without a stop.
    expect(args).toContain('--slTriggerPx');
    expect(args[args.indexOf('--slTriggerPx') + 1]).toBe('64000');
    // -1 means close at market once triggered.
    expect(args[args.indexOf('--slOrdPx') + 1]).toBe('-1');
    // `last` is wickable on a thin book, which turns a stop into an accident.
    expect(args[args.indexOf('--slTriggerPxType') + 1]).toBe('mark');
  });

  it('sends exact decimal strings, never floats', async () => {
    const cli = makeCli().on('swap place', [placed]);
    await makeAdapter(cli).submitOrder(order());
    const args = cli.lastCall('swap place');

    expect(args[args.indexOf('--px') + 1]).toBe('64778.3');
    expect(args[args.indexOf('--sz') + 1]).toBe('0.05');
    expect(args[args.indexOf('--tpTriggerPx') + 1]).toBe('67000');
  });

  it('uses isolated margin and the hedge-mode posSide', async () => {
    const cli = makeCli().on('swap place', [placed]);
    await makeAdapter(cli).submitOrder(order());
    const args = cli.lastCall('swap place');

    expect(args[args.indexOf('--tdMode') + 1]).toBe('isolated');
    expect(args[args.indexOf('--posSide') + 1]).toBe('long');
  });

  it('maps a sell to the short side in hedge mode', async () => {
    const cli = makeCli().on('swap place', [placed]);
    await makeAdapter(cli).submitOrder(order({ side: 'sell', stopPrice: 660_000n, targetPrice: 600_000n }));
    expect(cli.lastCall('swap place')[cli.lastCall('swap place').indexOf('--posSide') + 1]).toBe('short');
  });

  it('omits posSide in net mode', async () => {
    const cli = makeCli().on('swap place', [placed]);
    await makeAdapter(cli, { positionMode: 'net_mode' }).submitOrder(order());
    expect(cli.lastCall('swap place')).not.toContain('--posSide');
  });

  it('reports a per-order sCode rejection as rejected, despite exit 0', async () => {
    // The command succeeds while the order is refused. Treating exit 0 as
    // success would record a rejected order as accepted and leave the engine
    // believing it holds a position it does not.
    const cli = makeCli().on('swap place', [{ ordId: '', sCode: '51008', sMsg: 'Insufficient balance' }]);
    const result = await makeAdapter(cli).submitOrder(order());

    expect(result.status).toBe('rejected');
    expect(result.filledSize).toBe(0n);
  });

  it('never claims the stop is resting on acknowledgement alone', async () => {
    // `swap place` acknowledges the order, not the attached algo. Claiming true
    // here would defeat the GuardedExecutor check that trips the kill switch on
    // a naked fill — the one guard against an unstopped leveraged position.
    const cli = makeCli().on('swap place', [placed]);
    const result = await makeAdapter(cli).submitOrder(order());

    expect(result.status).toBe('accepted');
    expect(result.stopResting).toBe(false);
    expect(result.venueOrderId).toBe('1234567890');
  });
});

describe('openPositions', () => {
  const position = {
    instId: 'BTC-USDT-SWAP',
    posSide: 'long',
    pos: '0.05',
    avgPx: '64778.3',
    markPx: '64900.0',
    upl: '6.085',
  };

  it('requires discovery before it will scale an instrument', async () => {
    const cli = makeCli().on('account positions', [position]).on('swap algo orders', []);
    await expect(makeAdapter(cli).openPositions()).rejects.toThrow(/call describeVenue/);
  });

  it('reports a stop as resting only when it is in the algo book', async () => {
    // This value decides whether the watchdog panics, so it has to be read from
    // the venue rather than inferred from what we asked for.
    const cli = makeCli()
      .on('account positions', [position])
      .on('swap algo orders', [{ instId: 'BTC-USDT-SWAP', slTriggerPx: '64000', algoId: '99' }]);

    const adapter = makeAdapter(cli);
    await adapter.describeVenue();
    const [held] = await adapter.openPositions();

    expect(held?.stopRestingOnVenue).toBe(true);
    expect(held?.stopPrice).toBe(640_000n);
    expect(held?.size).toBe(5n);
    expect(held?.side).toBe('long');
  });

  it('reports no resting stop when the algo book is empty', async () => {
    const cli = makeCli().on('account positions', [position]).on('swap algo orders', []);
    const adapter = makeAdapter(cli);
    await adapter.describeVenue();
    const [held] = await adapter.openPositions();

    expect(held?.stopRestingOnVenue).toBe(false);
    expect(held?.stopPrice).toBeNull();
  });

  it('skips the flat rows that linger after a close', async () => {
    const cli = makeCli()
      .on('account positions', [{ ...position, pos: '0' }])
      .on('swap algo orders', []);
    const adapter = makeAdapter(cli);
    await adapter.describeVenue();

    expect(await adapter.openPositions()).toHaveLength(0);
  });

  it('does not lend one hedge leg the other leg\'s stop', async () => {
    // Hedge mode allows a long and a short on one instId. Keying the algo book
    // by instId alone reports the short's stop as the long's, which makes a
    // naked position look protected — the state the watchdog exists to catch.
    const cli = makeCli()
      .on('account positions', [
        position,
        { ...position, posSide: 'short', pos: '0.03' },
      ])
      .on('swap algo orders', [
        { instId: 'BTC-USDT-SWAP', posSide: 'short', slTriggerPx: '66000', algoId: '99' },
      ]);

    const adapter = makeAdapter(cli);
    await adapter.describeVenue();
    const positions = await adapter.openPositions();

    const long = positions.find((p) => p.side === 'long');
    const short = positions.find((p) => p.side === 'short');
    expect(long?.stopRestingOnVenue).toBe(false);
    expect(long?.stopPrice).toBeNull();
    expect(short?.stopRestingOnVenue).toBe(true);
    expect(short?.stopPrice).toBe(660_000n);
  });

  it('matches a net-mode algo row, which carries no side, to the position', async () => {
    const cli = makeCli()
      .on('account positions', [{ ...position, posSide: 'net' }])
      .on('swap algo orders', [{ instId: 'BTC-USDT-SWAP', posSide: 'net', slTriggerPx: '64000', algoId: '99' }]);

    const adapter = makeAdapter(cli);
    await adapter.describeVenue();
    const [held] = await adapter.openPositions();

    expect(held?.stopRestingOnVenue).toBe(true);
    expect(held?.stopPrice).toBe(640_000n);
  });

  it('reads a short from a negative size when posSide is absent', async () => {
    const cli = makeCli()
      .on('account positions', [{ ...position, posSide: '', pos: '-0.05' }])
      .on('swap algo orders', []);
    const adapter = makeAdapter(cli);
    await adapter.describeVenue();
    const [held] = await adapter.openPositions();

    expect(held?.side).toBe('short');
    expect(held?.size).toBe(5n); // magnitude, never negative
  });
});

describe('flatten', () => {
  it('works while stop custody is unverified, because closing risk must stay available', async () => {
    // Every other gate can shut. This one cannot, or a position becomes
    // unclosable exactly when something has already gone wrong.
    const cli = makeCli()
      .on('account positions', [
        { instId: 'BTC-USDT-SWAP', posSide: 'long', pos: '0.05', avgPx: '64778.3', markPx: '64900.0', upl: '1' },
      ])
      .on('swap algo orders', [])
      .on('swap close', [{ ordId: '555' }]);

    const adapter = makeAdapter(cli, { stopCustody: 'unverified' });
    await adapter.describeVenue();
    const result = await adapter.flatten(btc);

    expect(result.venueOrderId).toBe('555');
  });

  it('cancels resting algo orders on the way out', async () => {
    // A stop left behind on a flat position opens a NEW position when it fires.
    const cli = makeCli()
      .on('account positions', [
        { instId: 'BTC-USDT-SWAP', posSide: 'long', pos: '0.05', avgPx: '64778.3', markPx: '64900.0', upl: '1' },
      ])
      .on('swap algo orders', [])
      .on('swap close', [{ ordId: '555' }]);

    const adapter = makeAdapter(cli);
    await adapter.describeVenue();
    await adapter.flatten(btc);

    expect(cli.lastCall('swap close')).toContain('--autoCxl');
  });

  it('refuses to flatten what is not held rather than sending a blind close', async () => {
    const cli = makeCli().on('account positions', []).on('swap algo orders', []);
    const adapter = makeAdapter(cli);
    await adapter.describeVenue();

    await expect(adapter.flatten(btc)).rejects.toThrow(/no open position/);
  });
});

describe('availableBalance', () => {
  it('reads free collateral, not total equity', async () => {
    // eq includes USDT already margining a position; sizing off it would
    // double-commit the same collateral.
    const cli = makeCli().on('account balance', [
      { totalEq: '320', details: [{ ccy: 'USDT', eq: '320', availEq: '287.5' }] },
    ]);
    expect(await makeAdapter(cli).availableBalance()).toBe(28_750_000_000n); // 287.5 at 8dp
  });

  it('throws when there is no USDT line rather than reporting zero', async () => {
    const cli = makeCli().on('account balance', [{ details: [{ ccy: 'BTC', availEq: '1' }] }]);
    await expect(makeAdapter(cli).availableBalance()).rejects.toThrow(/no USDT line/);
  });
});

describe('cancelOrder', () => {
  it('resolves the instrument from the open book rather than guessing', async () => {
    const cli = makeCli()
      .on('swap orders', [{ ordId: '1234567890', instId: 'BTC-USDT-SWAP', state: 'live' }])
      .on('swap cancel', [{ ordId: '1234567890', sCode: '0' }]);

    await makeAdapter(cli).cancelOrder('1234567890');
    expect(cli.lastCall('swap cancel')).toEqual([
      'swap',
      'cancel',
      'BTC-USDT-SWAP',
      '--ordId',
      '1234567890',
    ]);
  });

  it('refuses to cancel an order it cannot find', async () => {
    const cli = makeCli().on('swap orders', []);
    await expect(makeAdapter(cli).cancelOrder('nope')).rejects.toThrow(/not in the open book/);
  });
});

describe('order state mapping', () => {
  it('maps the states OKX actually returns', () => {
    expect(mapOrderState('live')).toBe('accepted');
    expect(mapOrderState('filled')).toBe('filled');
    expect(mapOrderState('partially_filled')).toBe('partially_filled');
    expect(mapOrderState('canceled')).toBe('cancelled');
    expect(mapOrderState('mmp_canceled')).toBe('cancelled');
  });

  it('throws on an unrecognised state instead of guessing one', () => {
    // A new venue state silently mapped to "accepted" would have the reconciler
    // believing an order is live when it is not.
    expect(() => mapOrderState('something_new')).toThrow(ExecutionError);
    expect(() => mapOrderState(null)).toThrow(ExecutionError);
  });
});
