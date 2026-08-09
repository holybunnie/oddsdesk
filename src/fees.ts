/**
 * E7 — fee discipline.
 *
 * DeepSeek paid roughly a third of Qwen's fees and posted a better Sharpe. Fees
 * are a controllable P&L line, not an unavoidable cost of doing business, and
 * the way you control them is by making them visible and then binding.
 *
 * Two costs, and they are NOT the same kind of number:
 *
 *   - **Trading fees are MEASURED.** They come off `order_filled` receipts in
 *     the ledger, which carry `feePaid` exactly as the venue reported it. If the
 *     venue did not report a fee, none is counted — an estimate would be a
 *     number we invented sitting in a budget we enforce.
 *   - **Funding is MODELLED**, and labelled as such everywhere it appears. The
 *     Trade Kit adapter cannot read the venue's bills, so funding is accrued
 *     here from the observed rate and the position's notional at each funding
 *     timestamp actually crossed. That is an approximation of a real cash flow,
 *     and it is a far better one than the zero the system assumed before.
 *
 * Modelling funding rather than ignoring it is the whole point. At the old
 * regime threshold a 36h hold could pay 0.25% of notional — 1.7 trades' worth of
 * a 6% budget spread over ~40 trades — while a fee tracker reading 2 bps maker
 * reported everything healthy. A tracker that only counts what is easy to count
 * is what made that invisible.
 */

import type { Config } from './config.js';
import type { Ledger } from './ledger.js';

export class FeeBudgetError extends Error {
  override readonly name = 'FeeBudgetError';
}

/** Quote-currency scale used throughout the adapter boundary. */
const QUOTE_DECIMALS = 8;

export interface CostBreakdown {
  /** Measured from venue fee reports on filled orders. */
  readonly tradingFeesUsdt: number;
  /** Modelled from funding rate x notional at each window crossed. */
  readonly fundingUsdt: number;
  readonly totalUsdt: number;
  /** The hard cap: feeBudgetFraction x principalBase. */
  readonly budgetUsdt: number;
  readonly fractionUsed: number;
  /** True once the budget is spent. Halts NEW entries; never exits. */
  readonly breached: boolean;
}

/**
 * Trading fees paid so far, in USDT, read from ledger receipts.
 *
 * Sums `detail.feePaid` on `order_filled` rows. The venue reports fees as a
 * signed quantity — negative is charged, positive is a rebate — so the sign is
 * normalised here rather than at each call site, where getting it backwards
 * would make a fee budget count downwards.
 */
export function tradingFeesUsdt(ledger: Ledger, limit = 10_000): number {
  let total = 0;

  for (const row of ledger.recent(limit)) {
    if (row.action !== 'order_filled') continue;
    const raw = row.detail?.['feePaid'];
    if (typeof raw !== 'string') continue;

    const minor = Number(raw);
    if (!Number.isFinite(minor)) {
      throw new FeeBudgetError(
        `ledger row ${row.seq} carries an unparseable feePaid ${JSON.stringify(raw)} — ` +
          'refusing to guess at a number the fee budget is enforced against',
      );
    }
    total += Math.abs(minor) / 10 ** QUOTE_DECIMALS;
  }

  return total;
}

/**
 * Funding timestamps strictly after `fromMs` and at or before `toMs`.
 *
 * OKX charges funding on a fixed wall-clock schedule (00:00, 08:00, 16:00 UTC),
 * not on a per-position timer, so a position opened at 07:59 pays a full window
 * one minute later. Counting elapsed hours instead would systematically
 * under-charge short holds — which are most of them.
 *
 * Half-open at the lower end so a timestamp is never charged twice across two
 * consecutive cycles.
 */
export function fundingTimestampsBetween(fromMs: number, toMs: number, windowHours: number): number[] {
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) {
    throw new FeeBudgetError(`funding window bounds must be finite, got ${fromMs}..${toMs}`);
  }
  if (toMs <= fromMs) return [];

  const windowMs = windowHours * 3_600_000;
  const stamps: number[] = [];
  // First boundary strictly after `fromMs`.
  let t = Math.floor(fromMs / windowMs) * windowMs + windowMs;
  for (; t <= toMs; t += windowMs) stamps.push(t);

  return stamps;
}

/** One open position, as the funding accrual needs to see it. */
export interface FundingExposure {
  readonly instId: string;
  readonly side: 'long' | 'short';
  /** Position notional in USDT at the current mark. */
  readonly notionalUsdt: number;
  /** Current funding rate, signed as the venue reports it. */
  readonly fundingRate: number;
}

/**
 * Funding paid across a cycle, in USDT.
 *
 * Positive funding is paid BY longs TO shorts, so a short with positive funding
 * earns. Both directions are counted: unlike the entry-time estimate in E4,
 * which deliberately charges only adverse funding so a trade is never priced on
 * income that can invert, this is an accounting of what actually happened, and
 * an accounting that discarded the favourable half would not balance.
 */
export function accrueFundingUsdt(
  exposures: readonly FundingExposure[],
  fromMs: number,
  toMs: number,
  windowHours: number,
): number {
  const windows = fundingTimestampsBetween(fromMs, toMs, windowHours).length;
  if (windows === 0) return 0;

  let total = 0;
  for (const exposure of exposures) {
    const paid = exposure.side === 'long' ? exposure.fundingRate : -exposure.fundingRate;
    total += paid * exposure.notionalUsdt * windows;
  }
  return total;
}

/**
 * The budget itself.
 *
 * Deliberately a plain function of two numbers and the config, so the decision
 * to halt is reproducible from the ledger alone. Anything stateful about it
 * lives in `EngineState`, where it survives a restart — a fee budget that reset
 * on restart would be no budget at all on the day it mattered.
 */
export function costBreakdown(config: Config, tradingFees: number, funding: number): CostBreakdown {
  const budgetUsdt = config.execution.feeBudgetFraction * config.capital.principalBaseUsdt;
  // Favourable funding reduces cost and may make this negative; the budget
  // measures cost, so it floors at zero rather than crediting us headroom we
  // would lose the moment funding flipped.
  const totalUsdt = Math.max(0, tradingFees + funding);

  return {
    tradingFeesUsdt: tradingFees,
    fundingUsdt: funding,
    totalUsdt,
    budgetUsdt,
    fractionUsed: budgetUsdt > 0 ? totalUsdt / budgetUsdt : Number.POSITIVE_INFINITY,
    breached: totalUsdt >= budgetUsdt,
  };
}

/**
 * Human-readable one-liner for the daily report and the cycle log.
 *
 * Names which half is measured and which is modelled every time it is printed.
 * A single number would invite the reader to trust both equally, and they are
 * not equally trustworthy.
 */
export function describeCosts(costs: CostBreakdown): string {
  return (
    `${costs.totalUsdt.toFixed(2)}/${costs.budgetUsdt.toFixed(2)} USDT ` +
    `(${(costs.fractionUsed * 100).toFixed(1)}% of budget) — ` +
    `fees ${costs.tradingFeesUsdt.toFixed(2)} measured, ` +
    `funding ${costs.fundingUsdt.toFixed(2)} modelled`
  );
}
