/**
 * Compare declared research candidates using an inner holdout, then report
 * the final untouched holdout. This script never changes production config.
 */

import { loadReplayDataset, type ReplayDataset } from '../backtest/replay.js';
import { discoverSignals } from '../signal/discovery.js';
import { discoverBarrierSignals } from '../signal/barrier-discovery.js';

const DAY_MS = 86_400_000;
const FINAL_HOLDOUT_DAYS = 180;
const INNER_HOLDOUT_DAYS = 180;
const MIN_FINAL_TRADES = 30;
const MIN_FINAL_PAYOFF = 2.5;

interface CandidateReport {
  readonly name: string;
  readonly innerTrades: number;
  readonly innerNet: number;
  readonly finalTrades: number;
  readonly finalNet: number;
  readonly finalPayoff: number;
  readonly finalWinRate: number;
  readonly pass: boolean;
}

function pct(value: number): string {
  return `${(value * 100).toFixed(2)}%`;
}

function payoff(value: number): string {
  return Number.isFinite(value) ? value.toFixed(2) : '∞';
}

function boundedDataset(dataset: ReplayDataset, toMs: number): ReplayDataset {
  return { ...dataset, replayToMs: toMs };
}

function report(
  name: string,
  innerTrades: number,
  innerNet: number,
  finalTrades: number,
  finalNet: number,
  finalPayoff: number,
  finalWinRate: number,
): CandidateReport {
  return {
    name,
    innerTrades,
    innerNet,
    finalTrades,
    finalNet,
    finalPayoff,
    finalWinRate,
    pass: innerNet > 0 && finalNet > 0 && finalTrades >= MIN_FINAL_TRADES && finalPayoff >= MIN_FINAL_PAYOFF,
  };
}

async function main(): Promise<void> {
  const path = process.argv.find((arg) => !arg.startsWith('-') && arg.endsWith('.json')) ?? 'var/backtest/majors-540d.json';
  const dataset = loadReplayDataset(path);
  const requireBinance = process.argv.includes('--require-binance');
  const end = dataset.replayToMs;
  if (end === undefined) throw new Error('dataset needs replayToMs');
  const finalHoldoutStart = end - FINAL_HOLDOUT_DAYS * DAY_MS;
  const innerDataset = boundedDataset(dataset, finalHoldoutStart);
  const reports: CandidateReport[] = [];

  const returnInner = discoverSignals(innerDataset, { holdoutDays: INNER_HOLDOUT_DAYS, requireBinance });
  const returnFinal = discoverSignals(dataset, { holdoutDays: FINAL_HOLDOUT_DAYS, requireBinance });
  reports.push(report('return-ridge', returnInner.selectedTrades, returnInner.totalNetReturn, returnFinal.selectedTrades, returnFinal.totalNetReturn, returnFinal.payoffRatio, returnFinal.winRate));

  const barrierInner = discoverBarrierSignals(innerDataset, { holdoutDays: INNER_HOLDOUT_DAYS, requireBinance });
  const barrierFinal = discoverBarrierSignals(dataset, { holdoutDays: FINAL_HOLDOUT_DAYS, requireBinance });
  reports.push(report('barrier-expanding', barrierInner.selectedTrades, barrierInner.totalNetR, barrierFinal.selectedTrades, barrierFinal.totalNetR, barrierFinal.payoffRatio, barrierFinal.winRate));

  const rollingInner = discoverBarrierSignals(innerDataset, { holdoutDays: INNER_HOLDOUT_DAYS, trainingWindowDays: 180, requireBinance });
  const rollingFinal = discoverBarrierSignals(dataset, { holdoutDays: FINAL_HOLDOUT_DAYS, trainingWindowDays: 180, requireBinance });
  reports.push(report('barrier-rolling-180d', rollingInner.selectedTrades, rollingInner.totalNetR, rollingFinal.selectedTrades, rollingFinal.totalNetR, rollingFinal.payoffRatio, rollingFinal.winRate));

  console.log(`dataset ${path}`);
  console.log(`inner holdout ${INNER_HOLDOUT_DAYS}d ending ${new Date(finalHoldoutStart).toISOString()}`);
  console.log(`final holdout ${FINAL_HOLDOUT_DAYS}d ending ${new Date(end).toISOString()}`);
  console.log('candidate                         inner net   final trades   final net   final payoff   final win rate   gate');
  for (const candidate of reports) {
    console.log(`${candidate.name.padEnd(33)} ${candidate.innerNet.toFixed(2).padStart(9)}  ${String(candidate.finalTrades).padStart(12)}  ${candidate.finalNet.toFixed(2).padStart(9)}  ${payoff(candidate.finalPayoff).padStart(12)}  ${pct(candidate.finalWinRate).padStart(15)}   ${candidate.pass ? 'PASS' : 'REJECT'}`);
  }
  console.log(`gate requires positive inner and final net, at least ${MIN_FINAL_TRADES} final trades, and final payoff >= ${MIN_FINAL_PAYOFF.toFixed(1)}:1`);
  console.log('No candidate is promoted automatically. A passing research candidate still requires the full execution replay and explicit review.');
}

main().catch((error: unknown) => {
  console.error('MODEL TOURNAMENT FAILED:', error);
  process.exitCode = 1;
});
