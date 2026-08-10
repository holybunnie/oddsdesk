/**
 * Research-only walk-forward signal discovery.
 *
 * This module is intentionally not wired into the live engine. It answers a
 * narrower question first: do a small, fixed set of market features contain
 * directional information after costs on data that was not used for fitting?
 *
 * The model is a diagonal ridge score. Each feature is standardized on the
 * training window and receives a shrunk univariate coefficient. This is less
 * expressive than a flexible learner, but it is inspectable and makes it much
 * harder to hide curve fitting behind a leaderboard number.
 */

import type { Candle } from '../market/okx.js';
import { realizedVolatility, volumeTrend } from './indicators.js';
import type { ReplayDataset } from '../backtest/replay.js';
import {
  fundingIsCovered,
  observedFundingCostReturn,
  stressFundingRate,
  type FundingPolicy,
} from './funding-policy.js';

const HOUR_MS = 3_600_000;
const FOUR_HOUR_MS = 4 * HOUR_MS;
const HORIZON_HOURS = 24;
export const DISCOVERY_FEATURE_NAMES = [
  'return1h',
  'return4h',
  'return12h',
  'return24h',
  'return72h',
  'emaGap1h',
  'emaGap4h',
  'emaSlope1h',
  'emaSlope4h',
  'rsi14',
  'realizedVol24h',
  'volumeTrend12h',
  'fundingRate',
  'binanceReturn1h',
  'binanceReturn4h',
  'binanceReturn24h',
  'venueReturnGap1h',
  'venueReturnGap24h',
] as const;

export type DiscoveryFeatureName = (typeof DISCOVERY_FEATURE_NAMES)[number];

export interface DiscoverySample {
  readonly instId: string;
  readonly timestampMs: number;
  readonly features: readonly number[];
  /** Forward log return over the fixed horizon, before costs. */
  readonly forwardLogReturn: number;
  readonly fundingRate: number;
  readonly fundingObserved: boolean;
  readonly fundingCovered: boolean;
  readonly binanceAvailable: boolean;
  readonly observedFundingCostLong: number;
  readonly observedFundingCostShort: number;
  readonly spreadBps: number;
}

export interface DiscoveryPrediction {
  readonly instId: string;
  readonly timestampMs: number;
  readonly direction: 'long' | 'short';
  readonly predictedNetReturn: number;
  readonly realisedNetReturn: number;
}

export interface DiscoveryResult {
  readonly trainSamples: number;
  readonly holdoutSamples: number;
  readonly fundingObservedSamples: number;
  readonly fundingCoveredSamples: number;
  readonly binanceAvailableSamples: number;
  readonly fundingPolicy: FundingPolicy;
  readonly fundingStressRate: number;
  readonly predictions: readonly DiscoveryPrediction[];
  readonly selectedTrades: number;
  readonly wins: number;
  readonly losses: number;
  readonly totalNetReturn: number;
  readonly averageNetReturn: number;
  readonly payoffRatio: number;
  readonly profitFactor: number;
  readonly winRate: number;
  readonly featureNames: readonly DiscoveryFeatureName[];
  readonly assumptions: readonly string[];
}

export interface DiscoveryOptions {
  readonly holdoutDays?: number;
  readonly fundingPolicy?: FundingPolicy;
  readonly fundingStressRate?: number;
  /** Require complete Binance features instead of zero-filling this research input. */
  readonly requireBinance?: boolean;
}

function assertFinite(value: number, name: string): number {
  if (!Number.isFinite(value)) throw new Error(`${name} is not finite`);
  return value;
}

function ema(values: readonly number[], period: number): number {
  if (values.length < period) throw new Error(`EMA(${period}) needs ${period} values`);
  let result = values.slice(0, period).reduce((sum, value) => sum + value, 0) / period;
  const alpha = 2 / (period + 1);
  for (const value of values.slice(period)) result += alpha * (value - result);
  return assertFinite(result, `EMA(${period})`);
}

