/**
 * Frozen competition policy promoted from the exact-cost research tournament.
 *
 * These values are constants deliberately: changing one creates a new research
 * candidate and must not happen through a VPS environment variable or an
 * operational config edit.
 */

import type { Candle } from '../market/okx.js';
import { atr, realizedVolatility } from './indicators.js';
import type { EntryCandidate } from './entry.js';

export const FROZEN_MAJOR_INST_IDS = [
  'BTC-USDT-SWAP',
  'ETH-USDT-SWAP',
  'SOL-USDT-SWAP',
  'XRP-USDT-SWAP',
  'DOGE-USDT-SWAP',
  'BNB-USDT-SWAP',
] as const;

export const FROZEN_CONTINUATION_POLICY = Object.freeze({
  decisionIntervalHours: 4,
  direction: 'short' as const,
  minAbsoluteScore: 0.5,
  minDirectionalBreadth: 3,
  requireBtcAlignment: true,
  emaFast: 20,
  emaSlow: 50,
  continuationEma: 20,
  stopAtrPeriod: 14,
  stopAtrMultiple: 2,
  targetR: 3,
  maxHoldHours: 168,
});

export interface FrozenMarketState {
  readonly instId: string;
  readonly candles1h: readonly Candle[];
  readonly candles4h: readonly Candle[];
  readonly binanceCandles1h: readonly Candle[];
  readonly binanceCandles4h: readonly Candle[];
}

export interface FrozenDecision {
  readonly candidate?: EntryCandidate;
  readonly reason: string;
  readonly scores: ReadonlyMap<string, number>;
  readonly shortBreadth: number;
  readonly regimeFavourable: boolean;
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

function shortTrend(state: FrozenMarketState): boolean {
  return ema(state.candles4h, 20) < ema(state.candles4h, 50)
    && ema(state.binanceCandles4h, 20) < ema(state.binanceCandles4h, 50);
}

function score(state: FrozenMarketState): number {
  const okxVol = Math.max(realizedVolatility(state.candles1h, 24) * Math.sqrt(24), 1e-6);
  const binanceVol = Math.max(realizedVolatility(state.binanceCandles1h, 24) * Math.sqrt(24), 1e-6);
  return 0.35 * logReturn(state.candles1h, 24) / okxVol
    + 0.25 * logReturn(state.candles1h, 72) / okxVol
    + 0.25 * logReturn(state.binanceCandles1h, 24) / binanceVol
    + 0.15 * logReturn(state.binanceCandles1h, 72) / binanceVol;
}

function continuation(state: FrozenMarketState): boolean {
  const current = state.candles1h.at(-1)!;
  const previous = state.candles1h.at(-2)!;
  return current.close < previous.close
    && current.close < ema(state.candles1h, FROZEN_CONTINUATION_POLICY.continuationEma)
    && logReturn(state.binanceCandles1h, 1) < 0;
}

export function evaluateFrozenContinuation(
  states: readonly FrozenMarketState[],
  nowMs: number,
  cooldowns: ReadonlyMap<string, number> = new Map(),
): FrozenDecision {
  const byId = new Map(states.map((state) => [state.instId, state]));
  for (const instId of FROZEN_MAJOR_INST_IDS) {
    const state = byId.get(instId);
    if (state === undefined) return { reason: `missing ${instId}`, scores: new Map(), shortBreadth: 0, regimeFavourable: false };
    if (state.candles1h.length < 100 || state.candles4h.length < 60 || state.binanceCandles1h.length < 100 || state.binanceCandles4h.length < 60) {
      return { reason: `insufficient confirmed history for ${instId}`, scores: new Map(), shortBreadth: 0, regimeFavourable: false };
    }
  }

  const scores = new Map(states.map((state) => [state.instId, score(state)]));
  const shortBreadth = states.filter(shortTrend).length;
  if (!shortTrend(byId.get('BTC-USDT-SWAP')!)) {
    return { reason: 'BTC dual-venue 4h trend is not short', scores, shortBreadth, regimeFavourable: false };
  }
  if (shortBreadth < FROZEN_CONTINUATION_POLICY.minDirectionalBreadth) {
    return { reason: `short breadth ${shortBreadth}/6 is below 3/6`, scores, shortBreadth, regimeFavourable: false };
  }

  const chosen = states
    .filter(shortTrend)
    .filter(continuation)
    .filter((state) => (scores.get(state.instId) ?? 0) <= -FROZEN_CONTINUATION_POLICY.minAbsoluteScore)
    .filter((state) => (cooldowns.get(state.instId) ?? Number.NEGATIVE_INFINITY) <= nowMs)
    .sort((left, right) => (scores.get(left.instId) ?? 0) - (scores.get(right.instId) ?? 0))[0];
  if (chosen === undefined) return { reason: 'no score>=0.5 short continuation', scores, shortBreadth, regimeFavourable: true };

  const current = chosen.candles1h.at(-1)!;
  const atrValue = atr(chosen.candles1h, FROZEN_CONTINUATION_POLICY.stopAtrPeriod);
  const risk = FROZEN_CONTINUATION_POLICY.stopAtrMultiple * atrValue;
  const stopPrice = current.close + risk;
  const targetPrice = current.close - FROZEN_CONTINUATION_POLICY.targetR * risk;
  if (targetPrice <= 0) return { reason: `${chosen.instId} target is non-positive`, scores, shortBreadth, regimeFavourable: true };
  const absoluteScore = Math.abs(scores.get(chosen.instId)!);
  return {
    candidate: {
      instId: chosen.instId,
      direction: 'short',
      breakoutLevel: current.close,
      lastClose: current.close,
      entryBandLow: current.close,
      entryBandHigh: current.close,
      stopPrice,
      scaleOutPrice: targetPrice,
      targetPrice,
      expectedFundingCostFraction: 0,
      atr: atrValue,
      conviction: {
        momentum: Math.min(absoluteScore, 1),
        trendStrength: 1,
        volume: 1,
        multiTimeframe: 1,
        total: Math.min(absoluteScore * 100, 100),
      },
      validUntilMs: nowMs + FROZEN_CONTINUATION_POLICY.decisionIntervalHours * 3_600_000,
    },
    reason: `${chosen.instId} short continuation score ${absoluteScore.toFixed(2)}, breadth ${shortBreadth}/6`,
    scores,
    shortBreadth,
    regimeFavourable: true,
  };
}
