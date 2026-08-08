/**
 * Rank steering — the control input for sizing and stage.
 *
 * Score = rank(PnL%) * 50% + rank(PnL) * 50%, tie broken by PnL%. That makes
 * this a two-axis problem, and the two axes can bind independently: a field
 * crowded on return but thin on dollars means dollars are the scarce resource.
 * Sizing decisions follow the binding axis, not a guess about what rank 1 costs.
 *
 * Attrition is an active return stream. Every competitor who detonates promotes
 * us on both axes without a trade, so fieldNegativePct tells us how much risk we
 * actually need to take rather than how much we could.
 *
 * The scraper WILL break — page changes, rate limits, layout shifts. It is
 * treated with the same discipline as any other feed: stale beyond the config
 * limit and we refuse to act on it rather than steering off a remembered page.
 */

import type { Config } from '../config.js';

export interface LeaderboardRow {
  /** Whatever identifies an entrant on the page, verbatim. */
  readonly entrant: string;
  /** Return as a fraction, e.g. 0.12 for +12%. Parsed from the PnL% column. */
  readonly pnlPct: number;
  /** Absolute PnL in USDT. Parsed from the separate absolute column. */
  readonly pnlAbs: number;
}

export interface LeaderboardSnapshot {
  readonly capturedAtMs: number;
  readonly rows: readonly LeaderboardRow[];
  /** Raw HTML retained so a later parser change can be replayed against it. */
  readonly rawHtml: string;
}

export interface SteeringMetrics {
  readonly capturedAtMs: number;
  readonly fieldSize: number;

  readonly myPnlPct: number;
  readonly myPnlAbs: number;
  readonly myRankPct: number;
  readonly myRankAbs: number;
  /** Combined score: mean of the two ranks. Lower is better. */
  readonly myScore: number;

  /**
   * The first entrant below the podium on each axis — whoever would displace us.
   * Cushion is measured against this, not against the rank-3 threshold, because
   * when we ARE rank 3 the rank-3 threshold is our own number.
   */
  readonly pctAtRank4: number | null;
  readonly absAtRank4: number | null;

  readonly pctAtRank1: number;
  readonly pctAtRank3: number;
  readonly pctAtRank10: number | null;
  readonly absAtRank1: number;
  readonly absAtRank3: number;
  readonly absAtRank10: number | null;

  /** Return still needed to reach rank 3 on the % axis. Zero if already there. */
  readonly gapToRank3Pct: number;
  /** Dollars still needed to reach rank 3 on the $ axis. Zero if already there. */
  readonly gapToRank3Abs: number;

  /** Which axis is actually holding us back. */
  readonly bindingAxis: 'pct' | 'abs' | 'neither';

  /** Share of the field underwater. The attrition rate. */
  readonly fieldNegativePct: number;
}

export class SteeringUnavailable extends Error {
  override readonly name = 'SteeringUnavailable';
}

/**
 * Thrown by the parser until it has been written against the real page.
 *
 * The leaderboard does not exist until the competition opens, and a parser
 * written against a guessed DOM would return plausible ranks from a page it
 * never saw — which then feed sizing. Law 2: it stays unimplemented and throws
 * loudly rather than inventing a field.
 */
export class ParserNotBuilt extends Error {
  override readonly name = 'ParserNotBuilt';
  constructor() {
    super(
      'leaderboard parser has not been written. It must be built against the real page once ' +
        'the competition opens — a parser written against a guessed DOM would feed invented ' +
        'ranks into sizing decisions.',
    );
  }
}

/**
 * Parse the leaderboard page.
 *
 * Deliberately unimplemented. When the page exists: parse BOTH metric columns
 * separately for the full field, and throw on any row where either column fails
 * to parse rather than dropping it — a silently shortened field distorts every
 * rank and the attrition rate underneath it.
 */
export function parseLeaderboard(_html: string): readonly LeaderboardRow[] {
  throw new ParserNotBuilt();
}

/** Competition ranks are 1-based and ties share the better rank. */
function rankOf(values: readonly number[], mine: number): number {
  let better = 0;
  for (const v of values) if (v > mine) better += 1;
  return better + 1;
}

function valueAtRank(sortedDesc: readonly number[], rank: number): number | null {
  const value = sortedDesc[rank - 1];
  return value === undefined ? null : value;
}

/**
 * Compute the full metrics block from a snapshot.
 *
 * Throws if our entrant is absent. Being unable to find ourselves on the
 * leaderboard is not a zero — it means the parse is wrong or the identifier
 * changed, and steering off that would be worse than not steering at all.
 */