function rsi(candles: readonly Candle[], period: number): number {
  if (candles.length < period + 1) throw new Error(`RSI(${period}) needs ${period + 1} candles`);
  let gains = 0;
  let losses = 0;
  for (let index = 1; index <= period; index += 1) {
    const change = candles[index]!.close - candles[index - 1]!.close;
    if (change >= 0) gains += change;
    else losses -= change;
  }
  let averageGain = gains / period;
  let averageLoss = losses / period;
  for (let index = period + 1; index < candles.length; index += 1) {
    const change = candles[index]!.close - candles[index - 1]!.close;
    averageGain = (averageGain * (period - 1) + Math.max(change, 0)) / period;
    averageLoss = (averageLoss * (period - 1) + Math.max(-change, 0)) / period;
  }
  if (averageLoss === 0) return 100;
  return assertFinite(100 - 100 / (1 + averageGain / averageLoss), `RSI(${period})`);
}

function logReturn(candles: readonly Candle[], bars: number): number {
  if (candles.length < bars + 1) throw new Error(`return(${bars}) needs ${bars + 1} candles`);
  const last = candles.at(-1)!.close;
  const previous = candles[candles.length - 1 - bars]!.close;
  return assertFinite(Math.log(last / previous), `return(${bars})`);
}

function completedSeries(candles: readonly Candle[], atMs: number, barMs: number, maxBars: number): readonly Candle[] {
  let end = 0;
  while (end < candles.length && candles[end]!.openTimeMs <= atMs - barMs) end += 1;
  return candles.slice(Math.max(0, end - maxBars), end);
}

function latestCompleted(candles: readonly Candle[], atMs: number, barMs: number): Candle | undefined {
  let latest: Candle | undefined;
  for (const candle of candles) {
    if (candle.openTimeMs > atMs - barMs) break;
    latest = candle;
  }
  return latest;
}

export function discoveryFeatureVector(
  candles1h: readonly Candle[],
  candles4h: readonly Candle[],
  fundingRate: number,
  binanceCandles1h?: readonly Candle[],
  binanceCandles4h?: readonly Candle[],
): readonly number[] {
  const close = candles1h.at(-1)!.close;
  const fast1h = ema(candles1h.map((candle) => candle.close), 20);
  const slow1h = ema(candles1h.map((candle) => candle.close), 50);
  const fast4h = ema(candles4h.map((candle) => candle.close), 20);
  const slow4h = ema(candles4h.map((candle) => candle.close), 50);
  const priorFast1h = ema(candles1h.slice(0, -1).map((candle) => candle.close), 20);
  const priorFast4h = ema(candles4h.slice(0, -1).map((candle) => candle.close), 20);
  const okxReturn1h = logReturn(candles1h, 1);
  const okxReturn24h = logReturn(candles1h, 24);
  const binanceAvailable = binanceCandles1h !== undefined && binanceCandles4h !== undefined;
  const binanceReturn1h = binanceAvailable ? logReturn(binanceCandles1h, 1) : 0;
  const binanceReturn4h = binanceAvailable ? logReturn(binanceCandles4h, 1) : 0;
  const binanceReturn24h = binanceAvailable ? logReturn(binanceCandles1h, 24) : 0;
  return [
    okxReturn1h,
    logReturn(candles1h, 4),
    logReturn(candles1h, 12),
    logReturn(candles1h, 24),
    logReturn(candles1h, 72),
    (fast1h - slow1h) / close,
    (fast4h - slow4h) / close,
    (fast1h - priorFast1h) / close,
    (fast4h - priorFast4h) / close,
    (rsi(candles1h, 14) - 50) / 50,
    realizedVolatility(candles1h, 24),
    volumeTrend(candles1h, 12) - 1,
    fundingRate,
    binanceReturn1h,
    binanceReturn4h,
    binanceReturn24h,
    okxReturn1h - binanceReturn1h,
    okxReturn24h - binanceReturn24h,
  ].map((value, index) => assertFinite(value, `${DISCOVERY_FEATURE_NAMES[index]}`));
}

