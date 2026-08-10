/**
 * Offline replay of the trading pipeline.
 *
 * This is deliberately a replay, not a second strategy implementation. Each
 * decision bar calls the same E1 universe filter, E2 regime gate, E3 ranking,
 * E4 entry evaluator and E5 exit evaluator used by the live engine.
 *
 * The execution model is explicit:
 *   - only closed bars are visible at a decision timestamp;
 *   - an entry signal created at bar close can fill on the next bar at the
 *     published limit price or a better opening price, never by look-ahead;
 *   - a stop is checked against the next bar's adverse extreme;
 *   - if a bar contains both an old stop and a favourable trigger, the old
 *     stop wins (conservative OHLC ordering);
 *   - scale-outs and trailing moves use the pure E5 function at bar close.
 *
 * This makes the assumptions inspectable instead of hiding them in a number
 * called "backtest result". It is enough to answer whether the strategy has
 * the requested payoff/frequency shape; it is not a substitute for the Part IX
 * venue stop-custody test or live fill/slippage evidence.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  competitionPhase,
  type CompetitionPhase,
  type Config,
} from '../config.js';
import { accrueFundingUsdt, fundingTimestampsBetween } from '../fees.js';
import type { FundingPoint, Candle, InstrumentSpec, TickerSnapshot } from '../market/okx.js';
import { atr } from '../signal/indicators.js';
import { evaluateEntry, type EntryCandidate } from '../signal/entry.js';
import {
  evaluateExit,
  rMultiple,
  type Side,
} from '../signal/exits.js';
import {
  assessRegime,
  rankByMomentum,
  regimeIsFavourable,
  selectUniverseWithRejections,
  takeExtremes,
  type Direction,
} from '../signal/scanner.js';
import {
  evaluateMajorEntry,
  evaluateMajorBreakoutEntry,
  evaluateMajorPullbackEntry,
  majorBreakoutDirection,
  majorPullbackDirection,
  majorSignal,
} from '../signal/major.js';
import { assertAboveEligibilityFloor, computeSize, determineStage, type OpenRisk } from '../risk.js';
import { correlationGroupFor } from '../engine/loop.js';

export class ReplayError extends Error {
  override readonly name = 'ReplayError';
}

export interface ReplayInstrument {
  readonly instId: string;
  readonly spec: InstrumentSpec;
  /** Historical spread is not present in candle data; this is an explicit assumption. */
  readonly spreadBps: number;
  readonly candles1h: readonly Candle[];
  readonly candles4h: readonly Candle[];
  /** Optional Binance USDⓈ-M candles used only by research signal features. */
  readonly binanceCandles1h?: readonly Candle[];
  readonly binanceCandles4h?: readonly Candle[];
  readonly funding?: readonly FundingPoint[];
  /** Used only when no funding history was recorded for this instrument. */
  readonly defaultFundingRate?: number;
}

export interface ReplayDataset {
  readonly initialEquityUsdt: number;
  readonly instruments: readonly ReplayInstrument[];
  /** Preferred study range; the recorder may include warm-up bars before it. */
  readonly replayFromMs?: number;
  readonly replayToMs?: number;
}

export interface ReplayOptions {
  readonly config: Config;
  readonly dataset: ReplayDataset;
  readonly fromMs?: number;
  readonly toMs?: number;
  readonly oneHourHistoryBars?: number;
  readonly fourHourHistoryBars?: number;
  /** Backtest-only risk cap. Omit to measure strategy sizing without Part IX. */
  readonly maxLeverage?: number;
  /** Maker fee assumption; pass the verified runtime profile value for net results. */
  readonly tradingFeeRateFraction?: number;
  /** Applied to entry and exit prices as a deterministic stress assumption. */
  readonly slippageBps?: number;
  /** Apply the competition clock. Disabled by default for a rolling historical study. */
  readonly respectCompetitionClock?: boolean;
  /** Offline candidate strategy. The default preserves the production path. */
  readonly strategy?: 'breakout' | 'major-macd' | 'major-macd-long' | 'major-pullback' | 'major-breakout';
}

export interface ReplayTrade {
  readonly instId: string;
  readonly side: Side;
  readonly openedAtMs: number;
  readonly closedAtMs: number;
  readonly exitReason: string;
  readonly grossPnlUsdt: number;
  readonly fundingPnlUsdt: number;
  readonly tradingFeesUsdt: number;
  readonly netPnlUsdt: number;
  readonly rMultipleAtClose: number;
  readonly maxFavourableR: number;
}

export interface ReplayOpenPosition {
  readonly instId: string;
  readonly side: Side;
  readonly openedAtMs: number;
  readonly entryPrice: number;
  readonly currentStop: number;
  readonly remainingFraction: number;
  readonly unrealisedPnlUsdt: number;
}

