/**
 * Predeclared audit of one hypothesis only:
 * the frozen continuation architecture, applied LONG-ONLY or BIDIRECTIONALLY,
 * clears the same promotion gate the short-only policy was frozen under.
 *
 * Motivation is structural, not performance-chasing. The live policy is
 * short-only and its hard gate (BTC dual-venue 4h short + breadth >= 3/6) was
 * measured shut for as long as 47.8 continuous days on this dataset — more
 * than three times a 14-day competition window. A policy that cannot trade in
 * half of all regimes carries a real risk of zero trades, which scores zero.
 *
 * No threshold search happens here. Entry mode, stop, target, timeout, BTC
 * alignment, breadth floor, score floor, costs and funding policy are all held
 * at the frozen values. `direction` is the ONLY parameter that varies, and the
 * three arms are declared before the run. The gate below is copied unchanged
 * from `continuation-breadth-audit.ts` so the bar is identical.
 */

import { loadReplayDataset, type ReplayDataset } from '../backtest/replay.js';
import {
  testRelativePullback,
  type RelativePullbackOptions,
  type RelativePullbackTrade,
} from '../signal/relative-pullback.js';

const DAY_MS = 86_400_000;
const FOLD_DAYS = 90;
const REQUIRED_POSITIVE_FOLDS = 4;
const MIN_POOLED_TRADES = 100;
const MIN_POOLED_PROFIT_FACTOR = 1.2;
const MAX_CONTRIBUTION_FRACTION = 0.3;

/** The frozen policy, minus the direction. Nothing here may be tuned. */
const FROZEN: RelativePullbackOptions = {
  holdoutDays: FOLD_DAYS,
  fundingPolicy: 'stress',
  stopAtrMultiple: 2,
  maxHoldHours: 168,
  targetR: 3,
  entryMode: 'continuation',
  minDirectionalBreadth: 3,
  requireBtcAlignment: true,
  minTrendGapFraction: 0,
  minAbsoluteScore: 0.5,
};

const ARMS = [
  { name: 'short-only', direction: 'short-only' as const, incumbent: true },
  { name: 'long-only', direction: 'long-only' as const, incumbent: false },
  { name: 'both', direction: 'both' as const, incumbent: false },
];

interface Metrics {
  readonly n: number;
  readonly net: number;
  readonly winRate: number;
  readonly profitFactor: number;
}

function metrics(trades: readonly RelativePullbackTrade[]): Metrics {
  const wins = trades.filter((trade) => trade.realisedNetR > 0);
  const grossWin = wins.reduce((sum, trade) => sum + trade.realisedNetR, 0);
  const grossLoss = Math.abs(
    trades.filter((trade) => trade.realisedNetR < 0).reduce((sum, trade) => sum + trade.realisedNetR, 0),
  );
  return {
    n: trades.length,
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
  return (
    `${label.padEnd(22)} ${String(result.n).padStart(4)}  ` +
    `${(100 * result.winRate).toFixed(1).padStart(5)}%  ` +
    `${result.net.toFixed(1).padStart(7)}R  ${display(result.profitFactor).padStart(5)}`
  );
}

function concentrationPass(
  trades: readonly RelativePullbackTrade[],
  keyOf: (trade: RelativePullbackTrade) => string,
): boolean {
  const totalPositive = trades
    .filter((trade) => trade.realisedNetR > 0)
    .reduce((sum, trade) => sum + trade.realisedNetR, 0);
  if (totalPositive <= 0) return false;
  const byKey = new Map<string, number>();
  for (const trade of trades) {
    if (trade.realisedNetR <= 0) continue;
    const key = keyOf(trade);
    byKey.set(key, (byKey.get(key) ?? 0) + trade.realisedNetR);
  }
  return Math.max(0, ...byKey.values()) / totalPositive <= MAX_CONTRIBUTION_FRACTION;
}

function main(): void {
  const path =
    process.argv.find((arg) => !arg.startsWith('-') && arg.endsWith('.json')) ??
    'var/backtest/majors-540d-exact.json';
  const dataset = loadReplayDataset(path);
  const start = dataset.replayFromMs;
  const end = dataset.replayToMs;
  if (start === undefined || end === undefined) throw new Error('dataset needs replay bounds');

  console.log(`dataset ${path}`);
  console.log('predeclared: direction is the ONLY parameter that varies; three arms fixed in advance');
  console.log('gate: >=4/5 positive folds, >=100 pooled trades, PF >=1.20, <=30% concentration\n');
  console.log('arm/fold                  N    win%     netR     PF');

  const pooled = new Map<string, RelativePullbackTrade[]>();
  const positiveFolds = new Map<string, number>();
  const tradeFold = new Map<RelativePullbackTrade, string>();
  for (const arm of ARMS) {
    pooled.set(arm.name, []);
    positiveFolds.set(arm.name, 0);
  }

  for (let fold = 2; fold <= 6; fold += 1) {
    const toMs = Math.min(start + fold * FOLD_DAYS * DAY_MS, end);
    const foldName = `fold-${fold - 1}`;
    for (const arm of ARMS) {
      const trades = testRelativePullback(bounded(dataset, toMs), {
        ...FROZEN,
        direction: arm.direction,
      }).holdoutTradesList;
      const result = metrics(trades);
      if (result.net > 0) positiveFolds.set(arm.name, (positiveFolds.get(arm.name) ?? 0) + 1);
      pooled.get(arm.name)!.push(...trades);
      for (const trade of trades) tradeFold.set(trade, foldName);
      console.log(line(`${foldName} ${arm.name}`, result));
    }
  }

  console.log('\nPOOLED, AND THE PROMOTION GATE');
  for (const arm of ARMS) {
    const trades = pooled.get(arm.name)!;
    const result = metrics(trades);
    const folds = positiveFolds.get(arm.name) ?? 0;
    const byInstrument = concentrationPass(trades, (trade) => trade.instId);
    const byFold = concentrationPass(trades, (trade) => tradeFold.get(trade) ?? 'unknown');
    const passes =
      folds >= REQUIRED_POSITIVE_FOLDS &&
      result.n >= MIN_POOLED_TRADES &&
      result.profitFactor >= MIN_POOLED_PROFIT_FACTOR &&
      byInstrument &&
      byFold;

    console.log(`\n${arm.name}${arm.incumbent ? '  (incumbent — shown for reference, not gated)' : ''}`);
    console.log(line('  pooled', result));
    console.log(`  positive-net folds: ${folds}/5 (need ${REQUIRED_POSITIVE_FOLDS})`);
    console.log(`  pooled trades: ${result.n} (need ${MIN_POOLED_TRADES})`);
    console.log(`  pooled PF: ${display(result.profitFactor)} (need ${MIN_POOLED_PROFIT_FACTOR})`);
    console.log(`  instrument contribution <=30% of gross wins: ${byInstrument ? 'PASS' : 'FAIL'}`);
    console.log(`  fold contribution <=30% of gross wins: ${byFold ? 'PASS' : 'FAIL'}`);
    if (!arm.incumbent) console.log(`  decision: ${passes ? 'PROMOTE' : 'REJECT'}`);
  }
}

main();