function sampleAt(
  instrument: ReplayDataset['instruments'][number],
  timestampMs: number,
  requireBinance: boolean,
): DiscoverySample | undefined {
  const candles1h = completedSeries(instrument.candles1h, timestampMs, HOUR_MS, 160);
  const candles4h = completedSeries(instrument.candles4h, timestampMs, FOUR_HOUR_MS, 80);
  const binanceCandles1h = instrument.binanceCandles1h === undefined
    ? undefined
    : completedSeries(instrument.binanceCandles1h, timestampMs, HOUR_MS, 160);
  const binanceCandles4h = instrument.binanceCandles4h === undefined
    ? undefined
    : completedSeries(instrument.binanceCandles4h, timestampMs, FOUR_HOUR_MS, 80);
  const current = candles1h.at(-1);
  const future = latestCompleted(instrument.candles1h, timestampMs + HORIZON_HOURS * HOUR_MS, HOUR_MS);
  const observedFunding = instrument.funding?.filter((point) => point.timestampMs <= timestampMs).at(-1)?.fundingRate;
  const funding = observedFunding ?? 0;
  const fundingEndMs = timestampMs + HORIZON_HOURS * HOUR_MS;
  const binanceAvailable = binanceCandles1h !== undefined && binanceCandles4h !== undefined
    && binanceCandles1h.length >= 80 && binanceCandles4h.length >= 55;
  if (current === undefined || future === undefined || candles1h.length < 80 || candles4h.length < 55) return undefined;
  if (requireBinance && !binanceAvailable) return undefined;
  return {
    instId: instrument.instId,
    timestampMs,
    features: discoveryFeatureVector(candles1h, candles4h, funding, binanceAvailable ? binanceCandles1h : undefined, binanceAvailable ? binanceCandles4h : undefined),
    forwardLogReturn: Math.log(future.close / current.close),
    fundingRate: funding,
    fundingObserved: observedFunding !== undefined,
    fundingCovered: fundingIsCovered(instrument.funding, timestampMs, fundingEndMs),
    binanceAvailable,
    observedFundingCostLong: observedFundingCostReturn(instrument.funding, 'long', timestampMs, fundingEndMs),
    observedFundingCostShort: observedFundingCostReturn(instrument.funding, 'short', timestampMs, fundingEndMs),
    spreadBps: instrument.spreadBps,
  };
}

class DiagonalRidgeModel {
  readonly #means: number[];
  readonly #scales: number[];
  readonly #coefficients: number[];
  readonly #targetMean: number;
  readonly #targetScale: number;

  private constructor(means: number[], scales: number[], coefficients: number[], targetMean: number, targetScale: number) {
    this.#means = means;
    this.#scales = scales;
    this.#coefficients = coefficients;
    this.#targetMean = targetMean;
    this.#targetScale = targetScale;
  }

  static fit(samples: readonly DiscoverySample[]): DiagonalRidgeModel {
    if (samples.length < 20) throw new Error(`need at least 20 training samples, received ${samples.length}`);
    const width = DISCOVERY_FEATURE_NAMES.length;
    const means = Array<number>(width).fill(0);
    for (const sample of samples) for (let index = 0; index < width; index += 1) means[index]! += sample.features[index]!;
    for (let index = 0; index < width; index += 1) means[index]! /= samples.length;
    const scales = Array<number>(width).fill(0);
    for (const sample of samples) for (let index = 0; index < width; index += 1) scales[index]! += (sample.features[index]! - means[index]!) ** 2;
    for (let index = 0; index < width; index += 1) scales[index] = Math.sqrt(scales[index]! / samples.length) || 1;
    const targetMean = samples.reduce((sum, sample) => sum + sample.forwardLogReturn, 0) / samples.length;
    const targetScale = Math.sqrt(samples.reduce((sum, sample) => sum + (sample.forwardLogReturn - targetMean) ** 2, 0) / samples.length) || 1;
    const coefficients = Array<number>(width).fill(0);
    const ridge = 0.25;
    for (let index = 0; index < width; index += 1) {
      let covariance = 0;
      let variance = 0;
      for (const sample of samples) {
        const normalizedFeature = (sample.features[index]! - means[index]!) / scales[index]!;
        const normalizedTarget = (sample.forwardLogReturn - targetMean) / targetScale;
        covariance += normalizedFeature * normalizedTarget;
        variance += normalizedFeature ** 2;
      }
      coefficients[index] = covariance / (variance + ridge * samples.length);
    }
    return new DiagonalRidgeModel(means, scales, coefficients, targetMean, targetScale);
  }

