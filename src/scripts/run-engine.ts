/**
 * The agent entrypoint — assembles every component and runs the driver.
 *
 * This is the only file that constructs the real thing, and it is deliberately
 * assembly with no logic: every decision it could make has already been made in
 * a module that is tested. What it does add is the two refusals that only make
 * sense at startup, both of which are cheap here and catastrophic later:
 *
 *   - **Stop custody must come from the runtime profile**, never a literal. The
 *     adapter refuses to submit while it is `unverified`, so a hardcoded
 *     'venue-held' here would defeat the entire Part IX gate from outside it.
 *   - **`--live` must be explicit.** The default is a single dry cycle. An
 *     entrypoint that trades by default is one mistyped command away from
 *     trading when someone meant to look.
 *
 * Usage:
 *   npx tsx src/scripts/run-engine.ts            # one dry cycle, no publish
 *   OKX_ASP_AGENT_ID=<your-asp-id> npx tsx src/scripts/run-engine.ts --live
 */

import { competitionPhase, entriesPermitted, loadConfig } from '../config.js';
import { dailyAttribution, formatAttribution } from '../attribution.js';
import { describeCosts } from '../fees.js';
import { Ledger } from '../ledger.js';
import { KillSwitch } from '../kill-switch.js';
import { OkxMarketData } from '../market/okx.js';
import { BinanceMarketData } from '../market/binance.js';
import { TradeKitAdapter, assertTradingEnvironment, okxCliRunner } from '../execution/tradekit.js';
import { GuardedExecutor } from '../execution/guarded.js';
import { CopyExecutor } from '../execution/copy.js';
import type { Instrument } from '../execution/adapter.js';
import { ListedPerpRiskGate } from '../execution/perp-risk.js';
import { Driver } from '../engine/driver.js';
import { Engine, type SignalPublisher } from '../engine/loop.js';
import { EngineState } from '../engine/state.js';
import { A2aSignalPublisher } from '../publishing/a2a.js';
import { writeHeartbeat } from '../ops/heartbeat.js';
import { readRuntimeProfile } from '../ops/runtime-profile.js';
import { virtualDemoBalanceMinor } from '../ops/demo-balance.js';
import { readRankCushionFrom } from '../rank/snapshot-source.js';

const HEARTBEAT_INTERVAL_MS = 10_000;

/**
 * Facts read from the runtime profile written by the Day-0 and Part IX
 * verifications. Never literals here: a hardcoded value would defeat the gate
 * from outside it, which is exactly the move the gate cannot defend against.
 */
/** Dry mode must never fan out to real subscribers or reach the copy executor. */
class DryRunPublisher implements SignalPublisher {
  async publish(text: string): Promise<void> {
    throw new Error(`dry run: signal would be published but no order will be submitted: ${text}`);
  }
}

/** Demo signals are validated and executed locally, never pushed to subscribers. */
class DemoPublisher implements SignalPublisher {
  async publish(text: string): Promise<void> {
    console.log(`[demo signal] ${text}`);
  }
}

