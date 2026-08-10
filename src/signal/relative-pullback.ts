/**
 * Research-only fixed relative-strength pullback candidate.
 *
 * Signal venue: OKX candles plus Binance USDⓈ-M confirmation.
 * Execution truth: OKX candles, OKX spread assumption, and OKX funding.
 *
 * This is deliberately not a learner. The constants are declared here before
 * the final holdout is evaluated so the test answers whether a simple,
 * interpretable pullback policy generalises without fitting the holdout.
 */

import type { Candle } from '../market/okx.js';
import type { ReplayDataset, ReplayInstrument } from '../backtest/replay.js';
import { atr, realizedVolatility } from './indicators.js';
import {
  fundingIsCovered,
  observedFundingCostReturn,
  stressFundingRate,
  type FundingPolicy,
} from './funding-policy.js';

const HOUR_MS = 3_600_000;
const FOUR_HOUR_MS = 4 * HOUR_MS;
const DAY_MS = 86_400_000;
const MAX_HOLD_HOURS = 72;
const STOP_ATR_MULTIPLE = 2.5;
const TARGET_R = 3;
const EMA_FAST = 20;
const EMA_SLOW = 50;
const PULLBACK_EMA = 20;
const RELATIVE_TOP_BOTTOM_COUNT = 2;
const MIN_1H_BARS = 100;
const MIN_4H_BARS = 60;

export const RELATIVE_PULLBACK_POLICY = {
  universe: 'six majors present in the replay dataset',
  decisionInterval: '4h',
  ranking: '0.35 OKX 24h strength + 0.25 OKX 72h strength + 0.25 Binance 24h strength + 0.15 Binance 72h strength, each volatility-normalised',
  trend: 'OKX and Binance 4h EMA(20/50) must agree',
  trigger: 'OKX 1h previous low/high touches EMA(20), then the current bar reclaims EMA(20) and closes in the trend direction',
  confirmation: 'Binance 1h last return must agree with the direction',
  exits: '2.5 ATR(14) stop, unscaled 3R target, 72h maximum hold, stop-first on ambiguous OHLC bars',
} as const;

type Direction = 'long' | 'short';
type ExitClass = 'target' | 'stop' | 'time';

interface RelativeState {
  readonly instrument: ReplayInstrument;
  readonly timestampMs: number;
  readonly currentIndex: number;
  readonly current: Candle;
  readonly candles1h: readonly Candle[];
  readonly candles4h: readonly Candle[];
  readonly binance1h: readonly Candle[];
  readonly binance4h: readonly Candle[];
  readonly score: number;
  readonly trend: Direction | undefined;
  readonly pullback: Direction | undefined;
  readonly trendStrength: number;
  readonly fundingObserved: boolean;
}

interface BarrierPath {
  readonly exitClass: ExitClass;
  readonly exitPrice: number;
  readonly exitTimeMs: number;
}

export interface RelativePullbackTrade {
  readonly instId: string;
  readonly direction: Direction;
  readonly timestampMs: number;
  readonly exitTimeMs: number;
  readonly score: number;
  readonly exitClass: ExitClass;
  readonly realisedNetR: number;
  readonly fundingCovered: boolean;
}

export interface RelativePullbackResult {
  readonly holdoutDays: number;
  readonly fundingPolicy: FundingPolicy;
  readonly fundingStressRate: number;
  readonly totalSignalStates: number;
  readonly signalStatesWithBinance: number;
  readonly fundingObservedStates: number;
  readonly fundingCoveredStates: number;
  readonly preHoldoutTrades: number;
  readonly preHoldoutNetR: number;
  readonly preHoldoutPayoff: number;
  readonly preHoldoutProfitFactor: number;
  readonly holdoutTrades: number;
  readonly holdoutWins: number;
  readonly holdoutLosses: number;
  readonly holdoutTargetHits: number;
  readonly holdoutStopHits: number;
  readonly holdoutTimeStops: number;
  readonly holdoutNetR: number;
  readonly holdoutAverageNetR: number;
  readonly holdoutPayoff: number;
  readonly holdoutProfitFactor: number;
  readonly holdoutWinRate: number;
  readonly holdoutTradesPerDay: number;
  readonly holdoutTradesList: readonly RelativePullbackTrade[];
  readonly assumptions: readonly string[];
}