  predict(features: readonly number[]): number {
    let score = 0;
    for (let index = 0; index < this.#coefficients.length; index += 1) {
      score += this.#coefficients[index]! * ((features[index]! - this.#means[index]!) / this.#scales[index]!);
    }
    return this.#targetMean + this.#targetScale * score;
  }
}

function costFor(direction: 'long' | 'short', sample: DiscoverySample, policy: FundingPolicy, stressRate: number): number {
  const roundTripFeeAndSlippage = 0.0008;
  const roundTripSpread = sample.spreadBps / 10_000;
  const funding = policy === 'neutral'
    ? 0
    : sample.fundingCovered
      ? (direction === 'long' ? sample.observedFundingCostLong : sample.observedFundingCostShort)
      : stressRate * 3;
  return roundTripFeeAndSlippage + roundTripSpread + funding;
}

function netReturn(direction: 'long' | 'short', sample: DiscoverySample, policy: FundingPolicy, stressRate: number): number {
  const signed = direction === 'long' ? sample.forwardLogReturn : -sample.forwardLogReturn;
  return signed - costFor(direction, sample, policy, stressRate);
}

export function discoverSignals(dataset: ReplayDataset, options: DiscoveryOptions = {}): DiscoveryResult {
  const start = dataset.replayFromMs ?? 0;
  const end = dataset.replayToMs ?? Number.POSITIVE_INFINITY;
  const holdoutDays = options.holdoutDays ?? 180;
  if (!Number.isInteger(holdoutDays) || holdoutDays <= 0) throw new Error('holdoutDays must be a positive integer');
  const fundingPolicy = options.fundingPolicy ?? 'stress';
  const fundingStress = options.fundingStressRate ?? stressFundingRate(dataset);
  const requireBinance = options.requireBinance ?? false;
  if (!Number.isFinite(fundingStress) || fundingStress < 0) throw new Error('fundingStressRate must be finite and non-negative');
  const holdoutStart = end - holdoutDays * 86_400_000;
  const times: number[] = [];
  for (let timestamp = start; timestamp <= end - HORIZON_HOURS * HOUR_MS; timestamp += FOUR_HOUR_MS) times.push(timestamp);
  const samples: DiscoverySample[] = [];
  const byKey = new Map<string, DiscoverySample>();
  for (const timestamp of times) {
    for (const instrument of dataset.instruments) {
      const sample = sampleAt(instrument, timestamp, requireBinance);
      if (sample === undefined) continue;
      samples.push(sample);
      byKey.set(`${timestamp}:${instrument.instId}`, sample);
    }
  }

  const usableSamples = fundingPolicy === 'covered' ? samples.filter((sample) => sample.fundingCovered) : samples;
  const trainingSamples = usableSamples.filter((sample) => sample.timestampMs < holdoutStart && sample.timestampMs + HORIZON_HOURS * HOUR_MS <= holdoutStart);
  const holdoutSamples = usableSamples.filter((sample) => sample.timestampMs >= holdoutStart);
  const predictions: DiscoveryPrediction[] = [];
  const blockedUntil = new Map<string, number>();
  // Expanding training reaches the holdout boundary, then the fitted model is
  // frozen. No label from the final 180 days can influence this evaluation.
  const model = trainingSamples.length >= 100 ? DiagonalRidgeModel.fit(trainingSamples) : undefined;
  if (model !== undefined) for (const timestamp of times.filter((time) => time >= holdoutStart)) {
    const candidates: DiscoveryPrediction[] = [];
    for (const instrument of dataset.instruments) {
      const sample = byKey.get(`${timestamp}:${instrument.instId}`);
      if (sample === undefined || (fundingPolicy === 'covered' && !sample.fundingCovered)) continue;
      if ((blockedUntil.get(sample.instId) ?? Number.NEGATIVE_INFINITY) > timestamp) continue;
      const expectedLong = model.predict(sample.features);
      const direction = expectedLong >= 0 ? 'long' : 'short';
      const predictedNetReturn = Math.abs(expectedLong) - costFor(direction, sample, fundingPolicy, fundingStress);
      if (predictedNetReturn < 0.001) continue;
      candidates.push({
        instId: sample.instId,
        timestampMs: timestamp,
        direction,
        predictedNetReturn,
        realisedNetReturn: netReturn(direction, sample, fundingPolicy, fundingStress),
      });
    }
    // At most one signal per four-hour decision window keeps this diagnostic
    // closer to a tradable selection than an overlapping per-instrument tally;
    // the same instrument is blocked until its 24h label horizon completes.
    const best = candidates.sort((a, b) => b.predictedNetReturn - a.predictedNetReturn)[0];
    if (best !== undefined) {
      predictions.push(best);
      blockedUntil.set(best.instId, timestamp + HORIZON_HOURS * HOUR_MS);
    }
  }

  const wins = predictions.filter((prediction) => prediction.realisedNetReturn > 0).length;
  const losses = predictions.filter((prediction) => prediction.realisedNetReturn < 0).length;
  const positive = predictions.filter((prediction) => prediction.realisedNetReturn > 0).reduce((sum, prediction) => sum + prediction.realisedNetReturn, 0);
  const negative = Math.abs(predictions.filter((prediction) => prediction.realisedNetReturn < 0).reduce((sum, prediction) => sum + prediction.realisedNetReturn, 0));
  const totalNetReturn = predictions.reduce((sum, prediction) => sum + prediction.realisedNetReturn, 0);
  return {
    trainSamples: trainingSamples.length,
    holdoutSamples: holdoutSamples.length,
    fundingObservedSamples: samples.filter((sample) => sample.fundingObserved).length,
    fundingCoveredSamples: samples.filter((sample) => sample.fundingCovered).length,
    binanceAvailableSamples: samples.filter((sample) => sample.binanceAvailable).length,
    fundingPolicy,
    fundingStressRate: fundingStress,
    predictions,
    selectedTrades: predictions.length,
    wins,
    losses,
    totalNetReturn,
    averageNetReturn: predictions.length === 0 ? 0 : totalNetReturn / predictions.length,
    payoffRatio: wins === 0
      ? 0
      : negative === 0
      ? (positive > 0 ? Number.POSITIVE_INFINITY : 0)
      : (positive / wins) / (negative / losses),
    profitFactor: negative === 0 ? (positive > 0 ? Number.POSITIVE_INFINITY : 0) : positive / negative,
    winRate: predictions.length === 0 ? 0 : wins / predictions.length,
    featureNames: DISCOVERY_FEATURE_NAMES,
    assumptions: [
      'Training expands to the holdout boundary; each label is a 24h-forward return and is admitted only after its horizon has completed.',
      `The final ${holdoutDays} days are untouched holdout data and the fitted model is frozen across that period.`,
      'One four-hour decision window can select at most one instrument and direction; each instrument is blocked for the 24h forecast horizon.',
      'Costs include 2 bps fee plus 2 bps slippage per side, the recorded instrument spread, and funding under the selected policy.',
      requireBinance
        ? 'Every selected sample has at least 80 completed Binance 1h and 55 completed Binance 4h candles; Binance is used only as an additional signal feature source.'
        : 'Binance features are used when present and zero-filled when absent; use --require-binance for the multi-venue promotion study.',
      fundingPolicy === 'covered'
        ? 'Only samples whose complete 24h funding horizon is observed are included.'
        : fundingPolicy === 'stress'
          ? `Missing funding uses a conservative ${fundingStress} per 8h stress rate; observed horizons use actual funding.`
          : 'Funding is excluded from costs; this is a control only, not a promotion run.',
      'This is predictive signal evidence, not a live execution or portfolio-PnL result.',
    ],
  };
}