export interface ReplayResult {
  readonly fromMs: number;
  readonly toMs: number;
  readonly observedDays: number;
  readonly initialEquityUsdt: number;
  readonly finalEquityUsdt: number;
  readonly netPnlUsdt: number;
  readonly returnFraction: number;
  readonly peakEquityUsdt: number;
  readonly maxDrawdownFraction: number;
  readonly entries: number;
  readonly closedTrades: number;
  readonly wins: number;
  readonly losses: number;
  readonly scratches: number;
  readonly winRate: number;
  /** Average winning trade net PnL divided by absolute average losing trade net PnL. */
  readonly realisedPayoffRatio: number;
  /** Sum of winning trade net PnL divided by absolute sum of losing trade net PnL. */
  readonly profitFactor: number;
  readonly averageNetPnlUsdt: number;
  readonly tradesPerDay: number;
  readonly timeStopHitRate: number;
  readonly totalTradingFeesUsdt: number;
  readonly totalFundingUsdt: number;
  readonly maximumObservedLeverage: number;
  readonly regimeFavourableCycles: number;
  readonly scanCycles: number;
  readonly universeSizes: readonly number[];
  readonly minimumUniverseSize: number;
  readonly averageUniverseSize: number;
  readonly maximumUniverseSize: number;
  readonly trades: readonly ReplayTrade[];
  readonly openPositions: readonly ReplayOpenPosition[];
  readonly assumptions: readonly string[];
}

interface Position {
  instId: string;
  side: Side;
  entryPrice: number;
  initialStop: number;
  currentStop: number;
  remainingFraction: number;
  openedAtMs: number;
  scaledOut: boolean;
  size: number;
  signalId: string;
  highWaterPrice: number;
  lowWaterPrice: number;
  fundingMarkMs: number;
  grossPnlUsdt: number;
  fundingPnlUsdt: number;
  tradingFeesUsdt: number;
  maxFavourableR: number;
  maxObservedLeverage: number;
}

interface PendingEntry {
  readonly candidate: EntryCandidate;
  readonly createdAtMs: number;
}

interface ScanSnapshot {
  readonly candidates: readonly EntryCandidate[];
  readonly regimeFavourable: boolean;
  readonly universeSize: number;
  readonly lastPrices: ReadonlyMap<string, number>;
  readonly atrByInstrument: ReadonlyMap<string, number>;
  readonly fundingRates: ReadonlyMap<string, number>;
}

const HOUR_MS = 3_600_000;
const FOUR_HOUR_MS = 4 * HOUR_MS;
const DEFAULT_1H_HISTORY = 120;
const DEFAULT_4H_HISTORY = 60;

function assertFinitePositive(value: number, name: string): void {
  if (!Number.isFinite(value) || value <= 0) throw new ReplayError(`${name} must be positive and finite`);
}

function validateCandles(instId: string, candles: readonly Candle[], name: string): void {
  if (candles.length === 0) throw new ReplayError(`${instId} has no ${name} candles`);
  let previous = -Infinity;
  for (const candle of candles) {
    if (!Number.isFinite(candle.openTimeMs) || candle.openTimeMs <= previous) {
      throw new ReplayError(`${instId} ${name} candles are not strictly chronological`);
    }
    if (!candle.confirmed) throw new ReplayError(`${instId} ${name} contains an unconfirmed candle`);
    for (const [field, value] of Object.entries(candle)) {
      if (field === 'confirmed') continue;
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new ReplayError(`${instId} ${name} candle field ${field} is not finite`);
      }
    }
    if (candle.open <= 0 || candle.high <= 0 || candle.low <= 0 || candle.close <= 0) {
      throw new ReplayError(`${instId} ${name} contains a non-positive price`);
    }
    previous = candle.openTimeMs;
  }
}

export function validateReplayDataset(dataset: ReplayDataset): void {
  assertFinitePositive(dataset.initialEquityUsdt, 'initial equity');
  if (dataset.instruments.length === 0) throw new ReplayError('replay dataset has no instruments');

  const ids = new Set<string>();
  for (const instrument of dataset.instruments) {
    if (ids.has(instrument.instId)) throw new ReplayError(`duplicate instrument ${instrument.instId}`);
    ids.add(instrument.instId);
    if (!instrument.instId.endsWith('-USDT-SWAP')) {
      throw new ReplayError(`${instrument.instId} is not a USDT perpetual`);
    }
    if (!Number.isFinite(instrument.spreadBps) || instrument.spreadBps < 0) {
      throw new ReplayError(`${instrument.instId} spread must be finite and non-negative`);
    }
    validateCandles(instrument.instId, instrument.candles1h, '1h');
    validateCandles(instrument.instId, instrument.candles4h, '4h');
    if (instrument.binanceCandles1h !== undefined) validateCandles(instrument.instId, instrument.binanceCandles1h, 'Binance 1h');
    if (instrument.binanceCandles4h !== undefined) validateCandles(instrument.instId, instrument.binanceCandles4h, 'Binance 4h');
    let previousFunding = -Infinity;
    for (const point of instrument.funding ?? []) {
      if (!Number.isFinite(point.timestampMs) || !Number.isFinite(point.fundingRate)) {
        throw new ReplayError(`${instrument.instId} has an invalid funding point`);
      }
      if (point.timestampMs <= previousFunding) {
        throw new ReplayError(`${instrument.instId} funding history is not strictly chronological`);
      }
      previousFunding = point.timestampMs;
    }
    if (instrument.defaultFundingRate !== undefined && !Number.isFinite(instrument.defaultFundingRate)) {
      throw new ReplayError(`${instrument.instId} default funding rate is not finite`);
    }
  }
}