export interface RelativePullbackOptions {
  readonly holdoutDays?: number;
  readonly fundingPolicy?: FundingPolicy;
  readonly fundingStressRate?: number;
  readonly maxHoldHours?: number;
  readonly stopAtrMultiple?: number;
  readonly targetR?: number;
  readonly direction?: 'both' | 'long-only' | 'short-only';
  /** Minimum absolute mean 4h EMA(20/50) gap across OKX and Binance. */
  readonly minTrendGapFraction?: number;
  /** Minimum majors whose dual-venue 4h trend agrees with the trade direction. */
  readonly minDirectionalBreadth?: number;
  /** Require BTC's dual-venue 4h trend to agree with every trade. */
  readonly requireBtcAlignment?: boolean;
  readonly entryMode?: 'pullback' | 'breakout' | 'continuation';
  readonly minAbsoluteScore?: number;
}

function ema(candles: readonly Candle[], period: number): number {
  if (candles.length < period) throw new Error(`EMA(${period}) needs ${period} candles`);
  let value = candles.slice(0, period).reduce((sum, candle) => sum + candle.close, 0) / period;
  const alpha = 2 / (period + 1);
  for (const candle of candles.slice(period)) value += alpha * (candle.close - value);
  return value;
}

function logReturn(candles: readonly Candle[], bars: number): number {
  if (candles.length < bars + 1) throw new Error(`return(${bars}) needs ${bars + 1} candles`);
  return Math.log(candles.at(-1)!.close / candles[candles.length - bars - 1]!.close);
}

function completedSeries(candles: readonly Candle[], atMs: number, barMs: number, maxBars: number): readonly Candle[] {
  let end = 0;
  while (end < candles.length && candles[end]!.openTimeMs <= atMs - barMs) end += 1;
  return candles.slice(Math.max(0, end - maxBars), end);
}

function stateAt(instrument: ReplayInstrument, timestampMs: number, maxHoldHours: number, entryMode: 'pullback' | 'breakout' | 'continuation'): RelativeState | undefined {
  if (instrument.binanceCandles1h === undefined || instrument.binanceCandles4h === undefined) return undefined;
  const candles1h = completedSeries(instrument.candles1h, timestampMs, HOUR_MS, 180);
  const candles4h = completedSeries(instrument.candles4h, timestampMs, FOUR_HOUR_MS, 90);
  const binance1h = completedSeries(instrument.binanceCandles1h, timestampMs, HOUR_MS, 180);
  const binance4h = completedSeries(instrument.binanceCandles4h, timestampMs, FOUR_HOUR_MS, 90);
  if (candles1h.length < MIN_1H_BARS || candles4h.length < MIN_4H_BARS || binance1h.length < MIN_1H_BARS || binance4h.length < MIN_4H_BARS) return undefined;
  const current = candles1h.at(-1);
  const previous = candles1h.at(-2);
  const currentIndex = instrument.candles1h.findIndex((candle) => candle.openTimeMs === current?.openTimeMs);
  if (current === undefined || previous === undefined || currentIndex < 0 || currentIndex + maxHoldHours >= instrument.candles1h.length) return undefined;

  const okxVol = Math.max(realizedVolatility(candles1h, 24) * Math.sqrt(24), 1e-6);
  const binanceVol = Math.max(realizedVolatility(binance1h, 24) * Math.sqrt(24), 1e-6);
  const okx24 = logReturn(candles1h, 24) / okxVol;
  const okx72 = logReturn(candles1h, 72) / okxVol;
  const binance24 = logReturn(binance1h, 24) / binanceVol;
  const binance72 = logReturn(binance1h, 72) / binanceVol;
  const score = 0.35 * okx24 + 0.25 * okx72 + 0.25 * binance24 + 0.15 * binance72;

  const okxFast = ema(candles4h, EMA_FAST);
  const okxSlow = ema(candles4h, EMA_SLOW);
  const binanceFast = ema(binance4h, EMA_FAST);
  const binanceSlow = ema(binance4h, EMA_SLOW);
  const trend = okxFast > okxSlow && binanceFast > binanceSlow
    ? 'long'
    : okxFast < okxSlow && binanceFast < binanceSlow
      ? 'short'
      : undefined;
  const trendStrength = (Math.abs(okxFast - okxSlow) / current.close + Math.abs(binanceFast - binanceSlow) / binance1h.at(-1)!.close) / 2;

  const currentEma = ema(candles1h, PULLBACK_EMA);
  const previousEma = ema(candles1h.slice(0, -1), PULLBACK_EMA);
  const priorTwenty = candles1h.slice(-21, -1);
  const priorHigh = Math.max(...priorTwenty.map((candle) => candle.high));
  const priorLow = Math.min(...priorTwenty.map((candle) => candle.low));
  const pullback = entryMode === 'pullback'
    ? trend === 'long' && previous.low <= previousEma && current.close > currentEma && current.close > previous.close
      ? 'long'
      : trend === 'short' && previous.high >= previousEma && current.close < currentEma && current.close < previous.close
        ? 'short'
        : undefined
    : entryMode === 'breakout'
      ? trend === 'long' && current.close > priorHigh
        ? 'long'
        : trend === 'short' && current.close < priorLow
          ? 'short'
          : undefined
      : trend === 'long' && current.close > previous.close && current.close > currentEma
        ? 'long'
        : trend === 'short' && current.close < previous.close && current.close < currentEma
          ? 'short'
          : undefined;
  const binancePulse = logReturn(binance1h, 1);
  const confirmedDirection = pullback !== undefined && (pullback === 'long' ? binancePulse > 0 : binancePulse < 0)
    ? pullback
    : undefined;
  const latestFunding = instrument.funding?.findLast((point) => point.timestampMs <= timestampMs);
  return {
    instrument,
    timestampMs,
    currentIndex,
    current,
    candles1h,
    candles4h,
    binance1h,
    binance4h,
    score: confirmedDirection === undefined ? score : score,
    trend,
    pullback: confirmedDirection,
    trendStrength,
    fundingObserved: latestFunding !== undefined,
  };
}

