/** Test predeclared market-level regime gates around the strongest geometry. */

import { loadReplayDataset } from '../backtest/replay.js';
import { testRelativePullback } from '../signal/relative-pullback.js';

const MIN_TRADES = 30;
const MIN_PAYOFF = 2.5;
const MIN_PROFIT_FACTOR = 1.05;

function ratio(value: number): string {
  return Number.isFinite(value) ? value.toFixed(2) : '∞';
}

async function main(): Promise<void> {
  const path = process.argv.find((arg) => !arg.startsWith('-') && arg.endsWith('.json')) ?? 'var/backtest/majors-540d-exact.json';
  const dataset = loadReplayDataset(path);
  console.log(`dataset ${path}`);
  console.log('candidate                         early N/net/payoff/PF        final N/net/payoff/PF       gate');
  for (const minTrendGapFraction of [0.0025, 0.005, 0.01]) {
    for (const minDirectionalBreadth of [3, 4]) {
      for (const requireBtcAlignment of [false, true]) {
        const name = `gap${minTrendGapFraction}-breadth${minDirectionalBreadth}-btc${requireBtcAlignment ? 'yes' : 'no'}`;
        const result = testRelativePullback(dataset, {
          holdoutDays: 180,
          fundingPolicy: 'stress',
          stopAtrMultiple: 2,
          maxHoldHours: 168,
          targetR: 3,
          direction: 'both',
          minTrendGapFraction,
          minDirectionalBreadth,
          requireBtcAlignment,
        });
        const earlyPass = result.preHoldoutTrades >= MIN_TRADES && result.preHoldoutNetR > 0
          && result.preHoldoutPayoff >= MIN_PAYOFF && result.preHoldoutProfitFactor >= MIN_PROFIT_FACTOR;
        const finalPass = result.holdoutTrades >= MIN_TRADES && result.holdoutNetR > 0
          && result.holdoutPayoff >= MIN_PAYOFF && result.holdoutProfitFactor >= MIN_PROFIT_FACTOR;
        const early = `${result.preHoldoutTrades}/${result.preHoldoutNetR.toFixed(1)}R/${ratio(result.preHoldoutPayoff)}/${ratio(result.preHoldoutProfitFactor)}`;
        const final = `${result.holdoutTrades}/${result.holdoutNetR.toFixed(1)}R/${ratio(result.holdoutPayoff)}/${ratio(result.holdoutProfitFactor)}`;
        console.log(`${name.padEnd(33)} ${early.padEnd(28)} ${final.padEnd(28)} ${earlyPass && finalPass ? 'PASS' : earlyPass ? 'AUDIT FAIL' : 'REJECT'}`);
      }
    }
  }
}

main().catch((error: unknown) => {
  console.error('PULLBACK REGIME TOURNAMENT FAILED:', error);
  process.exitCode = 1;
});
