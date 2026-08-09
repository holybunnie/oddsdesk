/**
 * Configuration loading and validation.
 *
 * Two rules drive the shape of this module:
 *
 *  - Law 1: venue facts are discovered at runtime, never typed into source.
 *    Policy lives in config/default.yaml; fee tiers, tick size, lot size,
 *    minimum notional and per-instrument leverage limits live in the runtime
 *    profile written by the Day-0 verification.
 *  - Law 3: fail loudly. There is no default-on-missing anywhere in this file.
 *    A missing value throws at load, not at 3am with money on the book.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

const positive = z.number().positive();
const fraction = z.number().gt(0).lt(1);

const drawdownBandSchema = z
  .object({
    halveSizing: fraction,
    flatAndHalt12h: fraction,
    stopForCompetition: fraction,
  })
  .strict()
  .refine(
    (b) => b.halveSizing < b.flatAndHalt12h && b.flatAndHalt12h < b.stopForCompetition,
    'drawdown bands must increase: halveSizing < flatAndHalt12h < stopForCompetition',
  );

const stageKeyed = <T extends z.ZodTypeAny>(inner: T) => z.object({ 1: inner, 2: inner, 3: inner }).strict();

/**
 * An ISO-8601 instant with an explicit offset, parsed to epoch ms at load.
 *
 * The offset is mandatory. The competition is specified in UTC+8 and the box
 * runs UTC, so a bare "2026-08-11T12:00:00" would be read as UTC and open the
 * engine eight hours early — a pre-start fill that does not score and cannot be
 * undone. Requiring the offset makes that class of mistake unrepresentable.
 */
const instant = z
  .string()
  .regex(
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:Z|[+-]\d{2}:\d{2})$/,
    'must be an ISO-8601 instant with an explicit timezone offset, e.g. 2026-08-11T12:00:00+08:00',
  )
  .transform((text, ctx) => {
    const ms = Date.parse(text);
    if (Number.isNaN(ms)) {
      ctx.addIssue({ code: 'custom', message: `${text} is not a parseable instant` });
      return z.NEVER;
    }
    return ms;
  });