function followBarrier(candles: readonly Candle[], currentIndex: number, direction: Direction, entryPrice: number, riskPrice: number, targetR: number, maxHoldHours: number): BarrierPath {
  const stop = direction === 'long' ? entryPrice - riskPrice : entryPrice + riskPrice;
  const target = direction === 'long' ? entryPrice + targetR * riskPrice : entryPrice - targetR * riskPrice;
  const finalIndex = Math.min(currentIndex + maxHoldHours, candles.length - 1);
  for (let index = currentIndex + 1; index <= finalIndex; index += 1) {
    const candle = candles[index]!;
    const hitStop = direction === 'long' ? candle.low <= stop : candle.high >= stop;
    const hitTarget = direction === 'long' ? candle.high >= target : candle.low <= target;
    if (hitStop) return { exitClass: 'stop', exitPrice: stop, exitTimeMs: candle.openTimeMs + HOUR_MS };
    if (hitTarget) return { exitClass: 'target', exitPrice: target, exitTimeMs: candle.openTimeMs + HOUR_MS };
  }
  const timeout = candles[finalIndex]!;
  return { exitClass: 'time', exitPrice: timeout.close, exitTimeMs: timeout.openTimeMs + HOUR_MS };
}

function signedR(direction: Direction, entryPrice: number, exitPrice: number, riskPrice: number): number {
  return direction === 'long' ? (exitPrice - entryPrice) / riskPrice : (entryPrice - exitPrice) / riskPrice;
}

function netR(state: RelativeState, direction: Direction, path: BarrierPath, policy: FundingPolicy, stressRate: number, stopAtrMultiple: number, maxHoldHours: number): { readonly netR: number; readonly covered: boolean } {
  const fundingCovered = fundingIsCovered(state.instrument.funding, state.timestampMs, state.timestampMs + maxHoldHours * HOUR_MS);
  const funding = policy === 'neutral'
    ? 0
    : fundingCovered
      ? observedFundingCostReturn(state.instrument.funding, direction, state.timestampMs, path.exitTimeMs)
      : stressRate * Math.max(1, Math.ceil((path.exitTimeMs - state.timestampMs) / (8 * HOUR_MS)));
  const fixedCostReturn = 0.0008 + state.instrument.spreadBps / 10_000;
  const riskPrice = atr(state.candles1h, 14) * stopAtrMultiple;
  return {
    netR: signedR(direction, state.current.close, path.exitPrice, riskPrice) - (fixedCostReturn + funding) / (riskPrice / state.current.close),
    covered: fundingCovered,
  };
}

function payoff(trades: readonly RelativePullbackTrade[]): number {
  const winners = trades.filter((trade) => trade.realisedNetR > 0);
  const losers = trades.filter((trade) => trade.realisedNetR < 0);
  const positive = winners.reduce((sum, trade) => sum + trade.realisedNetR, 0);
  const negative = Math.abs(losers.reduce((sum, trade) => sum + trade.realisedNetR, 0));
  return winners.length === 0 ? 0 : negative === 0 ? Number.POSITIVE_INFINITY : (positive / winners.length) / (negative / losers.length);
}

