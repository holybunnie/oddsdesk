import type { FundingPoint } from '../market/okx.js';
import type { ReplayDataset } from '../backtest/replay.js';

export type FundingPolicy = 'neutral' | 'stress' | 'covered';

const DEFAULT_STRESS_RATE = 0.0002;

export function fundingIsCovered(points: readonly FundingPoint[] | undefined, fromMs: number, toMs: number): boolean {
  const first = points?.at(0)?.timestampMs;
  const last = points?.at(-1)?.timestampMs;
  return first !== undefined && last !== undefined && first <= fromMs && last >= toMs;
}

export function adverseFundingRate(direction: 'long' | 'short', fundingRate: number): number {
  return Math.max(direction === 'long' ? fundingRate : -fundingRate, 0);
}

export function observedFundingCostReturn(
  points: readonly FundingPoint[] | undefined,
  direction: 'long' | 'short',
  fromMs: number,
  toMs: number,
): number {
  return (points ?? [])
    .filter((point) => point.timestampMs > fromMs && point.timestampMs <= toMs)
    .reduce((sum, point) => sum + adverseFundingRate(direction, point.fundingRate), 0);
}

export function stressFundingRate(dataset: ReplayDataset): number {
  const rates = dataset.instruments
    .flatMap((instrument) => (instrument.funding ?? []).map((point) => Math.abs(point.fundingRate)))
    .filter((rate) => Number.isFinite(rate))
    .sort((a, b) => a - b);
  if (rates.length === 0) return DEFAULT_STRESS_RATE;
  const index = Math.min(rates.length - 1, Math.floor(rates.length * 0.95));
  return Math.max(rates[index]!, DEFAULT_STRESS_RATE);
}

export function policyFundingCostReturn(
  policy: FundingPolicy,
  direction: 'long' | 'short',
  points: readonly FundingPoint[] | undefined,
  fromMs: number,
  toMs: number,
  stressRate: number,
): number {
  if (policy === 'neutral') return 0;
  if (policy === 'covered' && !fundingIsCovered(points, fromMs, toMs)) return Number.POSITIVE_INFINITY;
  if (fundingIsCovered(points, fromMs, toMs)) return observedFundingCostReturn(points, direction, fromMs, toMs);
  return stressRate * Math.max(1, Math.ceil((toMs - fromMs) / (8 * 3_600_000)));
}