/** Parse the JSON format emitted by `src/scripts/record-candles.ts`. */
export function loadReplayDataset(path: string): ReplayDataset {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(resolve(path), 'utf8'));
  } catch (cause) {
    throw new ReplayError(`cannot read replay dataset at ${resolve(path)}`, { cause });
  }

  const root = parsed as { initialEquityUsdt?: unknown; instruments?: unknown; fromMs?: unknown; toMs?: unknown };
  if (typeof root.initialEquityUsdt !== 'number' || !Array.isArray(root.instruments)) {
    throw new ReplayError('replay dataset needs initialEquityUsdt and an instruments array');
  }

  const instruments = root.instruments.map((raw, index) => {
    const row = raw as Record<string, unknown>;
    const spec = row.spec as InstrumentSpec;
    const candles1h = row.candles1h as Candle[];
    const candles4h = row.candles4h as Candle[];
    const binanceCandles1h = row.binanceCandles1h as Candle[] | undefined;
    const binanceCandles4h = row.binanceCandles4h as Candle[] | undefined;
    if (typeof row.instId !== 'string' || typeof row.spreadBps !== 'number') {
      throw new ReplayError(`replay instrument ${index} is missing instId or spreadBps`);
    }
    if (!spec || !Array.isArray(candles1h) || !Array.isArray(candles4h)) {
      throw new ReplayError(`replay instrument ${row.instId} is missing spec or candle history`);
    }
    return {
      instId: row.instId,
      spec,
      spreadBps: row.spreadBps,
      candles1h,
      candles4h,
      ...(Array.isArray(binanceCandles1h) ? { binanceCandles1h } : {}),
      ...(Array.isArray(binanceCandles4h) ? { binanceCandles4h } : {}),
      funding: (row.funding as FundingPoint[] | undefined) ?? [],
      ...(typeof row.defaultFundingRate === 'number' ? { defaultFundingRate: row.defaultFundingRate } : {}),
    } satisfies ReplayInstrument;
  });

  const dataset = {
    initialEquityUsdt: root.initialEquityUsdt,
    instruments,
    ...(typeof root.fromMs === 'number' ? { replayFromMs: root.fromMs } : {}),
    ...(typeof root.toMs === 'number' ? { replayToMs: root.toMs } : {}),
  } satisfies ReplayDataset;
  validateReplayDataset(dataset);
  return dataset;
}

function upperBound(candles: readonly Candle[], completedByMs: number): number {
  let low = 0;
  let high = candles.length;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    const candle = candles[mid];
    if (candle === undefined || candle.openTimeMs > completedByMs) high = mid;
    else low = mid + 1;
  }
  return low;
}

function completedSeries(candles: readonly Candle[], atMs: number, barMs: number, maxBars: number): readonly Candle[] {
  const end = upperBound(candles, atMs - barMs);
  return candles.slice(Math.max(0, end - maxBars), end);
}

function latestCompleted(candles: readonly Candle[], atMs: number, barMs: number): Candle | undefined {
  const end = upperBound(candles, atMs - barMs);
  return candles[end - 1];
}

function tickerFor(instrument: ReplayInstrument, candle: Candle): TickerSnapshot {
  const halfSpread = instrument.spreadBps / 20_000;
  return {
    instId: instrument.instId,
    last: candle.close,
    bid: candle.close * (1 - halfSpread),
    ask: candle.close * (1 + halfSpread),
    quoteVolume24h: candle.quoteVolume,
  };
}

function fundingAt(instrument: ReplayInstrument, atMs: number): number | undefined {
  let result = instrument.defaultFundingRate;
  for (const point of instrument.funding ?? []) {
    if (point.timestampMs > atMs) break;
    result = point.fundingRate;
  }
  return result;
}

function fundingPointsBetween(
  instrument: ReplayInstrument,
  fromMs: number,
  toMs: number,
  windowHours: number,
): readonly FundingPoint[] {
  const points = instrument.funding ?? [];
  if (points.length > 0) {
    return points.filter((point) => point.timestampMs > fromMs && point.timestampMs <= toMs);
  }
  const rate = instrument.defaultFundingRate;
  if (rate === undefined) return [];
  return fundingTimestampsBetween(fromMs, toMs, windowHours).map((timestampMs) => ({
    timestampMs,
    fundingRate: rate,
  }));
}

function priceAt(instrument: ReplayInstrument, atMs: number, fallback: number): number {
  return latestCompleted(instrument.candles1h, atMs, HOUR_MS)?.close ?? fallback;
}

function phaseFor(config: Config, atMs: number, respect: boolean): CompetitionPhase {
  return respect ? competitionPhase(config, atMs) : 'open';
}

function positionRisk(position: Position): number {
  const distance = position.side === 'long'
    ? Math.max(0, position.entryPrice - position.currentStop)
    : Math.max(0, position.currentStop - position.entryPrice);
  return distance * position.size * position.remainingFraction;
}

function openRiskFor(config: Config, positions: readonly Position[]): OpenRisk[] {
  return positions.map((position) => ({
    instrument: position.instId,
    correlationGroup: correlationGroupFor(config, position.instId),
    riskUsdt: positionRisk(position),
    side: position.side,
  }));
}

function directionalPnl(side: Side, entryPrice: number, exitPrice: number, size: number): number {
  return (side === 'long' ? exitPrice - entryPrice : entryPrice - exitPrice) * size;
}

