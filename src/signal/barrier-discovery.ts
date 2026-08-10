/**
 * Research-only asymmetric barrier discovery.
 *
 * The ordinary discovery pass predicts the sign of a 24h return. That is not
 * the same objective as a competition trade with a 3R target and a 1R loss.
 * This pass labels each direction by whether its target is reached before its
 * stop, fits target-hit probabilities on the pre-holdout period, and reports
 * realised results in R after explicit costs.
 */

import type { Candle, FundingPoint } from '../market/okx.js';
import type { ReplayDataset, ReplayInstrument } from '../backtest/replay.js';
import {
  DISCOVERY_FEATURE_NAMES,
  discoveryFeatureVector,
  type DiscoveryFeatureName,
} from './discovery.js';
import { atr } from './indicators.js';
import {
  fundingIsCovered,
  observedFundingCostReturn,
  stressFundingRate,
  type FundingPolicy,
} from './funding-policy.js';

const HOUR_MS = 3_600_000;
const FOUR_HOUR_MS = 4 * HOUR_MS;
const HORIZON_HOURS = 72;
const TARGET_R = 3;
const MIN_TRAINING_SAMPLES = 100;
const MIN_TARGET_PROBABILITY = 0.40;

type Direction = 'long' | 'short';
type ExitClass = 'target' | 'stop' | 'time';

interface BarrierSample {
  readonly instId: string;
  readonly timestampMs: number;
  readonly features: readonly number[];
  readonly currentFundingRate: number;
  readonly fundingObserved: boolean;
  readonly fundingCovered: boolean;
  readonly binanceAvailable: boolean;
  readonly spreadBps: number;
  readonly longTargetHit: boolean;
  readonly shortTargetHit: boolean;
  readonly longNetR: number;
  readonly shortNetR: number;
  readonly longExitClass: ExitClass;
  readonly shortExitClass: ExitClass;
}

export interface BarrierPrediction {
  readonly instId: string;
  readonly timestampMs: number;
  readonly direction: Direction;
  readonly predictedTargetProbability: number;
  readonly predictedNetR: number;
  readonly realisedNetR: number;
  readonly exitClass: ExitClass;
  readonly fundingCovered: boolean;
}

export interface BarrierScoreBin {
  readonly lowerProbability: number;
  readonly upperProbability: number;
  readonly count: number;
  readonly targetHits: number;
  readonly targetRate: number;
}

export interface BarrierResult {
  readonly trainSamples: number;
  readonly holdoutSamples: number;
  readonly fundingObservedSamples: number;
  readonly fundingCoveredSamples: number;
  readonly fundingPolicy: FundingPolicy;
  readonly fundingStressRate: number;
  readonly trainLongTargetRate: number;
  readonly trainShortTargetRate: number;
  readonly holdoutLongTargetRate: number;
  readonly holdoutShortTargetRate: number;
  readonly holdoutScoreBins: readonly BarrierScoreBin[];
  readonly selectedTrades: number;
  readonly wins: number;
  readonly losses: number;
  readonly targetHits: number;
  readonly stopHits: number;
  readonly timeStops: number;
  readonly totalNetR: number;
  readonly averageNetR: number;
  readonly payoffRatio: number;
  readonly profitFactor: number;
  readonly winRate: number;
  readonly predictions: readonly BarrierPrediction[];
  readonly featureNames: readonly DiscoveryFeatureName[];
  readonly assumptions: readonly string[];
}

export interface BarrierDiscoveryOptions {
  /** Omit for the expanding pre-holdout window; set only for a declared study. */
  readonly trainingWindowDays?: number;
  readonly holdoutDays?: number;
  readonly fundingPolicy?: FundingPolicy;
  readonly fundingStressRate?: number;
  readonly requireBinance?: boolean;
}

function assertFinite(value: number, name: string): number {
  if (!Number.isFinite(value)) throw new Error(`${name} is not finite`);
  return value;
}

function completedSeries(candles: readonly Candle[], atMs: number, barMs: number, maxBars: number): readonly Candle[] {
  let end = 0;
  while (end < candles.length && candles[end]!.openTimeMs <= atMs - barMs) end += 1;
  return candles.slice(Math.max(0, end - maxBars), end);
}

function latestFunding(points: readonly FundingPoint[] | undefined, atMs: number): FundingPoint | undefined {
  return points?.filter((point) => point.timestampMs <= atMs).at(-1);
}

