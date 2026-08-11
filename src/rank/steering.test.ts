import { describe, expect, it } from 'vitest';
import { loadConfig } from '../config.js';
import { readFileSync } from 'node:fs';
import {
  LeaderboardParseError,
  SteeringUnavailable,
  assertFresh,
  computeMetrics,
  parseLeaderboard,
  parseLeaderboardField,
  podiumTargets,
  topThreeWithCushion,
  type LeaderboardRow,
  type LeaderboardSnapshot,
} from './steering.js';

const config = loadConfig('config/default.yaml');
const NOW = 1_760_000_000_000;

const row = (entrant: string, pnlPct: number, pnlAbs: number): LeaderboardRow => ({
  entrant,
  pnlPct,
  pnlAbs,
});

const snapshot = (rows: readonly LeaderboardRow[], ageMinutes = 0): LeaderboardSnapshot => ({
  capturedAtMs: NOW - ageMinutes * 60_000,
  rows,
  rawHtml: '<table><!-- retained for replay --></table>',
});

describe('parser', () => {
  // A real capture of /priapi/v1/wallet/activity/hackathon/rank taken on
  // 2026-08-11. Law 2: the parser is written against this, never a guessed shape.
  const fixture = readFileSync(new URL('./__fixtures__/hackathon-rank.json', import.meta.url), 'utf8');

  it('parses both metric axes from the real payload', () => {
    const rows = parseLeaderboard(fixture);
    expect(rows).toHaveLength(10);

    const leader = rows[0]!;
    expect(leader.entrant).toBe('Helios Terminal');
    expect(leader.pnlPct).toBeCloseTo(0.980927, 6);
    expect(leader.pnlAbs).toBeCloseTo(299.32, 2);

    // The two axes genuinely disagree in this field — the biggest absolute
    // profit is not the biggest return — which is the whole reason the score
    // is two-axis and the binding axis has to be measured.
    const byPct = [...rows].sort((a, b) => b.pnlPct - a.pnlPct)[0]!;
    const byAbs = [...rows].sort((a, b) => b.pnlAbs - a.pnlAbs)[0]!;
    expect(byPct.entrant).not.toBe(byAbs.entrant);
  });

  it('reports the visible window separately from the true field size', () => {
    // The endpoint serves a top-10 window on a 63-entrant field. Conflating the
    // two would let a 10-row read masquerade as the whole competition.
    const { rows, fieldSize, visible } = parseLeaderboardField(fixture);
    expect(rows).toHaveLength(10);
    expect(visible).toBe(10);
    expect(fieldSize).toBe(63);
  });

  it('prices the podium without needing our own row', () => {
    const { rows } = parseLeaderboardField(fixture);
    const targets = podiumTargets(rows);
    // Third place on the percentage axis is what a podium finish actually
    // costs — an order of magnitude below the leader's number.
    expect(targets.pctAtRank1).toBeCloseTo(0.980927, 6);
    expect(targets.pctAtRank3).toBeCloseTo(0.06628414, 6);
    expect(targets.absAtRank3).toBeCloseTo(71.18, 2);
    expect(targets.pctAtRank3).toBeLessThan(targets.pctAtRank1 / 10);
  });

  it('refuses a rejected request rather than reading it as an empty field', () => {
    const rejected = JSON.stringify({ code: 50113, msg: 'incorrect request sign parameters' });
    expect(() => parseLeaderboard(rejected)).toThrow(LeaderboardParseError);
    expect(() => parseLeaderboard(rejected)).toThrow(/50113/);
  });

  it('refuses a row missing either metric', () => {
    const broken = JSON.stringify({
      code: 0,
      data: { totalNumber: 1, hackathonAspRank: [{ name: 'x', profit: '1.0' }] },
    });
    expect(() => parseLeaderboard(broken)).toThrow(/unparseable returnRate/);
  });

  it('refuses non-JSON', () => {
    expect(() => parseLeaderboard('<html></html>')).toThrow(LeaderboardParseError);
  });
});

