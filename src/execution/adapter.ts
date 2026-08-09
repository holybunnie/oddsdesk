/**
 * Venue-agnostic execution interface.
 *
 * Both routes plug in here, which is what keeps the Polymarket order test a
 * small module rather than a rewrite, and what lets Route B be abandoned
 * without unpicking the engines.
 *
 * Money crosses this boundary as bigint minor units — never a float. A price of
 * 0.0842 on a 6-decimal venue is 84_200n, not 0.0842. Floats are permitted only
 * for ranking and comparison maths above this layer, never for a quantity that
 * reaches a venue.
 *
 * Law 1: nothing in this file describes a venue. Fees, tick sizes, minimum
 * order sizes and leverage limits are discovered at runtime and returned by
 * describeVenue(), so a wrong assumption surfaces as a probe result rather than
 * a silently mispriced order.
 */

export type Side = 'buy' | 'sell';
export type OrderType = 'limit' | 'market';
export type RouteId = 'routeA' | 'routeB';

/** Decimal exponent for a venue quantity, e.g. 6 means minor units are 1e-6. */
export type Decimals = number;

export interface Instrument {
  /** Venue-native identifier, exactly as the venue spells it. */
  readonly symbol: string;
  readonly priceDecimals: Decimals;
  readonly sizeDecimals: Decimals;
  /**
   * Coins per contract, where the venue quotes size in contracts.
   *
   * Required and explicitly nullable rather than optional: on a contract venue
   * a missing multiplier silently mis-sizes every order by the multiplier
   * itself (BTC-USDT-SWAP is 0.01 BTC per contract, so a hundredfold), and an
   * optional field is one a caller can forget. `null` means the venue quotes
   * size in the base asset directly and no conversion applies.
   */
  readonly contractValue: number | null;
}

/**
 * Venue facts, discovered at runtime. Every field here is a measurement.
 *
 * Optional fields are optional because the venue may genuinely not expose them,
 * not because we may skip discovering them — an absent value must be handled by
 * the caller, never defaulted.
 */
export interface VenueProfile {
  readonly venue: string;
  readonly discoveredAtMs: number;
  readonly instruments: readonly Instrument[];
  /** Taker fee as a fraction, e.g. 0.001. Measured, not assumed. */
  readonly takerFee: number;
  readonly makerFee: number;
  /** Minimum order size in instrument minor units, keyed by symbol. */
  readonly minOrderSize: Readonly<Record<string, bigint>>;
  /** Present only where the venue supports leverage. */
  readonly maxLeverage?: number;
  /**
   * Whether stop orders rest on the venue and survive process death.
   * 'unverified' until the Part IX kill test has actually been run and observed.
   */
  readonly stopCustody: 'venue-held' | 'client-held' | 'none' | 'unverified';
}

export interface OrderRequest {
  readonly route: RouteId;
  readonly engine: string;
  readonly instrument: Instrument;
  readonly side: Side;
  readonly type: OrderType;
  /** Minor units. Required for limit orders; must be null for market orders. */
  readonly limitPrice: bigint | null;
  readonly size: bigint;
  /**
   * Stop price in minor units. H2 forbids an entry without one on Route B.
   * Null is permitted only for Route A defined-risk positions, which cannot be
   * liquidated and whose maximum loss is the premium paid.
   */
  readonly stopPrice: bigint | null;
  readonly targetPrice: bigint | null;
  /** Why this order exists. Written straight into the ledger receipt. */
  readonly reason: string;
  /** Idempotency key, so a retry after a timeout cannot double-fill. */
  readonly clientOrderId: string;
}

export interface OrderResult {
  readonly clientOrderId: string;
  readonly venueOrderId: string;
  readonly status: 'accepted' | 'filled' | 'partially_filled' | 'rejected' | 'cancelled';
  readonly filledSize: bigint;
  readonly averagePrice: bigint | null;
  /** Fee actually charged, in quote minor units. Measured from the response. */
  readonly feePaid: bigint | null;
  /** Whether a stop order is now resting on the venue for this position. */
  readonly stopResting: boolean;
  /** Raw venue response, preserved verbatim for the ledger. */
  readonly raw: unknown;
}

export interface Position {
  readonly instrument: Instrument;
  readonly side: 'long' | 'short';
  readonly size: bigint;
  readonly entryPrice: bigint;
  readonly markPrice: bigint;
  readonly unrealisedPnlQuote: bigint;
  readonly stopPrice: bigint | null;
  readonly stopRestingOnVenue: boolean;
}

export class ExecutionError extends Error {
  override readonly name: string = 'ExecutionError';
  readonly venue: string;

  constructor(venue: string, message: string, options?: { cause?: unknown }) {
    super(`[${venue}] ${message}`, options);
    this.venue = venue;
  }
}

/**
 * Signals that a capability was called before it was verified against the real
 * venue. Thrown rather than returning a plausible value — Law 2: a stub
 * returning plausible numbers is worse than no code, because it trades on fiction.
 */
export class NotVerifiedError extends ExecutionError {
  override readonly name = 'NotVerifiedError';
}

export interface ExecutionAdapter {
  readonly venue: string;
  readonly route: RouteId;

  /**
   * Discover venue facts. Must hit the real venue. An adapter that returns a
   * hardcoded profile violates Law 1 and will mis-size every order built on it.
   */
  describeVenue(): Promise<VenueProfile>;

  submitOrder(request: OrderRequest): Promise<OrderResult>;
  cancelOrder(venueOrderId: string): Promise<void>;

  /** Venue-side truth. The reconciler compares this against local state. */
  openPositions(): Promise<readonly Position[]>;
  openOrders(): Promise<readonly OrderResult[]>;

  /** Close a position at market. Used by the endgame and by the watchdog. */
  flatten(instrument: Instrument): Promise<OrderResult>;

  /** Free collateral in quote minor units. */
  availableBalance(): Promise<bigint>;
}

/**
 * Blocking pre-trade risk gate. Wired into the execution path, never advisory.
 *
 * This is the check that protects against the failure mode that will gut the
 * meme-sniper entries: a token that passes a price filter and fails a security
 * one. Nothing submits without a clean result.
 */
export interface RiskTokenGate {
  /**
   * Resolves clean, or throws. Deliberately not a boolean — a boolean can be
   * ignored by a caller, and this must not be ignorable.
   */
  assertClean(instrument: Instrument): Promise<void>;
}

export class RiskTokenBlocked extends Error {
  override readonly name = 'RiskTokenBlocked';
  readonly symbol: string;
  readonly findings: readonly string[];

  constructor(symbol: string, findings: readonly string[]) {
    super(`risk token gate blocked ${symbol}: ${findings.join('; ')}`);
    this.symbol = symbol;
    this.findings = findings;
  }
}