function adverseFunding(direction: Direction, rate: number): number {
  return Math.max(direction === 'long' ? rate : -rate, 0);
}

interface BarrierPath {
  readonly targetHit: boolean;
  readonly exitClass: ExitClass;
  readonly exitPrice: number;
  readonly exitTimeMs: number;
}

function followBarrier(
  candles: readonly Candle[],
  currentIndex: number,
  direction: Direction,
  entryPrice: number,
  riskPrice: number,
): BarrierPath {
  const stop = direction === 'long' ? entryPrice - riskPrice : entryPrice + riskPrice;
  const target = direction === 'long' ? entryPrice + TARGET_R * riskPrice : entryPrice - TARGET_R * riskPrice;
  const finalIndex = Math.min(currentIndex + HORIZON_HOURS, candles.length - 1);
  for (let index = currentIndex + 1; index <= finalIndex; index += 1) {
    const candle = candles[index]!;
    const hitStop = direction === 'long' ? candle.low <= stop : candle.high >= stop;
    const hitTarget = direction === 'long' ? candle.high >= target : candle.low <= target;
    // Conservative ordering when both barriers are inside one OHLC bar.
    if (hitStop) return { targetHit: false, exitClass: 'stop', exitPrice: stop, exitTimeMs: candle.openTimeMs + HOUR_MS };
    if (hitTarget) return { targetHit: true, exitClass: 'target', exitPrice: target, exitTimeMs: candle.openTimeMs + HOUR_MS };
  }
  const timeoutCandle = candles[finalIndex]!;
  return {
    targetHit: false,
    exitClass: 'time',
    exitPrice: timeoutCandle.close,
    exitTimeMs: timeoutCandle.openTimeMs + HOUR_MS,
  };
}

function signedR(direction: Direction, entryPrice: number, exitPrice: number, riskPrice: number): number {
  return direction === 'long'
    ? (exitPrice - entryPrice) / riskPrice
    : (entryPrice - exitPrice) / riskPrice;
}

function roundTripCostReturn(spreadBps: number): number {
  // 2 bps fee + 2 bps slippage per side, plus the recorded bid/ask spread.
  return 0.0008 + spreadBps / 10_000;
}

function costR(
  instrument: ReplayInstrument,
  direction: Direction,
  entryPrice: number,
  riskPrice: number,
  exitTimeMs: number,
  decisionTimeMs: number,
  fundingPolicy: FundingPolicy,
  fundingStress: number,
): number {
  const fixed = roundTripCostReturn(instrument.spreadBps);
  const covered = fundingIsCovered(instrument.funding, decisionTimeMs, decisionTimeMs + HORIZON_HOURS * HOUR_MS);
  const funding = fundingPolicy === 'neutral'
    ? 0
    : covered
      ? observedFundingCostReturn(instrument.funding, direction, decisionTimeMs, exitTimeMs)
      : fundingStress * Math.max(1, Math.ceil((exitTimeMs - decisionTimeMs) / (8 * HOUR_MS)));
  return (fixed + funding) / (riskPrice / entryPrice);
}

