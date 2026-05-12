/**
 * Aggregates Solscan signals into a single rug-risk verdict.
 *
 * Inputs:  mint, pair (so we can exclude the LP pool from holder calc)
 * Output:  { rugRisk, top10Pct, devHoldsPct, mintAuthLive, freezeAuthLive, summary }
 *
 * Fail-soft: any error/timeout returns null and the alert renders "Unknown".
 */
import { getTokenMeta, getTopHolders } from './solscan.js';

// Standard Solana addresses we filter out of "concentration" calc
const KNOWN_BURN_OR_SYSTEM = new Set([
  '1nc1nerator11111111111111111111111111111111',
  '11111111111111111111111111111111',
  '11111111111111111111111111111112',
  // common pump.fun bonding curve / fee accounts
  'BurnerWalLet1111111111111111111111111111111',
]);

export type RugRisk = 'LOW' | 'MEDIUM' | 'HIGH' | 'UNKNOWN';

export interface DevCheck {
  rugRisk: RugRisk;
  top10Pct: number | null;       // % of supply held by top 10 (excl. pool/burn)
  top1Pct: number | null;        // % held by largest non-pool holder
  devHoldsPct: number | null;    // % held by creator wallet (null if not in top N)
  mintAuthLive: boolean | null;  // true = dev can mint more (rug)
  freezeAuthLive: boolean | null;// true = dev can freeze your tokens
  summary: string;               // one-line compact summary for the alert
  reasons: string[];             // bullet reasons (worst first)
}

export async function runDevCheck(mint: string, lpPoolAddress?: string): Promise<DevCheck | null> {
  if (!mint) return null;
  let meta, holders;
  try {
    [meta, holders] = await Promise.all([
      getTokenMeta(mint),
      getTopHolders(mint, 20),
    ]);
  } catch {
    return null;
  }
  if (!meta && !holders) return null;

  const decimals = meta?.decimals ?? 0;
  const supplyRaw = meta?.supply != null ? Number(meta.supply) : null;
  const supply = supplyRaw != null && Number.isFinite(supplyRaw)
    ? supplyRaw / Math.pow(10, decimals)
    : null;

  // Filter out LP pool + burn addresses for concentration calc
  const exclude = new Set<string>([...KNOWN_BURN_OR_SYSTEM]);
  if (lpPoolAddress) exclude.add(lpPoolAddress);

  let top10Pct: number | null = null;
  let top1Pct: number | null = null;
  let devHoldsPct: number | null = null;

  if (holders && holders.length && supply && supply > 0) {
    const filtered = holders.filter(h => !exclude.has(h.owner));
    const scaledAmt = (raw: number) => raw / Math.pow(10, decimals);
    const top10 = filtered.slice(0, 10).reduce((s, h) => s + scaledAmt(h.amount), 0);
    top10Pct = (top10 / supply) * 100;
    if (filtered.length > 0) {
      top1Pct = (scaledAmt(filtered[0]!.amount) / supply) * 100;
    }
    if (meta?.creator) {
      const dev = filtered.find(h => h.owner === meta.creator);
      if (dev) devHoldsPct = (scaledAmt(dev.amount) / supply) * 100;
    }
  }

  // Authorities: null means revoked (good); any string means still active (bad)
  const mintAuthLive = meta ? (meta.mintAuthority != null && meta.mintAuthority !== '') : null;
  const freezeAuthLive = meta ? (meta.freezeAuthority != null && meta.freezeAuthority !== '') : null;

  // Risk verdict
  const reasons: string[] = [];
  let risk: RugRisk = 'LOW';

  if (mintAuthLive === true) { risk = 'HIGH'; reasons.push('Mint authority active — dev can print more'); }
  if (freezeAuthLive === true) { risk = 'HIGH'; reasons.push('Freeze authority active — dev can freeze holders'); }
  if (top10Pct != null && top10Pct > 50) { risk = 'HIGH'; reasons.push('Top 10 hold ' + top10Pct.toFixed(0) + '% (>50%)'); }
  else if (top10Pct != null && top10Pct > 30 && risk !== 'HIGH') { risk = 'MEDIUM'; reasons.push('Top 10 hold ' + top10Pct.toFixed(0) + '% (>30%)'); }
  if (devHoldsPct != null && devHoldsPct > 20 && risk !== 'HIGH') { risk = 'MEDIUM'; reasons.push('Dev still holds ' + devHoldsPct.toFixed(1) + '%'); }
  if (top1Pct != null && top1Pct > 15 && risk !== 'HIGH') {
    if (risk === 'LOW') risk = 'MEDIUM';
    reasons.push('Largest non-pool holder = ' + top1Pct.toFixed(1) + '%');
  }

  // If we got nothing useful at all, return UNKNOWN so caller can render "Unknown"
  if (top10Pct == null && mintAuthLive == null && freezeAuthLive == null) {
    return null;
  }

  // Compact one-line summary
  const bits: string[] = [];
  if (top10Pct != null) bits.push('top10=' + top10Pct.toFixed(0) + '%');
  if (devHoldsPct != null) bits.push('dev=' + devHoldsPct.toFixed(1) + '%');
  else if (meta?.creator) bits.push('dev sold');
  if (mintAuthLive === false) bits.push('mint🔒');
  else if (mintAuthLive === true) bits.push('mint⚠');
  if (freezeAuthLive === false) bits.push('freeze🔒');
  else if (freezeAuthLive === true) bits.push('freeze⚠');
  const summary = bits.join(' · ');

  return {
    rugRisk: risk,
    top10Pct,
    top1Pct,
    devHoldsPct,
    mintAuthLive,
    freezeAuthLive,
    summary,
    reasons,
  };
}

export function riskEmoji(r: RugRisk): string {
  switch (r) {
    case 'LOW': return '🟢';
    case 'MEDIUM': return '🟡';
    case 'HIGH': return '🔴';
    default: return '⚪';
  }
}
