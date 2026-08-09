import { describe, expect, it } from 'vitest';
import { loadConfig } from '../config.js';
import {
  SignalCycle,
  SignalError,
  buildExitSignal,
  buildSignal,
  formatExitSignal,
  formatPrice,
  formatSignal,
  formatStatus,
  leverageFor,
  validateExitSignal,
  roundPrice,
  validateSignal,
  type ExitSignalPlan,
  type SignalPlan,
  type ValidationContext,
} from './publish.js';

const config = loadConfig('config/default.yaml');
const NOW = 1_760_000_000_000;
const HOUR = 3_600_000;

const INST = 'BTC-USDT-SWAP';

const plan = (overrides: Partial<SignalPlan> = {}): SignalPlan => ({
  signalId: 'S-2608091200-BTC-L',
  instId: INST,
  direction: 'long',
  entryLow: 100,
  entryHigh: 101,
  stopPrice: 95,
  scaleOutPrice: 113, // +2R off the band top, where E5 actually takes 25% off
  targetPrice: 119, // (101 - 95) * 3 + 101 = 119, exactly 3:1 off the band top
  sizePercent: 2,
  validUntilMs: NOW + 4 * HOUR,
  ...overrides,
});

const context = (overrides: Partial<ValidationContext> = {}): ValidationContext => ({
  liveInstruments: new Set([INST, 'YGG-USDT-SWAP']),
  nowMs: NOW,
  ...overrides,
});

const check = (p: SignalPlan, text?: string, ctx?: ValidationContext) =>
  validateSignal(config, text ?? formatSignal(config, p), p, ctx ?? context());

const reasonsOf = (result: ReturnType<typeof check>): string[] =>
  result.ok ? [] : [...result.reasons];

describe('price formatting', () => {
  it('keeps five significant figures across the whole perp price range', () => {
    expect(formatPrice(118_432.7)).toBe('118430');
    expect(formatPrice(0.0202601)).toBe('0.02026');
    expect(formatPrice(0.00067123)).toBe('0.00067123');
  });

  it('never drops integer zeros when trimming the fraction', () => {
    // Trimming trailing zeros unconditionally turns 118000 into 118 — a price
    // three orders of magnitude wrong that still looks like a price.
    expect(formatPrice(118_000)).toBe('118000');
    expect(formatPrice(100)).toBe('100');
    expect(formatPrice(1000)).toBe('1000');
  });

  it('never emits exponent notation, which a parser would read as a different number', () => {
    expect(formatPrice(0.0000012345)).not.toMatch(/e/i);
    expect(formatPrice(0.0000012345)).toMatch(/^0\.0+12345?$/);
  });

  it('refuses non-positive and non-finite prices rather than printing them', () => {
    expect(() => roundPrice(0)).toThrow(SignalError);
    expect(() => roundPrice(-1)).toThrow(SignalError);
    expect(() => roundPrice(Number.NaN)).toThrow(SignalError);
    expect(() => roundPrice(Number.POSITIVE_INFINITY)).toThrow(SignalError);
  });
});

describe('formatSignal', () => {
  it('starts with the exact configured header', () => {
    // ASP classification is keyword-driven: without this header the service is
    // classified as text, which delivers successfully and executes nothing.
    expect(formatSignal(config, plan()).startsWith('[Perpetual Signal]')).toBe(true);
    expect(config.publishing.perpHeader).toBe('[Perpetual Signal]');
  });

  it('carries direction, instrument, all four prices, size and id', () => {
    const text = formatSignal(config, plan());
    for (const part of ['LONG', INST, '100', '101', '95', '119', '2%', 'S-2608091200-BTC-L']) {
      expect(text).toContain(part);
    }
  });

  it('fits the character budget for a realistically long instrument and price', () => {
    const text = formatSignal(
      config,
      plan({
        instId: '1000000BABYDOGE-USDT-SWAP',
        entryLow: 0.00067123,
        entryHigh: 0.00068123,
        stopPrice: 0.00065123,
        targetPrice: 0.00077123,
        signalId: 'S-2608091200-BABYDOGE-L',
      }),
    );
    expect(text.length).toBeLessThanOrEqual(config.publishing.maxSignalChars);
  });

  it('says SHORT for a short', () => {
    const text = formatSignal(
      config,
      plan({ direction: 'short', entryLow: 100, entryHigh: 101, stopPrice: 106, targetPrice: 85 }),
    );
    expect(text).toContain('SHORT');
    expect(text).not.toContain('LONG');
  });
});

