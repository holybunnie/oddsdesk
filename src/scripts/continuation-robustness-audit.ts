/** Robustness audit for the frozen score>=0.5 short-continuation candidate. */

import { loadReplayDataset, type ReplayDataset } from '../backtest/replay.js';
import { testRelativePullback, type RelativePullbackOptions, type RelativePullbackTrade } from '../signal/relative-pullback.js';

const DAY_MS = 86_400_000;
const FROZEN_POLICY: RelativePullbackOptions = {
  holdoutDays: 90,
  fundingPolicy: 'stress',
  stopAtrMultiple: 2,
  maxHoldHours: 168,
  targetR: 3,
  direction: 'short-only',
  entryMode: 'continuation',
  minDirectionalBreadth: 3,
  requireBtcAlignment: true,
  minTrendGapFraction: 0,
  minAbsoluteScore: 0.5,
};

function metrics(trades: readonly RelativePullbackTrade[]): { readonly n: number; readonly net: number; readonly payoff: number; readonly pf: number } {
  const winners = trades.filter((trade) => trade.realisedNetR > 0);
  const losers = trades.filter((trade) => trade.realisedNetR < 0);
  const positive = winners.reduce((sum, trade) => sum + trade.realisedNetR, 0);
  const negative = Math.abs(losers.reduce((sum, trade) => sum + trade.realisedNetR, 0));
  return {
    n: trades.length,
    net: positive - negative,
    payoff: winners.length === 0 ? 0 : negative === 0 ? Number.POSITIVE_INFINITY : (positive / winners.length) / (negative / losers.length),
    pf: negative === 0 ? (positive > 0 ? Number.POSITIVE_INFINITY : 0) : positive / negative,
  };
}

function ratio(value: number): string {
  return Number.isFinite(value) ? value.toFixed(2) : '∞';
}

function line(name: string, value: ReturnType<typeof metrics>): string {
  return `${name.padEnd(24)} ${String(value.n).padStart(4)} trades  ${value.net.toFixed(1).padStart(7)}R  payoff ${ratio(value.payoff).padStart(5)}  PF ${ratio(value.pf).padStart(5)}`;
}

function bounded(dataset: ReplayDataset, toMs: number): ReplayDataset {
  return { ...dataset, replayToMs: toMs };
}

async function main(): Promise<void> {
  const path = process.argv.find((arg) => !arg.startsWith('-') && arg.endsWith('.json')) ?? 'var/backtest/majors-540d-exact.json';
  const dataset = loadReplayDataset(path);
  const start = dataset.replayFromMs;
  const end = dataset.replayToMs;
  if (start === undefined || end === undefined) throw new Error('dataset needs replay bounds');
  console.log(`dataset ${path}`);
  console.log('frozen policy: short-only continuation, score>=0.5, BTC aligned, breadth>=3, stop=2ATR, target=3R, max hold=168h');
  console.log('NON-OVERLAPPING 90-DAY CHRONOLOGICAL AUDITS');
  const pooled: RelativePullbackTrade[] = [];
  for (let fold = 2; fold <= 6; fold += 1) {
    const toMs = Math.min(start + fold * 90 * DAY_MS, end);
    const result = testRelativePullback(bounded(dataset, toMs), FROZEN_POLICY);
    pooled.push(...result.holdoutTradesList);
    console.log(line(`fold ${fold - 1}`, metrics(result.holdoutTradesList)));
  }
  console.log(line('pooled unseen folds', metrics(pooled)));

  if (process.argv.includes('--leave-one-out')) {
    console.log('LEAVE-ONE-INSTRUMENT-OUT, LATEST 180 DAYS');
    for (const omitted of dataset.instruments.map((instrument) => instrument.instId)) {
      const reduced = { ...dataset, instruments: dataset.instruments.filter((instrument) => instrument.instId !== omitted) };
      const result = testRelativePullback(reduced, { ...FROZEN_POLICY, holdoutDays: 180 });
      console.log(line(`without ${omitted.split('-')[0]}`, metrics(result.holdoutTradesList)));
    }
  }
}

main().catch((error: unknown) => {
  console.error('CONTINUATION ROBUSTNESS AUDIT FAILED:', error);
  process.exitCode = 1;
});
