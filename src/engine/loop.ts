/**
 * The engine loop — the piece that joins everything else.
 *
 * Every module it calls is already tested in isolation. What this file adds is
 * ORDER, and the order is the design:
 *
 *   1. Reconcile against the venue.
 *   2. Manage existing positions (E5).
 *   3. Check the governor.
 *   4. Only then look for new entries (E1-E4 -> size -> publish -> execute).
 *
 * Managing risk precedes taking it. That ordering is not stylistic: steps 1-2
 * must run even when the regime is unfavourable, even when the kill switch is
 * tripped, and even when the governor has halted trading — a halted engine that
 * stops managing its open positions has not become safe, it has become an
 * abandoned book. Only step 4 is gated.
 *
 * The cycle is also ACCOUNTED. `SignalCycle` asserts that every signal
 * generated was either delivered or recorded as rejected, and the assertion
 * runs in a `finally`, so a mid-cycle throw still cannot hide a dropped signal.
 * That failure has no other trace: the only evidence is an absence.
 *
 * Law 6 runs through the whole of step 4 in one direction: the engine decides,
 * publishes, and only then executes what it published. There is deliberately no
 * path from a decision to an order that does not pass through the published
 * text — `executeSignal` takes a string, not a plan.
 */

import {
  competitionPhase,
  entriesPermitted,
  requireMaxLeverage,
  type CompetitionPhase,
  type Config,
  type Stage,
} from '../config.js';
import {
  accrueFundingUsdt,
  costBreakdown,
  describeCosts,
  tradingFeesUsdt,
  type CostBreakdown,
  type FundingExposure,
} from '../fees.js';
import type { KillSwitch } from '../kill-switch.js';
import type { Ledger } from '../ledger.js';
import {
  computeSize,
  determineStage,
  governorAction,
  RiskRefusal,
  type EquityState,
  type GovernorAction,
  type OpenRisk,
} from '../risk.js';
import {
  buildExitSignal,
  buildSignal,
  SignalCycle,
  SignalError,
  roundPlan,
  type ExitSignalPlan,
  type SignalPlan,
} from '../signal/publish.js';
import { baseSymbol } from '../signal/scanner.js';
import { evaluateExit, type ExitPlan, type MarketState } from '../signal/exits.js';
import type { EntryCandidate } from '../signal/entry.js';
import type { Instrument } from '../execution/adapter.js';
import type { CopyExecutor, ExecutionOutcome } from '../execution/copy.js';
import type { FeedFreshness, GuardedExecutor } from '../execution/guarded.js';
import { EngineState, trackNewPosition, withObservedPrice, type TrackedPosition } from './state.js';

export class EngineError extends Error {
  override readonly name = 'EngineError';
}

/**
 * Delivers a signal to the ASP.
 *
 * Injected rather than built here because the ASP is both the eligibility
 * requirement and, under v2, the signal source. `publish` must resolve only
 * once the signal is actually delivered — resolving optimistically would let
 * the engine execute a trade whose published record never arrived, which is the
 * precise inversion of Law 6.
 */
export interface SignalPublisher {
  publish(text: string): Promise<void>;
}

/** What the scanner produced this cycle. Supplied by the caller so the loop stays testable. */
export interface ScanResult {
  readonly candidates: readonly EntryCandidate[];
  /** False when E2 stood the engine down. Standing down is a valid output. */
  readonly regimeFavourable: boolean;
  /** Last traded price per instrument, for exit evaluation. */
  readonly lastPrices: ReadonlyMap<string, number>;
  /** Current ATR per instrument, for the Chandelier trail. */
  readonly atrByInstrument: ReadonlyMap<string, number>;
  /**
   * Current funding rate per instrument, for E7's accrual.
   *
   * The scan already fetches these for E2, so carrying them through costs one
   * map and avoids a second round of requests for numbers we hold.
   */
  readonly fundingRates: ReadonlyMap<string, number>;
  /** Freshness of the feeds this scan depended on. Passed straight to the guard. */
  readonly feeds: readonly FeedFreshness[];
}

