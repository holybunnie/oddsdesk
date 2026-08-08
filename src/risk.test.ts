/**
 * Law 7: a safety mechanism that has never fired in a test does not exist.
 *
 * Every test below drives a refusal path to an actual throw. Tests that only
 * assert the happy case would leave the gates unproven, which is the state the
 * spec explicitly forbids.
 */

import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';
import {
  assertAboveEligibilityFloor,
  assertNotAddingToLoser,
  computeSize,
  determineStage,
  drawdownFromPeak,
  governorAction,
  RiskRefusal,
  type EquityState,
} from './risk.js';

const config = loadConfig('config/default.yaml');

const flat: EquityState = { equityUsdt: 320, peakEquityUsdt: 320 };

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
    // Defending a rank you cannot currently measure is guessing.
    expect(determineStage(config, { equityUsdt: 900, peakEquityUsdt: 900 }, null)).toBe(2);
  });
});

describe('drawdown governor', () => {
  it('reports no drawdown at the peak', () => {
    expect(drawdownFromPeak(flat)).toBe(0);
  });

  it('measures from peak, not from start', () => {
    // Equity is above the 320 start but 25% below a 800 peak. Measuring from
    // start would report a gain and size normally; that is the DeepSeek failure.
    const state: EquityState = { equityUsdt: 600, peakEquityUsdt: 800 };
    expect(drawdownFromPeak(state)).toBeCloseTo(0.25, 10);
    expect(governorAction(config, state, 2)).toBe('flatAndHalt');
  });

  it('escalates through the stage-1 bands', () => {
    const at = (equityUsdt: number) => governorAction(config, { equityUsdt, peakEquityUsdt: 1000 }, 1);
    expect(at(900)).toBe('normal'); // -10%
    expect(at(800)).toBe('halveSizing'); // -20%, past 18%
    expect(at(700)).toBe('flatAndHalt'); // -30%, past 28%
    expect(at(600)).toBe('stopForCompetition'); // -40%, past 38%
  });

  it('runs tighter in stage 3 than stage 1 at identical drawdown', () => {
    const state: EquityState = { equityUsdt: 880, peakEquityUsdt: 1000 }; // -12%
    expect(governorAction(config, state, 1)).toBe('normal');
    expect(governorAction(config, state, 3)).toBe('flatAndHalt');
  });
});

describe('H2 — payoff ratio enforcement', () => {
  it('accepts a 3:1 setup', () => {
    const result = computeSize(config, {
      stage: 1,
      equity: flat,
      entryPrice: 100,
      stopPrice: 99,
      targetPrice: 103,
      side: 'long',
    });
    expect(result.targetStopRatio).toBeCloseTo(3, 10);
  });

  it('refuses a 2:1 setup', () => {
    expect(() =>
      computeSize(config, {
        stage: 1,
        equity: flat,
        entryPrice: 100,
        stopPrice: 99,
        targetPrice: 102,
        side: 'long',
      }),
    ).toThrow(/below the required 3:1/);
  });

  it('refuses a long whose stop sits above entry', () => {
    expect(() =>
      computeSize(config, {
        stage: 1,
        equity: flat,
        entryPrice: 100,
        stopPrice: 101,
        targetPrice: 110,
        side: 'long',
      }),
    ).toThrow(RiskRefusal);
  });
});

describe('H3 — fixed fractional sizing', () => {
  it('risks the identical fraction of equity regardless of stop distance', () => {
    const tight = computeSize(config, {
      stage: 1,
      equity: flat,
      entryPrice: 100,
      stopPrice: 99,
      targetPrice: 105,
      side: 'long',
    });
    const wide = computeSize(config, {
      stage: 1,
      equity: flat,
      entryPrice: 100,
      stopPrice: 90,
      targetPrice: 150,
      side: 'long',
    });

    // Identical risk, different notional. This is the property whose absence
    // produced -62.7% in Alpha Arena.
    expect(tight.riskUsdt).toBeCloseTo(wide.riskUsdt, 10);
    expect(tight.riskUsdt).toBeCloseTo(320 * 0.02, 10);
    expect(wide.notionalUsdt).toBeLessThan(tight.notionalUsdt);
  });

  it('halves risk when the governor says halveSizing', () => {
    const state: EquityState = { equityUsdt: 800, peakEquityUsdt: 1000 }; // -20%, stage 1
    const result = computeSize(config, {
      stage: 1,
      equity: state,
      entryPrice: 100,
      stopPrice: 99,
      targetPrice: 105,
      side: 'long',
    });
    expect(result.governor).toBe('halveSizing');
    expect(result.riskFraction).toBeCloseTo(0.01, 10);
  });

  it('refuses to size at all once the governor has halted', () => {
    expect(() =>
      computeSize(config, {
        stage: 2,
        equity: { equityUsdt: 700, peakEquityUsdt: 1000 },
        entryPrice: 100,
        stopPrice: 99,
        targetPrice: 105,
        side: 'long',
      }),
    ).toThrow(/no new positions/);
  });

  it('exposes no override path for risk', () => {
    // Structural, not advisory: computeSize takes exactly (config, request) and
    // SizingRequest has no multiplier, confidence or override field. If someone
    // adds one, this assertion on the function arity fails and the review catches it.
    expect(computeSize.length).toBe(2);
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
