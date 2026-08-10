/**
 * Bounded geometry tournament for the fixed relative-strength pullback signal.
 *
 * The signal and target remain fixed. Only the three architecture questions
 * declared before evaluation vary: stop width, maximum holding horizon, and
 * whether shorts are admitted. The final 180 days are never used to rank a
 * candidate; they are an audit of candidates that first pass the earlier data.
 */

import { loadReplayDataset } from '../backtest/replay.js';
import { testRelativePullback } from '../signal/relative-pullback.js';

const HOLDOUT_DAYS = 180;
const MIN_TRADES_PER_PERIOD = 30;
const MIN_PAYOFF = 2.5;
const MIN_PROFIT_FACTOR = 1.05;

interface Variant {
  readonly name: string;
  readonly stopAtrMultiple: number;
  readonly maxHoldHours: number;
  readonly direction: 'both' | 'long-only';
}

const variants: readonly Variant[] = [1.5, 2, 2.5].flatMap((stopAtrMultiple) =>
  [72, 168].flatMap((maxHoldHours) =>
    (['both', 'long-only'] as const).map((direction) => ({
      name: `stop${stopAtrMultiple}-hold${maxHoldHours}-${direction}`,
      stopAtrMultiple,
      maxHoldHours,
      direction,
    })),
  ),
);

function ratio(value: number): string {
  return Number.isFinite(value) ? value.toFixed(2) : '∞';
}

async function main(): Promise<void> {
  const path = process.argv.find((arg) => !arg.startsWith('-') && arg.endsWith('.json')) ?? 'var/backtest/majors-540d-exact.json';
  const dataset = loadReplayDataset(path);
  console.log(`dataset ${path}`);
  console.log('candidate                         early N/net/payoff/PF        final N/net/payoff/PF       gate');
  for (const variant of variants) {
    const result = testRelativePullback(dataset, {
      holdoutDays: HOLDOUT_DAYS,
      fundingPolicy: 'stress',
      stopAtrMultiple: variant.stopAtrMultiple,
      maxHoldHours: variant.maxHoldHours,
      targetR: 3,
      direction: variant.direction,
    });
    const earlyPass = result.preHoldoutTrades >= MIN_TRADES_PER_PERIOD
      && result.preHoldoutNetR > 0
      && result.preHoldoutPayoff >= MIN_PAYOFF
      && result.preHoldoutProfitFactor >= MIN_PROFIT_FACTOR;
    const finalPass = result.holdoutTrades >= MIN_TRADES_PER_PERIOD
      && result.holdoutNetR > 0
      && result.holdoutPayoff >= MIN_PAYOFF
      && result.holdoutProfitFactor >= MIN_PROFIT_FACTOR;
    const early = `${result.preHoldoutTrades}/${result.preHoldoutNetR.toFixed(1)}R/${ratio(result.preHoldoutPayoff)}/${ratio(result.preHoldoutProfitFactor)}`;
    const final = `${result.holdoutTrades}/${result.holdoutNetR.toFixed(1)}R/${ratio(result.holdoutPayoff)}/${ratio(result.holdoutProfitFactor)}`;
    console.log(`${variant.name.padEnd(33)} ${early.padEnd(28)} ${final.padEnd(28)} ${earlyPass && finalPass ? 'PASS' : earlyPass ? 'AUDIT FAIL' : 'REJECT'}`);
  }
  console.log(`gate per period: >=${MIN_TRADES_PER_PERIOD} trades, positive net R, payoff >=${MIN_PAYOFF}:1, profit factor >=${MIN_PROFIT_FACTOR}`);
}

main().catch((error: unknown) => {
  console.error('PULLBACK GEOMETRY TOURNAMENT FAILED:', error);
  process.exitCode = 1;
});
