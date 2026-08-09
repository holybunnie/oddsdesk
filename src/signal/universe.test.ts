/**
 * E1's affordability filter.
 *
 * Breadth is the strategy's central assumption: a single-market trend follower
 * has poor odds and a fifty-market one has good odds. That assumption is only
 * true for instruments we can actually place an order on. At 320 USDT the
 * smallest notional we would ever place is around 60, and a perp whose minimum
 * order exceeds it is not narrow breadth — it is a candidate that can never
 * become a position, counted as though it could.
 */

import { describe, expect, it } from 'vitest';
import { loadConfig } from '../config.js';
import type { InstrumentSpec, TickerSnapshot } from '../market/okx.js';
import { minOrderNotionalUsdt, selectUniverseWithRejections } from './scanner.js';

const config = loadConfig('config/default.yaml');

const spec = (overrides: Partial<InstrumentSpec> = {}): InstrumentSpec => ({
  instId: 'AAA-USDT-SWAP',
  contractValue: 1,
  lotSize: 1,
  minSize: 1,
  tickSize: 0.001,
  state: 'live',
  ...overrides,
});

const ticker = (overrides: Partial<TickerSnapshot> = {}): TickerSnapshot => ({
  instId: 'AAA-USDT-SWAP',
  last: 10,
  bid: 9.999,
  ask: 10.001,
  quoteVolume24h: 100_000_000,
  ...overrides,
});

describe('minOrderNotionalUsdt', () => {
  it('reads minSize as CONTRACTS, multiplied through the contract value', () => {
    // On BTC-USDT-SWAP one contract is 0.01 BTC. Reading minSize as coins would
    // overstate the minimum a hundredfold — in the direction that rejects an
    // instrument we could afford, and understate it in the mirror case.
    expect(minOrderNotionalUsdt(spec({ minSize: 0.01, contractValue: 0.01 }), 100_000)).toBeCloseTo(10, 9);
    expect(minOrderNotionalUsdt(spec({ minSize: 1, contractValue: 1 }), 10)).toBeCloseTo(10, 9);
  });
});

describe('E1 affordability', () => {
  it('admits an instrument whose minimum order fits inside what we would place', () => {
    const { members } = selectUniverseWithRejections(config, [spec()], [ticker()]);
    expect(members).toHaveLength(1);
    expect(members[0]?.minNotionalUsdt).toBeCloseTo(10, 9);
  });

  it('rejects an instrument whose minimum order exceeds it', () => {
    // 100 contracts at 10 USDT is a 1000 USDT minimum against a 320 USDT
    // account. Every signal on it would be a venue rejection — and because the
    // signal is journalled before submission, one that is never retried.
    const { members, rejections } = selectUniverseWithRejections(
      config,
      [spec({ minSize: 100 })],
      [ticker()],
    );

    expect(members).toHaveLength(0);
    expect(rejections[0]?.reason).toBe('min_size');
    expect(rejections[0]?.detail).toMatch(/1000\.00 USDT/);
  });

  it('sits at the boundary without excluding the exact-fit case', () => {
    const atLimit = config.universe.minTradableNotionalUsdt;
    const priced = (notional: number) => spec({ minSize: notional / 10, contractValue: 1 });

    expect(selectUniverseWithRejections(config, [priced(atLimit)], [ticker()]).members).toHaveLength(1);
    expect(
      selectUniverseWithRejections(config, [priced(atLimit + 0.1)], [ticker()]).members,
    ).toHaveLength(0);
  });

  it('reports WHY each instrument was dropped, because the reasons are not interchangeable', () => {
    // An instrument dropped for volume returns if a threshold is loosened. One
    // dropped for minimum size never returns at this account size, and only the
    // second count answers "how much of the venue can we actually reach".
    const { rejections } = selectUniverseWithRejections(
      config,
      [
        spec({ instId: 'THIN-USDT-SWAP' }),
        spec({ instId: 'WIDE-USDT-SWAP' }),
        spec({ instId: 'BIG-USDT-SWAP', minSize: 100 }),
        spec({ instId: 'NVDA-USDT-SWAP' }),
      ],
      [
        ticker({ instId: 'THIN-USDT-SWAP', quoteVolume24h: 1 }),
        ticker({ instId: 'WIDE-USDT-SWAP', bid: 9, ask: 11 }),
        ticker({ instId: 'BIG-USDT-SWAP' }),
        ticker({ instId: 'NVDA-USDT-SWAP' }),
      ],
    );

    expect(rejections.map((r) => r.reason).sort()).toEqual(['excluded', 'min_size', 'spread', 'volume']);
  });

  it('does not report a rejection for an instrument that was never a candidate', () => {
    // Non-live and non-USDT instruments are not "rejected" — they were never in
    // scope, and counting them would inflate the rejection numbers the scan
    // report exists to make meaningful.
    const { rejections } = selectUniverseWithRejections(
      config,
      [spec({ instId: 'BTC-USD-SWAP' }), spec({ instId: 'NEW-USDT-SWAP', state: 'preopen' })],
      [],
    );
    expect(rejections).toHaveLength(0);
  });
});
