import { describe, expect, it } from 'vitest';
import { loadConfig } from '../config.js';
import type { Candle } from '../market/okx.js';
import { atr } from './indicators.js';
import {
  EntryError,
  evaluateEntry,
  expectedFundingCostFraction,
  hasBrokenOut,
  scoreConviction,
  type EntryInputs,
} from './entry.js';
import type { RankedInstrument } from './scanner.js';
import { buildSignal } from './publish.js';

const config = loadConfig('config/default.yaml');
const NOW = 1_760_000_000_000;
const HOUR = 3_600_000;

/**
 * A flat series with a constant 2-wide bar range, so ATR is exactly 2 and every
 * derived level (stop, target, band) is checkable by hand rather than by
 * re-running the implementation inside the assertion.
 */
function flat(count: number, close: number, quoteVolume = 1_000_000): Candle[] {
  return Array.from({ length: count }, (_, i) => ({
    openTimeMs: NOW - (count - i) * HOUR,
    open: close,
    high: close + 1,
    low: close - 1,
    close,
    volume: quoteVolume / close,
    quoteVolume,
    confirmed: true,
  }));
}

/** Replace the final bar of a series. */
function withLast(candles: Candle[], last: Partial<Candle>): Candle[] {
  const head = candles.slice(0, -1);
  const tail = candles[candles.length - 1] as Candle;
  return [...head, { ...tail, ...last }];
}

/** 24-bar high of 101, then a bar closing at 105 — a clean long breakout. */
const longBreakout1h = (): Candle[] =>
  withLast(flat(60, 100), { open: 100, high: 105, low: 99, close: 105 });

/** 24-bar low of 99, then a bar closing at 95 — a clean short breakout. */
const shortBreakout1h = (): Candle[] =>
  withLast(flat(60, 100), { open: 100, high: 101, low: 95, close: 95 });

/** Rising 4h series, so normalised momentum is positive. */
const rising4h = (): Candle[] =>
  Array.from({ length: 40 }, (_, i) => {
    const close = 100 + i;
    return {
      openTimeMs: NOW - (40 - i) * 4 * HOUR,
      open: close,
      high: close + 1,
      low: close - 1,
      close,
      volume: 1_000,
      quoteVolume: 1_000_000,
      confirmed: true,
    };
  });

const falling4h = (): Candle[] =>
  rising4h()
    .map((c, i, all) => ({ ...all[all.length - 1 - i] as Candle, openTimeMs: c.openTimeMs }));

const ranked = (overrides: Partial<RankedInstrument> = {}): RankedInstrument => ({
  instId: 'BTC-USDT-SWAP',
  momentumScore: 2.5,
  perLookback: { 4: 2, 12: 2.5, 24: 3 },
  adx: 45, // at the saturation point
  atr: 2,
  lastClose: 105,
  ...overrides,
});

/** A candidate that clears every gate: rank 0 of 80, saturated ADX and volume. */
const inputs = (overrides: Partial<EntryInputs> = {}): EntryInputs => ({
  ranked: ranked(),
  direction: 'long',
  candles1h: longBreakout1h(),
  candles4h: rising4h(),
  volumeTrendValue: 3.0,
  universeSize: 80,
  rankIndex: 0,
  fundingRate: 0,
  nowMs: NOW,
  ...overrides,
});

describe('hasBrokenOut', () => {
  it('excludes the current bar, so a bar cannot break its own level', () => {
    // The final bar prints the highest high in the whole series but closes back
    // inside the prior range. Without the exclusion every such bar is a
    // breakout and the trigger fires constantly.
    const candles = withLast(flat(60, 100), { high: 130, close: 100.5 });
    const result = hasBrokenOut(config, candles, 'long');

    expect(result.level).toBe(101);
    expect(result.broken).toBe(false);
  });

  it('requires a strict break, not a touch', () => {
    const candles = withLast(flat(60, 100), { high: 101, close: 101 });
    expect(hasBrokenOut(config, candles, 'long').broken).toBe(false);
  });

  it('detects breaks on both sides', () => {
    expect(hasBrokenOut(config, longBreakout1h(), 'long')).toMatchObject({
      broken: true,
      level: 101,
      lastClose: 105,
    });
    expect(hasBrokenOut(config, shortBreakout1h(), 'short')).toMatchObject({
      broken: true,
      level: 99,
      lastClose: 95,
    });
  });

  it('does not treat a long breakout as a short one', () => {
    expect(hasBrokenOut(config, longBreakout1h(), 'short').broken).toBe(false);
  });

  it('throws on an empty series rather than reporting "no breakout"', () => {
    expect(() => hasBrokenOut(config, [], 'long')).toThrow(EntryError);
  });
});

