/** Run the research-only walk-forward signal discovery layer. */

import { loadReplayDataset } from '../backtest/replay.js';
import { discoverSignals } from '../signal/discovery.js';
import type { FundingPolicy } from '../signal/funding-policy.js';

function pct(value: number): string {
  return `${(value * 100).toFixed(2)}%`;
}

function valueAfter(flag: string, fallback: string): string {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] ?? fallback : fallback;
}

async function main(): Promise<void> {
  const path = process.argv.find((arg) => !arg.startsWith('-') && arg.endsWith('.json')) ?? 'var/backtest/majors-540d.json';
  const fundingPolicy = valueAfter('--funding-policy', 'stress') as FundingPolicy;
  if (fundingPolicy !== 'neutral' && fundingPolicy !== 'stress' && fundingPolicy !== 'covered') throw new Error('--funding-policy must be neutral, stress, or covered');
  const holdoutDays = Number(valueAfter('--holdout-days', '180'));
  if (!Number.isInteger(holdoutDays) || holdoutDays <= 0) throw new Error('--holdout-days must be a positive integer');
  const requireBinance = process.argv.includes('--require-binance');
  const result = discoverSignals(loadReplayDataset(path), { fundingPolicy, holdoutDays, requireBinance });

  console.log(`dataset ${path}`);
  console.log(`funding policy ${result.fundingPolicy} · stress rate ${(result.fundingStressRate * 100).toFixed(4)}% per 8h`);
  console.log(`training samples ${result.trainSamples} · untouched holdout samples ${result.holdoutSamples}`);
  console.log(`funding observed ${result.fundingObservedSamples} · complete horizons ${result.fundingCoveredSamples} samples`);
  console.log(`Binance feature coverage ${result.binanceAvailableSamples} samples`);
  console.log(`selected holdout trades ${result.selectedTrades} (${result.wins}W/${result.losses}L, ${pct(result.winRate)} win rate)`);
  console.log(`holdout net return ${pct(result.totalNetReturn)} · average ${pct(result.averageNetReturn)} · payoff ${Number.isFinite(result.payoffRatio) ? result.payoffRatio.toFixed(2) : '∞'}:1 · profit factor ${Number.isFinite(result.profitFactor) ? result.profitFactor.toFixed(2) : '∞'}`);
  console.log(`features ${result.featureNames.join(', ')}`);
  for (const assumption of result.assumptions) console.log(`assumption: ${assumption}`);
}

main().catch((error: unknown) => {
  console.error('DISCOVERY FAILED:', error);
  process.exitCode = 1;
});