describe('formatStatus', () => {
  it('uses a distinct operational header and respects the same character budget', () => {
    const text = formatStatus(config, 'regime unfavourable — the engine stands down');
    expect(text.startsWith(config.publishing.statusHeader)).toBe(true);
    expect(text.startsWith(config.publishing.perpHeader)).toBe(false);
    expect(text.length).toBeLessThanOrEqual(config.publishing.maxSignalChars);
  });
});

describe('validateSignal — acceptance', () => {
  it('passes a well-formed long', () => {
    expect(check(plan())).toEqual({ ok: true });
  });

  it('passes a well-formed short', () => {
    // Risk off the band low: 106 - 100 = 6, so the target must be at most 82.
    const short = plan({ direction: 'short', stopPrice: 106, scaleOutPrice: 88, targetPrice: 82 });
    expect(check(short)).toEqual({ ok: true });
  });
});

describe('validateSignal — rejection', () => {
  it('rejects a missing or inexact header', () => {
    const text = formatSignal(config, plan()).replace('[Perpetual Signal]', '[Signal]');
    expect(reasonsOf(check(plan(), text)).join(' ')).toMatch(/exact header/);
  });

  it('rejects a header that is present but not at the start', () => {
    // A leading prefix is enough to change how the classifier reads the message.
    const text = `FYI ${formatSignal(config, plan())}`;
    expect(reasonsOf(check(plan(), text)).join(' ')).toMatch(/exact header/);
  });

  it('rejects text over the character limit', () => {
    const text = formatSignal(config, plan()) + ' x'.repeat(config.publishing.maxSignalChars);
    expect(reasonsOf(check(plan(), text)).join(' ')).toMatch(/over the 200 limit/);
  });

  it('rejects an instrument the venue does not list', () => {
    const dead = plan({ instId: 'DELISTED-USDT-SWAP' });
    expect(reasonsOf(check(dead)).join(' ')).toMatch(/not a live instrument/);
  });

  it('rejects a signal whose id is missing from the text, breaking traceability', () => {
    const text = formatSignal(config, plan()).replace('S-2608091200-BTC-L', 'S-OTHER');
    expect(reasonsOf(check(plan(), text)).join(' ')).toMatch(/signal id/);
  });

  it('rejects an id containing whitespace, which would not survive parsing', () => {
    expect(reasonsOf(check(plan({ signalId: 'S 1' }))).join(' ')).toMatch(/no whitespace/);
  });

  it('rejects relative price language', () => {
    for (const phrase of ['entry at market', 'around 100', 'stop ~95']) {
      const text = `${formatSignal(config, plan())} ${phrase}`;
      expect(reasonsOf(check(plan(), text)).join(' ')).toMatch(/relative-price phrase/);
    }
  });

  it('rejects a size that is not expressed as a percentage', () => {
    const text = formatSignal(config, plan()).replace('Position 2%', 'Position 6.4 USDT');
    const reasons = reasonsOf(check(plan(), text)).join(' ');
    expect(reasons).toMatch(/percentage 2%/);
  });

  it('rejects a non-positive size', () => {
    expect(reasonsOf(check(plan({ sizePercent: 0 }))).join(' ')).toMatch(/positive percentage/);
  });

  it('rejects an inverted entry band', () => {
    expect(reasonsOf(check(plan({ entryLow: 101, entryHigh: 100 }))).join(' ')).toMatch(
      /entry band is inverted/,
    );
  });

  it('rejects a stop on the wrong side of the entry', () => {
    // Publishing an inverted stop is worse than publishing nothing: it is an
    // instruction to take the trade with the risk control facing backwards.
    expect(reasonsOf(check(plan({ stopPrice: 105 }))).join(' ')).toMatch(/long stop is not below/);

    const short = plan({ direction: 'short', stopPrice: 94, targetPrice: 82 });
    expect(reasonsOf(check(short)).join(' ')).toMatch(/short stop is not above/);
  });

  it('rejects a target on the wrong side of the entry', () => {
    expect(reasonsOf(check(plan({ targetPrice: 99 }))).join(' ')).toMatch(/long target is not above/);
  });

  it('rejects a payoff ratio that rounding has shaved below the minimum', () => {
    // The ratio a follower can actually achieve is the one measured off the
    // published numbers, not the one the engine computed before rounding.
    const thin = plan({ targetPrice: 115 }); // (115-101)/(101-95) = 2.33
    expect(reasonsOf(check(thin)).join(' ')).toMatch(/payoff ratio 2\.33 is below the 3/);
  });

  it('rejects a signal that has already expired', () => {
    expect(reasonsOf(check(plan({ validUntilMs: NOW - 1 }))).join(' ')).toMatch(/already expired/);
  });

  it('reports every failure, not just the first', () => {
    const bad = plan({
      instId: 'DELISTED-USDT-SWAP',
      stopPrice: 105,
      targetPrice: 99,
      validUntilMs: NOW - 1,
    });
    expect(reasonsOf(check(bad)).length).toBeGreaterThanOrEqual(4);
  });
});