function profitFactor(trades: readonly RelativePullbackTrade[]): number {
  const positive = trades.filter((trade) => trade.realisedNetR > 0).reduce((sum, trade) => sum + trade.realisedNetR, 0);
  const negative = Math.abs(trades.filter((trade) => trade.realisedNetR < 0).reduce((sum, trade) => sum + trade.realisedNetR, 0));
  return negative === 0 ? (positive > 0 ? Number.POSITIVE_INFINITY : 0) : positive / negative;
}

function summarise(trades: readonly RelativePullbackTrade[]): { readonly net: number; readonly wins: number; readonly losses: number; readonly average: number } {
  const net = trades.reduce((sum, trade) => sum + trade.realisedNetR, 0);
  return {
    net,
    wins: trades.filter((trade) => trade.realisedNetR > 0).length,
    losses: trades.filter((trade) => trade.realisedNetR < 0).length,
    average: trades.length === 0 ? 0 : net / trades.length,
  };
}

export function testRelativePullback(dataset: ReplayDataset, options: RelativePullbackOptions = {}): RelativePullbackResult {
  const start = dataset.replayFromMs ?? 0;
  const end = dataset.replayToMs ?? Number.POSITIVE_INFINITY;
  const holdoutDays = options.holdoutDays ?? 180;
  if (!Number.isInteger(holdoutDays) || holdoutDays <= 0) throw new Error('holdoutDays must be a positive integer');
  const policy = options.fundingPolicy ?? 'stress';
  const stressRate = options.fundingStressRate ?? stressFundingRate(dataset);
  const maxHoldHours = options.maxHoldHours ?? MAX_HOLD_HOURS;
  const stopAtrMultiple = options.stopAtrMultiple ?? STOP_ATR_MULTIPLE;
  const targetR = options.targetR ?? TARGET_R;
  const direction = options.direction ?? 'both';
  const minTrendGapFraction = options.minTrendGapFraction ?? 0;
  const minDirectionalBreadth = options.minDirectionalBreadth ?? 1;
  const requireBtcAlignment = options.requireBtcAlignment ?? false;
  const entryMode = options.entryMode ?? 'pullback';
  const minAbsoluteScore = options.minAbsoluteScore ?? 0;
  if (!Number.isInteger(maxHoldHours) || maxHoldHours < 24) throw new Error('maxHoldHours must be an integer of at least 24');
  if (!Number.isFinite(stopAtrMultiple) || stopAtrMultiple <= 0) throw new Error('stopAtrMultiple must be positive');
  if (!Number.isFinite(targetR) || targetR <= 0) throw new Error('targetR must be positive');
  if (!Number.isFinite(minTrendGapFraction) || minTrendGapFraction < 0) throw new Error('minTrendGapFraction must be non-negative');
  if (!Number.isFinite(minAbsoluteScore) || minAbsoluteScore < 0) throw new Error('minAbsoluteScore must be non-negative');
  if (!Number.isInteger(minDirectionalBreadth) || minDirectionalBreadth < 1 || minDirectionalBreadth > dataset.instruments.length) throw new Error('minDirectionalBreadth is outside the universe');
  const holdoutStart = end - holdoutDays * DAY_MS;
  const states: RelativeState[] = [];
  const times: number[] = [];
  for (let timestampMs = start; timestampMs <= end - (maxHoldHours + 1) * HOUR_MS; timestampMs += FOUR_HOUR_MS) {
    times.push(timestampMs);
    for (const instrument of dataset.instruments) {
      const state = stateAt(instrument, timestampMs, maxHoldHours, entryMode);
      if (state !== undefined) states.push(state);
    }
  }

  const trades: RelativePullbackTrade[] = [];
  const blockedUntil = new Map<string, number>();
  for (const timestampMs of times) {
    const timestampStates = states.filter((state) => state.timestampMs === timestampMs);
    const candidates = timestampStates
      .filter((state) => state.pullback !== undefined && state.trendStrength >= minTrendGapFraction && Math.abs(state.score) >= minAbsoluteScore)
      .sort((left, right) => right.score - left.score);
    const longs = direction === 'short-only' ? [] : candidates.filter((state) => state.trend === 'long' && state.score > 0).slice(0, RELATIVE_TOP_BOTTOM_COUNT);
    const shorts = direction === 'long-only' ? [] : candidates.filter((state) => state.trend === 'short' && state.score < 0).slice(-RELATIVE_TOP_BOTTOM_COUNT);
    const chosen = [...longs, ...shorts]
      .filter((state) => (blockedUntil.get(state.instrument.instId) ?? Number.NEGATIVE_INFINITY) <= timestampMs)
      .filter((state) => timestampStates.filter((peer) => peer.trend === state.pullback).length >= minDirectionalBreadth)
      .filter((state) => !requireBtcAlignment || timestampStates.find((peer) => peer.instrument.instId === 'BTC-USDT-SWAP')?.trend === state.pullback)
      .sort((left, right) => Math.abs(right.score) - Math.abs(left.score))[0];
    if (chosen === undefined || chosen.pullback === undefined) continue;
    if (policy === 'covered' && !fundingIsCovered(chosen.instrument.funding, timestampMs, timestampMs + maxHoldHours * HOUR_MS)) continue;
    const riskPrice = atr(chosen.candles1h, 14) * stopAtrMultiple;
    const path = followBarrier(chosen.instrument.candles1h, chosen.currentIndex, chosen.pullback, chosen.current.close, riskPrice, targetR, maxHoldHours);
    const result = netR(chosen, chosen.pullback, path, policy, stressRate, stopAtrMultiple, maxHoldHours);
    trades.push({
      instId: chosen.instrument.instId,
      direction: chosen.pullback,
      timestampMs,
      exitTimeMs: path.exitTimeMs,
      score: chosen.score,
      exitClass: path.exitClass,
      realisedNetR: result.netR,
      fundingCovered: result.covered,
    });
    blockedUntil.set(chosen.instrument.instId, path.exitTimeMs);
  }

  const preHoldout = trades.filter((trade) => trade.timestampMs < holdoutStart);
  const holdout = trades.filter((trade) => trade.timestampMs >= holdoutStart);
  const summary = summarise(holdout);
  return {
    holdoutDays,
    fundingPolicy: policy,
    fundingStressRate: stressRate,
    totalSignalStates: states.length,
    signalStatesWithBinance: states.length,
    fundingObservedStates: states.filter((state) => state.fundingObserved).length,
    fundingCoveredStates: states.filter((state) => fundingIsCovered(state.instrument.funding, state.timestampMs, state.timestampMs + maxHoldHours * HOUR_MS)).length,
    preHoldoutTrades: preHoldout.length,
    preHoldoutNetR: summarise(preHoldout).net,
    preHoldoutPayoff: payoff(preHoldout),
    preHoldoutProfitFactor: profitFactor(preHoldout),
    holdoutTrades: holdout.length,
    holdoutWins: summary.wins,
    holdoutLosses: summary.losses,
    holdoutTargetHits: holdout.filter((trade) => trade.exitClass === 'target').length,
    holdoutStopHits: holdout.filter((trade) => trade.exitClass === 'stop').length,
    holdoutTimeStops: holdout.filter((trade) => trade.exitClass === 'time').length,
    holdoutNetR: summary.net,
    holdoutAverageNetR: summary.average,
    holdoutPayoff: payoff(holdout),
    holdoutProfitFactor: profitFactor(holdout),
    holdoutWinRate: holdout.length === 0 ? 0 : summary.wins / holdout.length,
    holdoutTradesPerDay: holdout.length / holdoutDays,
    holdoutTradesList: holdout,
    assumptions: [
      `Fixed policy: ${RELATIVE_PULLBACK_POLICY.ranking}.`,
      `Top/bottom ${RELATIVE_TOP_BOTTOM_COUNT} ranks are eligible; the selected candidate is the largest absolute score per four-hour window.`,
      `Trend requires ${RELATIVE_PULLBACK_POLICY.trend}; trigger requires ${RELATIVE_PULLBACK_POLICY.trigger}; ${RELATIVE_PULLBACK_POLICY.confirmation}.`,
      `Entry mode: ${entryMode}.`,
      `Regime filter requires EMA-gap strength >=${minTrendGapFraction}, directional breadth >=${minDirectionalBreadth}/${dataset.instruments.length}${requireBtcAlignment ? ', and BTC alignment' : ''}.`,
      `Relative-strength confidence requires absolute score >=${minAbsoluteScore}.`,
      `Execution path uses OKX candles only: ${stopAtrMultiple} ATR(14) stop, unscaled ${targetR}R target, ${maxHoldHours}h maximum hold, ${direction}, stop-first on ambiguous OHLC bars.`,
      'Costs include 2 bps fee plus 2 bps slippage per side, the recorded OKX spread, and OKX funding under the selected policy.',
      policy === 'covered'
        ? `Only trades with complete ${maxHoldHours}h OKX funding coverage are included.`
        : policy === 'stress'
          ? `Missing OKX funding uses ${stressRate} per 8h; observed funding is used whenever available.`
          : 'Funding is excluded as a control only; this is not a promotion run.',
      `The final ${holdoutDays} days are reported as an untouched holdout; no parameters are fitted on them.`,
    ],
  };
}
