import { describe, expect, it } from 'vitest';
import { loadConfig } from '../config.js';
import {
  ExitError,
  chandelierStop,
  evaluateExit,
  initialStopFor,
  rMultiple,
  ratchetStop,
  riskUnit,
  stopIsHit,
  type MarketState,
  type PositionState,
} from './exits.js';

const config = loadConfig('config/default.yaml');
const NOW = 1_760_000_000_000;
const HOUR = 3_600_000;

/** Long from 100 with a stop at 90, so R = 10. Round numbers keep R legible. */
const long = (overrides: Partial<PositionState> = {}): PositionState => ({
  instId: 'BTC-USDT-SWAP',
  side: 'long',
  entryPrice: 100,
  initialStop: 90,
  currentStop: 90,
  remainingFraction: 1,
  openedAtMs: NOW - HOUR,
  scaledOut: false,
  ...overrides,
});

const short = (overrides: Partial<PositionState> = {}): PositionState =>
  long({ side: 'short', entryPrice: 100, initialStop: 110, currentStop: 110, ...overrides });

const market = (overrides: Partial<MarketState> = {}): MarketState => ({
  lastPrice: 100,
  highestHighSinceEntry: 100,
  lowestLowSinceEntry: 100,
  atr: 5,
  nowMs: NOW,
  ...overrides,
});

const kinds = (position: PositionState, state: MarketState): string[] =>
  evaluateExit(config, position, state).actions.map((a) => a.kind);

describe('risk unit and R multiple', () => {
  it('anchors R to the initial stop, not the current one', () => {
    // Once the stop ratchets to breakeven, measuring against it would divide by
    // zero and, in between, would silently inflate every R multiple.
    const trailed = long({ currentStop: 100 });
    expect(riskUnit(trailed)).toBe(10);
    expect(rMultiple(trailed, 130)).toBeCloseTo(3, 10);
  });

  it('reports negative R when losing', () => {
    expect(rMultiple(long(), 95)).toBeCloseTo(-0.5, 10);
    expect(rMultiple(short(), 105)).toBeCloseTo(-0.5, 10);
  });

  it('refuses a position whose entry equals its stop', () => {
    expect(() => riskUnit(long({ initialStop: 100 }))).toThrow(ExitError);
  });
});

describe('initial stop placement', () => {
  it('scales with ATR rather than a fixed percentage', () => {
    // Same 2x ATR multiple, very different instruments — this is what makes the
    // two stops equivalent RISK rather than equivalent-looking numbers.
    expect(initialStopFor(config, 'long', 100, 5)).toBeCloseTo(90, 10);
    expect(initialStopFor(config, 'long', 60_000, 900)).toBeCloseTo(58_200, 10);
  });

  it('places a short stop above entry', () => {
    expect(initialStopFor(config, 'short', 100, 5)).toBeCloseTo(110, 10);
  });

  it('refuses a non-positive ATR', () => {
    expect(() => initialStopFor(config, 'long', 100, 0)).toThrow(/ATR must be positive/);
  });

  it('refuses when ATR is so wide the stop would be non-positive', () => {
    expect(() => initialStopFor(config, 'long', 10, 8)).toThrow(/non-positive stop/);
  });
});

describe('the stop ratchet', () => {
  it('moves a long stop up but never down', () => {
    expect(ratchetStop('long', 90, 95)).toBe(95);
    expect(ratchetStop('long', 95, 90)).toBe(95);
  });

  it('moves a short stop down but never up', () => {
    expect(ratchetStop('short', 110, 105)).toBe(105);
    expect(ratchetStop('short', 105, 110)).toBe(105);
  });

  it('returns a no-op rather than widening risk', () => {
    // A caller asking for a looser stop gets the existing one back. The code
    // does not offer "move the stop away" as an option at all.
    expect(ratchetStop('long', 100, 80)).toBe(100);
  });
});

