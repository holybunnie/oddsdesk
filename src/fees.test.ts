import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';
import { Ledger } from './ledger.js';
import {
  accrueFundingUsdt,
  costBreakdown,
  describeCosts,
  fundingTimestampsBetween,
  tradingFeesUsdt,
  FeeBudgetError,
} from './fees.js';

const config = loadConfig('config/default.yaml');
const HOUR = 3_600_000;

let ledger: Ledger;

beforeEach(() => {
  ledger = new Ledger(join(mkdtempSync(join(tmpdir(), 'fees-')), 'ledger.db'));
});

/** A filled order carrying a venue-reported fee, in quote minor units. */
function fill(feePaidMinor: string | null): void {
  ledger.append({
    action: 'order_filled',
    engine: 'test',
    venue: 'okx',
    instrument: 'BTC-USDT-SWAP',
    signal: 'S-1',
    price: '64000',
    size: '24',
    stop: '63000',
    reason: 'venue status filled',
    detail: { feePaid: feePaidMinor },
  });
}

describe('trading fees are MEASURED', () => {
  it('sums what the venue actually reported, at quote scale', () => {
    // 0.032 USDT at 8 decimals. Fees are the one half of the cost model that is
    // not an estimate, and they must not become one.
    fill('3200000');
    fill('3200000');
    expect(tradingFeesUsdt(ledger)).toBeCloseTo(0.064, 9);
  });

  it('normalises the sign, because a rebate must not count the budget downwards', () => {
    fill('-3200000');
    expect(tradingFeesUsdt(ledger)).toBeCloseTo(0.032, 9);
  });

  it('counts nothing when the venue reported nothing, rather than estimating', () => {
    // An estimate here would be a number we invented sitting inside a budget we
    // enforce. Under-counting is visible in the ledger; a fabricated fee is not.
    fill(null);
    expect(tradingFeesUsdt(ledger)).toBe(0);
  });

  it('throws on a fee it cannot parse rather than skipping it', () => {
    fill('not-a-number');
    expect(() => tradingFeesUsdt(ledger)).toThrow(FeeBudgetError);
  });

  it('ignores rows that are not fills', () => {
    ledger.append({
      action: 'order_submitted',
      engine: 'test',
      venue: 'okx',
      instrument: 'BTC-USDT-SWAP',
      signal: 'S-1',
      price: null,
      size: null,
      stop: null,
      reason: 'intent',
      detail: { feePaid: '99900000000' },
    });
    expect(tradingFeesUsdt(ledger)).toBe(0);
  });
});

describe('funding follows the venue clock, not the position clock', () => {
  const WINDOW = 8;

  it('charges a window crossed one minute after entry', () => {
    // OKX charges on a fixed schedule, so a position opened at 07:59 pays a full
    // window at 08:00. Counting elapsed hours would under-charge short holds,
    // which are most of them.
    const from = Date.UTC(2026, 7, 12, 7, 59);
    const to = Date.UTC(2026, 7, 12, 8, 1);
    expect(fundingTimestampsBetween(from, to, WINDOW)).toHaveLength(1);
  });

  it('charges nothing for a long interval that crosses no boundary', () => {
    const from = Date.UTC(2026, 7, 12, 8, 1);
    const to = Date.UTC(2026, 7, 12, 15, 59);
    expect(fundingTimestampsBetween(from, to, WINDOW)).toHaveLength(0);
  });

  it('is half-open, so consecutive cycles cannot charge the same window twice', () => {
    const boundary = Date.UTC(2026, 7, 12, 8, 0);
    const first = fundingTimestampsBetween(boundary - HOUR, boundary, WINDOW);
    const second = fundingTimestampsBetween(boundary, boundary + HOUR, WINDOW);

    expect(first).toEqual([boundary]);
    expect(second).toEqual([]);
  });

  it('charges three windows across a full day', () => {
    const from = Date.UTC(2026, 7, 12, 0, 0);
    const to = Date.UTC(2026, 7, 13, 0, 0);
    expect(fundingTimestampsBetween(from, to, WINDOW)).toHaveLength(3);
  });

  it('returns nothing for a backwards or zero interval', () => {
    const t = Date.UTC(2026, 7, 12, 12, 0);
    expect(fundingTimestampsBetween(t, t, WINDOW)).toEqual([]);
    expect(fundingTimestampsBetween(t, t - HOUR, WINDOW)).toEqual([]);
  });
});

