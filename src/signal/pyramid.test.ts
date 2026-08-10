import { describe, expect, it } from 'vitest';
import { loadConfig, type Stage } from '../config.js';
import { computeSize, RiskRefusal, type OpenRisk } from '../risk.js';
import type { TrackedPosition } from '../engine/state.js';
import { aggregateRiskUsdt, evaluatePyramid } from './pyramid.js';

const loadedConfig = loadConfig('config/default.yaml');
const config = {
  ...loadedConfig,
  strategy: { mode: 'legacy-cross-sectional' as const },
  pyramiding: { ...loadedConfig.pyramiding, enabled: true },
};
const withLeverage = { ...config, execution: { ...config.execution, maxLeverage: 5 } };

/** A long from 100 with R = 10, stop already ratcheted to breakeven, at +3R. */
const position = (overrides: Partial<TrackedPosition> = {}): TrackedPosition => ({
  instId: 'BTC-USDT-SWAP',
  signalId: 'S-1',
  side: 'long',
  entryPrice: 100,
  initialStop: 90,
  currentStop: 100,
  remainingFraction: 0.75,
  openedAtMs: 0,
  scaledOut: true,
  highWaterPrice: 130,
  lowWaterPrice: 100,
  venueSize: '24',
  adds: 0,
  ...overrides,
});

const inputs = (overrides = {}) => ({
  stage: 2 as Stage,
  position: position(),
  lastPrice: 130,
  freshBreakout: true,
  ...overrides,
});

describe('E6 arms only when every condition holds', () => {
  it('arms on a fresh breakout past +2R with the stop at breakeven, in stage 2', () => {
    const verdict = evaluatePyramid(config, inputs());
    expect(verdict.armed).toBe(true);
    expect(verdict.addIndex).toBe(1);
    expect(verdict.sizeMultiple).toBe(0.6);
  });

  it('refuses in stage 1 and stage 3', () => {
    // Stage 1 is survival and Stage 3 is defence. Adding in either is taking
    // more risk at exactly the moment the stage exists to take less.
    for (const stage of [1, 3] as const) {
      const verdict = evaluatePyramid(config, inputs({ stage }));
      expect(verdict.armed).toBe(false);
      expect(verdict.reasons.join(' ')).toMatch(/arms only in stage 2/);
    }
  });

  it('refuses on a pullback — adds follow a NEW breakout', () => {
    // Adding on a pullback is averaging into a position that has just moved
    // against you. It is the same instinct as averaging down.
    const verdict = evaluatePyramid(config, inputs({ freshBreakout: false }));
    expect(verdict.armed).toBe(false);
    expect(verdict.reasons.join(' ')).toMatch(/never a pullback/);
  });

  it('refuses below the +2R threshold', () => {
    const verdict = evaluatePyramid(config, inputs({ lastPrice: 115 }));
    expect(verdict.armed).toBe(false);
    expect(verdict.reasons.join(' ')).toMatch(/below the \+2R arming threshold/);
  });

  it('NEVER adds to a loser, and says so as its own reason', () => {
    // Stated separately from the R threshold so it survives every future edit
    // to that threshold. Averaging down ends the competition.
    const verdict = evaluatePyramid(config, inputs({ lastPrice: 95 }));
    expect(verdict.armed).toBe(false);
    expect(verdict.reasons.join(' ')).toMatch(/never add to a loser/);
  });

  it('refuses while the stop is still below breakeven', () => {
    // The stop at breakeven is what makes the add cheap: the original leg can
    // no longer lose, so the only new risk is the add's own.
    const verdict = evaluatePyramid(config, inputs({ position: position({ currentStop: 95 }) }));
    expect(verdict.armed).toBe(false);
    expect(verdict.reasons.join(' ')).toMatch(/not yet at breakeven/);
  });

  it('stops at maxAdds', () => {
    expect(evaluatePyramid(config, inputs({ position: position({ adds: 1 }) })).armed).toBe(true);
    const full = evaluatePyramid(config, inputs({ position: position({ adds: 2 }) }));
    expect(full.armed).toBe(false);
    expect(full.reasons.join(' ')).toMatch(/at the 2 limit/);
  });

  it('walks the ladder DOWN, never up', () => {
    // Decreasing adds are one of the three things separating this from
    // over-leveraging in disguise. The config schema refuses a ladder that does
    // not strictly decrease; this asserts the walk actually uses it.
    const first = evaluatePyramid(config, inputs({ position: position({ adds: 0 }) }));
    const second = evaluatePyramid(config, inputs({ position: position({ adds: 1 }) }));

    expect(first.sizeMultiple).toBe(0.6);
    expect(second.sizeMultiple).toBe(0.4);
    expect(second.sizeMultiple).toBeLessThan(first.sizeMultiple);
  });

  it('carries every reason, not the first', () => {
    const verdict = evaluatePyramid(
      config,
      inputs({ stage: 1 as Stage, freshBreakout: false, position: position({ currentStop: 95 }) }),
    );
    expect(verdict.reasons.length).toBeGreaterThan(2);
  });

  it('mirrors every rule for a short', () => {
    const short = position({
      side: 'short',
      entryPrice: 100,
      initialStop: 110,
      currentStop: 100,
      highWaterPrice: 100,
      lowWaterPrice: 70,
    });
    expect(evaluatePyramid(config, inputs({ position: short, lastPrice: 70 })).armed).toBe(true);
    // Stop still above entry for a short means it has NOT reached breakeven.
    expect(
      evaluatePyramid(config, inputs({ position: { ...short, currentStop: 105 }, lastPrice: 70 })).armed,
    ).toBe(false);
  });
});