describe('scoreConviction', () => {
  const score = (
    overrides: {
      direction?: 'long' | 'short';
      adx?: number;
      volume?: number;
      rankIndex?: number;
      universeSize?: number;
      htf?: number;
    } = {},
  ) =>
    scoreConviction(
      config,
      ranked({ adx: overrides.adx ?? 45 }),
      overrides.direction ?? 'long',
      overrides.universeSize ?? 80,
      overrides.rankIndex ?? 0,
      overrides.volume ?? 3.0,
      overrides.htf ?? 1,
    );

  it('scores a perfect candidate at 100', () => {
    expect(score().total).toBeCloseTo(100, 10);
  });

  it('saturates each component, so one extreme reading cannot carry a candidate', () => {
    // ADX 200 and volume 50x are absurd readings. If they were unbounded they
    // would drag a bottom-ranked candidate with no 4h agreement over the gate.
    const extreme = score({ adx: 200, volume: 50, rankIndex: 79, htf: -1 });

    expect(extreme.trendStrength).toBe(1);
    expect(extreme.volume).toBe(1);
    expect(extreme.momentum).toBe(0);
    expect(extreme.multiTimeframe).toBe(0);
    // Only the two saturated weights survive: 0.25 + 0.25.
    expect(extreme.total).toBeCloseTo(50, 10);
    expect(extreme.total).toBeLessThan(config.signals.minConviction);
  });

  it('floors components at zero rather than going negative below the regime floor', () => {
    const weak = score({ adx: 5, volume: 0.1 });
    expect(weak.trendStrength).toBe(0);
    expect(weak.volume).toBe(0);
  });

  it('measures rank from the relevant end for each direction', () => {
    // Rank 0 is the strongest instrument: best for a long, worst for a short.
    expect(score({ direction: 'long', rankIndex: 0 }).momentum).toBe(1);
    expect(score({ direction: 'short', rankIndex: 0, htf: -1 }).momentum).toBe(0);
    expect(score({ direction: 'short', rankIndex: 79, htf: -1 }).momentum).toBe(1);
  });

  it('treats higher-timeframe agreement as binary', () => {
    expect(score({ direction: 'long', htf: 0.001 }).multiTimeframe).toBe(1);
    expect(score({ direction: 'long', htf: -0.001 }).multiTimeframe).toBe(0);
    expect(score({ direction: 'short', htf: -0.001 }).multiTimeframe).toBe(1);
  });

  it('does not divide by zero on a single-instrument universe', () => {
    expect(score({ universeSize: 1, rankIndex: 0 }).momentum).toBe(1);
  });
});

describe('evaluateEntry — acceptance', () => {
  it('accepts a candidate that clears every gate', () => {
    const verdict = evaluateEntry(config, inputs());
    expect(verdict.accepted).toBe(true);
  });

  it('derives the stop from ATR and the target from the stop at exactly the minimum payoff', () => {
    const verdict = evaluateEntry(config, inputs());
    if (!verdict.accepted) throw new Error(verdict.rejection.reasons.join('; '));
    const c = verdict.candidate;

    const atrValue = atr(longBreakout1h(), config.exits.atrPeriod);
    expect(c.atr).toBeCloseTo(atrValue, 10);

    const referenceRisk = c.lastClose - c.stopPrice;
    expect(referenceRisk).toBeCloseTo(config.exits.initialStopAtrMultiple * atrValue, 10);

    const executableRisk = c.entryBandHigh - c.stopPrice;
    const reward = c.targetPrice - c.entryBandHigh;
    expect(reward / executableRisk).toBeCloseTo(config.risk.minTargetStopRatio, 10);
  });

  it('brackets the breakout level on the correct side for a long', () => {
    const verdict = evaluateEntry(config, inputs());
    if (!verdict.accepted) throw new Error('expected acceptance');
    const c = verdict.candidate;

    // A long rests between the level it broke and a little above the close —
    // never chasing beyond a fraction of an ATR.
    expect(c.entryBandLow).toBe(c.breakoutLevel);
    expect(c.entryBandHigh).toBeCloseTo(c.lastClose + config.entry.bandAtrFraction * c.atr, 10);
    expect(c.entryBandLow).toBeLessThan(c.entryBandHigh);
    expect(c.stopPrice).toBeLessThan(c.entryBandLow);
  });

  it('brackets the breakout level on the correct side for a short', () => {
    const verdict = evaluateEntry(
      config,
      inputs({
        direction: 'short',
        candles1h: shortBreakout1h(),
        candles4h: falling4h(),
        rankIndex: 79,
      }),
    );
    if (!verdict.accepted) throw new Error('expected acceptance');
    const c = verdict.candidate;

    expect(c.entryBandHigh).toBe(c.breakoutLevel);
    expect(c.entryBandLow).toBeCloseTo(c.lastClose - config.entry.bandAtrFraction * c.atr, 10);
    expect(c.entryBandLow).toBeLessThan(c.entryBandHigh);
    expect(c.stopPrice).toBeGreaterThan(c.entryBandHigh);
    expect(c.targetPrice).toBeLessThan(c.lastClose);
  });

  it('stamps an expiry so a stale signal cannot be filled into a moved market', () => {
    const verdict = evaluateEntry(config, inputs());
    if (!verdict.accepted) throw new Error('expected acceptance');
    expect(verdict.candidate.validUntilMs).toBe(NOW + config.entry.validityHours * HOUR);
  });

  it('still accepts without 4h agreement, but records the missing component', () => {
    // 4h disagreement costs exactly its weight (15) and nothing more; at 85 the
    // candidate is still above the gate. If this ever changes, the weights and
    // the threshold have drifted apart.
    const verdict = evaluateEntry(config, inputs({ candles4h: falling4h() }));
    if (!verdict.accepted) throw new Error('expected acceptance');

    expect(verdict.candidate.conviction.multiTimeframe).toBe(0);
    expect(verdict.candidate.conviction.total).toBeCloseTo(85, 10);
  });
});