describe('chandelier anchor', () => {
  it('anchors to the extreme since entry, not the current price', () => {
    // Price has pulled back to 120 from a 140 high. Anchoring to price would
    // loosen the stop on every pullback — the same error as moving it away.
    const state = market({ lastPrice: 120, highestHighSinceEntry: 140, atr: 5 });
    expect(chandelierStop('long', state, 3)).toBeCloseTo(125, 10);
  });

  it('sits above price for a short', () => {
    const state = market({ lastPrice: 80, lowestLowSinceEntry: 70, atr: 5 });
    expect(chandelierStop('short', state, 3)).toBeCloseTo(85, 10);
  });
});

describe('stop hit is terminal', () => {
  it('closes fully when a long trades to its stop', () => {
    const plan = evaluateExit(config, long(), market({ lastPrice: 90 }));
    expect(plan.actions).toHaveLength(1);
    expect(plan.actions[0]?.kind).toBe('close_full');
  });

  it('closes fully when a short trades to its stop', () => {
    expect(kinds(short(), market({ lastPrice: 110 }))).toEqual(['close_full']);
  });

  it('sets a re-entry cooldown', () => {
    const plan = evaluateExit(config, long(), market({ lastPrice: 90 }));
    const action = plan.actions[0];
    if (action?.kind !== 'close_full') throw new Error('expected a full close');
    expect(action.cooldownUntilMs).toBe(NOW + config.exits.reentryCooldownHours * HOUR);
  });

  it('takes precedence over everything else', () => {
    // Even a position old enough for the time stop exits on the stop reason.
    const plan = evaluateExit(config, long({ openedAtMs: NOW - 20 * HOUR }), market({ lastPrice: 90 }));
    const action = plan.actions[0];
    if (action?.kind !== 'close_full') throw new Error('expected a full close');
    expect(action.reason).toMatch(/stop hit/);
  });
});

describe('time stop', () => {
  it('closes a trade that has not reached +1R in the window', () => {
    const stale = long({ openedAtMs: NOW - 13 * HOUR });
    const plan = evaluateExit(config, stale, market({ lastPrice: 104 })); // +0.4R
    const action = plan.actions[0];
    if (action?.kind !== 'close_full') throw new Error('expected a full close');
    expect(action.reason).toMatch(/time stop/);
  });

  it('spares a trade that is working', () => {
    // Past the time window but at +1.5R, so it is not a dead trade.
    const working = long({ openedAtMs: NOW - 13 * HOUR });
    expect(kinds(working, market({ lastPrice: 115 }))).not.toContain('close_full');
  });

  it('leaves a young losing trade alone', () => {
    // Losing but young: nothing to do but wait for the stop. There is no path
    // that grants it more room.
    expect(kinds(long(), market({ lastPrice: 95 }))).toEqual(['hold']);
  });
});

describe('scale-out and breakeven at +2R', () => {
  it('does nothing at +1R', () => {
    expect(kinds(long(), market({ lastPrice: 110, highestHighSinceEntry: 110 }))).toEqual(['hold']);
  });

  it('takes 25% off and moves the stop to breakeven at +2R', () => {
    const plan = evaluateExit(config, long(), market({ lastPrice: 120, highestHighSinceEntry: 120 }));
    const scale = plan.actions.find((a) => a.kind === 'scale_out');
    if (scale?.kind !== 'scale_out') throw new Error('expected a scale-out');

    // 25%, not 50%: the entire expectancy is in the tail, and scaling out
    // heavily amputates the trade that wins.
    expect(scale.fraction).toBeCloseTo(0.25, 10);
    expect(plan.actions.some((a) => a.kind === 'move_stop')).toBe(true);
  });

  it('scales out only once', () => {
    const already = long({ scaledOut: true, currentStop: 100 });
    expect(kinds(already, market({ lastPrice: 125, highestHighSinceEntry: 125 }))).not.toContain('scale_out');
  });

  it('never leaves the stop below breakeven once past +2R', () => {
    const plan = evaluateExit(config, long(), market({ lastPrice: 120, highestHighSinceEntry: 120 }));
    const moves = plan.actions.filter((a) => a.kind === 'move_stop');
    for (const move of moves) {
      if (move.kind !== 'move_stop') continue;
      expect(move.to).toBeGreaterThanOrEqual(100);
    }
  });
});