export interface EngineDeps {
  readonly config: Config;
  readonly state: EngineState;
  readonly ledger: Ledger;
  readonly killSwitch: KillSwitch;
  readonly executor: GuardedExecutor;
  readonly copyExecutor: CopyExecutor;
  readonly publisher: SignalPublisher;
  readonly instruments: ReadonlyMap<string, Instrument>;
  /** Account equity in USDT, including unrealised. Read once per cycle. */
  readonly readEquity: () => Promise<number>;
  /**
   * Whether we hold top-3 with cushion. `null` when the leaderboard is
   * unavailable or stale, which keeps Stage 3 unreachable — defending a rank
   * you cannot measure is guessing.
   */
  readonly readRankCushion: () => Promise<boolean | null>;
  readonly now?: () => number;
}

export interface CycleReport {
  readonly stage: Stage;
  readonly governor: GovernorAction;
  /** Where the cycle found itself on the competition clock. */
  readonly phase: CompetitionPhase;
  /** E7 — fees measured, funding modelled, and whether the budget is spent. */
  readonly costs: CostBreakdown;
  readonly equityUsdt: number;
  readonly peakEquityUsdt: number;
  readonly exits: readonly ExitPlan[];
  readonly outcomes: readonly ExecutionOutcome[];
  readonly signals: { generated: number; delivered: number; rejected: number };
  /** Why no entries were attempted, when none were. Never silence. */
  readonly standDownReason: string | null;
}

/**
 * Correlation group for an instrument, from policy.
 *
 * Everything unclassified lands in ONE shared bucket. The previous behaviour
 * gave each unlisted symbol a private group, which meant the cap could not bind
 * on precisely the part of the universe where it was needed: E3 selects momentum
 * extremes, the extremes in crypto are the memecoin complex, and none of them
 * appear in any hand-written group. A live scan produced five of them at once,
 * every one satisfying a cap of two on its own.
 */
export function correlationGroupFor(config: Config, instId: string): string {
  const base = baseSymbol(instId);
  for (const [group, members] of Object.entries(config.correlationGroups)) {
    if (members.includes(base)) return group;
  }
  return config.ungroupedGroup;
}

/** Exit id: unique per position, per cycle, per kind of action. */
function exitIdFor(instId: string, nowMs: number, code: 'S' | 'C' | 'M'): string {
  const stamp = new Date(nowMs).toISOString().replace(/[-:T.]/g, '').slice(2, 14);
  return `X-${stamp}-${baseSymbol(instId)}-${code}`;
}

export class Engine {
  readonly #deps: EngineDeps;
  readonly #now: () => number;

  constructor(deps: EngineDeps) {
    this.#deps = deps;
    this.#now = deps.now ?? (() => Date.now());
  }

