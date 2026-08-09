import { describe, expect, it } from 'vitest';
import { RiskTokenBlocked } from './adapter.js';
import { ListedPerpRiskGate } from './perp-risk.js';

const gate = new ListedPerpRiskGate();

describe('ListedPerpRiskGate', () => {
  it('accepts a measured USDT perpetual', async () => {
    await expect(gate.assertClean({
      symbol: 'BTC-USDT-SWAP',
      priceDecimals: 1,
      sizeDecimals: 2,
      contractValue: 0.01,
      maxLeverage: 100,
    })).resolves.toBeUndefined();
  });

  it('blocks missing per-instrument leverage rather than treating it as clean', async () => {
    await expect(gate.assertClean({
      symbol: 'BTC-USDT-SWAP',
      priceDecimals: 1,
      sizeDecimals: 2,
      contractValue: 0.01,
    })).rejects.toThrow(RiskTokenBlocked);
  });

  it('blocks non-perpetual instruments', async () => {
    await expect(gate.assertClean({
      symbol: 'BTC-USDT',
      priceDecimals: 2,
      sizeDecimals: 6,
      contractValue: null,
      maxLeverage: 5,
    })).rejects.toThrow(/not a USDT perpetual/);
  });
});