describe('buildSignal', () => {
  it('returns the text when the plan is valid', () => {
    expect(buildSignal(config, plan(), context())).toContain('[Perpetual Signal]');
  });

  it('throws rather than returning an invalid signal', () => {
    // There is no skip-and-continue: an invalid signal must not be publishable
    // by any caller that forgot to check a return value.
    expect(() => buildSignal(config, plan({ stopPrice: 105 }), context())).toThrow(SignalError);
  });

  it('names the signal and every reason in the failure', () => {
    try {
      buildSignal(config, plan({ stopPrice: 105, validUntilMs: NOW - 1 }), context());
      throw new Error('expected a refusal');
    } catch (error) {
      expect((error as Error).message).toMatch(/S-2608091200-BTC-L/);
      expect((error as Error).message).toMatch(/stop is not below/);
      expect((error as Error).message).toMatch(/already expired/);
    }
  });
});

describe('SignalCycle accounting', () => {
  it('balances when every generated signal is delivered or rejected', () => {
    const cycle = new SignalCycle();
    cycle.generated();
    cycle.delivered();
    cycle.generated();
    cycle.rejected();

    expect(cycle.counts).toEqual({ generated: 2, delivered: 1, rejected: 1 });
    expect(() => cycle.assertBalanced()).not.toThrow();
  });

  it('balances trivially on a cycle that produced nothing', () => {
    expect(() => new SignalCycle().assertBalanced()).not.toThrow();
  });

  it('catches a signal dropped without a record', () => {
    // This is the failure whose only evidence is an absence: an early return or
    // a swallowed exception between generation and delivery.
    const cycle = new SignalCycle();
    cycle.generated();
    cycle.generated();
    cycle.delivered();

    expect(() => cycle.assertBalanced()).toThrow(/generated 2/);
    expect(() => cycle.assertBalanced()).toThrow(/dropped without a record/);
  });

  it('catches delivery of something that was never generated', () => {
    const cycle = new SignalCycle();
    cycle.delivered();
    expect(() => cycle.assertBalanced()).toThrow(SignalError);
  });
});

describe('published leverage', () => {
  it('publishes the EMERGENT leverage, which is the position size in other units', () => {
    // The spec's canonical example says "LONG 3x". Publishing a nominal 3x while
    // placing 0.8x is precisely the published-does-not-equal-placed failure Law
    // 6 exists to prevent. notional/equity IS sizePercent, so there is no third
    // number to invent.
    expect(leverageFor(80)).toBe(0.8);
    expect(leverageFor(250)).toBe(2.5);
    expect(formatSignal(config, plan({ sizePercent: 80 }))).toContain('LONG 0.8x');
    expect(formatSignal(config, plan({ sizePercent: 80 }))).toContain('Position 80%');
  });

  it('rejects a text whose stated leverage contradicts its stated size', () => {
    // The redundancy is the point: two published fields carrying one quantity
    // are checked against each other, so a change to one formatter and not the
    // other is caught at the gate rather than shipped as a signal.
    const text = formatSignal(config, plan({ sizePercent: 80 })).replace('0.8x', '3x');
    expect(reasonsOf(check(plan({ sizePercent: 80 }), text)).join(' ')).toMatch(/emergent leverage 0.8x/);
  });
});