function fillPending(
  pending: Map<string, PendingEntry>,
  positions: Map<string, Position>,
  instrumentById: ReadonlyMap<string, ReplayInstrument>,
  config: Config,
  atMs: number,
  barById: ReadonlyMap<string, Candle>,
  equityUsdt: number,
  feeRate: number,
  slippageBps: number,
  maxLeverage: number,
): { readonly filled: number; readonly maximumLeverage: number; readonly feesUsdt: number } {
  let maximumLeverage = 0;
  let filled = 0;
  let feesUsdt = 0;
  for (const [instId, order] of pending) {
    if (positions.has(instId)) {
      pending.delete(instId);
      continue;
    }
    if (atMs <= order.createdAtMs || atMs > order.candidate.validUntilMs) {
      if (atMs > order.candidate.validUntilMs) pending.delete(instId);
      continue;
    }
    const bar = barById.get(instId);
    const instrument = instrumentById.get(instId);
    if (bar === undefined || instrument === undefined) continue;

    const limit = order.candidate.direction === 'long'
      ? order.candidate.entryBandHigh
      : order.candidate.entryBandLow;
    let fillPrice: number | undefined;
    if (order.candidate.direction === 'long') {
      if (bar.open <= limit) fillPrice = bar.open;
      else if (bar.low <= limit) fillPrice = limit;
    } else {
      if (bar.open >= limit) fillPrice = bar.open;
      else if (bar.high >= limit) fillPrice = limit;
    }
    if (fillPrice === undefined) continue;

    const directionSlippage = order.candidate.direction === 'long' ? 1 : -1;
    const slippedPrice = fillPrice * (1 + directionSlippage * slippageBps / 10_000);
    const stage = determineStage(config, { equityUsdt, peakEquityUsdt: equityUsdt }, null);
    try {
      assertAboveEligibilityFloor(config, equityUsdt);
      const sized = computeSize(
        { ...config, execution: { ...config.execution, maxLeverage } },
        {
          stage,
          equity: { equityUsdt, peakEquityUsdt: equityUsdt },
          openRisk: openRiskFor(config, [...positions.values()]),
          correlationGroup: correlationGroupFor(config, instId),
          entryPrice: limit,
          stopPrice: order.candidate.stopPrice,
          targetPrice: order.candidate.targetPrice,
          side: order.candidate.direction,
          ...(instrument.spec.maxLeverage === undefined ? {} : { instrumentMaxLeverage: instrument.spec.maxLeverage }),
        },
      );

      const entryFee = Math.abs(sized.size * slippedPrice) * feeRate;
      const position: Position = {
        instId,
        signalId: `BT-${atMs}-${instId}`,
        side: order.candidate.direction,
        entryPrice: slippedPrice,
        initialStop: order.candidate.stopPrice,
        currentStop: order.candidate.stopPrice,
        remainingFraction: 1,
        openedAtMs: atMs,
        scaledOut: false,
        size: sized.size,
        highWaterPrice: slippedPrice,
        lowWaterPrice: slippedPrice,
        fundingMarkMs: atMs,
        grossPnlUsdt: 0,
        fundingPnlUsdt: 0,
        tradingFeesUsdt: entryFee,
        maxFavourableR: 0,
        maxObservedLeverage: sized.leverage,
      };
      positions.set(instId, position);
      pending.delete(instId);
      maximumLeverage = Math.max(maximumLeverage, sized.leverage);
      feesUsdt += entryFee;
      filled += 1;
    } catch {
      // A historical candidate can be refused by the same capital/portfolio
      // gates as live. It is a refused opportunity, not a data-integrity error.
      pending.delete(instId);
    }
  }
  return { filled, maximumLeverage, feesUsdt };
}

function accruePositionFunding(
  position: Position,
  instrument: ReplayInstrument,
  config: Config,
  toMs: number,
  fallbackPrice: number,
): number {
  const points = fundingPointsBetween(instrument, position.fundingMarkMs, toMs, config.regime.fundingWindowHours);
  let totalPaid = 0;
  for (const point of points) {
    const price = priceAt(instrument, point.timestampMs, fallbackPrice);
    const notional = Math.abs(position.size * price) * position.remainingFraction;
    const paid = position.side === 'long' ? point.fundingRate * notional : -point.fundingRate * notional;
    totalPaid += paid;
  }
  position.fundingMarkMs = toMs;
  position.fundingPnlUsdt -= totalPaid;
  return totalPaid;
}

function markEquity(cashUsdt: number, positions: readonly Position[], barById: ReadonlyMap<string, Candle>): number {
  return cashUsdt + positions.reduce((sum, position) => {
    const bar = barById.get(position.instId);
    if (bar === undefined) return sum;
    return sum + directionalPnl(position.side, position.entryPrice, bar.close, position.size * position.remainingFraction);
  }, 0);
}

function fillExitPrice(side: Side, bar: Candle, requested: number): number {
  // A gap through a stop fills at the opening print, not at a price that was
  // never available. For an in-range trigger, the requested level is used.
  return side === 'long' ? Math.min(requested, bar.open) : Math.max(requested, bar.open);
}

function applyClose(
  position: Position,
  positions: Map<string, Position>,
  trades: ReplayTrade[],
  price: number,
  atMs: number,
  reason: string,
  fraction: number,
  feeRate: number,
): number {
  const closeFraction = Math.min(position.remainingFraction, fraction);
  const sizeClosed = position.size * closeFraction;
  const gross = directionalPnl(position.side, position.entryPrice, price, sizeClosed);
  const fee = Math.abs(sizeClosed * price) * feeRate;
  position.grossPnlUsdt += gross;
  position.tradingFeesUsdt += fee;

  position.remainingFraction -= closeFraction;
  if (position.remainingFraction > 1e-9) {
    position.scaledOut = true;
    return gross - fee;
  }

  const net = position.grossPnlUsdt + position.fundingPnlUsdt - position.tradingFeesUsdt;
  trades.push({
    instId: position.instId,
    side: position.side,
    openedAtMs: position.openedAtMs,
    closedAtMs: atMs,
    exitReason: reason,
    grossPnlUsdt: position.grossPnlUsdt,
    fundingPnlUsdt: position.fundingPnlUsdt,
    tradingFeesUsdt: position.tradingFeesUsdt,
    netPnlUsdt: net,
    rMultipleAtClose: rMultiple(position, price),
    maxFavourableR: position.maxFavourableR,
  });
  positions.delete(position.instId);
  return gross - fee;
}

