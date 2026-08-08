/**
 * Configuration loading and validation.
 *
 * Two rules drive the shape of this module:
 *
 *  - Law 1: venue facts are discovered at runtime, never typed into source.
 *    Policy lives in config/default.yaml; venue facts live in runtime profiles
 *    written by the verification probes.
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

const stageKeyed = <T extends z.ZodTypeAny>(inner: T) =>
  z
    .object({ 1: inner, 2: inner, 3: inner })
    .strict();

export const configSchema = z
  .object({
    capital: z
      .object({
        principalBaseUsdt: positive,
        eligibilityFloorUsdt: positive,
        buckets: z
          .object({
            gasReserveUsdt: positive,
            polymarketUsdt: positive,
            tradeKitUsdt: positive,
          })
          .strict(),
        initialDeploymentFraction: fraction,
        initialDeploymentDays: z.number().int().positive(),
        gasAlertFraction: fraction,
      })
      .strict()
      .refine(
        (c) => c.eligibilityFloorUsdt < c.principalBaseUsdt,
        'eligibilityFloorUsdt must sit below principalBaseUsdt — the difference is the compliance buffer',
      ),

    risk: z
      .object({
        riskFractionByStage: stageKeyed(fraction),
        drawdownGovernor: stageKeyed(drawdownBandSchema),
        haltDurationHours: positive,
        stage2EquityMultiple: z.number().gt(1),
        minTargetStopRatio: z.number().gte(1),
        trailAfterR: positive,
        maxFeedStalenessSeconds: positive,
        maxLeaderboardStalenessMinutes: positive,
        reconcileIntervalSeconds: positive,
      })
      .strict(),

    engines: z
      .object({
        disableAfterDays: z.number().int().positive(),
        disableAfterTrades: z.number().int().positive(),
      })
      .strict(),

    routeB: z
      .object({
        armed: z.boolean(),
        // Absent until the Part IX stop verification writes it. Deliberately
        // optional in the schema and deliberately fatal in requireMaxLeverage().
        maxLeverage: positive.optional(),
        minConfidence: z.number().min(0).max(100),
        targetTradesPerDay: positive,
        feeBudgetFraction: fraction,
        minHoldHours: positive,
        maxHoldHours: positive,
        watchdog: z
          .object({
            heartbeatIntervalSeconds: positive,
            staleFlattenSeconds: positive,
          })
          .strict(),
      })
      .strict()
      .refine((r) => r.minHoldHours < r.maxHoldHours, 'minHoldHours must be below maxHoldHours'),

    ledger: z.object({ path: z.string().min(1) }).strict(),
    killSwitch: z.object({ path: z.string().min(1) }).strict(),

    publishing: z
      .object({
        lagMinutes: positive,
        maxSignalChars: z.number().int().positive(),
        predictionHeader: z.string().min(1),
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
 * Route B must not place a single order until maxLeverage has been written to
 * config as an explicit number by the Part IX stop verification.
 *
 * This is the only accessor for that value. It exists so the failure is a throw
 * at the call site rather than a silent fallback that puts an unverified stop
 * mechanism in front of a leveraged book.
 */
export function requireMaxLeverage(config: Config): number {
  const { armed, maxLeverage } = config.routeB;

  if (!armed) {
    throw new ConfigError(
      'Route B is not armed. It arms only when Polymarket execution is proven live ' +
        'end to end AND the Part IX venue-held stop verification has passed.',
    );
  }

  if (maxLeverage === undefined) {
    throw new ConfigError(
      'routeB.maxLeverage is not set. Run the Part IX venue-held stop verification and ' +
        'write the result explicitly (3 = venue-held stops confirmed, 1.5 = client-held ' +
        'stops only). There is no default: an unverified stop mechanism must never reach ' +
        'a leveraged book.',
    );
  }

  return maxLeverage;
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