describe('TP1 and TP2', () => {
  it('publishes both, because they describe different events', () => {
    const text = formatSignal(config, plan());
    expect(text).toContain('TP1 113');
    expect(text).toContain('TP2 119');
  });

  it('rejects a TP1 beyond TP2, which could never fire first', () => {
    expect(reasonsOf(check(plan({ scaleOutPrice: 125 }))).join(' ')).toMatch(/TP1 must sit above/);
  });

  it('rejects a TP1 inside the entry band, which would fire on entry', () => {
    expect(reasonsOf(check(plan({ scaleOutPrice: 100.5 }))).join(' ')).toMatch(/TP1 must sit above/);
  });

  it('checks the payoff ratio against TP2, the level that qualified the trade', () => {
    // TP1 is a scale-out of a quarter; the ratio a subscriber can evaluate is
    // the one measured to the screening target.
    expect(reasonsOf(check(plan({ targetPrice: 110 }))).join(' ')).toMatch(/payoff ratio/);
  });
});

describe('exit signals', () => {
  const exit = (overrides: Partial<ExitSignalPlan> = {}): ExitSignalPlan => ({
    exitId: 'X-2608091400-BTC-S',
    refSignalId: 'S-2608091200-BTC-L',
    instId: INST,
    direction: 'long',
    action: { kind: 'close', percent: 25 },
    price: 113,
    reason: 'reached +2.00R, taking 25% off',
    ...overrides,
  });

  it('renders a scale-out under the character budget with the same header', () => {
    // Same header, so the ASP classifier reads it as `perp` exactly as it reads
    // an entry. A different header would classify half our traffic as text.
    const text = formatExitSignal(config, exit());
    expect(text.startsWith(config.publishing.perpHeader)).toBe(true);
    expect(text.length).toBeLessThanOrEqual(config.publishing.maxSignalChars);
    expect(text).toContain('EXIT LONG');
    expect(text).toContain('CLOSE 25%');
  });

  it('renders a full close and a stop move', () => {
    expect(formatExitSignal(config, exit({ action: { kind: 'close', percent: 100 } }))).toContain('CLOSE 100%');
    expect(formatExitSignal(config, exit({ action: { kind: 'stop', to: 105 } }))).toContain('SL 105');
  });

  it('always references the entry signal it acts on', () => {
    // Without the reference an exit fill is an orphan from the auditor's side —
    // a trade with no corresponding signal, which is the gap this whole feature
    // exists to close.
    expect(formatExitSignal(config, exit())).toContain('ref S-2608091200-BTC-L');
    const orphan = formatExitSignal(config, exit()).replace('S-2608091200-BTC-L', 'S-OTHER');
    expect(reasonsOf(validateExitSignal(config, orphan, exit()))).toContainEqual(
      expect.stringMatching(/does not reference the entry signal/),
    );
  });

  it('rejects a close percentage outside (0, 100]', () => {
    for (const percent of [0, -5, 101]) {
      const plan = exit({ action: { kind: 'close', percent } });
      expect(reasonsOf(validateExitSignal(config, formatExitSignal(config, plan), plan)).join(' ')).toMatch(
        /close percentage/,
      );
    }
  });

  it('does NOT apply the entry gate — an exit describes a trade that already happened', () => {
    // The asymmetry is deliberate. An entry is validated before the trade, so a
    // failure costs a trade we were not obliged to take. An exit is validated
    // after the close, so a geometry or payoff check could only ever refuse to
    // describe something that has already occurred.
    const text = buildExitSignal(config, exit({ action: { kind: 'stop', to: 1 } }));
    expect(text).toContain('SL 1');
  });

  it('throws rather than returning an unpublishable exit record', () => {
    expect(() => buildExitSignal(config, exit({ exitId: 'X 1' }))).toThrow(SignalError);
  });
});