export function computeMetrics(snapshot: LeaderboardSnapshot, myEntrant: string): SteeringMetrics {
  const { rows } = snapshot;
  if (rows.length === 0) {
    throw new SteeringUnavailable('leaderboard snapshot contains no rows');
  }

  const me = rows.find((r) => r.entrant === myEntrant);
  if (me === undefined) {
    throw new SteeringUnavailable(
      `entrant "${myEntrant}" not found in a field of ${rows.length} — parse is wrong or the ` +
        'identifier changed; refusing to steer',
    );
  }

  const pctValues = rows.map((r) => r.pnlPct);
  const absValues = rows.map((r) => r.pnlAbs);
  const pctDesc = [...pctValues].sort((a, b) => b - a);
  const absDesc = [...absValues].sort((a, b) => b - a);

  const myRankPct = rankOf(pctValues, me.pnlPct);
  const myRankAbs = rankOf(absValues, me.pnlAbs);

  const pctAtRank3 = valueAtRank(pctDesc, 3);
  const absAtRank3 = valueAtRank(absDesc, 3);

  // In a field smaller than 3 the rank-3 threshold is the last place on the
  // board — the gap to "top 3" is then zero by construction, not unknown.
  const pctTarget = pctAtRank3 ?? pctDesc[pctDesc.length - 1] ?? me.pnlPct;
  const absTarget = absAtRank3 ?? absDesc[absDesc.length - 1] ?? me.pnlAbs;

  const gapToRank3Pct = Math.max(0, pctTarget - me.pnlPct);
  const gapToRank3Abs = Math.max(0, absTarget - me.pnlAbs);

  let bindingAxis: 'pct' | 'abs' | 'neither';
  if (gapToRank3Pct === 0 && gapToRank3Abs === 0) {
    bindingAxis = 'neither';
  } else {
    // Compare the two gaps in rank terms rather than raw units — percent and
    // dollars are not commensurable, and the question is which axis costs more
    // places, not which number is larger.
    bindingAxis = myRankPct >= myRankAbs ? 'pct' : 'abs';
  }

  const negatives = rows.filter((r) => r.pnlAbs < 0).length;

  return {
    capturedAtMs: snapshot.capturedAtMs,
    fieldSize: rows.length,
    myPnlPct: me.pnlPct,
    myPnlAbs: me.pnlAbs,
    myRankPct,
    myRankAbs,
    myScore: (myRankPct + myRankAbs) / 2,
    pctAtRank4: valueAtRank(pctDesc, 4),
    absAtRank4: valueAtRank(absDesc, 4),
    pctAtRank1: pctDesc[0] ?? me.pnlPct,
    pctAtRank3: pctTarget,
    pctAtRank10: valueAtRank(pctDesc, 10),
    absAtRank1: absDesc[0] ?? me.pnlAbs,
    absAtRank3: absTarget,
    absAtRank10: valueAtRank(absDesc, 10),
    gapToRank3Pct,
    gapToRank3Abs,
    bindingAxis,
    fieldNegativePct: negatives / rows.length,
  };
}

/**
 * Refuse to act on a snapshot older than the configured limit.
 *
 * Steering off a remembered page is how a stale rank produces confident sizing
 * into a distribution that has already moved.
 */
export function assertFresh(config: Config, metrics: SteeringMetrics, nowMs: number): void {
  const ageMinutes = (nowMs - metrics.capturedAtMs) / 60_000;
  const limit = config.risk.maxLeaderboardStalenessMinutes;
  if (ageMinutes > limit) {
    throw new SteeringUnavailable(
      `leaderboard snapshot is ${ageMinutes.toFixed(1)} minutes old (limit ${limit}) — ` +
        'not acting on stale ranks',
    );
  }
}

/**
 * Whether we hold top 3 on combined score WITH cushion — the Stage 3 trigger.
 *
 * Cushion is required because rank alone flickers: being third by a hair on a
 * five-minute-old page is not a position to defend, it is noise. Returns null
 * when the snapshot is stale, which keeps Stage 3 unreachable on unreliable
 * data rather than defaulting it either way.
 */
export function topThreeWithCushion(
  config: Config,
  metrics: SteeringMetrics,
  nowMs: number,
  cushion: { readonly pctAheadOfRank3: number; readonly absAheadOfRank3: number },
): boolean | null {
  try {
    assertFresh(config, metrics, nowMs);
  } catch {
    return null;
  }

  if (metrics.myScore > 3) return false;

  // Cushion is the margin over whoever is next in line. If there is no rank 4,
  // the field is too small for anyone to displace us and the cushion is met.
  const pctCushionMet =
    metrics.pctAtRank4 === null || metrics.myPnlPct - metrics.pctAtRank4 >= cushion.pctAheadOfRank3;
  const absCushionMet =
    metrics.absAtRank4 === null || metrics.myPnlAbs - metrics.absAtRank4 >= cushion.absAheadOfRank3;

  // Both axes must hold. Score is the mean of two ranks, so a thin margin on
  // either one is enough to lose the podium — defending a position that is only
  // cushioned on one axis is defending half a position.
  return pctCushionMet && absCushionMet;
}