function buildSample(
  instrument: ReplayInstrument,
  timestampMs: number,
  stopAtrMultiple: number,
  fundingPolicy: FundingPolicy,
  fundingStress: number,
  requireBinance: boolean,
): BarrierSample | undefined {
  const candles1h = completedSeries(instrument.candles1h, timestampMs, HOUR_MS, 160);
  const candles4h = completedSeries(instrument.candles4h, timestampMs, FOUR_HOUR_MS, 80);
  const binanceCandles1h = instrument.binanceCandles1h === undefined
    ? undefined
    : completedSeries(instrument.binanceCandles1h, timestampMs, HOUR_MS, 160);
  const binanceCandles4h = instrument.binanceCandles4h === undefined
    ? undefined
    : completedSeries(instrument.binanceCandles4h, timestampMs, FOUR_HOUR_MS, 80);
  if (candles1h.length < 80 || candles4h.length < 55) return undefined;
  const current = candles1h.at(-1)!;
  const binanceAvailable = binanceCandles1h !== undefined && binanceCandles4h !== undefined
    && binanceCandles1h.length >= 80 && binanceCandles4h.length >= 55;
  if (requireBinance && !binanceAvailable) return undefined;
  const currentIndex = instrument.candles1h.findIndex((candle) => candle.openTimeMs === current.openTimeMs);
  if (currentIndex < 0 || currentIndex + HORIZON_HOURS >= instrument.candles1h.length) return undefined;
  const fundingPoint = latestFunding(instrument.funding, timestampMs);
  const fundingRate = fundingPoint?.fundingRate ?? 0;
  const riskPrice = atr(candles1h, 14) * stopAtrMultiple;
  if (!Number.isFinite(riskPrice) || riskPrice <= 0) return undefined;
  const horizonEnd = instrument.candles1h[currentIndex + HORIZON_HOURS]!.openTimeMs + HOUR_MS;
  const longPath = followBarrier(instrument.candles1h, currentIndex, 'long', current.close, riskPrice);
  const shortPath = followBarrier(instrument.candles1h, currentIndex, 'short', current.close, riskPrice);
  const longCostR = costR(instrument, 'long', current.close, riskPrice, longPath.exitTimeMs, timestampMs, fundingPolicy, fundingStress);
  const shortCostR = costR(instrument, 'short', current.close, riskPrice, shortPath.exitTimeMs, timestampMs, fundingPolicy, fundingStress);
  return {
    instId: instrument.instId,
    timestampMs,
    features: discoveryFeatureVector(candles1h, candles4h, fundingRate, binanceAvailable ? binanceCandles1h : undefined, binanceAvailable ? binanceCandles4h : undefined),
    currentFundingRate: fundingRate,
    fundingObserved: fundingPoint !== undefined,
    fundingCovered: fundingIsCovered(instrument.funding, timestampMs, horizonEnd),
    binanceAvailable,
    spreadBps: instrument.spreadBps,
    longTargetHit: longPath.targetHit,
    shortTargetHit: shortPath.targetHit,
    longNetR: assertFinite(signedR('long', current.close, longPath.exitPrice, riskPrice) - longCostR, 'long net R'),
    shortNetR: assertFinite(signedR('short', current.close, shortPath.exitPrice, riskPrice) - shortCostR, 'short net R'),
    longExitClass: longPath.exitClass,
    shortExitClass: shortPath.exitClass,
  };
}

class ProbabilityModel {
  readonly #means: number[];
  readonly #scales: number[];
  readonly #coefficients: number[];
  readonly #targetMean: number;

  private constructor(means: number[], scales: number[], coefficients: number[], targetMean: number) {
    this.#means = means;
    this.#scales = scales;
    this.#coefficients = coefficients;
    this.#targetMean = targetMean;
  }

  static fit(samples: readonly BarrierSample[], target: (sample: BarrierSample) => boolean): ProbabilityModel {
    if (samples.length < MIN_TRAINING_SAMPLES) throw new Error(`need at least ${MIN_TRAINING_SAMPLES} barrier samples`);
    const width = DISCOVERY_FEATURE_NAMES.length;
    const means = Array<number>(width).fill(0);
    for (const sample of samples) for (let index = 0; index < width; index += 1) means[index]! += sample.features[index]!;
    for (let index = 0; index < width; index += 1) means[index]! /= samples.length;
    const scales = Array<number>(width).fill(0);
    for (const sample of samples) for (let index = 0; index < width; index += 1) scales[index]! += (sample.features[index]! - means[index]!) ** 2;
    for (let index = 0; index < width; index += 1) scales[index]! = Math.sqrt(scales[index]! / samples.length) || 1;
    const targetMean = samples.reduce((sum, sample) => sum + (target(sample) ? 1 : 0), 0) / samples.length;
    const coefficients = Array<number>(width).fill(0);
    const ridge = 0.25;
    for (let index = 0; index < width; index += 1) {
      let covariance = 0;
      let variance = 0;
      for (const sample of samples) {
        const normalizedFeature = (sample.features[index]! - means[index]!) / scales[index]!;
        covariance += normalizedFeature * ((target(sample) ? 1 : 0) - targetMean);
        variance += normalizedFeature ** 2;
      }
      coefficients[index] = covariance / (variance + ridge * samples.length);
    }
    return new ProbabilityModel(means, scales, coefficients, targetMean);
  }

  predict(features: readonly number[]): number {
    let score = this.#targetMean;
    for (let index = 0; index < this.#coefficients.length; index += 1) {
      score += this.#coefficients[index]! * ((features[index]! - this.#means[index]!) / this.#scales[index]!);
    }
    return Math.min(Math.max(score, 0), 1);
  }
}

