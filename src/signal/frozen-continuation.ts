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
  /**
   * Promoted to 'both' on 2026-08-11 as a declared exception to the promotion
   * gate, recorded so it can be reverted by changing this one value.
   *
   * The bidirectional arm REJECTED on the gate (PF 1.08, 3/5 positive folds) —
   * but so does the short-only incumbent when the same gate is turned on it
   * (PF 1.09, 2/5 positive folds, and it FAILS fold-concentration because all
   * of its profit comes from two of five windows). With no arm passing, the
   * tie-break is structural rather than statistical: short-only's hard gate was
   * measured shut for up to 47.8 continuous days against a 14-day competition
   * window, while the bidirectional gate is open 93.7% of the time with a
   * worst idle stretch of 3.2 days. A policy that cannot trade cannot rank.
   *
   * Set back to 'short' to restore the original frozen policy exactly.
   */
  direction: 'both' as 'short' | 'long' | 'both',
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

export type FrozenTrend = 'long' | 'short' | 'mixed';

export interface FrozenDecision {
  readonly candidate?: EntryCandidate;
  readonly reason: string;
  readonly scores: ReadonlyMap<string, number>;
  /**
   * Majors whose dual-venue 4h trend agrees with BTC. Named directionally
   * because the policy is no longer short-only; it is the count that the
   * `minDirectionalBreadth` floor is applied to, whichever way BTC points.
   */
  readonly directionalBreadth: number;
  /** The direction BTC licensed this cycle, or 'mixed' when the venues disagree. */
  readonly trend: FrozenTrend;
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

/**
 * Dual-venue 4h trend. Both venues must agree or the instrument is 'mixed' and
 * counts toward neither side — the same conservatism the short-only policy had,
 * applied symmetrically rather than only to the short case.
 */
function trendOf(state: FrozenMarketState): FrozenTrend {
  const okxShort = ema(state.candles4h, 20) < ema(state.candles4h, 50);
  const binanceShort = ema(state.binanceCandles4h, 20) < ema(state.binanceCandles4h, 50);
  if (okxShort && binanceShort) return 'short';
  if (!okxShort && !binanceShort) return 'long';
  return 'mixed';
}

function score(state: FrozenMarketState): number {
  const okxVol = Math.max(realizedVolatility(state.candles1h, 24) * Math.sqrt(24), 1e-6);
  const binanceVol = Math.max(realizedVolatility(state.binanceCandles1h, 24) * Math.sqrt(24), 1e-6);
  return 0.35 * logReturn(state.candles1h, 24) / okxVol
    + 0.25 * logReturn(state.candles1h, 72) / okxVol
    + 0.25 * logReturn(state.binanceCandles1h, 24) / binanceVol
    + 0.15 * logReturn(state.binanceCandles1h, 72) / binanceVol;
}

/**
 * The continuation bar, mirrored. Short takes a down bar closing below EMA(20)
 * with Binance agreeing; long is the exact reflection. The asymmetry that used
 * to live here was the direction constant, not the geometry.
 */
function continuation(state: FrozenMarketState, direction: 'long' | 'short'): boolean {
  const current = state.candles1h.at(-1)!;
  const previous = state.candles1h.at(-2)!;
  const continuationEma = ema(state.candles1h, FROZEN_CONTINUATION_POLICY.continuationEma);
  const binanceLastReturn = logReturn(state.binanceCandles1h, 1);
  return direction === 'short'
    ? current.close < previous.close && current.close < continuationEma && binanceLastReturn < 0
    : current.close > previous.close && current.close > continuationEma && binanceLastReturn > 0;
}

export function evaluateFrozenContinuation(
  states: readonly FrozenMarketState[],
  nowMs: number,
  cooldowns: ReadonlyMap<string, number> = new Map(),
): FrozenDecision {
  const empty = { scores: new Map<string, number>(), directionalBreadth: 0, trend: 'mixed' as const, regimeFavourable: false };
  const byId = new Map(states.map((state) => [state.instId, state]));
  for (const instId of FROZEN_MAJOR_INST_IDS) {
    const state = byId.get(instId);
    if (state === undefined) return { reason: `missing ${instId}`, ...empty };
    if (state.candles1h.length < 100 || state.candles4h.length < 60 || state.binanceCandles1h.length < 100 || state.binanceCandles4h.length < 60) {
      return { reason: `insufficient confirmed history for ${instId}`, ...empty };
    }
  }

  const scores = new Map(states.map((state) => [state.instId, score(state)]));
  const btcTrend = trendOf(byId.get('BTC-USDT-SWAP')!);
  const allowed = FROZEN_CONTINUATION_POLICY.direction;

  // BTC licenses the direction for the cycle. 'mixed' means the two venues
  // disagree on BTC itself, which is the one case with no defensible side.
  if (btcTrend === 'mixed') {
    return { reason: 'BTC dual-venue 4h trend disagrees across venues', scores, directionalBreadth: 0, trend: 'mixed', regimeFavourable: false };
  }
  if (allowed !== 'both' && allowed !== btcTrend) {
    return { reason: `BTC dual-venue 4h trend is ${btcTrend}, policy trades ${allowed} only`, scores, directionalBreadth: 0, trend: btcTrend, regimeFavourable: false };
  }

  const direction = btcTrend;
  const directionalBreadth = states.filter((state) => trendOf(state) === direction).length;
  if (directionalBreadth < FROZEN_CONTINUATION_POLICY.minDirectionalBreadth) {
    return {
      reason: `${direction} breadth ${directionalBreadth}/6 is below ${FROZEN_CONTINUATION_POLICY.minDirectionalBreadth}/6`,
      scores,
      directionalBreadth,
      trend: direction,
      regimeFavourable: false,
    };
  }

  // Score must be extreme in the traded direction: <= -0.5 to short, >= +0.5 to
  // long. Sorting takes the most extreme candidate either way.
  const floor = FROZEN_CONTINUATION_POLICY.minAbsoluteScore;
  const chosen = states
    .filter((state) => trendOf(state) === direction)
    .filter((state) => continuation(state, direction))
    .filter((state) => {
      const value = scores.get(state.instId) ?? 0;
      return direction === 'short' ? value <= -floor : value >= floor;
    })
    .filter((state) => (cooldowns.get(state.instId) ?? Number.NEGATIVE_INFINITY) <= nowMs)
    .sort((left, right) => {
      const a = scores.get(left.instId) ?? 0;
      const b = scores.get(right.instId) ?? 0;
      return direction === 'short' ? a - b : b - a;
    })[0];
  if (chosen === undefined) {
    return { reason: `no score>=${floor} ${direction} continuation`, scores, directionalBreadth, trend: direction, regimeFavourable: true };
  }

  const current = chosen.candles1h.at(-1)!;
  const atrValue = atr(chosen.candles1h, FROZEN_CONTINUATION_POLICY.stopAtrPeriod);
  const risk = FROZEN_CONTINUATION_POLICY.stopAtrMultiple * atrValue;
  const stopPrice = direction === 'short' ? current.close + risk : current.close - risk;
  const targetPrice = direction === 'short'
    ? current.close - FROZEN_CONTINUATION_POLICY.targetR * risk
    : current.close + FROZEN_CONTINUATION_POLICY.targetR * risk;
  if (stopPrice <= 0 || targetPrice <= 0) {
    return { reason: `${chosen.instId} stop or target is non-positive`, scores, directionalBreadth, trend: direction, regimeFavourable: true };
  }
  const absoluteScore = Math.abs(scores.get(chosen.instId)!);
  return {
    candidate: {
      instId: chosen.instId,
      direction,
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
    reason: `${chosen.instId} ${direction} continuation score ${absoluteScore.toFixed(2)}, breadth ${directionalBreadth}/6`,
    scores,
    directionalBreadth,
    trend: direction,
    regimeFavourable: true,
  };
}
