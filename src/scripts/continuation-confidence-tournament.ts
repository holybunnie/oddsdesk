/** Test fixed confidence floors for the only entry family near break-even in audit. */

import { loadReplayDataset } from '../backtest/replay.js';
import { testRelativePullback } from '../signal/relative-pullback.js';

function ratio(value: number): string {
  return Number.isFinite(value) ? value.toFixed(2) : '∞';
}

async function main(): Promise<void> {
  const path = process.argv.find((arg) => !arg.startsWith('-') && arg.endsWith('.json')) ?? 'var/backtest/majors-540d-exact.json';
  const dataset = loadReplayDataset(path);
  console.log(`dataset ${path}`);
  console.log('candidate                         early N/net/payoff/PF        final N/net/payoff/PF       gate');
  for (const minAbsoluteScore of [0.5, 1, 1.5]) {
    for (const direction of ['both', 'short-only'] as const) {
      for (const minTrendGapFraction of [0, 0.005]) {
        const name = `score${minAbsoluteScore}-${direction}-gap${minTrendGapFraction}`;
        const result = testRelativePullback(dataset, {
          holdoutDays: 180,
          fundingPolicy: 'stress',
          stopAtrMultiple: 2,
          maxHoldHours: 168,
          targetR: 3,
          direction,
          entryMode: 'continuation',
          minDirectionalBreadth: 3,
          requireBtcAlignment: true,
          minTrendGapFraction,
          minAbsoluteScore,
        });
        const earlyPass = result.preHoldoutTrades >= 30 && result.preHoldoutNetR > 0
          && result.preHoldoutPayoff >= 2.5 && result.preHoldoutProfitFactor >= 1.05;
        const finalPass = result.holdoutTrades >= 30 && result.holdoutNetR > 0
          && result.holdoutPayoff >= 2.5 && result.holdoutProfitFactor >= 1.05;
        const early = `${result.preHoldoutTrades}/${result.preHoldoutNetR.toFixed(1)}R/${ratio(result.preHoldoutPayoff)}/${ratio(result.preHoldoutProfitFactor)}`;
        const final = `${result.holdoutTrades}/${result.holdoutNetR.toFixed(1)}R/${ratio(result.holdoutPayoff)}/${ratio(result.holdoutProfitFactor)}`;
        console.log(`${name.padEnd(33)} ${early.padEnd(28)} ${final.padEnd(28)} ${earlyPass && finalPass ? 'PASS' : earlyPass ? 'AUDIT FAIL' : 'REJECT'}`);
      }
    }
  }
}

main().catch((error: unknown) => {
  console.error('CONTINUATION CONFIDENCE TOURNAMENT FAILED:', error);
  process.exitCode = 1;
});
