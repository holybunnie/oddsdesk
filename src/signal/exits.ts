/**
 * E5 — exits.
 *
 * At a ~30% win rate the entire expectancy lives in the fat right tail. Qwen's
 * competition came down to one winner roughly 4.7x its largest loser. That
 * single fact dictates everything here:
 *
 *  - cut losers mechanically, with no discretion and no re-entry
 *  - take only 25% off at +2R — scaling out heavily amputates the trade that wins
 *  - move the stop to breakeven so the trade becomes free, then let it run
 *  - trail wide (3x ATR) so noise cannot shake out the tail, tightening only
 *    once the trade is already large
 *
 * The module is a pure function of position state and market state. It places
 * no orders — it returns decisions the executor carries out — which is what
 * makes it exhaustively testable without a venue.
 */

import type { Config } from '../config.js';

export type Side = 'long' | 'short';

export class ExitError extends Error {
  override readonly name = 'ExitError';
}

export interface PositionState {
  readonly instId: string;
  readonly side: Side;
  readonly entryPrice: number;
  /** The stop set at entry. Defines R and never changes. */
  readonly initialStop: number;
  /** Where the stop rests right now. Ratchets toward price, never away. */
  readonly currentStop: number;
  /** Fraction of the original position still open, 1.0 until a scale-out. */
  readonly remainingFraction: number;
  readonly openedAtMs: number;
  readonly scaledOut: boolean;
}

export interface MarketState {
  readonly lastPrice: number;
  /** Highest high since entry — the Chandelier anchor for a long. */
  readonly highestHighSinceEntry: number;
  /** Lowest low since entry — the Chandelier anchor for a short. */
  readonly lowestLowSinceEntry: number;
  readonly atr: number;
  readonly nowMs: number;
}

export type ExitAction =
  | { readonly kind: 'hold' }
  | { readonly kind: 'scale_out'; readonly fraction: number; readonly reason: string }
  | { readonly kind: 'move_stop'; readonly to: number; readonly reason: string }
  | { readonly kind: 'close_full'; readonly reason: string; readonly cooldownUntilMs: number };

export interface ExitPlan {
  readonly instId: string;
  readonly rMultiple: number;
  readonly actions: readonly ExitAction[];
}

/**
 * R — the risk unit. Distance from entry to the ORIGINAL stop.
 *
 * Anchored to the initial stop deliberately: once the stop ratchets to
 * breakeven, measuring R against the current stop would divide by zero and, at
 * intermediate positions, would silently inflate every R multiple.
 */
export function riskUnit(position: PositionState): number {
  const r = Math.abs(position.entryPrice - position.initialStop);
  if (!Number.isFinite(r) || r <= 0) {
    throw new ExitError(
      `${position.instId}: risk unit is ${r} — entry ${position.entryPrice} and initial stop ` +
        `${position.initialStop} must differ`,
    );
  }
  return r;
}

/** How far the trade has travelled in R, negative when losing. */
export function rMultiple(position: PositionState, lastPrice: number): number {
  const move =
    position.side === 'long' ? lastPrice - position.entryPrice : position.entryPrice - lastPrice;
  return move / riskUnit(position);
}

/**
 * Move a stop only if the move is toward price.
 *
 * "Never move a stop away from price. Ever." — implemented as a ratchet that
 * returns the existing stop rather than the requested one, so a caller that
 * asks for a looser stop gets a no-op instead of a widened risk. Gemini's
 * failure was holding six losing shorts while writing about its conviction;
 * conviction after a stop is breached is a bug, and the code should not offer
 * the option.
 */
export function ratchetStop(side: Side, currentStop: number, proposedStop: number): number {
  if (!Number.isFinite(proposedStop)) {
    throw new ExitError(`proposed stop is not finite (${proposedStop})`);
  }
  if (side === 'long') return Math.max(currentStop, proposedStop);
  return Math.min(currentStop, proposedStop);
}

/**
 * Chandelier trail: anchored to the extreme reached since entry, not to the
 * current price. Anchoring to current price would loosen the stop on every
 * pullback, which is the same error as moving it away.
 */
export function chandelierStop(
  side: Side,
  market: MarketState,
  atrMultiple: number,
): number {
  return side === 'long'
    ? market.highestHighSinceEntry - atrMultiple * market.atr
    : market.lowestLowSinceEntry + atrMultiple * market.atr;
}

/** Whether price has reached or passed the resting stop. */
export function stopIsHit(position: PositionState, lastPrice: number): boolean {
  return position.side === 'long' ? lastPrice <= position.currentStop : lastPrice >= position.currentStop;
}

/**
 * The initial stop for a new entry: entry ∓ initialStopAtrMultiple × ATR.
 *
 * Never a fixed percentage. ATR adapts to each instrument's volatility, which
 * is what makes a 3% stop on BTC and a 9% stop on a high-beta alt equivalent
 * *risk* rather than equivalent-looking numbers.
 */