export const configSchema = z
  .object({
    /**
     * The competition clock, transcribed from the event page rather than chosen.
     *
     * Both ends do work. `startsAt` is a refusal — no position may be opened
     * before it, because a pre-start fill moves equity, does not score, and
     * cannot be reversed. `endsAt` anchors the Part X endgame, every phase of
     * which is measured backwards from the final snapshot.
     */
    competition: z
      .object({
        startsAt: instant,
        endsAt: instant,
        endgame: z
          .object({
            noNewEntriesHoursBeforeEnd: positive,
            closeLosersHoursBeforeEnd: positive,
            chandelierAtrMultiple: positive,
          })
          .strict()
          .refine(
            (e) => e.closeLosersHoursBeforeEnd < e.noNewEntriesHoursBeforeEnd,
            'the endgame narrows: entries stop before losers are closed, not after',
          ),
      })
      .strict()
      .refine((c) => c.startsAt < c.endsAt, 'the competition must end after it starts'),

    capital: z
      .object({
        principalBaseUsdt: positive,
        eligibilityFloorUsdt: positive,
      })
      .strict()
      .refine(
        (c) => c.eligibilityFloorUsdt < c.principalBaseUsdt,
        'eligibilityFloorUsdt must sit below principalBaseUsdt — the difference is the compliance buffer',
      ),

    risk: z
      .object({
        riskFractionByStage: stageKeyed(fraction),
        maxPortfolioHeat: fraction,
        maxConcurrentPositions: z.number().int().positive(),
        maxPositionsPerCorrelationGroup: z.number().int().positive(),
        /**
         * Portfolio-wide cap on positions facing the same way.
         *
         * The correlation groups encode relationships we anticipated. This
         * catches the ones we did not: E3 selects momentum extremes, and in
         * crypto the extremes are usually one complex moving together, so a
         * book that looks diversified by group can still be a single directional
         * bet placed three times.
         */
        maxPositionsPerSide: z.number().int().positive(),
        drawdownGovernor: stageKeyed(drawdownBandSchema),
        haltDurationHours: positive,
        stage2EquityMultiple: z.number().gt(1),
        minTargetStopRatio: z.number().gte(1),
        maxFeedStalenessSeconds: positive,
        maxLeaderboardStalenessMinutes: positive,
        reconcileIntervalSeconds: positive,
      })
      .strict()
      .refine(
        (r) => r.maxPositionsPerCorrelationGroup <= r.maxConcurrentPositions,
        'maxPositionsPerCorrelationGroup cannot exceed maxConcurrentPositions',
      )
      .refine(
        (r) => r.maxPositionsPerSide < r.maxConcurrentPositions,
        'maxPositionsPerSide must be BELOW maxConcurrentPositions — a cap equal to the ' +
          'position limit permits a fully one-sided book, which is the concentration it exists to prevent',
      ),

    execution: z
      .object({
        // Isolated always: cross margin lets one bad position consume the
        // equity backing every other. Enumerated rather than free text so a
        // typo cannot silently select cross.
        marginMode: z.enum(['isolated', 'cross']),
        // Absent until the Part IX stop verification writes it. Deliberately
        // optional in the schema and deliberately fatal in requireMaxLeverage().
        maxLeverage: positive.optional(),
        feeBudgetFraction: fraction,
      })
      .strict(),

    universe: z
      .object({
        minQuoteVolume24hUsdt: positive,
        maxSpreadBps: positive,
        excludeSymbols: z.array(z.string().min(1)),
        /**
         * Smallest notional the engine expects to place. An instrument whose
         * minimum order exceeds it is dropped from the universe.
         *
         * Without this, an unaffordable instrument counts as breadth in the
         * scan and produces a venue rejection in the book — and because the
         * signal is journalled before submission, that rejection is never
         * retried. It is a candidate that can never become a position.
         */
        minTradableNotionalUsdt: positive,
      })
      .strict(),

    signals: z
      .object({
        minConviction: z.number().min(0).max(100),
        targetTradesPerDay: positive,
        minInstrumentsPassingRegime: z.number().int().positive(),
      })
      .strict(),

    regime: z
      .object({
        adxPeriod: z.number().int().positive(),
        minAdx: positive,
        volLookback: z.number().int().positive(),
        minRealizedVol: positive,
        maxRealizedVol: positive,
        volumeWindow: z.number().int().positive(),
        minVolumeTrend: positive,
        maxAdverseFundingRate: positive,
        /**
         * Whether expected funding is charged against the payoff test.
         *
         * A filter asks whether a rate is tolerable; charging asks whether the
         * trade still clears the minimum payoff ratio after carry. Configurable
         * so the behaviour can be turned off deliberately and visibly, never by
         * a value quietly going missing.
         */
        fundingCharged: z.boolean(),
        fundingWindowHours: positive,
      })
      .strict()
      .refine((r) => r.minRealizedVol < r.maxRealizedVol, 'the volatility band must be non-empty'),

    /**
     * Correlation groups, keyed by group name, valued by base symbol.
     *
     * Policy, not a venue fact: it is our judgement about what moves together.
     * `maxPositionsPerCorrelationGroup` is meaningless without it — crypto perps
     * correlate around 0.8, so three longs is one trade wearing three hats, and
     * an ungrouped universe would let exactly that through.
     */
    correlationGroups: z.record(z.string().min(1), z.array(z.string().min(1)).min(1)),

    /**
     * The single group every unclassified base symbol falls into.
     *
     * A GROUP NAME, not a prefix. The prefix it replaces gave each unlisted
     * symbol a private bucket, which made `maxPositionsPerCorrelationGroup`
     * unenforceable exactly where enforcement matters — the unclassified tail is
     * where the correlated memecoin complex lives, and a live scan produced five
     * of them in one pass, each satisfying the cap alone.
     *
     * Renamed rather than redefined, so a config still carrying `ungroupedPrefix`
     * fails to load instead of silently keeping the old behaviour under a key
     * that now means something else.
     */
    ungroupedGroup: z.string().min(1),

    ranking: z
      .object({
        lookbacksHours: z.array(z.number().int().positive()).min(1),
        atrPeriod: z.number().int().positive(),
        decileFraction: fraction,
      })
      .strict(),

    entry: z
      .object({
        breakoutLookback: z.number().int().positive(),
        bandAtrFraction: positive,
        validityHours: positive,
        convictionWeights: z
          .object({
            momentum: fraction,
            trendStrength: fraction,
            volume: fraction,
            multiTimeframe: fraction,
          })
          .strict()
          .refine((w) => {
            const sum = w.momentum + w.trendStrength + w.volume + w.multiTimeframe;
            return Math.abs(sum - 1) < 1e-9;
          }, 'conviction weights must sum to 1'),
        adxSaturation: positive,
        volumeTrendSaturation: positive,
      })
      .strict(),

    exits: z
      .object({
        atrPeriod: z.number().int().positive(),
        initialStopAtrMultiple: positive,
        scaleOutAtR: positive,
        scaleOutFraction: fraction,
        breakevenAtR: positive,
        chandelierAtrMultiple: positive,
        tightenTrailAtR: positive,
        tightenedChandelierAtrMultiple: positive,
        timeStopHours: positive,
        timeStopRequiresR: positive,
        minHoldHours: positive,
        maxHoldHours: positive,
        reentryCooldownHours: positive,
      })
      .strict()
      .refine((e) => e.minHoldHours < e.maxHoldHours, 'minHoldHours must be below maxHoldHours')
      .refine(
        (e) => e.tightenedChandelierAtrMultiple < e.chandelierAtrMultiple,
        'the tightened trail must be tighter than the initial trail',
      )
      .refine(
        (e) => e.tightenTrailAtR > e.scaleOutAtR,
        'the trail tightens after the scale-out, not before it',
      ),

    pyramiding: z
      .object({
        enabled: z.boolean(),
        maxAdds: z.number().int().nonnegative(),
        addSizeMultiples: z.array(positive).min(1),
      })
      .strict()
      .refine(
        (p) => p.addSizeMultiples.every((m, i, a) => i === 0 || m < (a[i - 1] ?? Infinity)),
        'addSizeMultiples must strictly decrease — equal or growing adds are over-leveraging in disguise',
      )
      .refine(
        (p) => p.addSizeMultiples.length >= p.maxAdds + 1,
        'addSizeMultiples needs an entry for the initial entry plus every add',
      ),

    attribution: z
      .object({
        minRealisedPayoffRatio: positive,
        payoffRatioMinTrades: z.number().int().positive(),
      })
      .strict(),

    ledger: z.object({ path: z.string().min(1) }).strict(),
    killSwitch: z.object({ path: z.string().min(1) }).strict(),
    engineState: z.object({ path: z.string().min(1) }).strict(),

    publishing: z
      .object({
        maxSignalChars: z.number().int().positive(),
        perpHeader: z.string().min(1),
        requireSignalCorrespondence: z.boolean(),
        /**
         * Whether exit actions are published as signals of their own.
         *
         * Half of all fills are exits. With this off, half the book has no
         * corresponding published signal and a subscriber is told to open and
         * never told to close.
         */
        publishExits: z.boolean(),
      })
      .strict(),
  })
  .strict();

