/**
 * Walk-forward policy selection for the competition strategy.
 *
 * Each fold chooses a policy using only its earlier training window, then runs
 * that chosen policy on the following unseen test window. This is deliberately
 * small and explicit: it is a decision aid before listing, not an optimizer
 * that silently edits production config.
 */

import { loadConfig, type Config } from '../config.js';
import { loadReplayDataset, replay, type ReplayResult } from '../backtest/replay.js';

const DAY_MS = 86_400_000;

interface Variant {
  readonly name: string;
  readonly config: Config;
}

function variant(base: Config, name: string, changes: {
  readonly signals?: Partial<Config['signals']>;
  readonly regime?: Partial<Config['regime']>;
  readonly exits?: Partial<Config['exits']>;
}): Variant {
  return {
    name,
    config: {
      ...base,
      signals: { ...base.signals, ...changes.signals },
      regime: { ...base.regime, ...changes.regime },
      exits: { ...base.exits, ...changes.exits },
    },
  };
}

function variants(base: Config): readonly Variant[] {
  return [
    variant(base, 'current', {}),
    variant(base, 'entry-moderate', {
      signals: { minConviction: 70, minInstrumentsPassingRegime: 2 },
      regime: { minAdx: 20, minVolumeTrend: 0.9 },
    }),
    variant(base, 'entry-broad', {
      signals: { minConviction: 65, minInstrumentsPassingRegime: 2 },
      regime: { minAdx: 18, minVolumeTrend: 0.8 },
    }),
    variant(base, 'exit-late', {
      exits: { scaleOutAtR: 3, breakevenAtR: 3, tightenTrailAtR: 5 },
    }),
    variant(base, 'late-moderate', {
      signals: { minConviction: 70, minInstrumentsPassingRegime: 2 },
      regime: { minAdx: 20, minVolumeTrend: 0.9 },
      exits: { scaleOutAtR: 3, breakevenAtR: 3, tightenTrailAtR: 5 },
    }),
    variant(base, 'late-broad', {
      signals: { minConviction: 65, minInstrumentsPassingRegime: 2 },
      regime: { minAdx: 18, minVolumeTrend: 0.8 },
      exits: { scaleOutAtR: 3, breakevenAtR: 3, tightenTrailAtR: 5 },
    }),
  ];
}

function run(config: Config, dataset: ReturnType<typeof loadReplayDataset>, fromMs: number, toMs: number): ReplayResult {
  return replay({
    config,
    dataset,
    fromMs,
    toMs,
    tradingFeeRateFraction: 2 / 10_000,
    slippageBps: 0,
  });
}

function payoff(result: ReplayResult): string {
  return Number.isFinite(result.realisedPayoffRatio) ? result.realisedPayoffRatio.toFixed(2) : '∞';
}

function line(name: string, result: ReplayResult): string {
  return `${name.padEnd(18)} ${String(result.closedTrades).padStart(3)} trades ` +
    `${result.tradesPerDay.toFixed(2)}/d ` +
    `${payoff(result).padStart(5)}:1 payoff ` +
    `${(result.returnFraction * 100).toFixed(2).padStart(7)}% return ` +
    `${(result.maxDrawdownFraction * 100).toFixed(2).padStart(6)}% DD`;
}

async function main(): Promise<void> {
  const path = process.argv.find((arg) => !arg.startsWith('-') && arg.endsWith('.json')) ?? 'var/backtest/okx-90d.json';
  const dataset = loadReplayDataset(path);
  const base = loadConfig('config/default.yaml');
  const allVariants = variants(base);
  const start = dataset.replayFromMs;
  const end = dataset.replayToMs;
  if (start === undefined || end === undefined) throw new Error('dataset needs replay from/to bounds');

  console.log('FULL RANGE — descriptive only; not used for selection');
  for (const candidate of allVariants) console.log(line(candidate.name, run(candidate.config, dataset, start, end)));

  const trainDays = 45;
  const testDays = 15;
  const folds: Array<{ trainFrom: number; trainTo: number; testFrom: number; testTo: number }> = [];
  for (let testFrom = start + trainDays * DAY_MS; testFrom + testDays * DAY_MS <= end; testFrom += testDays * DAY_MS) {
    folds.push({
      trainFrom: start,
      trainTo: testFrom,
      testFrom,
      testTo: testFrom + testDays * DAY_MS,
    });
  }

  console.log(`\nWALK-FORWARD — ${trainDays}d expanding train / ${testDays}d unseen test`);
  let testNet = 0;
  let testTrades = 0;
  const fixedForward = new Map<string, { net: number; trades: number; dd: number }>();
  for (const [index, fold] of folds.entries()) {
    const trained = allVariants.map((candidate) => ({
      candidate,
      result: run(candidate.config, dataset, fold.trainFrom, fold.trainTo),
    }));
    for (const candidate of allVariants) {
      const tested = run(candidate.config, dataset, fold.testFrom, fold.testTo);
      const previous = fixedForward.get(candidate.name) ?? { net: 0, trades: 0, dd: 0 };
      fixedForward.set(candidate.name, {
        net: previous.net + tested.netPnlUsdt,
        trades: previous.trades + tested.closedTrades,
        dd: Math.max(previous.dd, tested.maxDrawdownFraction),
      });
    }
    const eligible = trained.filter(({ result }) => result.closedTrades >= 3);
    const ranked = [...(eligible.length > 0 ? eligible : trained)].sort(
      (a, b) => b.result.netPnlUsdt - a.result.netPnlUsdt,
    );
    const selected = ranked[0];
    if (selected === undefined) throw new Error('no walk-forward candidates');
    const tested = run(selected.candidate.config, dataset, fold.testFrom, fold.testTo);
    testNet += tested.netPnlUsdt;
    testTrades += tested.closedTrades;
    console.log(
      `fold ${index + 1}: train ${new Date(fold.trainFrom).toISOString().slice(0, 10)}→${new Date(fold.trainTo).toISOString().slice(0, 10)} ` +
        `selected ${selected.candidate.name} (${selected.result.closedTrades} train trades, ${selected.result.netPnlUsdt.toFixed(2)} USDT) ` +
        `| TEST ${tested.closedTrades} trades, ${tested.netPnlUsdt.toFixed(2)} USDT, ${payoff(tested)}:1`,
    );
  }
  console.log(`\nUNSEEN TEST TOTAL: ${testTrades} trades, ${testNet.toFixed(2)} USDT`);
  console.log('\nFIXED POLICY TOTALS ACROSS THE SAME UNSEEN WINDOWS');
  for (const candidate of allVariants) {
    const result = fixedForward.get(candidate.name);
    if (result === undefined) continue;
    console.log(`${candidate.name.padEnd(18)} ${String(result.trades).padStart(3)} trades ${result.net.toFixed(2).padStart(8)} USDT ${(
      result.dd * 100
    ).toFixed(2).padStart(6)}% worst fold DD`);
  }
  console.log('No variant is promoted automatically; production config changes require reviewing these unseen results.');
}

main().catch((error: unknown) => {
  console.error('WALK-FORWARD FAILED:', error);
  process.exitCode = 1;
});