  /**
   * Run one full cycle.
   *
   * Throws only on a fault that must stop the engine — an unbalanced signal
   * cycle, or a venue that cannot be reached. Everything else that prevents a
   * trade is a recorded refusal and a normal result.
   */
  async runCycle(scan: ScanResult): Promise<CycleReport> {
    const { config, state, ledger } = this.#deps;
    const nowMs = this.#now();
    const cycle = new SignalCycle();

    try {
      // 1. Reconcile. Divergence trips the kill switch inside the guard, which
      //    is why this runs before anything reads the position book: acting on a
      //    book we know to be wrong is worse than not acting.
      await this.#deps.executor.reconcile(
        state.positions().map((p) => toVenuePosition(this.#deps.instruments, p)),
      );

      // 2. Exits, always. A halted engine that stops managing open positions has
      //    not become safe — it has become an abandoned book. The competition
      //    phase reaches E5 because Part X is expressed as exit behaviour: at
      //    T-24h losers close and winners move to a tightened trail.
      const phase = competitionPhase(config, nowMs);
      const exits = await this.#manageExits(scan, nowMs, phase);

      // 3. Equity, stage, governor.
      const equityUsdt = await this.#deps.readEquity();
      const peakEquityUsdt = state.observeEquity(equityUsdt);
      const equity: EquityState = { equityUsdt, peakEquityUsdt };
      const stage = determineStage(config, equity, await this.#deps.readRankCushion());
      const governor = governorAction(config, equity, stage);

      // 3b. E7 — costs. Funding is accrued BEFORE the budget is read, so a
      //     window crossed during this cycle counts against this cycle's
      //     decision rather than the next one's.
      const costs = this.#accrueAndMeasureCosts(scan, nowMs);

      const base = {
        stage,
        governor,
        equityUsdt,
        peakEquityUsdt,
        exits,
        phase,
        costs,
      } as const;

      const standDown = (reason: string): CycleReport => {
        ledger.append({
          action: 'refusal',
          engine: 'engine-loop',
          venue: this.#deps.executor.venue,
          instrument: null,
          signal: null,
          price: null,
          size: null,
          stop: null,
          reason: `stand down: ${reason}`,
        });
        return { ...base, outcomes: [], signals: cycle.counts, standDownReason: reason };
      };

      // 4. Entry gates, in order of how badly we want them to stop us.
      //
      //    The competition clock comes FIRST, ahead of every risk gate, because
      //    it is the only one whose breach cannot be undone by any later
      //    decision. A pre-start fill moves equity and does not score; a
      //    post-T-48h fill cannot reach its maximum hold before the snapshot.
      //    Every other gate here is about whether a trade is wise. This one is
      //    about whether it is permitted to exist.
      if (!entriesPermitted(phase)) {
        return standDown(
          phase === 'before'
            ? `competition has not started (opens ${new Date(config.competition.startsAt).toISOString()})`
            : phase === 'after'
              ? 'competition is over — nothing traded now scores'
              : `endgame phase "${phase}" — no new positions inside the last ` +
                `${config.competition.endgame.noNewEntriesHoursBeforeEnd}h`,
        );
      }
      // E7's cap. It halts NEW ENTRIES only — never exits, and never the
      // management of what is already open. Fees are the price of taking
      // positions, so the response to spending the budget is to stop taking
      // them, not to abandon the ones already paid for.
      if (costs.breached) {
        return standDown(`fee budget spent: ${describeCosts(costs)}`);
      }
      if (governor === 'stopForCompetition') {
        return standDown('governor has stopped trading for the competition');
      }
      if (governor === 'flatAndHalt') {
        await this.#flattenAll('governor flatAndHalt');
        return standDown('governor requires flat and halt');
      }
      if (this.#tripped()) {
        return standDown('kill switch is tripped for routeB');
      }
      if (!scan.regimeFavourable) {
        return standDown('regime unfavourable — the engine stands down');
      }

      const outcomes = await this.#takeEntries(scan, equity, stage, cycle, nowMs);
      return { ...base, outcomes, signals: cycle.counts, standDownReason: null };
    } finally {
      // In a finally so a mid-cycle throw still cannot hide a dropped signal.
      // The one failure with no other trace is the one we must not lose to
      // another failure.
      cycle.assertBalanced();
    }
  }

  /**
   * Accrue this cycle's funding and read the fee budget.
   *
   * Funding is charged on the venue's wall-clock schedule, so what is accrued
   * depends on which funding timestamps fell inside the interval since the last
   * accrual — not on how long the cycle took. The mark advances even when
   * nothing is owed, so a flat spell does not bank windows to charge against the
   * next position opened.
   *
   * A position the scan cannot price is skipped rather than fatal. Unlike exit
   * management, where an unpriceable position means trailing a stop off a stale
   * number, an unaccrued funding window makes the budget slightly optimistic —
   * and halting the engine over an accounting approximation would be a worse
   * outcome than the approximation.
   */
  #accrueAndMeasureCosts(scan: ScanResult, nowMs: number): CostBreakdown {
    const { config, state, ledger } = this.#deps;

    const exposures: FundingExposure[] = [];
    for (const position of state.positions()) {
      const price = scan.lastPrices.get(position.instId);
      const fundingRate = scan.fundingRates.get(position.instId);
      if (price === undefined || fundingRate === undefined) continue;

      const instrument = this.#instrument(position.instId);
      const coins =
        (Number(BigInt(position.venueSize)) / 10 ** instrument.sizeDecimals) *
        (instrument.contractValue ?? 1);

      exposures.push({
        instId: position.instId,
        side: position.side,
        notionalUsdt: Math.abs(coins * price) * position.remainingFraction,
        fundingRate,
      });
    }

    // A cold start has no mark. Accruing from epoch zero would charge every
    // funding window since 1970; starting the mark here loses at most the
    // current window, which is the honest cost of not having been running.
    const from = state.lastFundingAccrualMs === 0 ? nowMs : state.lastFundingAccrualMs;
    const accrued = accrueFundingUsdt(exposures, from, nowMs, config.regime.fundingWindowHours);
    const fundingPaidUsdt = state.accrueFunding(accrued, nowMs);

    if (accrued !== 0) {
      ledger.append({
        action: 'alert',
        engine: 'engine-loop',
        venue: this.#deps.executor.venue,
        instrument: null,
        signal: null,
        price: null,
        size: null,
        stop: null,
        reason: `funding accrued ${accrued.toFixed(4)} USDT (modelled, not read from venue bills)`,
        detail: { fundingPaidUsdt, exposures },
      });
    }

    return costBreakdown(config, tradingFeesUsdt(ledger), fundingPaidUsdt);
  }

  #tripped(): boolean {
    try {
      this.#deps.killSwitch.assertClear('routeB');
      return false;
    } catch {
      return true;
    }
  }

