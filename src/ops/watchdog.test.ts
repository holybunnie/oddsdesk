import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { KillSwitch } from '../kill-switch.js';
import type { Instrument, Position } from '../execution/adapter.js';
import { writeHeartbeat } from './heartbeat.js';
import { PositionWatchdog } from './watchdog.js';

const instrument: Instrument = {
  symbol: 'BTC-USDT-SWAP',
  priceDecimals: 1,
  sizeDecimals: 2,
  contractValue: 0.01,
  maxLeverage: 100,
};
const position: Position = {
  instrument,
  side: 'long',
  size: 1n,
  entryPrice: 100n,
  markPrice: 99n,
  unrealisedPnlQuote: -1n,
  stopPrice: 95n,
  stopRestingOnVenue: false,
};

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'watchdog-'));
  const heartbeatPath = join(dir, 'heartbeat.json');
  const killSwitch = new KillSwitch(join(dir, 'kill.jsonl'));
  const calls: string[] = [];
  const alerts: string[] = [];
  return { dir, heartbeatPath, killSwitch, calls, alerts };
}

describe('PositionWatchdog', () => {
  it('does nothing while the heartbeat is fresh', async () => {
    const f = fixture();
    writeHeartbeat(f.heartbeatPath, 1_000, 42);
    const result = await new PositionWatchdog({
      venue: { openPositions: async () => [position], flatten: async () => f.calls.push('flatten') },
      killSwitch: f.killSwitch,
      heartbeatPath: f.heartbeatPath,
      staleAfterMs: 60_000,
      now: () => 2_000,
      onAlert: (message) => { f.alerts.push(message); },
    }).check();

    expect(result.healthy).toBe(true);
    expect(f.calls).toEqual([]);
    expect(f.killSwitch.isTripped('routeB')).toBe(false);
  });

  it('trips and flattens stale client-held positions', async () => {
    const f = fixture();
    writeHeartbeat(f.heartbeatPath, 1_000, 42);
    const result = await new PositionWatchdog({
      venue: { openPositions: async () => [position], flatten: async () => f.calls.push('flatten') },
      killSwitch: f.killSwitch,
      heartbeatPath: f.heartbeatPath,
      staleAfterMs: 60_000,
      now: () => 62_000,
      onAlert: (message) => { f.alerts.push(message); },
    }).check();

    expect(result.healthy).toBe(false);
    expect(result.positionsSeen).toBe(1);
    expect(result.positionsFlattened).toBe(1);
    expect(f.calls).toEqual(['flatten']);
    expect(f.killSwitch.isTripped('routeB')).toBe(true);
    expect(f.alerts.some((message) => message.includes('flattened'))).toBe(true);
  });

  it('retries a failed flatten and reports the final failure', async () => {
    const f = fixture();
    writeHeartbeat(f.heartbeatPath, 1_000, 42);
    let attempts = 0;
    const result = await new PositionWatchdog({
      venue: {
        openPositions: async () => [position],
        flatten: async () => {
          attempts += 1;
          throw new Error('venue unavailable');
        },
      },
      killSwitch: f.killSwitch,
      heartbeatPath: f.heartbeatPath,
      staleAfterMs: 60_000,
      maxFlattenAttempts: 2,
      now: () => 62_000,
      sleep: async () => undefined,
      onAlert: (message) => { f.alerts.push(message); },
    }).check();

    expect(attempts).toBe(2);
    expect(result.failures[0]).toMatch(/final failure|flatten attempt 2/);
    expect(f.alerts.some((message) => message.includes('WATCHDOG ALERT'))).toBe(true);
  });
});
