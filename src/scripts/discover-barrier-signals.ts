/** Run the research-only 3R/1R barrier discovery layer. */

import { loadReplayDataset } from '../backtest/replay.js';
import { discoverBarrierSignals } from '../signal/barrier-discovery.js';
import type { FundingPolicy } from '../signal/funding-policy.js';

function pct(value: number): string {
  return `${(value * 100).toFixed(2)}%`;
}

function numberAfter(flag: string): number | undefined {
  const index = process.argv.indexOf(flag);
  const raw = index >= 0 ? process.argv[index + 1] : undefined;
  return raw === undefined ? undefined : Number(raw);
}

function valueAfter(flag: string, fallback: string): string {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] ?? fallback : fallback;
}

async function main(): Promise<void> {
  const path = process.argv.find((arg) => !arg.startsWith('-') && arg.endsWith('.json')) ?? 'var/backtest/majors-540d.json';
  const trainingWindowDays = numberAfter('--train-window-days');
  if (trainingWindowDays !== undefined && (!Number.isInteger(trainingWindowDays) || trainingWindowDays <= 0)) throw new Error('--train-window-days must be a positive integer');
  const fundingPolicy = valueAfter('--funding-policy', 'stress') as FundingPolicy;
  if (fundingPolicy !== 'neutral' && fundingPolicy !== 'stress' && fundingPolicy !== 'covered') throw new Error('--funding-policy must be neutral, stress, or covered');
  const holdoutDays = Number(valueAfter('--holdout-days', '180'));
  if (!Number.isInteger(holdoutDays) || holdoutDays <= 0) throw new Error('--holdout-days must be a positive integer');
  const requireBinance = process.argv.includes('--require-binance');
  const result = discoverBarrierSignals(loadReplayDataset(path), {
    ...(trainingWindowDays === undefined ? {} : { trainingWindowDays }),
    fundingPolicy,
    holdoutDays,
    requireBinance,
  });

  console.log(`dataset ${path}`);
  console.log(`training window ${trainingWindowDays === undefined ? 'expanding' : `${trainingWindowDays}d rolling`}`);
  console.log(`funding policy ${result.fundingPolicy} · stress rate ${(result.fundingStressRate * 100).toFixed(4)}% per 8h`);
  console.log(`training samples ${result.trainSamples} · untouched holdout samples ${result.holdoutSamples}`);
  console.log(`funding observed ${result.fundingObservedSamples} · full horizon covered ${result.fundingCoveredSamples} samples`);
  console.log(`Binance feature mode ${requireBinance ? 'required' : 'optional'}`);
  console.log(`target-hit base rate train long ${pct(result.trainLongTargetRate)} / short ${pct(result.trainShortTargetRate)} · holdout long ${pct(result.holdoutLongTargetRate)} / short ${pct(result.holdoutShortTargetRate)}`);
  for (const bin of result.holdoutScoreBins) {
    console.log(`score ${bin.lowerProbability.toFixed(1)}–${bin.upperProbability.toFixed(1)}: ${bin.count} samples, ${pct(bin.targetRate)} target rate`);
  }
  console.log(`selected holdout trades ${result.selectedTrades} (${result.wins}W/${result.losses}L, ${pct(result.winRate)} win rate)`);
  console.log(`exits target ${result.targetHits} · stop ${result.stopHits} · time ${result.timeStops}`);
  console.log(`holdout net ${result.totalNetR.toFixed(2)}R · average ${result.averageNetR.toFixed(3)}R · payoff ${Number.isFinite(result.payoffRatio) ? result.payoffRatio.toFixed(2) : '∞'}:1 · profit factor ${Number.isFinite(result.profitFactor) ? result.profitFactor.toFixed(2) : '∞'}`);
  console.log(`features ${result.featureNames.join(', ')}`);
  for (const assumption of result.assumptions) console.log(`assumption: ${assumption}`);
}

main().catch((error: unknown) => {
  console.error('BARRIER DISCOVERY FAILED:', error);
  process.exitCode = 1;
});