describe('trailing', () => {
  it('trails at 3x ATR between the scale-out and tightening thresholds', () => {
    // +3.5R at price 135, high 135, ATR 5 → chandelier at 135 - 15 = 120.
    // Below +4R, so the wide multiple still applies.
    const running = long({ scaledOut: true, currentStop: 100 });
    const plan = evaluateExit(
      config,
      running,
      market({ lastPrice: 135, highestHighSinceEntry: 135, atr: 5 }),
    );
    const move = plan.actions.find((a) => a.kind === 'move_stop');
    if (move?.kind !== 'move_stop') throw new Error('expected a stop move');
    expect(move.to).toBeCloseTo(120, 10);
  });

  it('switches to the tightened multiple exactly at +4R', () => {
    // +4R at price 140 → tightened 2.5x ATR: 140 - 12.5 = 127.5. The boundary
    // is inclusive, so a trade sitting exactly on it gets the tighter trail.
    const running = long({ scaledOut: true, currentStop: 100 });
    const plan = evaluateExit(
      config,
      running,
      market({ lastPrice: 140, highestHighSinceEntry: 140, atr: 5 }),
    );
    const move = plan.actions.find((a) => a.kind === 'move_stop');
    if (move?.kind !== 'move_stop') throw new Error('expected a stop move');
    expect(move.to).toBeCloseTo(127.5, 10);
  });

  it('reports a stop as hit only when price reaches it', () => {
    expect(stopIsHit(long({ currentStop: 95 }), 96)).toBe(false);
    expect(stopIsHit(long({ currentStop: 95 }), 95)).toBe(true);
    expect(stopIsHit(short({ currentStop: 105 }), 105)).toBe(true);
  });

  it('tightens to 2.5x ATR past +4R', () => {
    // +5R at price 150, high 150, ATR 5 → tightened chandelier at 150 - 12.5.
    const running = long({ scaledOut: true, currentStop: 120 });
    const plan = evaluateExit(
      config,
      running,
      market({ lastPrice: 150, highestHighSinceEntry: 150, atr: 5 }),
    );
    const move = plan.actions.find((a) => a.kind === 'move_stop');
    if (move?.kind !== 'move_stop') throw new Error('expected a stop move');
    expect(move.to).toBeCloseTo(137.5, 10);
  });

  it('holds the stop through a pullback rather than loosening it', () => {
    // High was 150, price pulled back to 130. The trail would compute 135 from
    // the high, which is above the existing 137.5 stop — so it must not move.
    const running = long({ scaledOut: true, currentStop: 137.5 });
    const plan = evaluateExit(
      config,
      running,
      market({ lastPrice: 130, highestHighSinceEntry: 150, atr: 5 }),
    );
    const moves = plan.actions.filter((a) => a.kind === 'move_stop');
    expect(moves).toHaveLength(0);
  });

  it('does not trail before the scale-out threshold', () => {
    // At +1R a 3x ATR trail would sit at 95, below the entry — trailing this
    // early would tighten risk before the trade has proven anything.
    expect(kinds(long(), market({ lastPrice: 110, highestHighSinceEntry: 110 }))).toEqual(['hold']);
  });

  it('trails a short downward', () => {
    const running = short({ scaledOut: true, currentStop: 100 });
    const plan = evaluateExit(
      config,
      running,
      market({ lastPrice: 60, lowestLowSinceEntry: 60, atr: 5 }),
    );
    const move = plan.actions.find((a) => a.kind === 'move_stop');
    if (move?.kind !== 'move_stop') throw new Error('expected a stop move');
    // +4R short → tightened 2.5x ATR above the low: 60 + 12.5.
    expect(move.to).toBeCloseTo(72.5, 10);
  });
});

describe('the whole sequence on one winning trade', () => {
  it('never widens the stop across the life of the position', () => {
    // Walk a long from entry through a run to +5R and back, feeding each plan's
    // stop into the next step. The invariant is monotonic, not merely usually true.
    let position = long();
    const path: ReadonlyArray<{ price: number; high: number }> = [
      { price: 105, high: 105 },
      { price: 120, high: 120 },
      { price: 118, high: 120 },
      { price: 140, high: 140 },
      { price: 150, high: 150 },
      { price: 132, high: 150 },
    ];

    let previousStop = position.currentStop;
    for (const step of path) {
      const plan = evaluateExit(
        config,
        position,
        market({ lastPrice: step.price, highestHighSinceEntry: step.high, atr: 5 }),
      );

      for (const action of plan.actions) {
        if (action.kind === 'move_stop') {
          expect(action.to).toBeGreaterThanOrEqual(previousStop);
          previousStop = action.to;
          position = { ...position, currentStop: action.to };
        }
        if (action.kind === 'scale_out') position = { ...position, scaledOut: true };
      }
    }

    // Finished above breakeven, with the trade long since made free.
    expect(previousStop).toBeGreaterThan(position.entryPrice);
  });
});

