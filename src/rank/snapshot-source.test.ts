import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../config.js';
import { readRankCushionFrom } from './snapshot-source.js';
import type { LeaderboardRow, LeaderboardSnapshot } from './steering.js';

const config = loadConfig('config/default.yaml');
const NOW = 1_760_000_000_000;
const dir = mkdtempSync(join(tmpdir(), 'oddsdesk-rank-'));

const row = (entrant: string, pnlPct: number, pnlAbs: number): LeaderboardRow => ({ entrant, pnlPct, pnlAbs });

function write(name: string, snapshot: unknown): string {
  const path = join(dir, name);
  writeFileSync(path, JSON.stringify(snapshot));
  return path;
}

const podium = (ageMinutes = 0): LeaderboardSnapshot => ({
  capturedAtMs: NOW - ageMinutes * 60_000,
  rows: [
    row(config.competition.entrantName, 0.9, 300),
    row('a', 0.8, 260),
    row('b', 0.7, 220),
    row('c', 0.1, 20),
  ],
  rawHtml: '{}',
});

describe('rank snapshot source', () => {
  it('never throws when the snapshot is missing', () => {
    const reading = readRankCushionFrom(config, join(dir, 'does-not-exist.json'), NOW);
    expect(reading.cushion).toBeNull();
    expect(reading.unavailableBecause).toMatch(/no usable snapshot/);
  });

  it('never throws on a corrupt snapshot', () => {
    const path = join(dir, 'corrupt.json');
    writeFileSync(path, 'not json at all');
    expect(readRankCushionFrom(config, path, NOW).cushion).toBeNull();
  });

  it('never throws when the file is JSON but not a snapshot', () => {
    const path = write('wrong-shape.json', { hello: 'world' });
    const reading = readRankCushionFrom(config, path, NOW);
    expect(reading.cushion).toBeNull();
    expect(reading.unavailableBecause).toMatch(/rows or capturedAtMs/);
  });

  it('returns null while we are outside the visible window', () => {
    // The live board exposes only a top-10 slice, so this is the normal state
    // until we are actually in it — information, not an error.
    const path = write('absent.json', { capturedAtMs: NOW, rows: [row('someone-else', 0.5, 100)], rawHtml: '{}' });
    const reading = readRankCushionFrom(config, path, NOW);
    expect(reading.cushion).toBeNull();
    expect(reading.unavailableBecause).toMatch(/not found in a field/);
  });

  it('returns null rather than a stale true', () => {
    const path = write('stale.json', podium(config.risk.maxLeaderboardStalenessMinutes + 5));
    const reading = readRankCushionFrom(config, path, NOW);
    expect(reading.cushion).toBeNull();
    expect(reading.unavailableBecause).toMatch(/stale/);
  });

  it('reports the cushion when we hold the podium with margin', () => {
    const path = write('holding.json', podium());
    const reading = readRankCushionFrom(config, path, NOW);
    expect(reading.cushion).toBe(true);
    expect(reading.metrics?.myRankPct).toBe(1);
    expect(reading.unavailableBecause).toBeUndefined();
  });

  it('reports false when on the board but off the podium', () => {
    const path = write('offpodium.json', {
      capturedAtMs: NOW,
      rows: [row('a', 0.9, 300), row('b', 0.8, 260), row('c', 0.7, 220), row(config.competition.entrantName, 0.1, 20)],
      rawHtml: '{}',
    });
    const reading = readRankCushionFrom(config, path, NOW);
    expect(reading.cushion).toBe(false);
    expect(reading.metrics?.bindingAxis).toBe('pct');
  });
});