describe('evaluateEntry — rejection', () => {
  it('rejects without a breakout and says so', () => {
    const verdict = evaluateEntry(config, inputs({ candles1h: flat(60, 100) }));
    if (verdict.accepted) throw new Error('expected rejection');
    expect(verdict.rejection.reasons.join(' ')).toMatch(/no breakout/);
  });

  it('rejects below the conviction threshold and reports the score', () => {
    const verdict = evaluateEntry(
      config,
      inputs({ ranked: ranked({ adx: config.regime.minAdx }), volumeTrendValue: 1.0 }),
    );
    if (verdict.accepted) throw new Error('expected rejection');

    // Only momentum and 4h agreement contribute: 35 + 15 = 50.
    expect(verdict.rejection.conviction?.total).toBeCloseTo(50, 10);
    expect(verdict.rejection.reasons.join(' ')).toMatch(/conviction 50\.0 below the 75 threshold/);
  });

  it('blocks re-entry while the post-stop cooldown is running', () => {
    const verdict = evaluateEntry(config, inputs({ candles1h: flat(60, 100), cooldownUntilMs: NOW + 2 * HOUR }));
    if (verdict.accepted) throw new Error('expected rejection');
    expect(verdict.rejection.reasons.join(' ')).toMatch(/cooldown for another 120 minutes/);
  });

  it('allows a fresh breakout during the post-stop cooldown', () => {
    const verdict = evaluateEntry(config, inputs({ cooldownUntilMs: NOW + 2 * HOUR }));
    expect(verdict.accepted).toBe(true);
  });

  it('allows entry once the cooldown has expired', () => {
    const verdict = evaluateEntry(config, inputs({ cooldownUntilMs: NOW }));
    expect(verdict.accepted).toBe(true);
  });

  it('carries every reason, not just the first', () => {
    // The daily attribution needs to see whether the gate rejects for one
    // dominant cause — short-circuiting would hide a misplaced threshold.
    const verdict = evaluateEntry(
      config,
      inputs({
        candles1h: flat(60, 100),
        ranked: ranked({ adx: config.regime.minAdx }),
        volumeTrendValue: 1.0,
        cooldownUntilMs: NOW + HOUR,
      }),
    );
    if (verdict.accepted) throw new Error('expected rejection');

    const joined = verdict.rejection.reasons.join(' ');
    expect(verdict.rejection.reasons).toHaveLength(3);
    expect(joined).toMatch(/cooldown/);
    expect(joined).toMatch(/no breakout/);
    expect(joined).toMatch(/conviction/);
  });

  it('scores a rejected candidate anyway, so attribution can see how close it was', () => {
    const verdict = evaluateEntry(config, inputs({ candles1h: flat(60, 100) }));
    if (verdict.accepted) throw new Error('expected rejection');
    expect(verdict.rejection.conviction?.total).toBeCloseTo(100, 10);
  });

  it('reports the instrument and direction on a rejection', () => {
    const verdict = evaluateEntry(config, inputs({ candles1h: flat(60, 100) }));
    if (verdict.accepted) throw new Error('expected rejection');
    expect(verdict.rejection.instId).toBe('BTC-USDT-SWAP');
    expect(verdict.rejection.direction).toBe('long');
  });
});

