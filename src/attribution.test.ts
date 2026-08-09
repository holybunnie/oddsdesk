import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';
import { Ledger } from './ledger.js';
import {
  AttributionError,
  attribute,
  closedTradesFrom,
  dailyAttribution,
  formatAttribution,
  type ClosedTrade,
} from './attribution.js';

const config = loadConfig('config/default.yaml');

let ledger: Ledger;

beforeEach(() => {
  ledger = new Ledger(join(mkdtempSync(join(tmpdir(), 'attr-')), 'ledger.db'));
});

const trade = (rMultiple: number, instrument = 'BTC-USDT-SWAP'): ClosedTrade => ({
  instrument,
  signalId: 'S-1',
  rMultiple,
  closedAtMs: 0,
});

/** Enough trades to clear payoffRatioMinTrades, at a chosen win/loss shape. */
const sample = (wins: number, winR: number, losses: number, lossR: number): ClosedTrade[] => [
  ...Array.from({ length: wins }, () => trade(winR)),
  ...Array.from({ length: losses }, () => trade(-lossR)),
];

function close(rMultiple: number, terminal: boolean, instrument = 'BTC-USDT-SWAP'): void {
  ledger.append({
    action: 'position_closed',
    engine: 'engine-loop',
    venue: 'okx',
    instrument,
    signal: 'S-1',
    price: '100',
    size: '24',
    stop: '95',
    reason: terminal ? 'full: stop hit' : 'partial: scale-out',
    detail: { rMultiple, terminal, fraction: terminal ? 1 : 0.25 },
  });
}

describe('reading closed trades from the ledger', () => {
  it('counts terminal closes only', () => {
    // A scale-out at +2R is not a completed trade. Counting it would fill the
    // sample with guaranteed winners taken at a fixed multiple and report the
    // exit system as healthy precisely BECAUSE it takes profits early — which
    // is the failure the ratio exists to detect.
    close(2, false);
    close(-1, true);
    const trades = closedTradesFrom(ledger);

    expect(trades).toHaveLength(1);
    expect(trades[0]?.rMultiple).toBe(-1);
  });

  it('reads R from structured detail, not from the reason text', () => {
    // A report that parsed prose would break the first time someone reworded a
    // message, and would break toward "not enough evidence yet" — which reads
    // as a normal state rather than as a bug.
    close(3.5, true);
    expect(closedTradesFrom(ledger)[0]?.rMultiple).toBe(3.5);
  });

  it('throws on a close whose R is missing or unusable', () => {
    ledger.append({
      action: 'position_closed',
      engine: 'engine-loop',
      venue: 'okx',
      instrument: 'BTC-USDT-SWAP',
      signal: 'S-1',
      price: '100',
      size: '24',
      stop: null,
      reason: 'full: stop hit',
      detail: { terminal: true },
    });
    expect(() => closedTradesFrom(ledger)).toThrow(AttributionError);
  });

  it('ignores every other kind of ledger row', () => {
    ledger.append({
      action: 'signal_published',
      engine: 'engine-loop',
      venue: 'okx',
      instrument: 'BTC-USDT-SWAP',
      signal: 'S-1',
      price: '100',
      size: '2',
      stop: '95',
      reason: 'text',
    });
    expect(closedTradesFrom(ledger)).toHaveLength(0);
  });
});

describe('the realised payoff ratio', () => {
  it('is average R won over average R lost', () => {
    // 4 wins at +3R, 6 losses at -1R: 3.0 / 1.0 = 3:1.
    const result = attribute(config, sample(4, 3, 6, 1));

    expect(result.averageRWon).toBeCloseTo(3, 9);
    expect(result.averageRLost).toBeCloseTo(1, 9);
    expect(result.realisedPayoffRatio).toBeCloseTo(3, 9);
    expect(result.hitRate).toBeCloseTo(0.4, 9);
  });

  it('flags broken exits below the floor over enough trades', () => {
    // The one measured failure the spec permits acting on.
    const result = attribute(config, sample(4, 2, 6, 1));

    expect(result.realisedPayoffRatio).toBeCloseTo(2, 9);
    expect(result.exitLogicSuspect).toBe(true);
    expect(result.verdict).toMatch(/EXIT LOGIC IS BROKEN/);
  });

  it('does NOT flag a bad ratio on too few trades', () => {
    // "A bad day is not evidence." Nine trades is a bad day.
    const result = attribute(config, sample(2, 1, 7, 1));

    expect(result.trades).toBeLessThan(config.attribution.payoffRatioMinTrades);
    expect(result.exitLogicSuspect).toBe(false);
    expect(result.verdict).toMatch(/NOT a pass/);
  });

  it('says "not enough evidence" rather than "healthy" when the sample is thin', () => {
    // Conflating the two is how a strategy gets changed on nine trades — or
    // left alone on the strength of three good ones.
    expect(attribute(config, []).verdict).toMatch(/NOT a pass/);
    expect(attribute(config, [trade(5)]).verdict).not.toMatch(/at or above/);
  });

  it('returns null, never Infinity, when there are no losses', () => {
    // A system with no losses has not proved an infinite payoff ratio; it has
    // proved nothing. Infinity would let it pass a threshold it never met.
    const result = attribute(config, Array.from({ length: 12 }, () => trade(2)));

    expect(result.realisedPayoffRatio).toBeNull();
    expect(result.exitLogicSuspect).toBe(false);
    expect(result.verdict).toMatch(/not computable/);
  });

  it('counts a flat trade as a loss, because a scratch is not a win', () => {
    const result = attribute(config, [trade(0), trade(1)]);
    expect(result.wins).toBe(1);
    expect(result.losses).toBe(1);
  });

  it('passes a healthy system', () => {
    const result = attribute(config, sample(3, 6, 9, 1));
    expect(result.exitLogicSuspect).toBe(false);
    expect(result.verdict).toMatch(/at or above/);
  });
});

describe('the report block', () => {
  it('attributes by instrument, so a single bad market is visible', () => {
    const result = attribute(config, [
      trade(3, 'BTC-USDT-SWAP'),
      trade(-1, 'BOME-USDT-SWAP'),
      trade(-1, 'BOME-USDT-SWAP'),
    ]);

    expect(result.byInstrument.get('BOME-USDT-SWAP')).toEqual({ trades: 2, totalR: -2 });
    expect(formatAttribution(result)).toMatch(/BOME-USDT-SWAP -2.0R x2/);
  });

  it('prints n/a rather than a number it does not have', () => {
    const text = formatAttribution(attribute(config, []));
    expect(text).toMatch(/hit rate n\/a/);
    expect(text).toMatch(/average R won n\/a/);
  });

  it('runs end to end off the ledger', () => {
    for (let i = 0; i < 4; i++) close(3, true);
    for (let i = 0; i < 6; i++) close(-1, true);
    close(2, false); // a scale-out, which must not count

    const result = dailyAttribution(config, ledger);
    expect(result.trades).toBe(10);
    expect(result.realisedPayoffRatio).toBeCloseTo(3, 9);
    expect(result.exitLogicSuspect).toBe(false);
  });
});
