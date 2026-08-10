/** Evaluate the fixed six-major relative-strength pullback candidate. */

import { loadReplayDataset } from '../backtest/replay.js';
import { testRelativePullback } from '../signal/relative-pullback.js';
import type { FundingPolicy } from '../signal/funding-policy.js';

function valueAfter(flag: string, fallback: string): string {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] ?? fallback : fallback;
}

function pct(value: number): string {
  return `${(value * 100).toFixed(2)}%`;
}

function ratio(value: number): string {
  return Number.isFinite(value) ? value.toFixed(2) : '∞';
}

async function main(): Promise<void> {
  const path = process.argv.find((arg) => !arg.startsWith('-') && arg.endsWith('.json')) ?? 'var/backtest/majors-540d-exact.json';
  const fundingPolicy = valueAfter('--funding-policy', 'stress') as FundingPolicy;
  if (fundingPolicy !== 'neutral' && fundingPolicy !== 'stress' && fundingPolicy !== 'covered') throw new Error('--funding-policy must be neutral, stress, or covered');
  const holdoutDays = Number(valueAfter('--holdout-days', '180'));
  if (!Number.isInteger(holdoutDays) || holdoutDays <= 0) throw new Error('--holdout-days must be a positive integer');
  const result = testRelativePullback(loadReplayDataset(path), { fundingPolicy, holdoutDays });

  console.log(`dataset ${path}`);
  console.log(`fixed relative-pullback candidate · funding ${result.fundingPolicy} · stress ${(result.fundingStressRate * 100).toFixed(4)}% per 8h`);
  console.log(`signal states ${result.totalSignalStates} · Binance complete ${result.signalStatesWithBinance} · funding observed ${result.fundingObservedStates} · 72h covered ${result.fundingCoveredStates}`);
  console.log(`pre-holdout ${result.preHoldoutTrades} trades · ${result.preHoldoutNetR.toFixed(2)}R · payoff ${ratio(result.preHoldoutPayoff)}:1 · profit factor ${ratio(result.preHoldoutProfitFactor)}`);
  console.log(`untouched holdout ${result.holdoutTrades} trades (${result.holdoutTradesPerDay.toFixed(2)}/day) · ${result.holdoutWins}W/${result.holdoutLosses}L · win ${pct(result.holdoutWinRate)}`);
  console.log(`holdout exits target ${result.holdoutTargetHits} · stop ${result.holdoutStopHits} · time ${result.holdoutTimeStops}`);
  console.log(`holdout net ${result.holdoutNetR.toFixed(2)}R · average ${result.holdoutAverageNetR.toFixed(3)}R · payoff ${ratio(result.holdoutPayoff)}:1 · profit factor ${ratio(result.holdoutProfitFactor)}`);
  for (const assumption of result.assumptions) console.log(`assumption: ${assumption}`);
}

main().catch((error: unknown) => {
  console.error('RELATIVE PULLBACK FAILED:', error);
  process.exitCode = 1;
});
