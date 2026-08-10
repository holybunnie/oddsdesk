/**
 * Law 7: a safety mechanism that has never fired in a test does not exist.
 *
 * Every test below drives a refusal path to an actual throw.
 */

import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig, requireMaxLeverage, assertIsolatedMargin, type Config } from './config.js';
import {
  assertAboveEligibilityFloor,
  assertNotAddingToLoser,
  computeSize,
  determineStage,
  drawdownFromPeak,
  governorAction,
  RiskRefusal,
  type EquityState,
  type OpenRisk,
  type SizingRequest,
} from './risk.js';

/** The shipped config deliberately has no maxLeverage until verification writes it. */
const unverified = loadConfig('config/default.yaml');

/** Stands in for the post-verification config: venue-held stops confirmed. */
const config: Config = {
  ...unverified,
  execution: { ...unverified.execution, maxLeverage: 5 },
};

const flat: EquityState = { equityUsdt: 320, peakEquityUsdt: 320 };

const request = (overrides: Partial<SizingRequest> = {}): SizingRequest => ({
  stage: 1,
  equity: flat,
  openRisk: [],
  correlationGroup: 'btc-beta',
  entryPrice: 100,
  stopPrice: 99,
  targetPrice: 103,
  side: 'long',
  ...overrides,
});

const held = (
  instrument: string,
  correlationGroup: string,
  riskUsdt: number,
  side: 'long' | 'short' = 'long',
): OpenRisk => ({
  instrument,
  correlationGroup,
  riskUsdt,
  side,
});

describe('maxLeverage must be verified before any order', () => {
  it('throws while unset rather than defaulting', () => {
    expect(() => requireMaxLeverage(unverified)).toThrow(ConfigError);
    expect(() => requireMaxLeverage(unverified)).toThrow(/stop verification/);
  });

  it('blocks sizing entirely while unset', () => {
    // Not a warning. Nothing can be sized until the kill test has been observed.
    expect(() => computeSize(unverified, request())).toThrow(/maxLeverage is not set/);
  });

  it('returns the written value once verification has set it', () => {
    expect(requireMaxLeverage(config)).toBe(5);
  });
});

describe('isolated margin', () => {
  it('passes on the shipped config', () => {
    expect(() => assertIsolatedMargin(config)).not.toThrow();
  });

  it('refuses cross margin', () => {
    const cross: Config = { ...config, execution: { ...config.execution, marginMode: 'cross' } };
    expect(() => assertIsolatedMargin(cross)).toThrow(/isolated margin is mandatory/);
  });
});

describe('stage determination', () => {
  it('starts in stage 1 at the principal base', () => {
    expect(determineStage(config, flat, false)).toBe(1);
  });

  it('enters stage 2 at 2x start equity', () => {
    expect(determineStage(config, { equityUsdt: 640, peakEquityUsdt: 640 }, false)).toBe(2);
  });

  it('enters stage 3 only on confirmed top-3 with cushion', () => {
    expect(determineStage(config, { equityUsdt: 900, peakEquityUsdt: 900 }, true)).toBe(3);
  });

  it('refuses stage 3 when rank data is unavailable, even at high equity', () => {
    expect(determineStage(config, { equityUsdt: 900, peakEquityUsdt: 900 }, null)).toBe(2);
  });
});

describe('drawdown governor', () => {
  it('measures from peak, not from start', () => {
    // Above the 320 start but 25% below an 800 peak. Measuring from start would
    // report a gain and size normally; that is the DeepSeek give-back.
    const state: EquityState = { equityUsdt: 600, peakEquityUsdt: 800 };
    expect(drawdownFromPeak(state)).toBeCloseTo(0.25, 10);
    expect(governorAction(config, state, 2)).toBe('flatAndHalt');
  });

  it('escalates through the stage-1 bands', () => {
    const at = (equityUsdt: number) => governorAction(config, { equityUsdt, peakEquityUsdt: 1000 }, 1);
    expect(at(900)).toBe('normal');
    expect(at(800)).toBe('halveSizing');
    expect(at(700)).toBe('flatAndHalt');
    expect(at(600)).toBe('stopForCompetition');
  });

  it('runs tighter in stage 3 than stage 1 at identical drawdown', () => {
    const state: EquityState = { equityUsdt: 880, peakEquityUsdt: 1000 };
    expect(governorAction(config, state, 1)).toBe('normal');
    expect(governorAction(config, state, 3)).toBe('flatAndHalt');
  });

  it('refuses to size once the governor has halted', () => {
    expect(() =>
      computeSize(config, { ...request({ stage: 2 }), equity: { equityUsdt: 700, peakEquityUsdt: 1000 } }),
    ).toThrow(/no new positions/);
  });
});

