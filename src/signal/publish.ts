/**
 * Signal formatting and the publication gate.
 *
 * Law 6: every trade must trace to a published signal. That makes the published
 * text the authoritative record of the trade, not a human-readable summary of
 * one — the copy executor parses these numbers and acts on them. A malformed
 * signal is therefore not a cosmetic problem; it is either an unexecutable
 * signal or, worse, an executable one that says something different from what
 * the engine decided.
 *
 * So the flow is: round the plan to publishable precision FIRST, format from
 * the rounded plan, then validate the text against that same rounded plan. The
 * published numbers and the numbers we place are the same numbers by
 * construction, rather than by two code paths agreeing.
 *
 * `validateSignal` is a HARD GATE. There is no skip-and-continue: a signal
 * either passes and is delivered, or fails and is recorded as rejected. The
 * cycle accounting below exists to prove that no third outcome occurred.
 */

import type { Config } from '../config.js';
import type { Direction } from './scanner.js';

export class SignalError extends Error {
  override readonly name = 'SignalError';
}

/** What the engine decided, before it has been rounded for publication. */
export interface SignalPlan {
  readonly signalId: string;
  readonly instId: string;
  readonly direction: Direction;
  readonly entryLow: number;
  readonly entryHigh: number;
  readonly stopPrice: number;
  readonly targetPrice: number;
  /** Position size as a percentage of equity, e.g. 2.5 for 2.5%. */
  readonly sizePercent: number;
  readonly validUntilMs: number;
}

export type ValidationResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reasons: readonly string[] };

/**
 * Significant figures kept for published prices.
 *
 * Perps on this venue span roughly 1e-5 to 1e5, so a fixed decimal count is
 * either useless at one end or absurd at the other. Five significant figures
 * is finer than the tick size of everything in the E1 universe.
 */
const PRICE_SIGNIFICANT_FIGURES = 5;

/**
 * Round a price to publishable precision.
 *
 * Exported because the plan must be rounded BEFORE sizing and order placement,
 * not after. Rounding afterwards would mean the stop we place and the stop we
 * publish differ by up to half a digit — small, but it makes the published
 * record subtly untrue, and the whole point of Law 6 is that it is not.
 */
export function roundPrice(value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new SignalError(`cannot publish a price of ${value}`);
  }
  return Number(value.toPrecision(PRICE_SIGNIFICANT_FIGURES));
}

/** Format a rounded price without exponent notation or trailing zeros. */
export function formatPrice(value: number): string {
  const rounded = roundPrice(value);
  // toPrecision emits exponent form outside ~[1e-7, 1e21]; toFixed does not.
  const decimals = Math.max(0, PRICE_SIGNIFICANT_FIGURES - 1 - Math.floor(Math.log10(rounded)));
  const fixed = rounded.toFixed(Math.min(decimals, 12));
  // Strip trailing zeros only in the fractional part. Stripping unconditionally
  // would turn 118000 into 118 — a formatting bug that publishes a real price
  // three orders of magnitude wrong.
  return fixed.includes('.') ? fixed.replace(/0+$/, '').replace(/\.$/, '') : fixed;
}

/** Round every price in a plan. The result is what gets traded AND published. */
export function roundPlan(plan: SignalPlan): SignalPlan {
  return {
    ...plan,
    entryLow: roundPrice(plan.entryLow),
    entryHigh: roundPrice(plan.entryHigh),
    stopPrice: roundPrice(plan.stopPrice),
    targetPrice: roundPrice(plan.targetPrice),
    sizePercent: Number(plan.sizePercent.toFixed(2)),
  };
}

/**
 * Render the signal text.
 *
 * The header is taken from config and must be exact: ASP classification is
 * keyword-driven, and a service whose signals do not carry the perpetual
 * keyword is classified as `text`, which delivers successfully and executes
 * nothing — a failure mode that looks like success from every angle except the
 * leaderboard.
 */
export function formatSignal(config: Config, plan: SignalPlan): string {
  const p = roundPlan(plan);
  const side = p.direction === 'long' ? 'LONG' : 'SHORT';

  return (
    `${config.publishing.perpHeader} ${side} ${p.instId} ` +
    `entry ${formatPrice(p.entryLow)}-${formatPrice(p.entryHigh)} ` +
    `stop ${formatPrice(p.stopPrice)} target ${formatPrice(p.targetPrice)} ` +
    `size ${p.sizePercent}% id ${p.signalId}`
  );
}

/**
 * Phrases that make a signal unexecutable by a machine reading it literally.
 * A copy executor cannot act on "entry at market" or "stop 2% below spot"; it
 * would either guess or skip, and both are silent divergence from Law 6.
 */
const RELATIVE_PRICE_PHRASES = [
  'market',
  'spot price',
  'current price',
  'around',
  'approx',
  '~',
  'tbd',
  'above current',
  'below current',
];

export interface ValidationContext {
  /** Instruments the venue currently lists. A signal on a delisted perp is dead on arrival. */
  readonly liveInstruments: ReadonlySet<string>;
  readonly nowMs: number;
}

/**
 * The publication gate. Returns every failure, not the first — a signal that
 * fails three checks and a signal that fails one are different problems, and
 * only the full list distinguishes a formatting bug from a logic bug.
 */
