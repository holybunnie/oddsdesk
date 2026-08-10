/**
 * Predeclared audit of one hypothesis only:
 * short continuation works when dual-venue bearish breadth is greater than it
 * was eight hours (two four-hour decisions) earlier.
 *
 * No threshold search happens here. The frozen entry, stop, target, timeout,
 * BTC alignment, score floor, costs, and funding policy remain unchanged.
 */

import { loadReplayDataset, type ReplayDataset } from '../backtest/replay.js';
import {
  classifyBreadthChange,
  testRelativePullback,
  type BreadthChange,
  type RelativePullbackOptions,
  type RelativePullbackTrade,
} from '../signal/relative-pullback.js';

const DAY_MS = 86_400_000;
const FOLD_DAYS = 90;
const REQUIRED_POSITIVE_FOLDS = 4;
const MIN_POOLED_TRADES = 100;
const MIN_POOLED_PROFIT_FACTOR = 1.2;
const MAX_CONTRIBUTION_FRACTION = 0.3;

const FROZEN: RelativePullbackOptions = {
  holdoutDays: FOLD_DAYS,
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

interface Metrics {
  readonly n: number;
  readonly wins: number;
  readonly net: number;
  readonly winRate: number;
  readonly profitFactor: number;
}

function metrics(trades: readonly RelativePullbackTrade[]): Metrics {
  const wins = trades.filter((trade) => trade.realisedNetR > 0);
  const grossWin = wins.reduce((sum, trade) => sum + trade.realisedNetR, 0);
  const grossLoss = Math.abs(trades.filter((trade) => trade.realisedNetR < 0).reduce((sum, trade) => sum + trade.realisedNetR, 0));
  return {
    n: trades.length,
    wins: wins.length,
    net: grossWin - grossLoss,
    winRate: trades.length === 0 ? 0 : wins.length / trades.length,
    profitFactor: grossLoss === 0 ? (grossWin > 0 ? Number.POSITIVE_INFINITY : 0) : grossWin / grossLoss,
  };
}

function bounded(dataset: ReplayDataset, toMs: number): ReplayDataset {
  return { ...dataset, replayToMs: toMs };
}

function display(value: number): string {
  return Number.isFinite(value) ? value.toFixed(2) : 'inf';
}

function line(label: string, result: Metrics): string {
  return `${label.padEnd(20)} ${String(result.n).padStart(4)}  ${(100 * result.winRate).toFixed(1).padStart(5)}%  ${result.net.toFixed(1).padStart(7)}R  ${display(result.profitFactor).padStart(5)}`;
}

function concentrationPass(trades: readonly RelativePullbackTrade[], keyOf: (trade: RelativePullbackTrade) => string): boolean {
  const totalPositive = trades.filter((trade) => trade.realisedNetR > 0).reduce((sum, trade) => sum + trade.realisedNetR, 0);
  if (totalPositive <= 0) return false;
  const byKey = new Map<string, number>();
  for (const trade of trades) {
    if (trade.realisedNetR <= 0) continue;
    const key = keyOf(trade);
    byKey.set(key, (byKey.get(key) ?? 0) + trade.realisedNetR);
  }
  return Math.max(0, ...byKey.values()) / totalPositive <= MAX_CONTRIBUTION_FRACTION;
}

async function main(): Promise<void> {
  const path = process.argv.find((arg) => !arg.startsWith('-') && arg.endsWith('.json')) ?? 'var/backtest/majors-540d-exact.json';
  const dataset = loadReplayDataset(path);
  const start = dataset.replayFromMs;
  const end = dataset.replayToMs;
  if (start === undefined || end === undefined) throw new Error('dataset needs replay bounds');

  console.log(`dataset ${path}`);
  console.log('predeclared: expanding means current directional breadth > breadth exactly 8h earlier');
  console.log('bucket/fold              N    win%     netR     PF');

  const pooledBaseline: RelativePullbackTrade[] = [];
  const pooledGated: RelativePullbackTrade[] = [];
  let improvedFolds = 0;
  let positiveGatedFolds = 0;
  const tradeFold = new Map<RelativePullbackTrade, string>();

  for (let fold = 2; fold <= 6; fold += 1) {
    const toMs = Math.min(start + fold * FOLD_DAYS * DAY_MS, end);
    const foldName = `fold-${fold - 1}`;
    const baseline = testRelativePullback(bounded(dataset, toMs), FROZEN).holdoutTradesList;
    const gated = testRelativePullback(bounded(dataset, toMs), {
      ...FROZEN,
      requireExpandingDirectionalBreadth8h: true,
    }).holdoutTradesList;
    const baseMetrics = metrics(baseline);
    const gatedMetrics = metrics(gated);
    if (gatedMetrics.winRate > baseMetrics.winRate) improvedFolds += 1;
    if (gatedMetrics.net > 0) positiveGatedFolds += 1;
    pooledBaseline.push(...baseline);
    pooledGated.push(...gated);
    for (const trade of gated) tradeFold.set(trade, foldName);
    console.log(line(`${foldName} baseline`, baseMetrics));
    console.log(line(`${foldName} expanding`, gatedMetrics));
  }

  console.log('BASELINE ENTRY BUCKETS, POOLED');
  for (const bucket of ['expanding', 'flat', 'contracting'] as const satisfies readonly BreadthChange[]) {
    console.log(line(bucket, metrics(pooledBaseline.filter((trade) => classifyBreadthChange(trade.directionalBreadth, trade.priorDirectionalBreadth8h) === bucket))));
  }

  const pooled = metrics(pooledGated);
  const instrumentPass = concentrationPass(pooledGated, (trade) => trade.instId);
  const foldPass = concentrationPass(pooledGated, (trade) => tradeFold.get(trade) ?? 'unknown');
  const pass = improvedFolds >= REQUIRED_POSITIVE_FOLDS
    && positiveGatedFolds >= REQUIRED_POSITIVE_FOLDS
    && pooled.n >= MIN_POOLED_TRADES
    && pooled.profitFactor >= MIN_POOLED_PROFIT_FACTOR
    && instrumentPass
    && foldPass;

  console.log('PROMOTION GATE');
  console.log(line('expanding pooled', pooled));
  console.log(`hit-rate improved folds: ${improvedFolds}/5 (need ${REQUIRED_POSITIVE_FOLDS})`);
  console.log(`positive-net folds: ${positiveGatedFolds}/5 (need ${REQUIRED_POSITIVE_FOLDS})`);
  console.log(`pooled trades: ${pooled.n} (need ${MIN_POOLED_TRADES})`);
  console.log(`pooled PF: ${display(pooled.profitFactor)} (need ${MIN_POOLED_PROFIT_FACTOR.toFixed(2)})`);
  console.log(`instrument contribution <=30% of gross wins: ${instrumentPass ? 'PASS' : 'FAIL'}`);
  console.log(`fold contribution <=30% of gross wins: ${foldPass ? 'PASS' : 'FAIL'}`);
  console.log(`decision: ${pass ? 'PROMOTE' : 'REJECT'}`);
}

main().catch((error: unknown) => {
  console.error('CONTINUATION BREADTH AUDIT FAILED:', error);
  process.exitCode = 1;
});
