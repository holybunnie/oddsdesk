/**
 * Read the persisted leaderboard snapshot and answer the one question the
 * engine asks of it: do we hold top 3 with cushion?
 *
 * The capture process and the engine are deliberately separate. This module is
 * the seam, and its contract is that it NEVER throws. Every failure — no file,
 * unparseable file, stale capture, us absent from the visible window — collapses
 * to `null`, which `determineStage` reads as "Stage 3 unreachable".
 *
 * That asymmetry is the point. Failing to read a rank must cost us a defensive
 * stage we might have earned; it must never cost us the ability to trade. An
 * exception escaping here would propagate into the cycle and stop the engine
 * over a browser that did not start.
 */

import { readFileSync } from 'node:fs';
import type { Config } from '../config.js';
import {
  computeMetrics,
  topThreeWithCushion,
  type LeaderboardSnapshot,
  type SteeringMetrics,
} from './steering.js';

export interface RankReading {
  /** The Stage 3 trigger: true, false, or null when it cannot be determined. */
  readonly cushion: boolean | null;
  /** Present only when we were found on the board. */
  readonly metrics?: SteeringMetrics;
  /** Why the reading is null, for the operator. Absent when it is not null. */
  readonly unavailableBecause?: string;
}

function loadSnapshot(path: string): LeaderboardSnapshot {
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as LeaderboardSnapshot;
  if (!Array.isArray(parsed.rows) || typeof parsed.capturedAtMs !== 'number') {
    throw new Error('snapshot file is missing rows or capturedAtMs');
  }
  return parsed;
}

/**
 * Read the snapshot at `path` and derive the Stage 3 trigger.
 *
 * Total function: returns a reading rather than throwing, whatever it finds.
 */
export function readRankCushionFrom(config: Config, path: string, nowMs: number): RankReading {
  let snapshot: LeaderboardSnapshot;
  try {
    snapshot = loadSnapshot(path);
  } catch (error) {
    return { cushion: null, unavailableBecause: `no usable snapshot at ${path}: ${(error as Error).message}` };
  }

  let metrics: SteeringMetrics;
  try {
    metrics = computeMetrics(snapshot, config.competition.entrantName);
  } catch (error) {
    // The common case, and not an error: the board exposes only a top-10
    // window, so we are absent from it until we are actually in the top 10.
    return { cushion: null, unavailableBecause: (error as Error).message };
  }

  try {
    const cushion = topThreeWithCushion(config, metrics, nowMs, config.risk.stage3Cushion);
    return cushion === null
      ? { cushion: null, metrics, unavailableBecause: 'snapshot is stale' }
      : { cushion, metrics };
  } catch (error) {
    return { cushion: null, metrics, unavailableBecause: (error as Error).message };
  }
}