describe('PART X — the endgame', () => {
  it('closes a losing position at T-24h rather than carrying it into the snapshot', () => {
    // Unrealised PnL counts at the final snapshot. A loser held into it is not a
    // trade still working — it is a realised loss taken at the worst moment,
    // and it is what took DeepSeek from +125% to +4.89%.
    const plan = evaluateExit(config, long(), market({ lastPrice: 98 }), 'closeLosers');

    expect(plan.actions[0]).toMatchObject({ kind: 'close_full' });
    expect(plan.actions[0]).toMatchObject({ reason: expect.stringMatching(/endgame/) });
  });

  it('closes a FLAT position too — zero is not a winner', () => {
    const plan = evaluateExit(config, long(), market({ lastPrice: 100 }), 'closeLosers');
    expect(plan.actions[0]).toMatchObject({ kind: 'close_full' });
  });

  it('does NOT close a winner — it trails it into the snapshot', () => {
    // The trail converts a coinflip into a floor while leaving the upside
    // intact, which is the entire argument for holding a winner through.
    const plan = evaluateExit(
      config,
      long(),
      market({ lastPrice: 112, highestHighSinceEntry: 112 }),
      'closeLosers',
    );
    expect(plan.actions.some((a) => a.kind === 'close_full')).toBe(false);
    expect(plan.actions.some((a) => a.kind === 'move_stop')).toBe(true);
  });

  it('trails a SMALL winner in the endgame that it would leave alone normally', () => {
    // Below the scale-out threshold there is normally room to run, because
    // there is time for a small winner to become a large one. Inside the last
    // day there is not, and an unprotected +0.5R at the snapshot is a gain left
    // to chance.
    const small = long();
    const state = market({ lastPrice: 102.5, highestHighSinceEntry: 102.5 });

    expect(evaluateExit(config, small, state, 'open').actions).toEqual([{ kind: 'hold' }]);
    expect(evaluateExit(config, small, state, 'closeLosers').actions.some((a) => a.kind === 'move_stop')).toBe(true);
  });

  it('uses a tighter trail in the endgame than the tightened trail', () => {
    const winner = long();
    const state = market({ lastPrice: 130, highestHighSinceEntry: 130 });

    const normal = stopFrom(evaluateExit(config, winner, state, 'open'));
    const endgame = stopFrom(evaluateExit(config, winner, state, 'closeLosers'));

    expect(endgame).toBeGreaterThan(normal);
    expect(config.competition.endgame.chandelierAtrMultiple).toBeLessThan(
      config.exits.tightenedChandelierAtrMultiple,
    );
  });

  it('still honours a hit stop before any endgame rule', () => {
    // The endgame changes when we choose to exit. It never overrides an exit
    // that has already been forced.
    const plan = evaluateExit(
      config,
      long({ currentStop: 99 }),
      market({ lastPrice: 98 }),
      'closeLosers',
    );
    expect(plan.actions[0]).toMatchObject({ reason: expect.stringMatching(/stop hit/) });
  });

  it('leaves every other phase behaving exactly as before', () => {
    const p = long();
    const m = market({ lastPrice: 98 });
    for (const phase of ['before', 'open', 'noNewEntries'] as const) {
      expect(evaluateExit(config, p, m, phase).actions).toEqual([{ kind: 'hold' }]);
    }
  });
});

/** The stop a plan would leave behind, for comparing trail tightness. */
function stopFrom(plan: ReturnType<typeof evaluateExit>): number {
  return plan.actions.reduce<number>((stop, action) => (action.kind === 'move_stop' ? action.to : stop), 0);
}