  /**
   * Carry out E5's decisions for every open position.
   *
   * The plan is computed from state the engine holds, then applied. Note the
   * anchors are advanced BEFORE evaluation: a stop must be derived from the
   * extreme including this bar, or the trail lags a cycle behind the price that
   * justified it.
   */
  async #manageExits(scan: ScanResult, nowMs: number, phase: CompetitionPhase): Promise<readonly ExitPlan[]> {
    const { config, state, ledger } = this.#deps;
    const plans: ExitPlan[] = [];

    for (const tracked of state.positions()) {
      const lastPrice = scan.lastPrices.get(tracked.instId);
      const atr = scan.atrByInstrument.get(tracked.instId);
      if (lastPrice === undefined || atr === undefined) {
        // A position we cannot price is a position we cannot manage. Loud,
        // because the alternative is trailing a stop off a stale number.
        throw new EngineError(
          `no market data for open position ${tracked.instId} — refusing to manage it blind`,
        );
      }

      const advanced = withObservedPrice(tracked, lastPrice);
      state.update(advanced);

      const market: MarketState = {
        lastPrice,
        highestHighSinceEntry: advanced.highWaterPrice,
        lowestLowSinceEntry: advanced.lowWaterPrice,
        atr,
        nowMs,
      };
      const plan = evaluateExit(config, advanced, market, phase);
      plans.push(plan);

      for (const action of plan.actions) {
        if (action.kind === 'hold') continue;

        if (action.kind === 'close_full') {
          const instrument = this.#instrument(tracked.instId);
          await this.#deps.executor.flatten(instrument, `${advanced.signalId}: ${action.reason}`);
          state.close(tracked.instId, action.cooldownUntilMs);
          ledger.append({
            action: 'position_closed',
            engine: 'engine-loop',
            venue: this.#deps.executor.venue,
            instrument: tracked.instId,
            signal: advanced.signalId,
            price: String(lastPrice),
            size: advanced.venueSize,
            stop: String(advanced.currentStop),
            reason: `full: ${action.reason}`,
            // R is what Part VIII measures. Recorded numerically here because
            // parsing it back out of the reason string would make the daily
            // attribution depend on prose.
            detail: { rMultiple: plan.rMultiple, fraction: advanced.remainingFraction, terminal: true },
          });
          await this.#publishExit(advanced, nowMs, lastPrice, action.reason, 'C', {
            kind: 'close',
            percent: advanced.remainingFraction * 100,
          });
          break; // Terminal. Nothing after a close applies to this position.
        }

