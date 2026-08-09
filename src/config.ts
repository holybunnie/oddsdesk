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

export const configSchema = z
  .object({
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
     * Prefix for a base symbol named in no list, e.g. `ungrouped:FARTCOIN`.
     *
     * A PREFIX, not a group name. A single shared "other" bucket would make two
     * unrelated small caps count as a correlated pair and refuse a trade we
     * cannot justify refusing.
     */
    ungroupedPrefix: z.string().min(1),

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

export function riskFractionForStage(config: Config, stage: Stage): number {
  return config.risk.riskFractionByStage[stage];
}

export function drawdownBandForStage(
  config: Config,
  stage: Stage,
): Readonly<{ halveSizing: number; flatAndHalt12h: number; stopForCompetition: number }> {
  return config.risk.drawdownGovernor[stage];
}
