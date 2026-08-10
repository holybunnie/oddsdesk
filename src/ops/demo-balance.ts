/** Map OKX's large simulated balance onto the competition's virtual bankroll. */

const QUOTE_SCALE = 100_000_000n;

function minor(usdt: number): bigint {
  if (!Number.isFinite(usdt) || usdt <= 0) throw new Error(`invalid demo balance ${usdt}`);
  return BigInt(Math.round(usdt * Number(QUOTE_SCALE)));
}

export function virtualDemoBalanceMinor(
  actualMinor: bigint,
  venueBaselineUsdt: number,
  virtualPrincipalUsdt: number,
): bigint {
  const result = minor(virtualPrincipalUsdt) + actualMinor - minor(venueBaselineUsdt);
  return result > 0n ? result : 0n;
}