export function initialStopFor(config: Config, side: Side, entryPrice: number, atrValue: number): number {
  if (!Number.isFinite(atrValue) || atrValue <= 0) {
    throw new ExitError(`ATR must be positive to place a stop, got ${atrValue}`);
  }
  const distance = config.exits.initialStopAtrMultiple * atrValue;
  const stop = side === 'long' ? entryPrice - distance : entryPrice + distance;

  if (stop <= 0) {
    throw new ExitError(
      `${side} stop computed at ${stop} from entry ${entryPrice} and ATR ${atrValue} — ` +
        'non-positive stop, refusing the trade',
    );
  }
  return stop;
}

/**
 * Evaluate a position and return what should happen to it.
 *
 * Ordering is deliberate and the first terminal action wins:
 *
 *   1. stop hit          — exit fully, no negotiation
 *   2. time stop         — dead trades consume margin, heat and attention
 *   3. scale-out at +2R  — once only
 *   4. breakeven move    — makes the trade free
 *   5. trail             — only past the scale-out threshold
 *
 * A losing position produces nothing but "hold" until its stop is hit or the
 * time stop fires. There is deliberately no path that widens a stop, averages
 * down, or grants a losing trade more time.
 */
export function evaluateExit(config: Config, position: PositionState, market: MarketState): ExitPlan {
  const { exits } = config;
  const r = rMultiple(position, market.lastPrice);
  const actions: ExitAction[] = [];

  const cooldownUntilMs = market.nowMs + exits.reentryCooldownHours * 3_600_000;

  // 1. Stop hit. Terminal, and no re-entry on this instrument for the cooldown.
  if (stopIsHit(position, market.lastPrice)) {
    return {
      instId: position.instId,
      rMultiple: r,
      actions: [
        {
          kind: 'close_full',
          reason: `stop hit at ${market.lastPrice} (stop ${position.currentStop}, ${r.toFixed(2)}R)`,
          cooldownUntilMs,
        },
      ],
    };
  }

  // 2. Time stop. A trade that has not reached +1R within the window is not
  //    working, and holding it costs margin and portfolio heat that a live
  //    candidate could use.
  const ageHours = (market.nowMs - position.openedAtMs) / 3_600_000;
  if (ageHours >= exits.timeStopHours && r < exits.timeStopRequiresR) {
    return {
      instId: position.instId,
      rMultiple: r,
      actions: [
        {
          kind: 'close_full',
          reason:
            `time stop: ${ageHours.toFixed(1)}h without reaching ` +
            `+${exits.timeStopRequiresR}R (currently ${r.toFixed(2)}R)`,
          cooldownUntilMs,
        },
      ],
    };
  }

  // 3. Scale-out, once. Only 25% so three-quarters of the tail survives — the
  //    trade that wins the competition is the one not amputated here.
  if (!position.scaledOut && r >= exits.scaleOutAtR) {
    actions.push({
      kind: 'scale_out',
      fraction: exits.scaleOutFraction,
      reason: `reached +${r.toFixed(2)}R, taking ${(exits.scaleOutFraction * 100).toFixed(0)}% off`,
    });
  }

  // 4. Breakeven. From here the trade cannot lose money, which is what buys the
  //    patience to let the remainder run.
  if (r >= exits.breakevenAtR) {
    const breakeven = ratchetStop(position.side, position.currentStop, position.entryPrice);
    if (breakeven !== position.currentStop) {
      actions.push({
        kind: 'move_stop',
        to: breakeven,
        reason: `+${r.toFixed(2)}R reached — stop to breakeven, the trade is now free`,
      });
    }
  }

  // 5. Trail. Wide at first so ordinary noise cannot shake out the tail,
  //    tightening only once the trade is already large.
  if (r >= exits.scaleOutAtR) {
    const multiple =
      r >= exits.tightenTrailAtR ? exits.tightenedChandelierAtrMultiple : exits.chandelierAtrMultiple;

    const trail = chandelierStop(position.side, market, multiple);

    // Ratchet against whatever the breakeven step may have just proposed, so
    // the two rules cannot fight and loosen the stop between them.
    const proposedSoFar = actions.reduce<number>(
      (stop, action) => (action.kind === 'move_stop' ? action.to : stop),
      position.currentStop,
    );
    const trailed = ratchetStop(position.side, proposedSoFar, trail);

    if (trailed !== proposedSoFar) {
      actions.push({
        kind: 'move_stop',
        to: trailed,
        reason: `trailing at ${multiple}x ATR from the extreme since entry (${r.toFixed(2)}R)`,
      });
    }
  }

  if (actions.length === 0) actions.push({ kind: 'hold' });

  return { instId: position.instId, rMultiple: r, actions };
}
