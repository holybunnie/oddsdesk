import { describe, expect, it } from 'vitest';
import { virtualDemoBalanceMinor } from './demo-balance.js';

describe('virtual demo bankroll', () => {
  it('maps the venue baseline to 320 USDT', () => {
    expect(virtualDemoBalanceMinor(499_998_736_644n, 4999.98736644, 320)).toBe(32_000_000_000n);
  });

  it('preserves PnL across restarts through the fixed venue baseline', () => {
    expect(virtualDemoBalanceMinor(500_998_736_644n, 4999.98736644, 320)).toBe(33_000_000_000n);
    expect(virtualDemoBalanceMinor(498_998_736_644n, 4999.98736644, 320)).toBe(31_000_000_000n);
  });
});