function managePosition(
  position: Position,
  positions: Map<string, Position>,
  trades: ReplayTrade[],
  instrument: ReplayInstrument,
  config: Config,
  atMs: number,
  bar: Candle,
  phase: CompetitionPhase,
  feeRate: number,
): number {
  position.highWaterPrice = Math.max(position.highWaterPrice, bar.high);
  position.lowWaterPrice = Math.min(position.lowWaterPrice, bar.low);
  const favourable = position.side === 'long' ? bar.high : bar.low;
  position.maxFavourableR = Math.max(position.maxFavourableR, rMultiple(position, favourable));

  const oldStopHit = position.side === 'long' ? bar.low <= position.currentStop : bar.high >= position.currentStop;
  if (oldStopHit) {
    return applyClose(
      position,
      positions,
      trades,
      fillExitPrice(position.side, bar, position.currentStop),
      atMs,
      'stop hit',
      position.remainingFraction,
      feeRate,
    );
  }

  const plan = evaluateExit(config, position, {
    lastPrice: bar.close,
    highestHighSinceEntry: position.highWaterPrice,
    lowestLowSinceEntry: position.lowWaterPrice,
    atr: atr(completedSeries(instrument.candles1h, atMs, HOUR_MS, DEFAULT_1H_HISTORY), config.exits.atrPeriod),
    nowMs: atMs,
  }, phase);

  let cashDelta = 0;
  for (const action of plan.actions) {
    if (action.kind === 'scale_out') {
      const risk = Math.abs(position.entryPrice - position.initialStop);
      const level = position.side === 'long'
        ? position.entryPrice + config.exits.scaleOutAtR * risk
        : position.entryPrice - config.exits.scaleOutAtR * risk;
      cashDelta += applyClose(position, positions, trades, level, atMs, action.reason, action.fraction, feeRate);
      if (!positions.has(position.instId)) return cashDelta;
    } else if (action.kind === 'move_stop') {
      position.currentStop = action.to;
    } else if (action.kind === 'close_full') {
      cashDelta += applyClose(position, positions, trades, bar.close, atMs, action.reason, position.remainingFraction, feeRate);
      return cashDelta;
    }
  }

  // A scale-out or Chandelier move can update the stop on the same bar. If that
  // new stop was crossed after the favourable trigger, the remainder closes too.
  const newStopHit = position.side === 'long' ? bar.low <= position.currentStop : bar.high >= position.currentStop;
  if (newStopHit) {
    cashDelta += applyClose(
      position,
      positions,
      trades,
      fillExitPrice(position.side, bar, position.currentStop),
      atMs,
      'ratcheted stop hit',
      position.remainingFraction,
      feeRate,
    );
  }
  return cashDelta;
}

function buildTimes(dataset: ReplayDataset, fromMs: number, toMs: number): number[] {
  const times = new Set<number>();
  for (const instrument of dataset.instruments) {
    for (const candle of instrument.candles1h) {
      const close = candle.openTimeMs + HOUR_MS;
      if (close >= fromMs && close <= toMs) times.add(close);
    }
  }
  return [...times].sort((a, b) => a - b);
}

