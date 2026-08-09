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
 * +2R is not a completed trade — counting it would fill the sample with
 * guaranteed winners taken at a fixed multiple and report an exit system as
 * healthy precisely because it takes profits early, which is the failure mode
 * the ratio exists to detect.
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
}

export interface Attribution {
  readonly trades: number;
  readonly wins: number;
  readonly losses: number;
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
}

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

    trades.push({
      instrument: row.instrument ?? 'unknown',
      signalId: row.signal ?? 'unknown',
      rMultiple,
      closedAtMs: row.timestampMs,
    });
  }

  return trades;
}

/** Compute the attribution block from a set of closed trades. */
export function attribute(config: Config, trades: readonly ClosedTrade[]): Attribution {
  const wins = trades.filter((t) => t.rMultiple > 0);
  const losses = trades.filter((t) => t.rMultiple <= 0);

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

  return {
    trades: trades.length,
    wins: wins.length,
    losses: losses.length,
    hitRate: trades.length === 0 ? null : wins.length / trades.length,
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
