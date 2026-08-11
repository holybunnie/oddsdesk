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
export class LeaderboardParseError extends Error {
  override readonly name = 'LeaderboardParseError';
}

/**
 * Parse a leaderboard payload.
 *
 * Built on 2026-08-11 against the real response, not a guessed DOM. The page
 * renders client-side from `/priapi/v1/wallet/activity/hackathon/rank`, so the
 * source here is that endpoint's JSON rather than HTML — strictly better than
 * the scrape Part VII assumed, because there is no layout to shift underneath
 * us. The envelope is `{code, msg, data: {totalNumber, lastNumber,
 * hackathonAspRank: [{id, name, profit, returnRate, ...}]}}`, where `profit` is
 * absolute PnL as a decimal string and `returnRate` is already a fraction.
 *
 * Throws on any row where either metric fails to parse rather than dropping it.
 * A silently shortened field distorts every rank and the attrition rate
 * underneath it, and it would do so invisibly.
 */
export function parseLeaderboard(raw: string): readonly LeaderboardRow[] {
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch (cause) {
    throw new LeaderboardParseError(`leaderboard payload is not JSON: ${(cause as Error).message}`);
  }

  if (typeof payload !== 'object' || payload === null) {
    throw new LeaderboardParseError('leaderboard payload is not an object');
  }
  const envelope = payload as { code?: unknown; msg?: unknown; data?: unknown };

  // A non-zero code means the request was rejected. Parsing on regardless would
  // turn an auth or signing failure into an empty field, which reads as "every
  // competitor vanished" rather than "we failed to read the page".
  if (envelope.code !== 0) {
    throw new LeaderboardParseError(
      `leaderboard endpoint returned code ${String(envelope.code)}: ${String(envelope.msg ?? '')}`,
    );
  }

  const data = envelope.data as { hackathonAspRank?: unknown; totalNumber?: unknown } | undefined;
  const list = data?.hackathonAspRank;
  if (!Array.isArray(list)) {
    throw new LeaderboardParseError('leaderboard payload has no hackathonAspRank array');
  }

  const rows = list.map((entry, index) => {
    const row = entry as { name?: unknown; profit?: unknown; returnRate?: unknown };
    const entrant = row.name;
    if (typeof entrant !== 'string' || entrant.length === 0) {
      throw new LeaderboardParseError(`row ${index} has no usable entrant name`);
    }
    // profit arrives as a decimal string, returnRate as a number already
    // expressed as a fraction. Both are required; a row missing either cannot
    // be ranked on the two-axis score.
    const pnlAbs = typeof row.profit === 'string' ? Number(row.profit) : row.profit;
    const pnlPct = row.returnRate;
    if (typeof pnlAbs !== 'number' || !Number.isFinite(pnlAbs)) {
      throw new LeaderboardParseError(`row ${index} ("${entrant}") has an unparseable profit`);
    }
    if (typeof pnlPct !== 'number' || !Number.isFinite(pnlPct)) {
      throw new LeaderboardParseError(`row ${index} ("${entrant}") has an unparseable returnRate`);
    }
    return { entrant, pnlPct, pnlAbs } satisfies LeaderboardRow;
  });

  if (rows.length === 0) {
    throw new LeaderboardParseError('leaderboard returned an empty field');
  }

  return rows;
}

/**
 * Parse, and also report how large the field actually is.
 *
 * The endpoint only ever serves a top-N window — verified on 2026-08-11, where
 * it returned 10 rows of a 63-entrant field and neither raising `limit` nor
 * paging the UI widened it, because the signature covers the URL and the page
 * never asks for more. So `rows` is the visible podium region, NOT the field.
 *
 * That distinction is load-bearing. The visible rows are enough to price the
 * podium — what return and what dollar figure currently sit at rank 1, 3 and
 * 10 — which is the actionable half of Part VII. They are NOT enough to compute
 * our own rank while we sit outside the window, and they cannot measure
 * attrition, because a top-10 window is all winners by construction.
 */
export function parseLeaderboardField(raw: string): {
  readonly rows: readonly LeaderboardRow[];
  readonly fieldSize: number;
  readonly visible: number;
} {
  const rows = parseLeaderboard(raw);
  const data = (JSON.parse(raw) as { data?: { totalNumber?: unknown } }).data;
  const fieldSize = typeof data?.totalNumber === 'number' ? data.totalNumber : rows.length;
  return { rows, fieldSize, visible: rows.length };
}

/** What it currently costs to reach a given rank, on each axis. */
export interface PodiumTargets {
  readonly pctAtRank1: number;
  readonly pctAtRank3: number;
  readonly pctAtRank10: number | null;
  readonly absAtRank1: number;
  readonly absAtRank3: number;
  readonly absAtRank10: number | null;
}

/**
 * Price the podium from a snapshot, without needing our own row.
 *
 * `computeMetrics` deliberately refuses to run when we are absent from the
 * field, because steering off a rank we cannot see would be guessing. But the
 * podium thresholds are readable regardless of whether we appear, and while we
 * are outside the top 10 they are the only rank information available — and the
 * only rank information that sets a target.
 */
export function podiumTargets(rows: readonly LeaderboardRow[]): PodiumTargets {
  if (rows.length === 0) throw new SteeringUnavailable('cannot price the podium from an empty field');
  const pctDesc = [...rows.map((r) => r.pnlPct)].sort((a, b) => b - a);
  const absDesc = [...rows.map((r) => r.pnlAbs)].sort((a, b) => b - a);
  const last = <T,>(values: readonly T[]): T => values[values.length - 1]!;
  return {
    pctAtRank1: pctDesc[0]!,
    pctAtRank3: valueAtRank(pctDesc, 3) ?? last(pctDesc),
    pctAtRank10: valueAtRank(pctDesc, 10),
    absAtRank1: absDesc[0]!,
    absAtRank3: valueAtRank(absDesc, 3) ?? last(absDesc),
    absAtRank10: valueAtRank(absDesc, 10),
  };
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
