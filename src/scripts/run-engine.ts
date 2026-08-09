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
 *   npx tsx src/scripts/run-engine.ts --live     # run continuously
 */

import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { competitionPhase, entriesPermitted, loadConfig } from '../config.js';
import { dailyAttribution, formatAttribution } from '../attribution.js';
import { describeCosts } from '../fees.js';
import { Ledger } from '../ledger.js';
import { KillSwitch } from '../kill-switch.js';
import { OkxMarketData } from '../market/okx.js';
import { TradeKitAdapter, okxCliRunner } from '../execution/tradekit.js';
import { GuardedExecutor } from '../execution/guarded.js';
import { CopyExecutor } from '../execution/copy.js';
import type { Instrument, RiskTokenGate, VenueProfile } from '../execution/adapter.js';
import { Driver } from '../engine/driver.js';
import { Engine, type SignalPublisher } from '../engine/loop.js';
import { EngineState } from '../engine/state.js';

const RUNTIME_PROFILE = 'config/runtime-profile.tradekit.yaml';
const PROFILE = 'okx-sub';

/**
 * Facts read from the runtime profile written by the Day-0 and Part IX
 * verifications. Never literals here: a hardcoded value would defeat the gate
 * from outside it, which is exactly the move the gate cannot defend against.
 */
interface RuntimeFacts {
  readonly stopCustody: VenueProfile['stopCustody'];
  readonly positionMode: 'long_short_mode' | 'net_mode';
}

function readRuntimeProfile(): RuntimeFacts {
  let raw: string;
  try {
    raw = readFileSync(RUNTIME_PROFILE, 'utf8');
  } catch {
    throw new Error(
      `no runtime profile at ${RUNTIME_PROFILE}. Stop custody and position mode are unknown until ` +
        'the venue has been measured. Refusing to guess either.',
    );
  }

  const parsed = parseYaml(raw) as {
    stops?: { custody?: unknown; killTestObserved?: unknown; rebootTestObserved?: unknown };
    account?: { positionMode?: unknown };
  };

  const custody = parsed?.stops?.custody;
  if (custody !== 'venue-held' && custody !== 'client-held' && custody !== 'none' && custody !== 'unverified') {
    throw new Error(
      `runtime profile has stops.custody ${JSON.stringify(custody)}; expected one of ` +
        'venue-held | client-held | none | unverified.',
    );
  }

  // A custody claim without an observed kill test is the one inconsistency that
  // would quietly re-open everything Part IX exists to close. Someone editing
  // the profile by hand is precisely how that happens, so it is checked.
  if (custody !== 'unverified' && parsed.stops?.killTestObserved !== true) {
    throw new Error(
      `runtime profile claims stops.custody "${custody}" but killTestObserved is not true. ` +
        'A custody value that was not observed is worse than none — it puts an unverified stop ' +
        'mechanism in front of a leveraged book while looking verified.',
    );
  }

  const positionMode = parsed?.account?.positionMode;
  if (positionMode !== 'long_short_mode' && positionMode !== 'net_mode') {
    throw new Error(
      `runtime profile has account.positionMode ${JSON.stringify(positionMode)}; expected ` +
        'long_short_mode | net_mode. Getting this wrong makes every order carry the wrong posSide.',
    );
  }

  return { stopCustody: custody, positionMode };
}

/**
 * Placeholder ASP publisher.
 *
 * Throws rather than no-opping. A publisher that silently succeeds would let
 * the engine trade signals nobody ever received, which reads as a working agent
 * from every angle except the rules — exactly the failure Law 2 warns about.
 * Replace with the real ASP client before go-live.
 */
class UnbuiltPublisher implements SignalPublisher {
  async publish(): Promise<void> {
    throw new Error(
      'ASP publisher is not built. The engine must not trade a signal it cannot publish — ' +
        'Law 6 requires the published record to exist before the order does.',
    );
  }
}

/** Placeholder risk-token gate. Perps on a major venue carry no token risk. */
class PerpTokenGate implements RiskTokenGate {
  async assertClean(): Promise<void> {
    // USDT perpetuals on OKX are venue-listed instruments, not arbitrary
    // tokens. The gate exists for the meme-sniper route and stays clean here.
  }
}

async function main(): Promise<void> {
  const live = process.argv.includes('--live');
  const config = loadConfig('config/default.yaml');
  const { stopCustody, positionMode } = readRuntimeProfile();

  const ledger = new Ledger(config.ledger.path);
  const killSwitch = new KillSwitch(config.killSwitch.path);
  const state = new EngineState(config.engineState.path);
  const market = new OkxMarketData();

  const adapter = new TradeKitAdapter({
    profile: PROFILE,
    runner: okxCliRunner(PROFILE),
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

  const profile = await adapter.describeVenue();
  const instruments = new Map<string, Instrument>(profile.instruments.map((i) => [i.symbol, i]));
  console.log(`discovered ${instruments.size} live USDT perps, maker ${profile.makerFee}, taker ${profile.takerFee}`);

  const executor = new GuardedExecutor({
    adapter,
    ledger,
    killSwitch,
    riskGate: new PerpTokenGate(),
    maxFeedStalenessSeconds: config.risk.maxFeedStalenessSeconds,
  });

  const copyExecutor = new CopyExecutor({
    config,
    executor,
    account: adapter,
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
    publisher: new UnbuiltPublisher(),
    instruments,
    readEquity: async () => Number(await adapter.availableBalance()) / 1e8,
    // Stage 3 stays unreachable until the leaderboard parser exists. Returning
    // null is the honest answer: defending a rank we cannot measure is guessing.
    readRankCushion: async () => null,
  });

  const driver = new Driver({
    config,
    engine,
    state,
    market,
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

  if (!live) {
    console.log('\nDRY RUN — one cycle, then exit. Pass --live to run continuously.\n');
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

  const result = await driver.run();
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