describe('payoff ratio enforcement', () => {
  it('accepts a 3:1 setup', () => {
    expect(computeSize(config, request()).targetStopRatio).toBeCloseTo(3, 10);
  });

  it('refuses a 2:1 setup', () => {
    expect(() => computeSize(config, request({ targetPrice: 102 }))).toThrow(/below the required 3:1/);
  });

  it('refuses a long whose stop sits above entry', () => {
    expect(() => computeSize(config, request({ stopPrice: 101, targetPrice: 110 }))).toThrow(RiskRefusal);
  });
});

describe('fixed fractional sizing', () => {
  it('risks the identical fraction regardless of stop distance', () => {
    const tight = computeSize(config, request({ targetPrice: 105 }));
    const wide = computeSize(config, request({ stopPrice: 90, targetPrice: 150 }));

    expect(tight.riskUsdt).toBeCloseTo(wide.riskUsdt, 10);
    expect(tight.riskUsdt).toBeCloseTo(320 * 0.01, 10);
    expect(wide.notionalUsdt).toBeLessThan(tight.notionalUsdt);
  });

  it('halves risk when the governor says halveSizing', () => {
    const result = computeSize(config, {
      ...request({ targetPrice: 105 }),
      equity: { equityUsdt: 800, peakEquityUsdt: 1000 },
    });
    expect(result.governor).toBe('halveSizing');
    expect(result.riskFraction).toBeCloseTo(0.005, 10);
  });

  it('exposes no override path for risk', () => {
    // Structural, not advisory. If someone adds a multiplier parameter this fails.
    expect(computeSize.length).toBe(2);
  });
});

describe('leverage is an output, not an input', () => {
  it('reports emergent leverage well under the cap on a normal stop', () => {
    // 1% risk with a 1% stop distance is 1x notional. The cap is nowhere near.
    const result = computeSize(config, request({ targetPrice: 105 }));
    expect(result.leverage).toBeCloseTo(1, 6);
    expect(result.leverage).toBeLessThan(requireMaxLeverage(config));
  });

  it('rejects a pathologically tight stop rather than sizing into it', () => {
    // A stop a hair from entry produces enormous size at identical nominal
    // risk. This is exactly what the cap exists to catch.
    expect(() => computeSize(config, request({ stopPrice: 99.9, targetPrice: 101 }))).toThrow(
      /leverage against a 5x cap/,
    );
  });

  it('honours a measured per-instrument leverage ceiling below policy cap', () => {
    expect(() => computeSize(config, request({ instrumentMaxLeverage: 0.75, targetPrice: 105 }))).toThrow(
      /against a 0.75x cap/,
    );
  });
});