describe('funding as a cost, not just a filter', () => {
  it('charges nothing when funding pays us', () => {
    // Funding in our favour is real income, but pricing a trade on income that
    // inverts the moment the crowd rotates turns a cost model into an
    // optimistic one. Favourable funding is simply free.
    expect(expectedFundingCostFraction(config, -0.0001, 'long')).toBe(0);
    expect(expectedFundingCostFraction(config, 0.0001, 'short')).toBe(0);
  });

  it('charges every window that fits inside the maximum hold', () => {
    // The hold band runs to 36h at 8h per window, so the honest worst case is
    // 5 payments. Assuming an average would price the trade on a hold we have
    // not committed to.
    const windows = Math.ceil(config.exits.maxHoldHours / config.regime.fundingWindowHours);
    expect(expectedFundingCostFraction(config, 0.0002, 'long')).toBeCloseTo(0.0002 * windows, 12);
  });

  it('pushes the target out rather than merely vetoing the trade', () => {
    // This is the difference the fix makes. Before, funding was a filter and an
    // "acceptable" rate was treated as free; now an expensive-to-hold
    // instrument needs a bigger move to clear the same payoff ratio.
    const free = evaluateEntry(config, inputs({ fundingRate: 0 }));
    const costly = evaluateEntry(config, inputs({ fundingRate: 0.0002 }));

    expect(free.accepted && costly.accepted).toBe(true);
    if (!free.accepted || !costly.accepted) return;

    expect(costly.candidate.targetPrice).toBeGreaterThan(free.candidate.targetPrice);
    expect(costly.candidate.expectedFundingCostFraction).toBeGreaterThan(0);
    // The stop is untouched: carry changes what the trade must earn, never what
    // it is allowed to lose.
    expect(costly.candidate.stopPrice).toBe(free.candidate.stopPrice);
  });

  it('charges a short for negative funding, mirroring the long', () => {
    const shortInputs = { direction: 'short' as const, candles1h: shortBreakout1h(), rankIndex: 79 };
    const free = evaluateEntry(config, inputs({ ...shortInputs, fundingRate: 0 }));
    const costly = evaluateEntry(config, inputs({ ...shortInputs, fundingRate: -0.0002 }));

    if (!free.accepted || !costly.accepted) {
      expect.unreachable('both short setups should clear the gate');
      return;
    }
    // A short's target sits BELOW entry, so carry pushes it further down.
    expect(costly.candidate.targetPrice).toBeLessThan(free.candidate.targetPrice);
  });
});

describe('TP1 — the level E5 actually acts on', () => {
  it('sits at the scale-out threshold, not at the screening target', () => {
    // The old signal published the 3:1 target and described it as the plan. E5
    // has no target logic at all: it takes 25% off at +2R and trails the rest,
    // so published intent and actual behaviour diverged on every winner.
    const verdict = evaluateEntry(config, inputs({ fundingRate: 0 }));
    if (!verdict.accepted) {
      expect.unreachable('the base fixture should clear the gate');
      return;
    }

    const { entryBandHigh, stopPrice, scaleOutPrice, targetPrice } = verdict.candidate;
    const r = Math.abs(entryBandHigh - stopPrice);

    expect(scaleOutPrice).toBeCloseTo(entryBandHigh + config.exits.scaleOutAtR * r, 9);
    expect(scaleOutPrice).toBeLessThan(targetPrice);
    expect(scaleOutPrice).toBeGreaterThan(entryBandHigh);
  });
});

describe('entry geometry and publication', () => {
  it('builds a publishable signal using the same band-edge payoff that sizing uses', () => {
    const verdict = evaluateEntry(config, inputs({ fundingRate: 0 }));
    if (!verdict.accepted) {
      expect.unreachable('the base fixture should clear the gate');
      return;
    }
    const c = verdict.candidate;
    expect(() => buildSignal(config, {
      signalId: 'S-TEST-BTC-L',
      instId: c.instId,
      direction: c.direction,
      entryLow: c.entryBandLow,
      entryHigh: c.entryBandHigh,
      stopPrice: c.stopPrice,
      ...(c.scaleOutPrice === undefined ? {} : { scaleOutPrice: c.scaleOutPrice }),
      targetPrice: c.targetPrice,
      sizePercent: 1,
      validUntilMs: NOW + HOUR,
    }, {
      liveInstruments: new Set([c.instId]),
      nowMs: NOW,
    })).not.toThrow();
  });
});