        if (action.kind === 'move_stop') {
          state.update({ ...advanced, currentStop: action.to });
          ledger.append({
            action: 'stop_attached',
            engine: 'engine-loop',
            venue: this.#deps.executor.venue,
            instrument: tracked.instId,
            signal: advanced.signalId,
            price: null,
            size: null,
            stop: String(action.to),
            reason: action.reason,
          });
          await this.#publishExit(advanced, nowMs, lastPrice, action.reason, 'M', {
            kind: 'stop',
            to: action.to,
          });
        }

        if (action.kind === 'scale_out') {
          state.update({
            ...advanced,
            scaledOut: true,
            remainingFraction: advanced.remainingFraction * (1 - action.fraction),
          });
          ledger.append({
            action: 'position_closed',
            engine: 'engine-loop',
            venue: this.#deps.executor.venue,
            instrument: tracked.instId,
            signal: advanced.signalId,
            price: String(lastPrice),
            size: null,
            stop: null,
            reason: `partial: ${action.reason}`,
            detail: { rMultiple: plan.rMultiple, fraction: action.fraction, terminal: false },
          });
          await this.#publishExit(advanced, nowMs, lastPrice, action.reason, 'S', {
            kind: 'close',
            percent: action.fraction * 100,
          });
        }
      }
    }

    return plans;
  }

  /**
   * Publish an exit action AFTER it has been carried out.
   *
   * The ordering is the inverse of an entry, and deliberately so.
   *
   * An entry publishes first and trades only if delivery succeeded, because an
   * untraceable entry is a rule breach we chose to commit and declining to trade
   * costs nothing but an opportunity. An exit has already happened by the time
   * this runs. Gating the close on the publisher being reachable would mean a
   * dead ASP leaves us unable to cut a losing position — trading eligibility
   * bought with unbounded risk, which is not a trade worth making.
   *
   * So a failure here NEVER propagates. It is recorded as an alert, because a
   * fill with no published signal is a real correspondence gap that someone has
   * to know about; it is simply not a reason to have kept the position.
   */
  async #publishExit(
    position: TrackedPosition,
    nowMs: number,
    lastPrice: number,
    reason: string,
    code: 'S' | 'C' | 'M',
    action: ExitSignalPlan['action'],
  ): Promise<void> {
    const { config, ledger } = this.#deps;
    if (!config.publishing.publishExits) return;

    const plan: ExitSignalPlan = {
      exitId: exitIdFor(position.instId, nowMs, code),
      refSignalId: position.signalId,
      instId: position.instId,
      direction: position.side,
      action,
      price: lastPrice,
      reason,
    };

    try {
      const text = buildExitSignal(config, plan);
      await this.#deps.publisher.publish(text);
      ledger.append({
        action: 'signal_published',
        engine: 'engine-loop',
        venue: this.#deps.executor.venue,
        instrument: position.instId,
        signal: plan.exitId,
        price: String(lastPrice),
        size: null,
        stop: action.kind === 'stop' ? String(action.to) : null,
        reason: text,
        detail: { exitOf: position.signalId },
      });
    } catch (error) {
      // An unpublished exit is a correspondence gap, not an emergency. It is
      // loud in the ledger and invisible to the position, which is correct: the
      // trade is already done and cannot be undone by a failed record.
      ledger.append({
        action: 'alert',
        engine: 'engine-loop',
        venue: this.#deps.executor.venue,
        instrument: position.instId,
        signal: position.signalId,
        price: String(lastPrice),
        size: null,
        stop: null,
        reason:
          `EXIT PUBLISHED FAILED for ${plan.exitId} (${reason}): ${(error as Error).message}. ` +
          'The fill has no corresponding signal — Law 6 gap, investigate before the next cycle.',
      });
    }
  }

  async #flattenAll(reason: string): Promise<void> {
    for (const tracked of this.#deps.state.positions()) {
      await this.#deps.executor.flatten(this.#instrument(tracked.instId), reason);
      this.#deps.state.close(tracked.instId, this.#now());
    }
  }

  /**
   * Size, publish, and execute each accepted candidate.
   *
   * The order inside the loop is the whole point: `computeSize` -> `buildSignal`
   * -> `publish` -> `copyExecutor.execute(text)`. The executor receives the
   * TEXT, never the plan, so there is no path from a decision to an order that
   * bypasses the published record.
   */
  async #takeEntries(
    scan: ScanResult,
    equity: EquityState,
    stage: Stage,
    cycle: SignalCycle,
    nowMs: number,
  ): Promise<readonly ExecutionOutcome[]> {
    const { config, state, ledger } = this.#deps;
    const outcomes: ExecutionOutcome[] = [];

    // Consulted before any candidate is sized: an unverified config must stop
    // the engine, not produce a cycle of individually-refused signals.
    requireMaxLeverage(config);

    const openRisk: OpenRisk[] = state.positions().map((p) => ({
      instrument: p.instId,
      correlationGroup: correlationGroupFor(config, p.instId),
      riskUsdt: openRiskUsdt(this.#instrument(p.instId), p),
      side: p.side,
    }));

    // Strongest conviction first. Position slots and portfolio heat are finite,
    // so the order candidates are considered in decides which ones get them —
    // leaving it to scan order would allocate capital alphabetically.
    const ordered = [...scan.candidates].sort((a, b) => b.conviction.total - a.conviction.total);

    for (const candidate of ordered) {
      const cooldownUntilMs = state.cooldownUntil(candidate.instId, nowMs);
      if (cooldownUntilMs !== undefined) {
        // E4 also checks this, but E4 only sees what it is told. The engine is
        // the only thing that knows, so it must not rely on having passed it in.
        outcomes.push({
          status: 'refused',
          signalId: null,
          reason: `${candidate.instId} is in post-stop cooldown`,
        });
        continue;
      }

      const entryPrice = candidate.direction === 'long' ? candidate.entryBandHigh : candidate.entryBandLow;

      let sizePercent: number;
      try {
        const sized = computeSize(config, {
          stage,
          equity,
          openRisk,
          correlationGroup: correlationGroupFor(config, candidate.instId),
          entryPrice,
          stopPrice: candidate.stopPrice,
          targetPrice: candidate.targetPrice,
          side: candidate.direction,
        });
        // The governor is NOT applied again here. computeSize already halves
        // the risk fraction under `halveSizing`, and halving a second time
        // would quarter the position while the ledger still called it a halve.
        // One owner for one policy.
        sizePercent = (sized.notionalUsdt / equity.equityUsdt) * 100;
      } catch (error) {
        if (!(error instanceof RiskRefusal)) throw error;
        ledger.append({
          action: 'refusal',
          engine: 'engine-loop',
          venue: this.#deps.executor.venue,
          instrument: candidate.instId,
          signal: null,
          price: String(entryPrice),
          size: null,
          stop: String(candidate.stopPrice),
          reason: `${error.code}: ${error.message}`,
        });
        outcomes.push({ status: 'refused', signalId: null, reason: error.message });
        continue;
      }

      const signalId = signalIdFor(candidate, nowMs);
      const plan: SignalPlan = roundPlan({
        signalId,
        instId: candidate.instId,
        direction: candidate.direction,
        entryLow: candidate.entryBandLow,
        entryHigh: candidate.entryBandHigh,
        stopPrice: candidate.stopPrice,
        scaleOutPrice: candidate.scaleOutPrice,
        targetPrice: candidate.targetPrice,
        sizePercent,
        validUntilMs: candidate.validUntilMs,
      });

      // Counted the moment a signal exists. Everything after this either
      // delivers it or rejects it; nothing may return without doing one.
      cycle.generated();

      let text: string;
      try {
        text = buildSignal(config, plan, {
          liveInstruments: new Set(this.#deps.instruments.keys()),
          nowMs,
        });
      } catch (error) {
        if (!(error instanceof SignalError)) throw error;
        cycle.rejected();
        ledger.append({
          action: 'signal_rejected',
          engine: 'engine-loop',
          venue: this.#deps.executor.venue,
          instrument: candidate.instId,
          signal: signalId,
          price: null,
          size: null,
          stop: null,
          reason: error.message,
        });
        outcomes.push({ status: 'refused', signalId, reason: error.message });
        continue;
      }

      // Published BEFORE execution, and awaited. A trade whose signal never
      // arrived is untraceable to a signal, which is a rule breach, not an
      // inefficiency — so a failed publish must stop this candidate dead.
      try {
        await this.#deps.publisher.publish(text);
      } catch (error) {
        cycle.rejected();
        ledger.append({
          action: 'signal_rejected',
          engine: 'engine-loop',
          venue: this.#deps.executor.venue,
          instrument: candidate.instId,
          signal: signalId,
          price: null,
          size: null,
          stop: null,
          reason: `delivery failed, not trading it: ${(error as Error).message}`,
        });
        outcomes.push({ status: 'refused', signalId, reason: `delivery failed: ${(error as Error).message}` });
        continue;
      }

      cycle.delivered();
      ledger.append({
        action: 'signal_published',
        engine: 'engine-loop',
        venue: this.#deps.executor.venue,
        instrument: candidate.instId,
        signal: signalId,
        price: String(plan.entryHigh),
        size: String(plan.sizePercent),
        stop: String(plan.stopPrice),
        reason: text,
        detail: { conviction: candidate.conviction },
      });

      const outcome = await this.#deps.copyExecutor.execute(text, nowMs, scan.feeds);
      outcomes.push(outcome);

      if (outcome.status === 'submitted') {
        state.open(
          trackNewPosition({
            instId: candidate.instId,
            signalId,
            side: candidate.direction,
            entryPrice,
            initialStop: plan.stopPrice,
            openedAtMs: nowMs,
            venueSize: outcome.size,
          }),
        );
        // Added to the running heat so the NEXT candidate in this same cycle is
        // sized against a book that includes this position. Without it, three
        // candidates in one cycle would each be sized as though flat.
        openRisk.push({
          instrument: candidate.instId,
          correlationGroup: correlationGroupFor(config, candidate.instId),
          side: candidate.direction,
          riskUsdt: openRiskUsdt(this.#instrument(candidate.instId), {
            entryPrice,
            currentStop: plan.stopPrice,
            remainingFraction: 1,
            venueSize: outcome.size.toString(),
          }),
        });
      }
    }

    return outcomes;
  }

  #instrument(instId: string): Instrument {
    const instrument = this.#deps.instruments.get(instId);
    if (instrument === undefined) {
      throw new EngineError(`no discovered instrument for ${instId}`);
    }
    return instrument;
  }
}

