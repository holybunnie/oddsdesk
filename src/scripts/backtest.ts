/** Run the offline replay and print the decision metrics from the work queue. */

import { loadConfig } from '../config.js';
import { loadReplayDataset, replay } from '../backtest/replay.js';

function numberAfter(flag: string, fallback: number): number {
  const index = process.argv.indexOf(flag);
  const raw = index >= 0 ? process.argv[index + 1] : undefined;
  return raw === undefined ? fallback : Number(raw);
}

function pct(value: number): string {
  return `${(value * 100).toFixed(2)}%`;
}

async function main(): Promise<void> {
  const path = process.argv.find((arg) => !arg.startsWith('-') && arg.endsWith('.json')) ?? 'var/backtest/okx-90d.json';
  const dataset = loadReplayDataset(path);
  const result = replay({
    config: loadConfig('config/default.yaml'),
    dataset,
    tradingFeeRateFraction: numberAfter('--maker-bps', 2) / 10_000,
    slippageBps: numberAfter('--slippage-bps', 0),
    respectCompetitionClock: process.argv.includes('--competition-clock'),
  });

  console.log(`range ${new Date(result.fromMs).toISOString()} → ${new Date(result.toMs).toISOString()} (${result.observedDays.toFixed(1)}d)`);
  console.log(`equity ${result.initialEquityUsdt.toFixed(2)} → ${result.finalEquityUsdt.toFixed(2)} USDT (${pct(result.returnFraction)})`);
  console.log(`trades ${result.closedTrades} closed / ${result.entries} entries (${result.tradesPerDay.toFixed(2)}/day)`);
  console.log(`win rate ${pct(result.winRate)} (${result.wins}W/${result.losses}L/${result.scratches} scratch)`);
  console.log(`realised payoff ratio ${Number.isFinite(result.realisedPayoffRatio) ? result.realisedPayoffRatio.toFixed(2) : '∞'}:1`);
  console.log(`max drawdown ${pct(result.maxDrawdownFraction)} · time stops ${pct(result.timeStopHitRate)}`);
  console.log(`costs fees ${result.totalTradingFeesUsdt.toFixed(4)} measured-assumption · funding ${result.totalFundingUsdt.toFixed(4)} modelled`);
  console.log(`max observed leverage ${result.maximumObservedLeverage.toFixed(2)}x · favourable regime ${result.regimeFavourableCycles}/${result.scanCycles} cycles`);
  console.log(`historical E1 universe ${result.minimumUniverseSize}/${result.averageUniverseSize.toFixed(1)}/${result.maximumUniverseSize} min/avg/max`);
  if (result.openPositions.length > 0) console.log(`open at end ${result.openPositions.map((p) => `${p.instId}:${p.side}`).join(', ')}`);
  for (const assumption of result.assumptions) console.log(`assumption: ${assumption}`);
}

main().catch((error: unknown) => {
  console.error('BACKTEST FAILED:', error);
  process.exitCode = 1;
});
