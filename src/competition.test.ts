/**
 * The competition clock — the start gate and the Part X endgame.
 *
 * These are the two rules whose breach cannot be undone by any later decision.
 * A pre-start fill moves equity and does not score. A position still open and
 * losing at the final snapshot is a realised loss taken at the worst possible
 * moment. Everything else in the risk architecture governs whether a trade is
 * wise; this governs whether it is permitted to exist at all.
 */

import { describe, expect, it } from 'vitest';
import { competitionPhase, configSchema, entriesPermitted, loadConfig, type Config } from './config.js';

const config = loadConfig('config/default.yaml');

const START = config.competition.startsAt;
const END = config.competition.endsAt;
const HOUR = 3_600_000;

describe('competitionPhase', () => {
  it('reads the configured window as the event page states it, in UTC+8', () => {
    // The registration page gives Aug 11 12:00 UTC+8, which is 04:00 UTC. If
    // this ever reads 12:00 UTC the engine opens eight hours early, and the
    // fills in between are unscored and irreversible.
    expect(new Date(START).toISOString()).toBe('2026-08-11T04:00:00.000Z');
    expect(new Date(END).toISOString()).toBe('2026-08-25T04:00:00.000Z');
  });

  it('refuses to be before and open at the same instant', () => {
    expect(competitionPhase(config, START - 1)).toBe('before');
    expect(competitionPhase(config, START)).toBe('open');
  });

  it('closes at the snapshot, inclusive of the final instant', () => {
    expect(competitionPhase(config, END - 1)).not.toBe('after');
    expect(competitionPhase(config, END)).toBe('after');
  });

  it('walks through the endgame in the order Part X specifies', () => {
    const { noNewEntriesHoursBeforeEnd: noEntries, closeLosersHoursBeforeEnd: closeLosers } =
      config.competition.endgame;

    expect(competitionPhase(config, END - (noEntries + 1) * HOUR)).toBe('open');
    expect(competitionPhase(config, END - noEntries * HOUR)).toBe('noNewEntries');
    expect(competitionPhase(config, END - (closeLosers + 1) * HOUR)).toBe('noNewEntries');
    expect(competitionPhase(config, END - closeLosers * HOUR)).toBe('closeLosers');
    expect(competitionPhase(config, END - 1)).toBe('closeLosers');
  });

  it('permits entries in exactly one phase', () => {
    const phases = ['before', 'open', 'noNewEntries', 'closeLosers', 'after'] as const;
    expect(phases.filter(entriesPermitted)).toEqual(['open']);
  });

  it('is total — every instant maps to a phase, so no caller can read permission from an unknown', () => {
    // A phase function with a gap would eventually be handled by a default
    // branch somewhere, and the safe default is not obvious enough to trust to
    // one. Sampling across the whole window plus generous margins either side.
    for (let t = START - 30 * 24 * HOUR; t < END + 30 * 24 * HOUR; t += 7 * HOUR) {
      expect(['before', 'open', 'noNewEntries', 'closeLosers', 'after']).toContain(
        competitionPhase(config, t),
      );
    }
  });
});

describe('competition config validation', () => {
  const raw = (competition: unknown): unknown => ({
    ...(JSON.parse(JSON.stringify(rawConfigShape())) as object),
    competition,
  });

  it('accepts the real block — the control, so the rejections below are not vacuous', () => {
    // Without this, every test here would pass even if `raw()` produced garbage
    // the schema rejected for unrelated reasons.
    const result = configSchema.safeParse(
      raw({
        startsAt: '2026-08-11T12:00:00+08:00',
        endsAt: '2026-08-25T12:00:00+08:00',
        endgame: config.competition.endgame,
      }),
    );
    expect(result.success).toBe(true);
  });

  it('rejects a timestamp with no offset, which would be read as UTC', () => {
    // This is the whole reason the field is a string and not a number. "12:00"
    // with no offset is eight hours wrong in the direction that trades early.
    const result = configSchema.safeParse(
      raw({
        startsAt: '2026-08-11T12:00:00',
        endsAt: '2026-08-25T12:00:00+08:00',
        endgame: config.competition.endgame,
      }),
    );
    expect(result.success).toBe(false);
  });

  it('rejects a competition that ends before it starts', () => {
    const result = configSchema.safeParse(
      raw({
        startsAt: '2026-08-25T12:00:00+08:00',
        endsAt: '2026-08-11T12:00:00+08:00',
        endgame: config.competition.endgame,
      }),
    );
    expect(result.success).toBe(false);
  });

  it('rejects an endgame that widens instead of narrowing', () => {
    // Closing losers BEFORE entries stop would mean the engine closes a loser at
    // T-48h and is still permitted to open a fresh one at T-30h.
    const result = configSchema.safeParse(
      raw({
        startsAt: '2026-08-11T12:00:00+08:00',
        endsAt: '2026-08-25T12:00:00+08:00',
        endgame: { noNewEntriesHoursBeforeEnd: 24, closeLosersHoursBeforeEnd: 48, chandelierAtrMultiple: 1.5 },
      }),
    );
    expect(result.success).toBe(false);
  });
});

/**
 * The loaded config, back in the shape the schema parses.
 *
 * `loadConfig` transforms the timestamps to epoch ms, so the parsed value cannot
 * be fed back in. Only the competition block is replaced per test; everything
 * else is read from the real file so these tests fail if the rest of the schema
 * moves under them.
 */
function rawConfigShape(): unknown {
  const { competition: _competition, ...rest } = config as Config;
  return {
    ...rest,
    // Re-serialise the values the schema transformed, so the rest round-trips.
    capital: rest.capital,
  };
}