/**
 * USDT at risk on an open position: stop distance times the position's actual
 * size, times what is left of it.
 *
 * The size conversion is the part that is easy to get wrong and expensive to
 * get wrong. `venueSize` is in CONTRACT minor units, so it needs both the lot
 * scale and the contract multiplier to become coins. Using the raw stop
 * distance instead — a price, not an amount — reads as hundreds of percent of
 * portfolio heat and refuses every subsequent trade.
 */
export function openRiskUsdt(
  instrument: Instrument,
  position: { entryPrice: number; currentStop: number; remainingFraction: number; venueSize: string },
): number {
  const coins =
    (Number(BigInt(position.venueSize)) / 10 ** instrument.sizeDecimals) * (instrument.contractValue ?? 1);
  return Math.abs(position.entryPrice - position.currentStop) * coins * position.remainingFraction;
}

/**
 * Signal id: sortable, unique per instrument and direction, and alphanumeric
 * once punctuation is stripped for the client order id.
 */
export function signalIdFor(candidate: EntryCandidate, nowMs: number): string {
  const stamp = new Date(nowMs).toISOString().replace(/[-:T.]/g, '').slice(2, 14);
  const side = candidate.direction === 'long' ? 'L' : 'S';
  return `S-${stamp}-${baseSymbol(candidate.instId)}-${side}`;
}

/** A tracked position in the shape the reconciler compares against venue truth. */
function toVenuePosition(instruments: ReadonlyMap<string, Instrument>, tracked: TrackedPosition) {
  const instrument = instruments.get(tracked.instId);
  if (instrument === undefined) {
    throw new EngineError(`no discovered instrument for tracked position ${tracked.instId}`);
  }
  // Only `symbol`, `side` and `size` are compared by the reconciler; the rest
  // describe venue truth, which is exactly what we are checking ourselves
  // against and must therefore not assert.
  return {
    instrument,
    side: tracked.side,
    size: BigInt(tracked.venueSize),
    entryPrice: 0n,
    markPrice: 0n,
    unrealisedPnlQuote: 0n,
    stopPrice: null,
    stopRestingOnVenue: false,
  } as const;
}