function scanAt(
  options: ReplayOptions,
  instruments: readonly ReplayInstrument[],
  atMs: number,
  cooldowns: ReadonlyMap<string, number>,
): ScanSnapshot {
  if (
    options.strategy === 'major-macd' || options.strategy === 'major-macd-long' ||
    options.strategy === 'major-pullback' || options.strategy === 'major-breakout'
  ) {
    return scanMajorAt(options, instruments, atMs, cooldowns);
  }
  const { config } = options;
  const oneHour = options.oneHourHistoryBars ?? DEFAULT_1H_HISTORY;
  const fourHour = options.fourHourHistoryBars ?? DEFAULT_4H_HISTORY;
  const live = instruments.filter((instrument) => latestCompleted(instrument.candles1h, atMs, HOUR_MS) !== undefined);
  const specs = live.map((instrument) => instrument.spec);
  const tickers = live.map((instrument) => {
    const bar = latestCompleted(instrument.candles1h, atMs, HOUR_MS);
    if (bar === undefined) throw new ReplayError(`no bar for ${instrument.instId} at ${atMs}`);
    const recent = completedSeries(instrument.candles1h, atMs, HOUR_MS, 24);
    return tickerFor(instrument, { ...bar, quoteVolume: recent.reduce((sum, row) => sum + row.quoteVolume, 0) });
  });
  const { members } = selectUniverseWithRejections(config, specs, tickers);

  const candlesById = new Map<string, readonly Candle[]>();
  const fundingById = new Map<string, number>();
  const lastPrices = new Map<string, number>();
  const atrById = new Map<string, number>();
  const instrumentById = new Map(instruments.map((instrument) => [instrument.instId, instrument]));

  for (const member of members) {
    const instrument = instrumentById.get(member.instId);
    if (instrument === undefined) continue;
    const candles = completedSeries(instrument.candles1h, atMs, HOUR_MS, oneHour);
    if (candles.length < oneHour || candles.length < config.entry.breakoutLookback + 1) continue;
    try {
      candlesById.set(member.instId, candles);
      lastPrices.set(member.instId, candles.at(-1)?.close ?? 0);
      atrById.set(member.instId, atr(candles, config.ranking.atrPeriod));
      const funding = fundingAt(instrument, atMs);
      if (funding !== undefined) fundingById.set(member.instId, funding);
    } catch {
      // Warm-up/indicator failures exclude only this instrument from this bar.
    }
  }

  const ranked = rankByMomentum(config, candlesById);
  const extremes = takeExtremes(config, ranked);
  const rankIndex = new Map(ranked.map((item, index) => [item.instId, index]));
  const assessed = [...extremes.longs.map((item) => [item, 'long' as Direction] as const), ...extremes.shorts.map((item) => [item, 'short' as Direction] as const)];
  const verdicts = assessed.map(([item, direction]) => {
    const candles = candlesById.get(item.instId);
    const funding = fundingById.get(item.instId);
    if (candles === undefined || funding === undefined) return null;
    return { item, direction, verdict: assessRegime(config, item.instId, candles, funding, direction) };
  }).filter((item): item is NonNullable<typeof item> => item !== null);
  const regimeFavourable = regimeIsFavourable(config, verdicts.map((item) => item.verdict));
  if (!regimeFavourable) {
    return { candidates: [], regimeFavourable, universeSize: ranked.length, lastPrices, atrByInstrument: atrById, fundingRates: fundingById };
  }

  const candidates: EntryCandidate[] = [];
  for (const { item, direction, verdict } of verdicts) {
    if (!verdict.passed) continue;
    const instrument = instrumentById.get(item.instId);
    const candles1h = candlesById.get(item.instId);
    const candles4h = instrument === undefined ? undefined : completedSeries(instrument.candles4h, atMs, FOUR_HOUR_MS, fourHour);
    const funding = fundingById.get(item.instId);
    const index = rankIndex.get(item.instId);
    if (instrument === undefined || candles1h === undefined || candles4h === undefined || funding === undefined || index === undefined) continue;
    if (candles4h.length < 12 || candles1h.length < config.entry.breakoutLookback + 1) continue;
    const cooldownUntilMs = cooldowns.get(item.instId);
    const result = evaluateEntry(config, {
      ranked: item,
      direction,
      candles1h,
      candles4h,
      volumeTrendValue: verdict.volumeTrend,
      universeSize: ranked.length,
      rankIndex: index,
      fundingRate: funding,
      nowMs: atMs,
      ...(cooldownUntilMs === undefined ? {} : { cooldownUntilMs }),
    });
    if (result.accepted) candidates.push(result.candidate);
  }
  return { candidates, regimeFavourable, universeSize: ranked.length, lastPrices, atrByInstrument: atrById, fundingRates: fundingById };
}

function scanMajorAt(
  options: ReplayOptions,
  instruments: readonly ReplayInstrument[],
  atMs: number,
  cooldowns: ReadonlyMap<string, number>,
): ScanSnapshot {
  const { config } = options;
  const oneHour = options.oneHourHistoryBars ?? DEFAULT_1H_HISTORY;
  const fourHour = options.fourHourHistoryBars ?? 260;
  const candidates: EntryCandidate[] = [];
  const lastPrices = new Map<string, number>();
  const atrById = new Map<string, number>();
  const fundingById = new Map<string, number>();
  let priced = 0;

  for (const instrument of instruments) {
    const candles1h = completedSeries(instrument.candles1h, atMs, HOUR_MS, oneHour);
    const candles4h = completedSeries(instrument.candles4h, atMs, FOUR_HOUR_MS, fourHour);
    const last = candles1h.at(-1);
    const funding = fundingAt(instrument, atMs);
    if (last === undefined || funding === undefined || candles1h.length < oneHour || candles4h.length < fourHour) continue;

    try {
      lastPrices.set(instrument.instId, last.close);
      atrById.set(instrument.instId, atr(candles1h, config.exits.atrPeriod));
      fundingById.set(instrument.instId, funding);
      priced += 1;
      const direction = options.strategy === 'major-pullback'
        ? majorPullbackDirection(candles1h, candles4h)
        : options.strategy === 'major-breakout'
          ? majorBreakoutDirection(candles1h, candles4h)
          : majorSignal(candles1h, candles4h).direction;
      if (direction === undefined || (options.strategy === 'major-macd-long' && direction !== 'long')) continue;
      const cooldownUntilMs = cooldowns.get(instrument.instId);
      const result = options.strategy === 'major-pullback'
        ? evaluateMajorPullbackEntry(config, instrument.instId, direction, candles1h, candles4h, funding, atMs, cooldownUntilMs)
        : options.strategy === 'major-breakout'
          ? evaluateMajorBreakoutEntry(config, instrument.instId, direction, candles1h, candles4h, funding, atMs, cooldownUntilMs)
          : evaluateMajorEntry(config, instrument.instId, direction, candles1h, candles4h, funding, atMs, cooldownUntilMs);
      if (result.accepted) candidates.push(result.candidate);
    } catch {
      // An indicator warm-up or malformed series excludes this instrument for
      // this cycle, matching the current replay's fail-closed behaviour.
    }
  }

  return {
    // Major mode uses explicit instruments and direction-level indicators; it
    // does not stand down because a cross-sectional count is small.
    candidates,
    regimeFavourable: priced > 0,
    universeSize: priced,
    lastPrices,
    atrByInstrument: atrById,
    fundingRates: fundingById,
  };
}

