import { RiskTokenBlocked, type Instrument, type RiskTokenGate } from './adapter.js';

/**
 * Route-B risk gate for OKX USDT perpetuals.
 *
 * These are venue-listed derivative instruments, not arbitrary on-chain token
 * contracts, so the token-risk question is answered by measured venue facts:
 * the symbol must be a USDT swap and its per-instrument leverage ceiling must
 * be present and usable. Missing data is blocked rather than treated as clean.
 */
export class ListedPerpRiskGate implements RiskTokenGate {
  async assertClean(instrument: Instrument): Promise<void> {
    const findings: string[] = [];
    if (!instrument.symbol.endsWith('-USDT-SWAP')) {
      findings.push('instrument is not a USDT perpetual');
    }
    if (
      instrument.maxLeverage === undefined ||
      !Number.isFinite(instrument.maxLeverage) ||
      instrument.maxLeverage <= 0
    ) {
      findings.push('per-instrument leverage ceiling was not measured');
    }
    if (findings.length > 0) throw new RiskTokenBlocked(instrument.symbol, findings);
  }
}
