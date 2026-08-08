import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Ledger, LedgerIntegrityError, type LedgerEntry } from './ledger.js';
import { KillSwitch, KillSwitchTripped } from './kill-switch.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'oddsdesk-test-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const entry = (reason: string): LedgerEntry => ({
  action: 'order_submitted',
  engine: 'P1',
  venue: 'polymarket',
  instrument: 'BTC-UP-5M',
  signal: 'interval closed, up confirmed',
  price: '0.9840',
  size: '12.5',
  stop: null,
  reason,
});

describe('hash-chained ledger', () => {
  it('chains each row to its predecessor', () => {
    const ledger = new Ledger(join(dir, 'ledger.sqlite'));
    const a = ledger.append(entry('first'));
    const b = ledger.append(entry('second'));

    expect(a.prevHash).toBe('0'.repeat(64));
    expect(b.prevHash).toBe(a.hash);
    expect(ledger.verifyChain()).toEqual({ verified: 2 });
    ledger.close();
  });

  it('records refusals, not only trades', () => {
    // Law 4: a declined trade is as much a decision as a placed one.
    const ledger = new Ledger(join(dir, 'ledger.sqlite'));
    ledger.append({
      action: 'refusal',
      engine: 'H2',
      venue: 'tradekit',
      instrument: 'BTC-USDT-SWAP',
      signal: 'momentum long',
      price: '61200',
      size: null,
      stop: '60900',
      reason: 'target/stop ratio 2.10 below required 3:1',
    });
    expect(ledger.recent(1)[0]?.action).toBe('refusal');
    ledger.close();
  });

  it('requires a reason on every entry', () => {
    const ledger = new Ledger(join(dir, 'ledger.sqlite'));
    expect(() => ledger.append({ ...entry(''), reason: '   ' })).toThrow(/requires a reason/);
    ledger.close();
  });

  it('refuses UPDATE and DELETE at the database level', () => {
    const path = join(dir, 'ledger.sqlite');
    const ledger = new Ledger(path);
    ledger.append(entry('first'));
    ledger.close();

    // Append-only enforced in the database, so even a hand-issued statement fails.
    const raw = new Database(path);
    expect(() => raw.prepare("UPDATE ledger SET reason = 'edited'").run()).toThrow(/append-only/);
    expect(() => raw.prepare('DELETE FROM ledger').run()).toThrow(/append-only/);
    raw.close();
  });

  it('detects a row altered behind the triggers', () => {
    const path = join(dir, 'ledger.sqlite');
    const ledger = new Ledger(path);
    ledger.append(entry('first'));
    ledger.append(entry('second'));
    ledger.close();

    // Drop the guard triggers the way an attacker or a careless operator would,
    // then edit a row. The chain must still catch it.
    const raw = new Database(path);
    raw.exec('DROP TRIGGER ledger_no_update');
    raw.prepare("UPDATE ledger SET price = '0.0100' WHERE seq = 1").run();
    raw.close();

    const reopened = new Ledger(path);
    expect(() => reopened.verifyChain()).toThrow(LedgerIntegrityError);
    reopened.close();
  });

  it('detects a deleted row as a sequence gap', () => {
    const path = join(dir, 'ledger.sqlite');
    const ledger = new Ledger(path);
    ledger.append(entry('first'));
    ledger.append(entry('second'));
    ledger.close();

    const raw = new Database(path);
    raw.exec('DROP TRIGGER ledger_no_delete');
    raw.prepare('DELETE FROM ledger WHERE seq = 1').run();
    raw.close();

    const reopened = new Ledger(path);
    expect(() => reopened.verifyChain()).toThrow(/sequence gap/);
    reopened.close();
  });

  it('survives reopening and continues the chain', () => {
    const path = join(dir, 'ledger.sqlite');
    const first = new Ledger(path);
    const a = first.append(entry('before restart'));
    first.close();

    const second = new Ledger(path);
    const b = second.append(entry('after restart'));
    expect(b.prevHash).toBe(a.hash);
    expect(second.verifyChain()).toEqual({ verified: 2 });
    second.close();
  });
});

describe('kill switch', () => {
  it('is clear before anything trips it', () => {
    const ks = new KillSwitch(join(dir, 'kill-switch'));
    expect(ks.isTripped('all')).toBe(false);
    expect(() => ks.assertClear('routeA')).not.toThrow();
  });

  it('throws rather than returning false once tripped', () => {
    const ks = new KillSwitch(join(dir, 'kill-switch'));
    ks.trip('routeB', 'watchdog', 'agent heartbeat stale beyond 60s');
    expect(() => ks.assertClear('routeB')).toThrow(KillSwitchTripped);
  });

  it('scopes a routeB trip so routeA keeps running', () => {
    const ks = new KillSwitch(join(dir, 'kill-switch'));
    ks.trip('routeB', 'operator', 'leverage unverified');
    expect(() => ks.assertClear('routeA')).not.toThrow();
    expect(() => ks.assertClear('routeB')).toThrow();
  });

  it('applies an "all" trip to every scope', () => {
    const ks = new KillSwitch(join(dir, 'kill-switch'));
    ks.trip('all', 'operator', 'stop everything');
    expect(() => ks.assertClear('routeA')).toThrow();
    expect(() => ks.assertClear('routeB')).toThrow();
  });

  it('survives process restart — a forgetful kill switch is not a kill switch', () => {
    const path = join(dir, 'kill-switch');
    new KillSwitch(path).trip('all', 'operator', 'drawdown breach');
    expect(() => new KillSwitch(path).assertClear('all')).toThrow(/drawdown breach/);
  });

  it('preserves the first cause when later trips pile on', () => {
    const ks = new KillSwitch(join(dir, 'kill-switch'));
    ks.trip('all', 'governor', 'first cause');
    ks.trip('all', 'operator', 'second cause');
    expect(ks.records()[0]?.reason).toBe('first cause');
    expect(ks.records()).toHaveLength(2);
  });

  it('fails closed on a corrupted file', () => {
    const path = join(dir, 'kill-switch');
    writeFileSync(path, 'not json\n', 'utf8');
    // An unreadable kill switch must never read as "clear".
    expect(() => new KillSwitch(path).isTripped('all')).toThrow(/unparseable/);
  });
});
