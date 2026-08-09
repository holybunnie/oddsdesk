/**
 * E6 — pyramiding. Stage 2 only.
 *
 * "You do not reach the target through many small wins. You reach it through one
 * or two enormous trades you added to repeatedly, funded by many small
 * controlled losses."
 *
 * Most retail pyramiding is over-leveraging wearing a strategy's clothes. Three
 * things separate this from that, and all three are enforced here rather than
 * described:
 *
 *   1. **Decreasing adds** — 1.0, then 0.6, then 0.4 of the base risk. Never
 *      equal, never growing. The config schema already refuses a ladder that
 *      does not strictly decrease.
 *   2. **A stack-wide stop** — one stop covers the whole position, and after
 *      every add the AGGREGATE open risk must still be no more than the
 *      original 1R. This is the check that makes adding free rather than
 *      leveraged: you are spending profit already banked by the stop, not new
 *      risk.
 *   3. **New breakouts only** — an add follows a fresh breakout in the same
 *      direction. Adding on a pullback is averaging into a position that has
 *      just moved against you, which is the same instinct as averaging down and
 *      ends the same way.
 *
 * Like E5 this is a pure function of state. It authorises; it does not act.
 */

import type { Config, Stage } from '../config.js';
import type { TrackedPosition } from '../engine/state.js';
import { rMultiple } from './exits.js';

export class PyramidError extends Error {
  override readonly name = 'PyramidError';
}

export interface PyramidVerdict {
  /** True only when every condition holds. Refusals carry every reason. */
  readonly armed: boolean;
  /** Which rung of the ladder this add is: 1 for the first add, 2 for the second. */
  readonly addIndex: number;
  /** Fraction of the BASE risk this add may take, from `addSizeMultiples`. */
  readonly sizeMultiple: number;
  readonly reasons: readonly string[];
}

/**
 * Aggregate USDT at risk once an add is on, measured from the STACK-WIDE stop.
 *
 * The original portion contributes negative risk once its stop is past
 * breakeven — it is locked in profit — but that credit is deliberately NOT used
 * to fund a larger add: each leg is floored at zero. Netting a banked gain
 * against new exposure is exactly how "risk-free pyramiding" turns into a
 * position that gives back more than it ever locked in.
 */
export function aggregateRiskUsdt(
  side: 'long' | 'short',
  stopPrice: number,
  legs: readonly { entryPrice: number; sizeUsdtPerPoint: number }[],
): number {
  let total = 0;
  for (const leg of legs) {
    const distance = side === 'long' ? leg.entryPrice - stopPrice : stopPrice - leg.entryPrice;
    total += Math.max(0, distance) * leg.sizeUsdtPerPoint;
  }
  return total;
}

export interface PyramidInputs {
  readonly stage: Stage;
  readonly position: TrackedPosition;
  /** Last traded price, for the R multiple. */
  readonly lastPrice: number;
  /**
   * Whether E4 says a NEW breakout has just fired in the same direction.
   *
   * Passed in rather than recomputed, so there is exactly one implementation of
   * "has it broken out" and the add uses the same one the entry did.
   */
  readonly freshBreakout: boolean;
}

/**
 * Decide whether a position may be added to.
 *
 * Returns every reason it may not, never just the first — the daily attribution
 * needs to see whether pyramiding is being blocked by one dominant condition,
 * which is how you learn a threshold is misplaced rather than guessing.
 */
export function evaluatePyramid(config: Config, inputs: PyramidInputs): PyramidVerdict {
  const { stage, position, lastPrice, freshBreakout } = inputs;
  const { pyramiding, exits } = config;
  const reasons: string[] = [];

  const addIndex = position.adds + 1;
  // Index 0 of the ladder is the initial entry, so add N reads rung N.
  const sizeMultiple = pyramiding.addSizeMultiples[addIndex] ?? 0;

  if (!pyramiding.enabled) {
    reasons.push('pyramiding is disabled in config');
  }

  // Stage 2 only. Stage 1 is survival and Stage 3 is defence; adding in either
  // is taking more risk at the moment the stage exists to take less.
  if (stage !== 2) {
    reasons.push(`stage ${stage} — pyramiding arms only in stage 2 (house money)`);
  }

  if (position.adds >= pyramiding.maxAdds) {
    reasons.push(`already added ${position.adds} time(s), at the ${pyramiding.maxAdds} limit`);
  }

  const r = rMultiple(position, lastPrice);
  if (r < exits.scaleOutAtR) {
    reasons.push(`position is at ${r.toFixed(2)}R, below the +${exits.scaleOutAtR}R arming threshold`);
  }

  // Never add to a loser. Stated separately from the R threshold above because
  // it is the rule that must survive every future edit to that threshold:
  // averaging into a losing position ends the competition.
  if (r <= 0) {
    reasons.push(`position is at ${r.toFixed(2)}R — never add to a loser`);
  }

  // Stop at breakeven or better. This is what makes the add cheap: the original
  // leg can no longer lose, so the only new risk is the add's own.
  const stopIsFree =
    position.side === 'long'
      ? position.currentStop >= position.entryPrice
      : position.currentStop <= position.entryPrice;
  if (!stopIsFree) {
    reasons.push(
      `stop ${position.currentStop} is not yet at breakeven (${position.entryPrice}) or better`,
    );
  }

  if (!freshBreakout) {
    reasons.push('no new breakout — adds follow a fresh breakout, never a pullback');
  }

  if (sizeMultiple <= 0) {
    reasons.push(`no size multiple defined for add ${addIndex}`);
  }

  return { armed: reasons.length === 0, addIndex, sizeMultiple, reasons };
}
