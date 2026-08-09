import { loadConfig } from '../config.js';
import { KillSwitch } from '../kill-switch.js';
import { TradeKitAdapter, okxCliRunner } from '../execution/tradekit.js';
import { PositionWatchdog } from '../ops/watchdog.js';
import { readRuntimeProfile } from '../ops/runtime-profile.js';

const PROFILE = 'okx-sub';
const HEARTBEAT_PATH = process.env.ODDSDESK_HEARTBEAT_PATH?.trim() || 'var/engine-heartbeat.json';
const STALE_AFTER_MS = Number(process.env.ODDSDESK_WATCHDOG_STALE_SECONDS ?? '60') * 1_000;
const INTERVAL_MS = Number(process.env.ODDSDESK_WATCHDOG_INTERVAL_SECONDS ?? '10') * 1_000;

async function main(): Promise<void> {
  const config = loadConfig('config/default.yaml');
  const facts = readRuntimeProfile();
  if (facts.stopCustody !== 'client-held') {
    throw new Error(
      `watchdog is only required for client-held stops; measured custody is ${facts.stopCustody}. ` +
        'Do not run a client-held watchdog against an unverified or venue-held profile.',
    );
  }
  if (!Number.isFinite(STALE_AFTER_MS) || STALE_AFTER_MS <= 0 || !Number.isFinite(INTERVAL_MS) || INTERVAL_MS <= 0) {
    throw new Error('watchdog interval and stale threshold must be positive finite numbers');
  }

  const adapter = new TradeKitAdapter({
    profile: PROFILE,
    runner: okxCliRunner(PROFILE),
    stopCustody: facts.stopCustody,
    marginMode: config.execution.marginMode,
    positionMode: facts.positionMode,
  });
  const killSwitch = new KillSwitch(config.killSwitch.path);
  const webhook = process.env.ODDSDESK_ALERT_WEBHOOK?.trim();
  const alert = async (message: string): Promise<void> => {
    console.error(message);
    if (webhook === undefined || webhook === '') return;
    try {
      const response = await fetch(webhook, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content: message, text: message }),
      });
      if (!response.ok) console.error(`alert webhook returned HTTP ${response.status}`);
    } catch (error) {
      console.error(`alert webhook failed: ${(error as Error).message}`);
    }
  };

  const watchdog = new PositionWatchdog({
    venue: adapter,
    killSwitch,
    heartbeatPath: HEARTBEAT_PATH,
    staleAfterMs: STALE_AFTER_MS,
    onAlert: alert,
  });

  let stopping = false;
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => { stopping = true; });
  }
  while (!stopping) {
    const result = await watchdog.check();
    if (!result.healthy && result.failures.length > 0) process.exitCode = 1;
    await new Promise((resolve) => setTimeout(resolve, INTERVAL_MS));
  }
}

main().catch((error: unknown) => {
  console.error('WATCHDOG FAILED:', error);
  process.exitCode = 1;
});