describe('funding accrual', () => {
  const window = (n: number) => ({
    from: Date.UTC(2026, 7, 12, 7, 59),
    to: Date.UTC(2026, 7, 12, 7, 59) + n * 8 * HOUR,
  });

  it('charges a long when funding is positive', () => {
    const { from, to } = window(1);
    const paid = accrueFundingUsdt(
      [{ instId: 'BTC-USDT-SWAP', side: 'long', notionalUsdt: 200, fundingRate: 0.0002 }],
      from,
      to,
      8,
    );
    expect(paid).toBeCloseTo(0.04, 9);
  });

  it('CREDITS a short when funding is positive', () => {
    // Unlike the entry-time estimate, which charges only adverse funding so a
    // trade is never priced on income that can invert, this is an accounting of
    // what happened — and an accounting that dropped the favourable half would
    // not balance.
    const { from, to } = window(1);
    const paid = accrueFundingUsdt(
      [{ instId: 'BTC-USDT-SWAP', side: 'short', notionalUsdt: 200, fundingRate: 0.0002 }],
      from,
      to,
      8,
    );
    expect(paid).toBeCloseTo(-0.04, 9);
  });

  it('scales with the number of windows crossed, not with elapsed time', () => {
    const one = accrueFundingUsdt(
      [{ instId: 'X', side: 'long', notionalUsdt: 100, fundingRate: 0.001 }],
      window(1).from,
      window(1).to,
      8,
    );
    const three = accrueFundingUsdt(
      [{ instId: 'X', side: 'long', notionalUsdt: 100, fundingRate: 0.001 }],
      window(3).from,
      window(3).to,
      8,
    );
    expect(three).toBeCloseTo(one * 3, 9);
  });

  it('sums across every open position', () => {
    const { from, to } = window(1);
    const paid = accrueFundingUsdt(
      [
        { instId: 'A', side: 'long', notionalUsdt: 100, fundingRate: 0.001 },
        { instId: 'B', side: 'long', notionalUsdt: 100, fundingRate: 0.001 },
      ],
      from,
      to,
      8,
    );
    expect(paid).toBeCloseTo(0.2, 9);
  });

  it('charges a flat book nothing', () => {
    const { from, to } = window(3);
    expect(accrueFundingUsdt([], from, to, 8)).toBe(0);
  });
});

describe('the budget', () => {
  it('caps at feeBudgetFraction of Principal Base', () => {
    // 6% of 320 = 19.20 USDT for the whole competition.
    expect(costBreakdown(config, 0, 0).budgetUsdt).toBeCloseTo(19.2, 9);
  });

  it('does not breach below the cap and does breach at it', () => {
    expect(costBreakdown(config, 19.19, 0).breached).toBe(false);
    expect(costBreakdown(config, 19.2, 0).breached).toBe(true);
  });

  it('counts funding toward the same budget as fees', () => {
    // The whole point. Before this, a trade could pay 0.25% of notional in
    // funding while the fee tracker reported 2 bps maker and looked healthy.
    expect(costBreakdown(config, 10, 10).breached).toBe(true);
    expect(costBreakdown(config, 10, 0).breached).toBe(false);
  });

  it('floors at zero rather than crediting headroom from favourable funding', () => {
    // Funding we earned is not budget we can spend on fees: it inverts the
    // moment the crowd rotates, and a budget that grew on it would be loosest
    // exactly when the crowding it reflects is at its most extreme.
    const costs = costBreakdown(config, 1, -50);
    expect(costs.totalUsdt).toBe(0);
    expect(costs.fundingUsdt).toBe(-50);
  });

  it('says which half is measured and which is modelled, every time it is printed', () => {
    // A single number would invite the reader to trust both equally.
    const text = describeCosts(costBreakdown(config, 1.5, 0.5));
    expect(text).toMatch(/measured/);
    expect(text).toMatch(/modelled/);
  });
});