function expectedNetR(
  direction: Direction,
  probability: number,
  sample: BarrierSample,
  stopAtrMultiple: number,
  fundingPolicy: FundingPolicy,
  fundingStress: number,
): number {
  const riskFraction = atrFromFeaturesNotAvailable(stopAtrMultiple);
  const currentRate = fundingPolicy === 'neutral'
    ? 0
    : sample.fundingCovered
      ? adverseFunding(direction, sample.currentFundingRate) * 9
      : fundingStress * 9;
  const costReturn = roundTripCostReturn(sample.spreadBps) + currentRate;
  const costInR = costReturn / riskFraction;
  return probability * TARGET_R - (1 - probability) - costInR;
}

// The feature vector deliberately does not contain ATR. Use a conservative
// fixed cost gate in R based on the configured stop multiple and the observed
// instrument spread. The actual trade result still uses the sample's ATR.
function atrFromFeaturesNotAvailable(stopAtrMultiple: number): number {
  // The discovery gate needs only an order-of-magnitude cost estimate. A 1%
  // ATR proxy avoids smuggling future volatility into the decision threshold;
  // the final result is always measured using the actual ATR barrier.
  return Math.max(stopAtrMultiple * 0.01, 0.0001);
}

export function discoverBarrierSignals(dataset: ReplayDataset, options: BarrierDiscoveryOptions = {}): BarrierResult {
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
  for (let timestamp = start; timestamp <= end - (HORIZON_HOURS + 1) * HOUR_MS; timestamp += FOUR_HOUR_MS) times.push(timestamp);
  const samples: BarrierSample[] = [];
  const byKey = new Map<string, BarrierSample>();
  for (const timestamp of times) {
    for (const instrument of dataset.instruments) {
      const sample = buildSample(instrument, timestamp, 2.5, fundingPolicy, fundingStress, requireBinance);
      if (sample === undefined) continue;
      samples.push(sample);
      byKey.set(`${timestamp}:${instrument.instId}`, sample);
    }
  }

  const usableSamples = fundingPolicy === 'covered' ? samples.filter((sample) => sample.fundingCovered) : samples;
  const trainingStart = options.trainingWindowDays === undefined
    ? Number.NEGATIVE_INFINITY
    : holdoutStart - options.trainingWindowDays * 86_400_000;
  const training = usableSamples.filter((sample) => sample.timestampMs >= trainingStart && sample.timestampMs < holdoutStart && sample.timestampMs + HORIZON_HOURS * HOUR_MS <= holdoutStart);
  const holdout = usableSamples.filter((sample) => sample.timestampMs >= holdoutStart);
  const longModel = training.length >= MIN_TRAINING_SAMPLES ? ProbabilityModel.fit(training, (sample) => sample.longTargetHit) : undefined;
  const shortModel = training.length >= MIN_TRAINING_SAMPLES ? ProbabilityModel.fit(training, (sample) => sample.shortTargetHit) : undefined;
  const predictions: BarrierPrediction[] = [];
  const holdoutScores: Array<{ probability: number; targetHit: boolean }> = [];
  const blockedUntil = new Map<string, number>();
  if (longModel !== undefined && shortModel !== undefined) for (const timestamp of times.filter((time) => time >= holdoutStart)) {
    const candidates: BarrierPrediction[] = [];
    for (const instrument of dataset.instruments) {
      const sample = byKey.get(`${timestamp}:${instrument.instId}`);
      if (sample === undefined || (fundingPolicy === 'covered' && !sample.fundingCovered)) continue;
      const longProbability = longModel.predict(sample.features);
      const shortProbability = shortModel.predict(sample.features);
      const longExpected = expectedNetR('long', longProbability, sample, 2.5, fundingPolicy, fundingStress);
      const shortExpected = expectedNetR('short', shortProbability, sample, 2.5, fundingPolicy, fundingStress);
      const direction = longExpected >= shortExpected ? 'long' : 'short';
      const probability = direction === 'long' ? longProbability : shortProbability;
      holdoutScores.push({ probability, targetHit: direction === 'long' ? sample.longTargetHit : sample.shortTargetHit });
      if ((blockedUntil.get(sample.instId) ?? Number.NEGATIVE_INFINITY) > timestamp) continue;
      const predictedNetR = Math.max(longExpected, shortExpected);
      if (probability < MIN_TARGET_PROBABILITY || predictedNetR <= 0) continue;
      candidates.push({
        instId: sample.instId,
        timestampMs: timestamp,
        direction,
        predictedTargetProbability: probability,
        predictedNetR,
        realisedNetR: direction === 'long' ? sample.longNetR : sample.shortNetR,
        exitClass: direction === 'long' ? sample.longExitClass : sample.shortExitClass,
        fundingCovered: sample.fundingCovered,
      });
    }
    const best = candidates.sort((a, b) => b.predictedNetR - a.predictedNetR)[0];
    if (best !== undefined) {
      predictions.push(best);
      blockedUntil.set(best.instId, timestamp + HORIZON_HOURS * HOUR_MS);
    }
  }

  const wins = predictions.filter((prediction) => prediction.realisedNetR > 0).length;
  const losses = predictions.filter((prediction) => prediction.realisedNetR < 0).length;
  const positive = predictions.filter((prediction) => prediction.realisedNetR > 0).reduce((sum, prediction) => sum + prediction.realisedNetR, 0);
  const negative = Math.abs(predictions.filter((prediction) => prediction.realisedNetR < 0).reduce((sum, prediction) => sum + prediction.realisedNetR, 0));
  const totalNetR = predictions.reduce((sum, prediction) => sum + prediction.realisedNetR, 0);
  const scoreEdges = [0, 0.2, 0.3, 0.4, 0.5, 0.6, 1];
  const holdoutScoreBins = scoreEdges.slice(0, -1).map((lowerProbability, index) => {
    const upperProbability = scoreEdges[index + 1]!;
    const members = holdoutScores.filter((score) => score.probability >= lowerProbability && (index === scoreEdges.length - 2 ? score.probability <= upperProbability : score.probability < upperProbability));
    const targetHits = members.filter((score) => score.targetHit).length;
    return {
      lowerProbability,
      upperProbability,
      count: members.length,
      targetHits,
      targetRate: members.length === 0 ? 0 : targetHits / members.length,
    } satisfies BarrierScoreBin;
  });
  return {
    trainSamples: training.length,
    holdoutSamples: holdout.length,
    fundingObservedSamples: samples.filter((sample) => sample.fundingObserved).length,
    fundingCoveredSamples: samples.filter((sample) => sample.fundingCovered).length,
    fundingPolicy,
    fundingStressRate: fundingStress,
    trainLongTargetRate: training.length === 0 ? 0 : training.filter((sample) => sample.longTargetHit).length / training.length,
    trainShortTargetRate: training.length === 0 ? 0 : training.filter((sample) => sample.shortTargetHit).length / training.length,
    holdoutLongTargetRate: holdout.length === 0 ? 0 : holdout.filter((sample) => sample.longTargetHit).length / holdout.length,
    holdoutShortTargetRate: holdout.length === 0 ? 0 : holdout.filter((sample) => sample.shortTargetHit).length / holdout.length,
    holdoutScoreBins,
    selectedTrades: predictions.length,
    wins,
    losses,
    targetHits: predictions.filter((prediction) => prediction.exitClass === 'target').length,
    stopHits: predictions.filter((prediction) => prediction.exitClass === 'stop').length,
    timeStops: predictions.filter((prediction) => prediction.exitClass === 'time').length,
    totalNetR,
    averageNetR: predictions.length === 0 ? 0 : totalNetR / predictions.length,
    payoffRatio: wins === 0
      ? 0
      : negative === 0
      ? (positive > 0 ? Number.POSITIVE_INFINITY : 0)
      : (positive / wins) / (negative / losses),
    profitFactor: negative === 0 ? (positive > 0 ? Number.POSITIVE_INFINITY : 0) : positive / negative,
    winRate: predictions.length === 0 ? 0 : wins / predictions.length,
    predictions,
    featureNames: DISCOVERY_FEATURE_NAMES,
    assumptions: [
      'The label is target-first: +3R before -1R, with a 72h maximum hold; same-bar stop and target hits resolve as stops.',
      `The final ${holdoutDays} days are untouched holdout data; target-hit models are frozen at the holdout boundary.`,
      'A selected instrument is blocked for the full 72h barrier horizon and only one instrument is selected per four-hour window.',
      'Each realised result is risk-normalized and includes 2 bps fee plus 2 bps slippage per side, the recorded spread, and funding under the selected policy.',
      fundingPolicy === 'covered'
        ? 'Only samples whose complete 72h funding horizon is observed are included.'
        : fundingPolicy === 'stress'
          ? `Missing funding uses a conservative ${fundingStress} per 8h stress rate; observed horizons use actual funding.`
          : 'Funding is excluded from costs; this is a control only, not a promotion run.',
      'This is a research signal test, not a live execution or account-equity result.',
    ],
  };
}