describe('metrics', () => {
  const field = [
    row('alpha', 1.2, 3600),
    row('bravo', 0.8, 2400),
    row('charlie', 0.4, 1280),
    row('us', 0.1, 320),
    row('echo', -0.3, -900),
    row('foxtrot', -0.6, -1800),
  ];

  it('ranks both axes separately', () => {
    const m = computeMetrics(snapshot(field), 'us');
    expect(m.myRankPct).toBe(4);
    expect(m.myRankAbs).toBe(4);
    expect(m.myScore).toBe(4);
    expect(m.fieldSize).toBe(6);
  });

  it('reports what each rank currently costs', () => {
    const m = computeMetrics(snapshot(field), 'us');
    expect(m.pctAtRank1).toBeCloseTo(1.2, 10);
    expect(m.pctAtRank3).toBeCloseTo(0.4, 10);
    expect(m.absAtRank1).toBe(3600);
    expect(m.absAtRank3).toBe(1280);
    // A six-entrant field has no rank 10. Null, never zero — zero would read as
    // "rank 10 costs nothing" and invite sizing off it.
    expect(m.pctAtRank10).toBeNull();
    expect(m.absAtRank10).toBeNull();
  });

  it('computes the gap to the podium on both axes', () => {
    const m = computeMetrics(snapshot(field), 'us');
    expect(m.gapToRank3Pct).toBeCloseTo(0.3, 10);
    expect(m.gapToRank3Abs).toBe(960);
  });

  it('measures attrition', () => {
    const m = computeMetrics(snapshot(field), 'us');
    expect(m.fieldNegativePct).toBeCloseTo(2 / 6, 10);
  });

  it('identifies the abs axis as binding when it costs more places', () => {
    // Strong on return, weak on dollars — the small-account signature. Dollars
    // are the scarce resource, so size up rather than protecting the rate.
    const mixed = [
      row('alpha', 0.05, 9000),
      row('bravo', 0.04, 7000),
      row('charlie', 0.03, 5000),
      row('delta', 0.02, 4000),
      row('us', 0.9, 288),
    ];
    const m = computeMetrics(snapshot(mixed), 'us');
    expect(m.myRankPct).toBe(1);
    expect(m.myRankAbs).toBe(5);
    expect(m.bindingAxis).toBe('abs');
  });

  it('reports neither axis binding when already top 3 on both', () => {
    const m = computeMetrics(snapshot([row('us', 2.0, 6000), row('a', 0.1, 300), row('b', 0.05, 150)]), 'us');
    expect(m.bindingAxis).toBe('neither');
    expect(m.gapToRank3Pct).toBe(0);
    expect(m.gapToRank3Abs).toBe(0);
  });

  it('refuses to steer when we are not on the board', () => {
    // Not a zero — it means the parse is wrong or the identifier changed.
    expect(() => computeMetrics(snapshot(field), 'not-us')).toThrow(SteeringUnavailable);
  });

  it('refuses an empty field', () => {
    expect(() => computeMetrics(snapshot([]), 'us')).toThrow(SteeringUnavailable);
  });

  it('gives tied entrants the better rank', () => {
    const tied = [row('a', 0.5, 1000), row('us', 0.5, 1000), row('c', 0.1, 200)];
    expect(computeMetrics(snapshot(tied), 'us').myRankPct).toBe(1);
  });
});

describe('staleness', () => {
  it('accepts a fresh snapshot', () => {
    const m = computeMetrics(snapshot([row('us', 0.1, 320)], 5), 'us');
    expect(() => assertFresh(config, m, NOW)).not.toThrow();
  });

  it('refuses beyond the configured limit', () => {
    const m = computeMetrics(snapshot([row('us', 0.1, 320)], 45), 'us');
    expect(() => assertFresh(config, m, NOW)).toThrow(/not acting on stale ranks/);
  });
});

describe('stage 3 trigger', () => {
  const cushion = { pctAheadOfRank3: 0.05, absAheadOfRank3: 200 };

  it('fires when top 3 with margin over rank 4 on both axes', () => {
    const field = [
      row('us', 1.0, 3000),
      row('a', 0.9, 2800),
      row('b', 0.8, 2600),
      row('c', 0.2, 500),
    ];
    const m = computeMetrics(snapshot(field), 'us');
    expect(topThreeWithCushion(config, m, NOW, cushion)).toBe(true);
  });

  it('refuses when the margin over rank 4 is thin', () => {
    // Third by a hair is not a position to defend, it is noise.
    const field = [
      row('a', 1.0, 3000),
      row('b', 0.9, 2800),
      row('us', 0.8, 2600),
      row('c', 0.79, 2590),
    ];
    const m = computeMetrics(snapshot(field), 'us');
    expect(topThreeWithCushion(config, m, NOW, cushion)).toBe(false);
  });

  it('refuses when cushioned on one axis only', () => {
    // Score is the mean of two ranks, so a thin margin on either loses the podium.
    const field = [
      row('a', 1.0, 3000),
      row('b', 0.9, 2900),
      row('us', 0.85, 2800),
      row('c', 0.5, 2790),
    ];
    const m = computeMetrics(snapshot(field), 'us');
    expect(topThreeWithCushion(config, m, NOW, cushion)).toBe(false);
  });

  it('refuses outright when off the podium', () => {
    const field = [row('a', 1.0, 3000), row('b', 0.9, 2800), row('c', 0.8, 2600), row('us', 0.1, 320)];
    const m = computeMetrics(snapshot(field), 'us');
    expect(topThreeWithCushion(config, m, NOW, cushion)).toBe(false);
  });

  it('returns null on a stale snapshot so stage 3 stays unreachable', () => {
    // Null rather than false: unknown is not the same as "no", and determineStage
    // must not enter a defensive posture off data it cannot trust.
    const m = computeMetrics(snapshot([row('us', 2.0, 9000), row('a', 0.1, 100)], 45), 'us');
    expect(topThreeWithCushion(config, m, NOW, cushion)).toBeNull();
  });
});
