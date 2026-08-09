/**
 * PART VIII — daily attribution.
 *
 * Its one job is to detect a specific measured failure, so that strategy is
 * changed only on evidence. The spec is blunt about why that matters: the rules
 * permit updating strategy mid-competition, and that permission is a trap. A bad
 * day is not evidence. A realised payoff ratio below 2.5:1 across ten or more
 * closed trades IS evidence — it means the exit logic is not delivering the
 * asymmetry the whole design rests on.
 *
 * Everything here is computed from the LEDGER, never from live state. Two
 * reasons, and the second is the important one:
 *
 *   - the ledger is hash-chained and append-only, so a report computed from it
 *     cannot quietly disagree with the record it claims to summarise;
 *   - a report computed from engine memory would go blank on restart, and the
 *     day you most want the attribution is the day something crashed.
 *
 * The realised payoff ratio is measured on TERMINAL closes only. A scale-out at
 * +2R is not a completed trade, and counting one would break the report three
 * ways: it double-counts a single position (one trade, two rows), so
 * `payoffRatioMinTrades` would be satisfied after seven real trades rather than
 * ten; it inflates the hit rate, because every winner contributes an extra
 * guaranteed win and no loser contributes anything; and because every scale-out
 * row is +2R by construction, it drags the measured average win toward exactly
 * 2.0 from whichever side it actually sits — understating a good system and
 * flattering a bad one.
 *
 * SCRATCHES are excluded from both sides. A trade that ran to +3R and trailed
 * back to a breakeven stop closes at ~0R, and counting it as a zero-magnitude
 * loss would drag `averageRLost` down and inflate the ratio: losses of
 * [-1.0, 0.0] average 0.5, making a system with breakeven scratches look twice
 * as good as one without. A breakeven stop-out is the one case where the
 * position's own risk control did exactly what it was designed to do, so it is
 * neither a win nor a loss and is reported separately.
 */

import type { Config } from './config.js';
import type { Ledger, LedgerRow } from './ledger.js';

export class AttributionError extends Error {
  override readonly name = 'AttributionError';
}

/** One completed trade, as the attribution needs to see it. */
export interface ClosedTrade {
  readonly instrument: string;
  readonly signalId: string;
  readonly rMultiple: number;
  readonly closedAtMs: number;
  /** Hours held, when the close row recorded it. Null when it did not. */
  readonly heldHours: number | null;
}

export interface Attribution {
  readonly trades: number;
  readonly wins: number;
  readonly losses: number;
  /** Closed at breakeven within tolerance — neither a win nor a loss. */
  readonly scratches: number;
  /** Fraction in [0, 1]. Null when nothing has closed. */
  readonly hitRate: number | null;
  /** Mean R across winning trades. Null when there are none. */
  readonly averageRWon: number | null;
  /** Mean R across losing trades, as a POSITIVE magnitude. Null when there are none. */
  readonly averageRLost: number | null;
  /**
   * Realised payoff: average R won / average R lost.
   *
   * Null when it cannot be computed — no wins, or no losses. A system with no
   * losses yet has not proved an infinite payoff ratio; it has proved nothing,
   * and returning Infinity would let it pass a threshold it never met.
   */
  readonly realisedPayoffRatio: number | null;
  /** Sum of R across every closed trade. The honest single number. */
  readonly totalR: number;
  /** True only when the ratio is BOTH computable and below the floor, over enough trades. */
  readonly exitLogicSuspect: boolean;
  /** Why the verdict is what it is, including "not enough evidence yet". */
  readonly verdict: string;
  readonly byInstrument: ReadonlyMap<string, { trades: number; totalR: number }>;
  /** Median hold in hours, and how many fell outside the target band. */
  readonly holdHours: { readonly median: number | null; readonly outsideBand: number };
}

/**
 * How close to zero counts as a scratch rather than an outcome.
 *
 * A breakeven stop never fills at exactly the entry price — slippage and the
 * tick make it a few basis points either way — so an exact test would classify
 * essentially every scratch as a tiny win or a tiny loss, which is the
 * classification error this exists to avoid.
 */
const SCRATCH_TOLERANCE_R = 0.05;

/**
 * Terminal closes, read back from the ledger.
 *
 * Rows are matched on the structured `detail.terminal` flag rather than on the
 * reason text. A report that parsed prose would break silently the first time
 * someone reworded a message, and it would break in the direction of reporting
 * fewer trades — which reads as "not enough evidence yet" rather than as a bug.
 */
export function closedTradesFrom(ledger: Ledger, limit = 10_000): readonly ClosedTrade[] {
  const trades: ClosedTrade[] = [];

  for (const row of ledger.recent(limit)) {
    if (row.action !== 'position_closed') continue;
    if (row.detail?.['terminal'] !== true) continue;

    const rMultiple = row.detail['rMultiple'];
    if (typeof rMultiple !== 'number' || !Number.isFinite(rMultiple)) {
      throw new AttributionError(
        `ledger row ${row.seq} closes ${row.instrument} with an unusable rMultiple ` +
          `${JSON.stringify(rMultiple)} — the payoff ratio must not be computed from a guess`,
      );
    }

    const heldHours = row.detail['heldHours'];

    trades.push({
      instrument: row.instrument ?? 'unknown',
      signalId: row.signal ?? 'unknown',
      rMultiple,
      closedAtMs: row.timestampMs,
      heldHours: typeof heldHours === 'number' && Number.isFinite(heldHours) ? heldHours : null,
    });
  }

  return trades;
}