describe('portfolio heat and correlation caps', () => {
  it('permits a position that keeps heat under the cap', () => {
    const result = computeSize(config, {
      ...request({ targetPrice: 105 }),
      openRisk: [held('ETH-PERP', 'eth-beta', 6.4)],
    });
    // 6.4 held + 3.2 new = 9.6 on 320 equity = 3%, under the 6% cap.
    expect(result.heatAfter).toBeCloseTo(0.03, 6);
  });

  it('refuses when heat would breach the cap', () => {
    // This is the control that would have saved the model holding six losing shorts.
    expect(() =>
      computeSize(config, {
        ...request({ targetPrice: 105 }),
        openRisk: [held('ETH-PERP', 'eth-beta', 9.0, 'short'), held('SOL-PERP', 'high-beta-alt', 9.0, 'short')],
      }),
    ).toThrow(/portfolio heat would reach/);
  });

  it('lets a position trailed to breakeven free capacity', () => {
    // Risk still live is what counts, not the risk originally taken.
    const result = computeSize(config, {
      ...request({ targetPrice: 105 }),
      openRisk: [held('ETH-PERP', 'eth-beta', 0, 'short'), held('SOL-PERP', 'high-beta-alt', 0, 'short')],
    });
    expect(result.heatAfter).toBeCloseTo(0.01, 6);
  });

  it('refuses a fourth concurrent position', () => {
    expect(() =>
      computeSize(config, {
        ...request({ targetPrice: 105 }),
        openRisk: [
          held('ETH-PERP', 'eth-beta', 0),
          held('SOL-PERP', 'high-beta-alt', 0),
          held('DOGE-PERP', 'high-beta-alt', 0),
        ],
      }),
    ).toThrow(/already holding 3 positions/);
  });

  it('refuses a third position in the same correlation group', () => {
    // Three high-beta alts is one trade wearing three hats.
    expect(() =>
      computeSize(config, {
        ...request({ targetPrice: 105, correlationGroup: 'high-beta-alt' }),
        openRisk: [held('SOL-PERP', 'high-beta-alt', 0, 'short'), held('DOGE-PERP', 'high-beta-alt', 0, 'short')],
      }),
    ).toThrow(/correlation group "high-beta-alt"/);
  });

  it('permits a second position in a different group', () => {
    expect(() =>
      computeSize(config, {
        ...request({ targetPrice: 105, correlationGroup: 'btc-beta' }),
        openRisk: [held('SOL-PERP', 'high-beta-alt', 0, 'short'), held('DOGE-PERP', 'high-beta-alt', 0, 'short')],
      }),
    ).not.toThrow();
  });
});

describe('hard refusals', () => {
  it('never adds to a losing long', () => {
    expect(() => assertNotAddingToLoser('long', 100, 95)).toThrow(/never add to a loser/);
  });

  it('never adds to a losing short', () => {
    expect(() => assertNotAddingToLoser('short', 100, 105)).toThrow(/never add to a loser/);
  });

  it('permits adding to a winner', () => {
    expect(() => assertNotAddingToLoser('long', 100, 110)).not.toThrow();
  });

  it('refuses below the eligibility floor', () => {
    expect(() => assertAboveEligibilityFloor(config, 299.5)).toThrow(/eligibility floor/);
    expect(() => assertAboveEligibilityFloor(config, 300)).not.toThrow();
  });
});

describe('the directional cap', () => {
  it('refuses a third position on the same side even across different groups', () => {
    // The correlation groups encode relationships we anticipated. This catches
    // the ones we did not: E3 selects momentum extremes, and the extremes are
    // usually one complex moving together, so a book that satisfies every group
    // cap can still be a single bet placed three times.
    expect(() =>
      computeSize(config, {
        ...request({ targetPrice: 105 }),
        openRisk: [held('BTC-PERP', 'majors', 0, 'long'), held('SOL-PERP', 'layer1', 0, 'long')],
      }),
    ).toThrow(/a third position on the same side/);
  });

  it('permits a position that disagrees with the book', () => {
    // A genuinely two-sided book is not concentration, and the cap must not
    // become a position limit by another name.
    expect(() =>
      computeSize(config, {
        ...request({ targetPrice: 97, stopPrice: 101, side: 'short' }),
        openRisk: [held('BTC-PERP', 'majors', 0, 'long'), held('SOL-PERP', 'layer1', 0, 'long')],
      }),
    ).not.toThrow();
  });

  it('leaves the third slot reachable only by disagreeing', () => {
    // With 3 slots and a cap of 2, the third position must take the other side
    // or not exist. That is the whole intent, stated as a property.
    expect(config.risk.maxPositionsPerSide).toBeLessThan(config.risk.maxConcurrentPositions);
  });

  it('names the gate that refused, so the ledger records which one it was', () => {
    try {
      computeSize(config, {
        ...request({ targetPrice: 105 }),
        openRisk: [held('BTC-PERP', 'majors', 0, 'long'), held('SOL-PERP', 'layer1', 0, 'long')],
      });
      expect.unreachable('should have refused');
    } catch (error) {
      expect((error as RiskRefusal).code).toBe('directional_cap');
    }
  });
});