describe('aggregate risk across the stack', () => {
  it('never credits a banked gain against new exposure', () => {
    // The original leg is locked in profit once its stop is past breakeven, and
    // that credit is deliberately NOT used to fund a larger add. Netting it is
    // how "risk-free pyramiding" becomes a position that gives back more than
    // it ever locked in.
    const risk = aggregateRiskUsdt('long', 110, [
      { entryPrice: 100, sizeUsdtPerPoint: 1 }, // 10 points in profit
      { entryPrice: 130, sizeUsdtPerPoint: 1 }, // 20 points at risk
    ]);
    expect(risk).toBe(20);
  });

  it('is zero when the stop is beyond every leg', () => {
    const risk = aggregateRiskUsdt('long', 140, [
      { entryPrice: 100, sizeUsdtPerPoint: 1 },
      { entryPrice: 130, sizeUsdtPerPoint: 1 },
    ]);
    expect(risk).toBe(0);
  });

  it('mirrors for a short', () => {
    // Short from 100 with the stop ratcheted down to 90 is 10 points in profit,
    // so that leg contributes nothing. The add at 70 sits 20 points under the
    // same stop, and 20 is the whole stack's risk.
    const risk = aggregateRiskUsdt('short', 90, [
      { entryPrice: 100, sizeUsdtPerPoint: 1 },
      { entryPrice: 70, sizeUsdtPerPoint: 1 },
    ]);
    expect(risk).toBe(20);
  });
});

describe('sizing an add', () => {
  const request = (overrides = {}) => ({
    stage: 2 as Stage,
    equity: { equityUsdt: 640, peakEquityUsdt: 640 },
    openRisk: [] as readonly OpenRisk[],
    correlationGroup: 'majors',
    entryPrice: 130,
    stopPrice: 100,
    targetPrice: 220,
    side: 'long' as const,
    ...overrides,
  });

  it('sizes the add at the ladder multiple of the base risk', () => {
    // Stage 2 risks 3%; the first add takes 0.6 of that, so 1.8%.
    const base = computeSize(withLeverage, request());
    const add = computeSize(withLeverage, request({ pyramidAddIndex: 1 }));

    expect(add.riskFraction).toBeCloseTo(base.riskFraction * 0.6, 9);
    expect(add.riskUsdt).toBeCloseTo(base.riskUsdt * 0.6, 9);
  });

  it('keeps computeSize free of any override parameter', () => {
    // The caller declares WHICH add it is; policy decides how big. There is
    // still no path by which a caller chooses its own size.
    expect(computeSize.length).toBe(2);
  });

  it('refuses an add outside stage 2', () => {
    expect(() => computeSize(withLeverage, request({ stage: 1, pyramidAddIndex: 1 }))).toThrow(
      /arms only in stage 2/,
    );
  });

  it('refuses an add past the ladder', () => {
    expect(() => computeSize(withLeverage, request({ pyramidAddIndex: 3 }))).toThrow(/exceeds the 2-add limit/);
  });

  it('refuses every add when pyramiding is disabled', () => {
    const off = { ...withLeverage, pyramiding: { ...withLeverage.pyramiding, enabled: false } };
    expect(() => computeSize(off, request({ pyramidAddIndex: 1 }))).toThrow(RiskRefusal);
  });

  it('exempts an add from the position, correlation and directional caps', () => {
    // An add is not a new position — it is more of one that already counts
    // against all three. Re-applying them would make the second add impossible
    // for the arithmetic reason that the first one succeeded.
    const full: OpenRisk[] = [
      { instrument: 'BTC-USDT-SWAP', correlationGroup: 'majors', riskUsdt: 0, side: 'long' },
      { instrument: 'ETH-USDT-SWAP', correlationGroup: 'majors', riskUsdt: 0, side: 'long' },
      { instrument: 'SOL-USDT-SWAP', correlationGroup: 'layer1', riskUsdt: 0, side: 'long' },
    ];

    expect(() => computeSize(withLeverage, request({ openRisk: full }))).toThrow(RiskRefusal);
    expect(() => computeSize(withLeverage, request({ openRisk: full, pyramidAddIndex: 1 }))).not.toThrow();
  });

  it('does NOT exempt an add from portfolio heat', () => {
    // Heat is the one cap that must still bind: it measures live risk, and an
    // add genuinely adds some.
    const hot: OpenRisk[] = [
      { instrument: 'BTC-USDT-SWAP', correlationGroup: 'majors', riskUsdt: 38, side: 'long' },
    ];
    expect(() => computeSize(withLeverage, request({ openRisk: hot, pyramidAddIndex: 1 }))).toThrow(
      /portfolio heat/,
    );
  });
});