/** Compute the attribution block from a set of closed trades. */
export function attribute(config: Config, trades: readonly ClosedTrade[]): Attribution {
  const wins = trades.filter((t) => t.rMultiple > SCRATCH_TOLERANCE_R);
  const losses = trades.filter((t) => t.rMultiple < -SCRATCH_TOLERANCE_R);
  const scratches = trades.filter((t) => Math.abs(t.rMultiple) <= SCRATCH_TOLERANCE_R);

  const mean = (values: readonly number[]): number | null =>
    values.length === 0 ? null : values.reduce((sum, v) => sum + v, 0) / values.length;

  const averageRWon = mean(wins.map((t) => t.rMultiple));
  const averageRLost = mean(losses.map((t) => Math.abs(t.rMultiple)));

  // Null rather than Infinity when there are no losses. An untested denominator
  // is not a passing grade.
  const realisedPayoffRatio =
    averageRWon === null || averageRLost === null || averageRLost === 0
      ? null
      : averageRWon / averageRLost;

  const { minRealisedPayoffRatio, payoffRatioMinTrades } = config.attribution;
  const enoughEvidence = trades.length >= payoffRatioMinTrades;
  const exitLogicSuspect =
    enoughEvidence && realisedPayoffRatio !== null && realisedPayoffRatio < minRealisedPayoffRatio;

  const byInstrument = new Map<string, { trades: number; totalR: number }>();
  for (const trade of trades) {
    const current = byInstrument.get(trade.instrument) ?? { trades: 0, totalR: 0 };
    byInstrument.set(trade.instrument, {
      trades: current.trades + 1,
      totalR: current.totalR + trade.rMultiple,
    });
  }

  // Hold times. The 4-36h band is a TARGET, not a rule — the spec describes
  // where both Alpha Arena winners sat, and holds outside it are a diagnostic
  // rather than a violation. Reported so a drift out of the band is visible
  // before it has to be inferred from a run of bad trades.
  const holds = trades
    .filter((t) => t.heldHours !== null)
    .map((t) => t.heldHours as number)
    .sort((a, b) => a - b);
  const median = holds.length === 0 ? null : (holds[Math.floor(holds.length / 2)] ?? null);
  const outsideBand = holds.filter(
    (h) => h < config.exits.minHoldHours || h > config.exits.maxHoldHours,
  ).length;

  return {
    trades: trades.length,
    wins: wins.length,
    losses: losses.length,
    scratches: scratches.length,
    holdHours: { median, outsideBand },
    // Scratches are excluded from the denominator too: a hit rate that counted
    // them would fall every time the breakeven stop did its job.
    hitRate: wins.length + losses.length === 0 ? null : wins.length / (wins.length + losses.length),
    averageRWon,
    averageRLost,
    realisedPayoffRatio,
    totalR: trades.reduce((sum, t) => sum + t.rMultiple, 0),
    exitLogicSuspect,
    verdict: verdictFor(trades.length, payoffRatioMinTrades, realisedPayoffRatio, minRealisedPayoffRatio),
    byInstrument,
  };
}

/**
 * The verdict, spelled out.
 *
 * "Not enough evidence" is a distinct answer from "healthy", and conflating them
 * is how a strategy gets changed on nine trades. Each branch says which it is.
 */
function verdictFor(
  trades: number,
  minTrades: number,
  ratio: number | null,
  floor: number,
): string {
  if (trades < minTrades) {
    return `only ${trades} closed trade(s), need ${minTrades} before the payoff ratio means anything — NOT a pass`;
  }
  if (ratio === null) {
    return `${trades} closed trades but no wins and losses on both sides yet — the ratio is not computable`;
  }
  if (ratio < floor) {
    return (
      `realised payoff ${ratio.toFixed(2)}:1 is below the ${floor}:1 floor over ${trades} trades — ` +
      'THE EXIT LOGIC IS BROKEN. Investigate before trading further. Never change risk sizing and ' +
      'exit logic in the same edit.'
    );
  }
  return `realised payoff ${ratio.toFixed(2)}:1 over ${trades} trades, at or above the ${floor}:1 floor`;
}

/** The Part VIII step-5 report block, as one printable string. */
export function formatAttribution(attribution: Attribution): string {
  const pct = (value: number | null): string => (value === null ? 'n/a' : `${(value * 100).toFixed(1)}%`);
  const num = (value: number | null): string => (value === null ? 'n/a' : value.toFixed(2));

  const lines = [
    `trades ${attribution.trades} (${attribution.wins}W / ${attribution.losses}L), hit rate ${pct(attribution.hitRate)}`,
    `average R won ${num(attribution.averageRWon)}, average R lost ${num(attribution.averageRLost)}, total ${attribution.totalR.toFixed(2)}R`,
    `payoff: ${attribution.verdict}`,
    `hold: median ${attribution.holdHours.median === null ? 'n/a' : `${attribution.holdHours.median.toFixed(1)}h`}` +
      `, ${attribution.holdHours.outsideBand} outside the target band` +
      (attribution.scratches > 0 ? `, ${attribution.scratches} scratch(es) excluded` : ''),
  ];

  if (attribution.byInstrument.size > 0) {
    const ranked = [...attribution.byInstrument.entries()].sort((a, b) => b[1].totalR - a[1].totalR);
    lines.push(
      `by instrument: ${ranked.map(([i, s]) => `${i} ${s.totalR >= 0 ? '+' : ''}${s.totalR.toFixed(1)}R x${s.trades}`).join(', ')}`,
    );
  }

  return lines.join('\n');
}

/** Read the ledger and attribute in one step. */
export function dailyAttribution(config: Config, ledger: Ledger): Attribution {
  return attribute(config, closedTradesFrom(ledger));
}

/** Exported for tests that build rows by hand. */
export type { LedgerRow };