export function replay(options: ReplayOptions): ReplayResult {
  validateReplayDataset(options.dataset);
  const history1h = options.oneHourHistoryBars ?? DEFAULT_1H_HISTORY;
  const history4h = options.fourHourHistoryBars ?? DEFAULT_4H_HISTORY;
  if (history1h < 60 || history4h < 20) throw new ReplayError('replay history windows are too short for the configured indicators');
  const feeRate = options.tradingFeeRateFraction ?? 0;
  const slippageBps = options.slippageBps ?? 0;
  const maxLeverage = options.maxLeverage ?? Number.MAX_SAFE_INTEGER;
  if (!Number.isFinite(feeRate) || feeRate < 0) throw new ReplayError('trading fee rate must be finite and non-negative');
  if (!Number.isFinite(slippageBps) || slippageBps < 0) throw new ReplayError('slippage must be finite and non-negative');
  if (!Number.isFinite(maxLeverage) || maxLeverage <= 0) throw new ReplayError('max leverage must be positive and finite');

  const allTimes = buildTimes(
    options.dataset,
    options.fromMs ?? options.dataset.replayFromMs ?? -Infinity,
    options.toMs ?? options.dataset.replayToMs ?? Infinity,
  );
  if (allTimes.length === 0) throw new ReplayError('replay range contains no closed 1h bars');
  const fromMs = options.fromMs ?? options.dataset.replayFromMs ?? allTimes[0] as number;
  const toMs = options.toMs ?? options.dataset.replayToMs ?? allTimes.at(-1) as number;
  const times = allTimes.filter((atMs) => atMs >= fromMs && atMs <= toMs);
  if (times.length === 0) throw new ReplayError('replay range contains no closed 1h bars');

  const instrumentById = new Map(options.dataset.instruments.map((instrument) => [instrument.instId, instrument]));
  const positions = new Map<string, Position>();
  const pending = new Map<string, PendingEntry>();
  const cooldowns = new Map<string, number>();
  const trades: ReplayTrade[] = [];
  let cash = options.dataset.initialEquityUsdt;
  let peak = cash;
  let maxDrawdown = 0;
  let totalFunding = 0;
  let totalFees = 0;
  let entries = 0;
  let favourableCycles = 0;
  let maxObservedLeverage = 0;
  const universeSizes: number[] = [];

  for (const atMs of times) {
    const barById = new Map<string, Candle>();
    for (const instrument of options.dataset.instruments) {
      const bar = latestCompleted(instrument.candles1h, atMs, HOUR_MS);
      if (bar !== undefined) barById.set(instrument.instId, bar);
    }

    for (const position of positions.values()) {
      const instrument = instrumentById.get(position.instId);
      const bar = barById.get(position.instId);
      if (instrument === undefined || bar === undefined) continue;
      const paid = accruePositionFunding(position, instrument, options.config, atMs, bar.close);
      cash -= paid;
      totalFunding += paid;
    }

    const phase = phaseFor(options.config, atMs, options.respectCompetitionClock ?? false);
    for (const position of [...positions.values()]) {
      const instrument = instrumentById.get(position.instId);
      const bar = barById.get(position.instId);
      if (instrument === undefined || bar === undefined) continue;
      const beforeTrades = trades.length;
      cash += managePosition(position, positions, trades, instrument, options.config, atMs, bar, phase, feeRate);
      for (const trade of trades.slice(beforeTrades)) {
        cooldowns.set(trade.instId, atMs + options.config.exits.reentryCooldownHours * HOUR_MS);
      }
    }

    const equity = markEquity(cash, [...positions.values()], barById);
    peak = Math.max(peak, equity);
    maxDrawdown = Math.max(maxDrawdown, peak > 0 ? (peak - equity) / peak : 0);

    const fills = fillPending(
      pending,
      positions,
      instrumentById,
      options.config,
      atMs,
      barById,
      equity,
      feeRate,
      slippageBps,
      maxLeverage,
    );
    cash -= fills.feesUsdt;
    if (fills.filled > 0) {
      entries += fills.filled;
      maxObservedLeverage = Math.max(maxObservedLeverage, fills.maximumLeverage);
    }

    const snapshot = scanAt({ ...options, oneHourHistoryBars: history1h, fourHourHistoryBars: history4h }, options.dataset.instruments, atMs, cooldowns);
    universeSizes.push(snapshot.universeSize);
    if (snapshot.regimeFavourable) favourableCycles += 1;
    if (phase === 'open' || !(options.respectCompetitionClock ?? false)) {
      for (const candidate of snapshot.candidates) {
        if (!positions.has(candidate.instId)) pending.set(candidate.instId, { candidate, createdAtMs: atMs });
      }
    }

    for (const [instId, until] of cooldowns) if (until <= atMs) cooldowns.delete(instId);
  }

  const finalBars = new Map<string, Candle>();
  for (const instrument of options.dataset.instruments) {
    const bar = latestCompleted(instrument.candles1h, toMs, HOUR_MS);
    if (bar !== undefined) finalBars.set(instrument.instId, bar);
  }
  const finalEquity = markEquity(cash, [...positions.values()], finalBars);
  totalFees = trades.reduce((sum, trade) => sum + trade.tradingFeesUsdt, 0) + [...positions.values()].reduce((sum, p) => sum + p.tradingFeesUsdt, 0);
  const winners = trades.filter((trade) => trade.netPnlUsdt > 0);
  const losers = trades.filter((trade) => trade.netPnlUsdt < 0);
  const scratches = trades.length - winners.length - losers.length;
  const grossWinners = winners.reduce((sum, trade) => sum + trade.netPnlUsdt, 0);
  const grossLosers = Math.abs(losers.reduce((sum, trade) => sum + trade.netPnlUsdt, 0));
  const observedDays = Math.max((toMs - fromMs) / 86_400_000, 1 / 24);
  const openPositions = [...positions.values()].map((position) => {
    const bar = finalBars.get(position.instId);
    return {
      instId: position.instId,
      side: position.side,
      openedAtMs: position.openedAtMs,
      entryPrice: position.entryPrice,
      currentStop: position.currentStop,
      remainingFraction: position.remainingFraction,
      unrealisedPnlUsdt: bar === undefined ? 0 : directionalPnl(position.side, position.entryPrice, bar.close, position.size * position.remainingFraction),
    } satisfies ReplayOpenPosition;
  });

  const assumptions = [
    'Only closed 1h/4h bars are visible; entries are generated at 1h close and can fill from the next 1h bar.',
    'Historical spread comes from each dataset instrument.spreadBps; candle data has no historical order book.',
    'An OHLC bar that hits an existing stop and a favourable trigger is ordered stop-first.',
    options.respectCompetitionClock ? 'The configured competition clock was enforced.' : 'The competition clock was not enforced; this is a rolling strategy study.',
    options.strategy === 'major-macd' || options.strategy === 'major-macd-long'
      ? 'Six-major MACD mode: explicit instruments, 4h EMA(20/50) alignment, 1h MACD(12/26/9) crossover, and RSI(14) between 30 and 70.'
      : options.strategy === 'major-pullback'
        ? 'Six-major pullback mode: explicit instruments, 4h EMA(20/50) alignment, 1h EMA(20) touch-and-reclaim, and RSI(14) between 30 and 70.'
        : options.strategy === 'major-breakout'
          ? 'Six-major breakout mode: explicit instruments, 4h EMA(20/50) alignment, and 1h Donchian(20) breakout.'
        : 'Cross-sectional mode: E1 universe filter, E2 regime gate, E3 momentum extremes, and E4 breakout entry.',
    options.maxLeverage === undefined ? 'No live maxLeverage cap was assumed; Part IX venue verification remains separate.' : `Backtest maxLeverage cap: ${maxLeverage}x.`,
    feeRate === 0 ? 'Trading fees were excluded; pass the verified maker fee to measure net fee drag.' : `Trading fee assumption: ${(feeRate * 10_000).toFixed(2)} bps per fill.`,
    slippageBps === 0 ? 'Slippage was excluded.' : `Slippage assumption: ${slippageBps.toFixed(2)} bps per fill.`,
  ];
  const minimumUniverseSize = Math.min(...universeSizes);
  const maximumUniverseSize = Math.max(...universeSizes);
  const averageUniverseSize = universeSizes.reduce((sum, size) => sum + size, 0) / universeSizes.length;

  return {
    fromMs,
    toMs,
    observedDays,
    initialEquityUsdt: options.dataset.initialEquityUsdt,
    finalEquityUsdt: finalEquity,
    netPnlUsdt: finalEquity - options.dataset.initialEquityUsdt,
    returnFraction: (finalEquity - options.dataset.initialEquityUsdt) / options.dataset.initialEquityUsdt,
    peakEquityUsdt: peak,
    maxDrawdownFraction: maxDrawdown,
    entries,
    closedTrades: trades.length,
    wins: winners.length,
    losses: losers.length,
    scratches,
    winRate: trades.length === 0 ? 0 : winners.length / trades.length,
    realisedPayoffRatio: winners.length === 0
      ? 0
      : grossLosers === 0
      ? (grossWinners > 0 ? Number.POSITIVE_INFINITY : 0)
      : (grossWinners / winners.length) / (grossLosers / losers.length),
    profitFactor: grossLosers === 0 ? (grossWinners > 0 ? Number.POSITIVE_INFINITY : 0) : grossWinners / grossLosers,
    averageNetPnlUsdt: trades.length === 0 ? 0 : trades.reduce((sum, trade) => sum + trade.netPnlUsdt, 0) / trades.length,
    tradesPerDay: entries / observedDays,
    timeStopHitRate: trades.length === 0 ? 0 : trades.filter((trade) => trade.exitReason.startsWith('time stop')).length / trades.length,
    totalTradingFeesUsdt: totalFees,
    totalFundingUsdt: totalFunding,
    maximumObservedLeverage: maxObservedLeverage,
    regimeFavourableCycles: favourableCycles,
    scanCycles: times.length,
    universeSizes,
    minimumUniverseSize,
    averageUniverseSize,
    maximumUniverseSize,
    trades,
    openPositions,
    assumptions,
  };
}

/** Small helper for callers that want the exact funding accounting primitive. */
export function fundingForReplay(
  exposure: { readonly instId: string; readonly side: Side; readonly notionalUsdt: number; readonly fundingRate: number },
  fromMs: number,
  toMs: number,
  windowHours: number,
): number {
  return accrueFundingUsdt([exposure], fromMs, toMs, windowHours);
}