async function main(): Promise<void> {
  const live = process.argv.includes('--live');
  const demoDryRun = process.argv.includes('--demo-dry-run');
  const demo = process.argv.includes('--demo') || demoDryRun;
  if (live && demo) throw new Error('--live and --demo are mutually exclusive');
  const continuous = live || (demo && !demoDryRun);
  const profile = demo ? (process.env.OKX_DEMO_PROFILE?.trim() || 'okx-demo') : 'okx-sub';
  const runtimeProfile = demo ? 'config/runtime-profile.demo.yaml' : 'config/runtime-profile.tradekit.yaml';
  const loadedConfig = loadConfig('config/default.yaml');
  const { stopCustody, positionMode, maxLeverage, demoBalance } = readRuntimeProfile(runtimeProfile);
  if (demo && demoBalance === undefined) throw new Error('demo runtime profile is missing its virtual balance baseline');
  const config = {
    ...loadedConfig,
    execution: { ...loadedConfig.execution, maxLeverage },
    ...(demo
      ? {
          ledger: { path: 'var/demo/ledger.sqlite' },
          killSwitch: { path: 'var/demo/kill-switch' },
          engineState: { path: 'var/demo/engine-state.json' },
        }
      : {}),
  };
  const heartbeatPath = demo ? 'var/demo/engine-heartbeat.json' : 'var/engine-heartbeat.json';
  const aspAgentId = process.env.OKX_ASP_AGENT_ID?.trim();
  if (live && (aspAgentId === undefined || aspAgentId === '')) {
    throw new Error(
      'OKX_ASP_AGENT_ID is required in --live mode. Set it to the reviewed ASP identity; ' +
        'the A2A publisher refuses to guess which ASP should receive the signal.',
    );
  }

  const ledger = new Ledger(config.ledger.path);
  const killSwitch = new KillSwitch(config.killSwitch.path);
  const state = new EngineState(config.engineState.path);
  const market = new OkxMarketData();
  const binance = new BinanceMarketData();

  const runner = okxCliRunner(profile);
  await assertTradingEnvironment(runner, demo ? 'demo' : 'live');
  console.log(`trading environment: ${demo ? 'demo' : 'live'} (profile ${profile})`);

  const adapter = new TradeKitAdapter({
    profile,
    runner,
    stopCustody,
    marginMode: config.execution.marginMode,
    positionMode,
  });

  // Stated at startup rather than discovered at the first refusal. Running the
  // engine before the competition opens is a legitimate thing to do — it is how
  // the dry run works — but it must never be a surprise that nothing traded.
  const phase = competitionPhase(config, Date.now());
  console.log(
    `competition phase: ${phase} ` +
      `(opens ${new Date(config.competition.startsAt).toISOString()}, ` +
      `closes ${new Date(config.competition.endsAt).toISOString()})`,
  );
  if (!entriesPermitted(phase)) {
    console.log('  no new position will be opened in this phase. Exits are still managed.');
  }

  console.log(`stop custody: ${stopCustody}`);
  if (stopCustody === 'unverified') {
    console.log('  submitOrder will refuse. Run the Part IX kill test before expecting a fill.');
  }

  const venueProfile = await adapter.describeVenue();
  const instruments = new Map<string, Instrument>(venueProfile.instruments.map((i) => [i.symbol, i]));
  console.log(`discovered ${instruments.size} live USDT perps, maker ${venueProfile.makerFee}, taker ${venueProfile.takerFee}`);

  const executor = new GuardedExecutor({
    adapter,
    ledger,
    killSwitch,
    riskGate: new ListedPerpRiskGate(),
    maxFeedStalenessSeconds: config.risk.maxFeedStalenessSeconds,
  });

  const copyExecutor = new CopyExecutor({
    config,
    executor,
    account: demo
      ? {
          availableBalance: async () => virtualDemoBalanceMinor(
            await adapter.availableBalance(),
            demoBalance!.venueBaselineUsdt,
            demoBalance!.virtualPrincipalUsdt,
          ),
          openPositions: async () => adapter.openPositions(),
        }
      : adapter,
    instruments,
    journal: state.signalJournal(),
    maxSignalAgeMs: config.entry.validityHours * 3_600_000,
  });

  const engine = new Engine({
    config,
    state,
    ledger,
    killSwitch,
    executor,
    copyExecutor,
    publisher: live
      ? new A2aSignalPublisher({ agentId: aspAgentId as string })
      : demo && !demoDryRun
        ? new DemoPublisher()
        : new DryRunPublisher(),
    instruments,
    readEquity: async () => {
      const actual = await adapter.availableBalance();
      const measured = demo
        ? virtualDemoBalanceMinor(actual, demoBalance!.venueBaselineUsdt, demoBalance!.virtualPrincipalUsdt)
        : actual;
      return Number(measured) / 1e8;
    },
    // Rank steering reads the snapshot the capture process persists. It never
    // throws: a missing, stale, or unreadable snapshot — or simply being below
    // the board's visible top-10 window — yields null, which keeps Stage 3
    // unreachable. Defending a rank we cannot measure is guessing, but a failed
    // capture must never stop the engine trading.
    readRankCushion: async () => {
      const reading = readRankCushionFrom(config, config.leaderboard.path, Date.now());
      if (reading.cushion === null && reading.unavailableBecause !== undefined) {
        console.log(`[rank] steering unavailable — ${reading.unavailableBecause}`);
      } else if (reading.metrics !== undefined) {
        const m = reading.metrics;
        console.log(
          `[rank] score ${m.myScore.toFixed(1)} (pct #${m.myRankPct}, abs #${m.myRankAbs}) ` +
            `binding ${m.bindingAxis} gap-to-3 ${(100 * m.gapToRank3Pct).toFixed(2)}%/` +
            `${m.gapToRank3Abs.toFixed(2)} USDT — cushion ${String(reading.cushion)}`,
        );
      }
      return reading.cushion;
    },
  });

  const driver = new Driver({
    config,
    engine,
    state,
    market,
    binance,
    ledger,
    killSwitch,
    intervalSeconds: config.risk.reconcileIntervalSeconds,
    onCycle: (report) => {
      console.log(
        `[cycle] phase ${report.phase} stage ${report.stage} governor ${report.governor} ` +
          `costs ${describeCosts(report.costs)} ` +
          `equity ${report.equityUsdt.toFixed(2)} peak ${report.peakEquityUsdt.toFixed(2)} ` +
          `exits ${report.exits.length} signals ${JSON.stringify(report.signals)}` +
          (report.standDownReason === null ? '' : ` — ${report.standDownReason}`),
      );
    },
  });

  if (!continuous) {
    console.log('\nDRY RUN — one cycle, then exit. Pass --demo or --live to run continuously.\n');
    const { report, scan } = await driver.runOnce();
    console.log(
      `universe ${scan.universeSize}/${scan.liveUsdtPerps}, ` +
        `regime ${scan.result.regimeFavourable ? 'favourable' : 'unfavourable'}, ` +
        `${scan.result.candidates.length} candidate(s)`,
    );
    console.log(JSON.stringify(report, replacer, 2));
    // Part VIII step 5. Printed from the LEDGER, not from this cycle: the point
    // of the attribution is what has happened across the competition, and a
    // block computed from live state would go blank on the restart after the
    // crash you most want to explain.
    console.log(`\nattribution:\n${formatAttribution(dailyAttribution(config, ledger))}`);
    return;
  }

  // Finish the cycle in flight rather than aborting it: a half-run cycle can
  // leave a position opened but untracked, which the state file cannot repair.
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      console.log(`\n${signal} — finishing the current cycle, then stopping.`);
      driver.stop();
    });
  }

  const heartbeat = () => {
    try {
      writeHeartbeat(heartbeatPath);
    } catch (error) {
      console.error(`HEARTBEAT FAILED: ${(error as Error).message}`);
      killSwitch.trip('routeB', 'engine', `heartbeat write failed: ${(error as Error).message}`);
    }
  };
  heartbeat();
  const heartbeatTimer = setInterval(heartbeat, HEARTBEAT_INTERVAL_MS);
  const result = await driver.run().finally(() => clearInterval(heartbeatTimer));
  console.log(`stopped after ${result.cycles} cycle(s)`);

  if (result.haltedBecause !== null) {
    // Non-zero, deliberately. The reference delivery daemon exits zero on JWT
    // expiry and Restart=always then does not restart it; that trap is not
    // going to be repeated here.
    console.error(`HALTED: ${result.haltedBecause}`);
    process.exitCode = 1;
  }
}

/** bigint has no JSON representation, and dropping it silently would hide sizes. */
function replacer(_key: string, value: unknown): unknown {
  return typeof value === 'bigint' ? value.toString() : value;
}

main().catch((error: unknown) => {
  console.error('ENGINE FAILED:', error);
  process.exitCode = 1;
});