export type Config = z.infer<typeof configSchema>;
export type Stage = 1 | 2 | 3;

export class ConfigError extends Error {
  override readonly name = 'ConfigError';
}

/**
 * Load and validate config. Throws on any missing or malformed value — there is
 * no partial-config mode, because a half-loaded risk policy is worse than none.
 */
export function loadConfig(path = 'config/default.yaml'): Config {
  const absolute = resolve(path);

  let raw: string;
  try {
    raw = readFileSync(absolute, 'utf8');
  } catch (cause) {
    throw new ConfigError(`cannot read config at ${absolute}`, { cause });
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (cause) {
    throw new ConfigError(`config at ${absolute} is not valid YAML`, { cause });
  }

  const result = configSchema.safeParse(parsed);
  if (!result.success) {
    const detail = result.error.issues
      .map((i) => `  ${i.path.join('.') || '<root>'}: ${i.message}`)
      .join('\n');
    throw new ConfigError(`config at ${absolute} failed validation:\n${detail}`);
  }

  return result.data;
}

/**
 * No order may be placed until maxLeverage has been written to config as an
 * explicit number by the Part IX stop verification.
 *
 * This is the only accessor for that value. It exists so the failure is a throw
 * at the call site rather than a silent fallback that puts an unverified stop
 * mechanism in front of a leveraged book.
 */
export function requireMaxLeverage(config: Config): number {
  const { maxLeverage } = config.execution;

  if (maxLeverage === undefined) {
    throw new ConfigError(
      'execution.maxLeverage is not set. Run the Part IX venue-held stop verification and write ' +
        'the result explicitly (5 = venue-held stops confirmed, 2 = client-held stops only, ' +
        'do not trade if there is no stop capability). There is no default: an unverified stop ' +
        'mechanism must never reach a leveraged book.',
    );
  }

  return maxLeverage;
}

/**
 * Isolated margin is a requirement, not a preference. Cross margin means one bad
 * position can consume the equity backing every other, which turns a single
 * stop-out into a competition-ending event.
 */
export function assertIsolatedMargin(config: Config): void {
  if (config.execution.marginMode !== 'isolated') {
    throw new ConfigError(
      `execution.marginMode is "${config.execution.marginMode}" — isolated margin is mandatory. ` +
        'Cross margin lets one position consume the equity backing every other.',
    );
  }
}

/**
 * Where we are on the competition clock.
 *
 * One vocabulary shared by the start gate and the Part X endgame, so the two
 * cannot disagree about what phase it is. Ordered by how much they restrict:
 *
 *   before      — registration window. No position may be opened at all.
 *   open        — normal trading.
 *   noNewEntries — T-48h. Manage what we hold; start nothing new.
 *   closeLosers — T-24h. Losing and flat positions go; winners trail tight.
 *   after       — the snapshot has been taken. Nothing we do now scores.
 */
export type CompetitionPhase = 'before' | 'open' | 'noNewEntries' | 'closeLosers' | 'after';

/**
 * The phase at a given instant.
 *
 * Pure and total: every instant maps to exactly one phase, so there is no
 * "unknown" state a caller could interpret as permission. Callers pass the clock
 * in rather than reading it here — the engine has one `now` per cycle, and two
 * gates disagreeing about the time by a few milliseconds at a boundary is the
 * kind of fault that appears once, at the worst moment, and never reproduces.
 */
export function competitionPhase(config: Config, nowMs: number): CompetitionPhase {
  const { startsAt, endsAt, endgame } = config.competition;

  if (nowMs < startsAt) return 'before';
  if (nowMs >= endsAt) return 'after';

  const msLeft = endsAt - nowMs;
  if (msLeft <= endgame.closeLosersHoursBeforeEnd * 3_600_000) return 'closeLosers';
  if (msLeft <= endgame.noNewEntriesHoursBeforeEnd * 3_600_000) return 'noNewEntries';
  return 'open';
}

/** Whether a NEW position may be opened right now. Only one phase permits it. */
export function entriesPermitted(phase: CompetitionPhase): boolean {
  return phase === 'open';
}

export function riskFractionForStage(config: Config, stage: Stage): number {
  return config.risk.riskFractionByStage[stage];
}

export function drawdownBandForStage(
  config: Config,
  stage: Stage,
): Readonly<{ halveSizing: number; flatAndHalt12h: number; stopForCompetition: number }> {
  return config.risk.drawdownGovernor[stage];
}