export function validateSignal(
  config: Config,
  text: string,
  plan: SignalPlan,
  context: ValidationContext,
): ValidationResult {
  const reasons: string[] = [];
  const p = roundPlan(plan);

  // Header: an exact prefix, not merely present somewhere in the body.
  const header = config.publishing.perpHeader;
  if (!text.startsWith(header)) {
    reasons.push(`text does not begin with the exact header ${JSON.stringify(header)}`);
  }

  if (text.length > config.publishing.maxSignalChars) {
    reasons.push(`text is ${text.length} chars, over the ${config.publishing.maxSignalChars} limit`);
  }

  if (p.signalId.trim() === '' || /\s/.test(p.signalId)) {
    reasons.push(`signal id ${JSON.stringify(p.signalId)} must be non-empty and contain no whitespace`);
  } else if (!text.includes(p.signalId)) {
    reasons.push(`text does not carry the signal id ${p.signalId}, so a fill cannot be traced to it`);
  }

  // Instrument must be real. Filtering to what the venue lists keeps a stale
  // universe from producing signals nobody can fill.
  if (!text.includes(p.instId)) {
    reasons.push(`text does not name the instrument ${p.instId}`);
  }
  if (!context.liveInstruments.has(p.instId)) {
    reasons.push(`${p.instId} is not a live instrument on the venue`);
  }

  const side = p.direction === 'long' ? 'LONG' : 'SHORT';
  if (!text.includes(side)) {
    reasons.push(`text does not state the direction ${side}`);
  }

  // Every price must appear literally. This is what "absolute prices" means:
  // the executor reads a number, not an instruction to compute one.
  for (const [label, value] of [
    ['entry low', p.entryLow],
    ['entry high', p.entryHigh],
    ['stop', p.stopPrice],
    ['target', p.targetPrice],
  ] as const) {
    if (!text.includes(formatPrice(value))) {
      reasons.push(`text does not carry the absolute ${label} price ${formatPrice(value)}`);
    }
  }

  const lower = text.toLowerCase();
  for (const phrase of RELATIVE_PRICE_PHRASES) {
    if (lower.includes(phrase)) {
      reasons.push(`text contains the relative-price phrase ${JSON.stringify(phrase)}`);
    }
  }

  // Size as a percentage, never a notional. A follower's account is not our
  // account, and a USDT amount would size their trade off our equity.
  if (!Number.isFinite(p.sizePercent) || p.sizePercent <= 0) {
    reasons.push(`size must be a positive percentage, got ${p.sizePercent}`);
  } else if (!text.includes(`${p.sizePercent}%`)) {
    reasons.push(`text does not express size as the percentage ${p.sizePercent}%`);
  }

  // Geometry. A published signal with an inverted stop is worse than no signal:
  // it is an instruction to take the trade with the risk control facing the
  // wrong way.
  if (!(p.entryLow <= p.entryHigh)) {
    reasons.push(`entry band is inverted: ${formatPrice(p.entryLow)} > ${formatPrice(p.entryHigh)}`);
  }
  if (p.direction === 'long') {
    if (p.stopPrice >= p.entryLow) reasons.push('long stop is not below the entry band');
    if (p.targetPrice <= p.entryHigh) reasons.push('long target is not above the entry band');
  } else {
    if (p.stopPrice <= p.entryHigh) reasons.push('short stop is not above the entry band');
    if (p.targetPrice >= p.entryLow) reasons.push('short target is not below the entry band');
  }

  // Payoff must survive rounding. Deriving the target from the stop guarantees
  // the ratio in principle; publishing rounded numbers can shave it, and the
  // ratio the follower can actually achieve is the one that counts.
  const entryReference = p.direction === 'long' ? p.entryHigh : p.entryLow;
  const risk = Math.abs(entryReference - p.stopPrice);
  const reward = Math.abs(p.targetPrice - entryReference);
  if (risk > 0) {
    const ratio = reward / risk;
    if (ratio < config.risk.minTargetStopRatio) {
      reasons.push(
        `published payoff ratio ${ratio.toFixed(2)} is below the ${config.risk.minTargetStopRatio} minimum`,
      );
    }
  }

  if (p.validUntilMs <= context.nowMs) {
    reasons.push('signal has already expired and must not be published');
  }

  return reasons.length === 0 ? { ok: true } : { ok: false, reasons };
}

/**
 * Format and validate in one step. Throws rather than returning a bad signal,
 * because the one thing that must never happen is a caller treating an invalid
 * signal as publishable.
 */
export function buildSignal(config: Config, plan: SignalPlan, context: ValidationContext): string {
  const text = formatSignal(config, plan);
  const result = validateSignal(config, text, plan, context);
  if (!result.ok) {
    throw new SignalError(`refusing to publish ${plan.signalId}: ${result.reasons.join('; ')}`);
  }
  return text;
}

/**
 * Per-cycle accounting.
 *
 * The invariant is `generated === delivered + rejected`. It exists to catch the
 * failure that leaves no other trace: a signal that was generated and then
 * neither delivered nor recorded as rejected — dropped by an early return, a
 * swallowed exception, or a `continue` in a loop. Nothing else in the system
 * would notice, because the only evidence is an absence.
 */
export class SignalCycle {
  #generated = 0;
  #delivered = 0;
  #rejected = 0;

  generated(): void {
    this.#generated += 1;
  }

  delivered(): void {
    this.#delivered += 1;
  }

  rejected(): void {
    this.#rejected += 1;
  }

  get counts(): { generated: number; delivered: number; rejected: number } {
    return { generated: this.#generated, delivered: this.#delivered, rejected: this.#rejected };
  }

  /** Call at the end of every cycle. Throws on any unaccounted-for signal. */
  assertBalanced(): void {
    const settled = this.#delivered + this.#rejected;
    if (settled !== this.#generated) {
      throw new SignalError(
        `signal accounting does not balance: generated ${this.#generated}, ` +
          `delivered ${this.#delivered} + rejected ${this.#rejected} = ${settled}. ` +
          'A signal was dropped without a record.',
      );
    }
  }
}
