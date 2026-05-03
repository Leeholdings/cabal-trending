/**
 * Backtest engine. Replays stored snapshots in chronological order, applies
 * the same scoring + tier classification as the live scanner, computes
 * forward returns at 5/15/30/60 minutes, and writes a CSV summary.
 *
 * Run with: npm run backtest
 *
 * Output:
 *   - console: alerts by tier, win rate, avg return per horizon, max drawdown / upside
 *   - data/exports/backtest_<timestamp>.csv
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { getConfig, PROJECT_ROOT } from '../config/loader.js';
import { db } from '../db/schema.js';
import {
  recentSnapshots,
  type SnapshotRow,
} from '../db/snapshots.js';
import { scoreAnomaly } from '../scoring/engine.js';
import { classifyTier, type AlertTier } from '../scoring/tiers.js';
import { log } from '../util/logger.js';

interface BacktestResult {
  pairAddress: string;
  alertTimestamp: number;
  tier: AlertTier;
  score: number;
  volumeAcceleration: number;
  priceAtAlert: number;
  ret5:  number | null;
  ret15: number | null;
  ret30: number | null;
  ret60: number | null;
}

const SCORING_LOOKBACK_MS = 20 * 60 * 1000;

function priceAtOrAfter(snaps: SnapshotRow[], targetTs: number): number | null {
  for (const s of snaps) {
    if (s.timestamp >= targetTs && s.price_usd !== null) {
      return s.price_usd;
    }
  }
  return null;
}

function pctReturn(entry: number, exit: number | null): number | null {
  if (exit === null || entry === 0) return null;
  return ((exit - entry) / entry) * 100;
}

function maxDrawdown(returns: (number | null)[]): number {
  const valid = returns.filter((r): r is number => r !== null);
  if (valid.length === 0) return 0;
  return Math.min(...valid);
}

function maxUpside(returns: (number | null)[]): number {
  const valid = returns.filter((r): r is number => r !== null);
  if (valid.length === 0) return 0;
  return Math.max(...valid);
}

function avg(values: (number | null)[]): number {
  const valid = values.filter((v): v is number => v !== null);
  if (valid.length === 0) return 0;
  return valid.reduce((a, b) => a + b, 0) / valid.length;
}

function distinctPairs(): string[] {
  return (db().prepare(`
    SELECT DISTINCT pair_address FROM snapshots
  `).all() as { pair_address: string }[]).map((r) => r.pair_address);
}

function snapsForPair(pairAddress: string): SnapshotRow[] {
  return db().prepare(`
    SELECT * FROM snapshots WHERE pair_address = ? ORDER BY timestamp ASC
  `).all(pairAddress) as SnapshotRow[];
}

async function main(): Promise<void> {
  const cfg = getConfig();
  log.info('Backtest starting', { strategy: cfg.strategy.chainId });

  const pairs = distinctPairs();
  log.info(`Replaying ${pairs.length} distinct pair(s)`);

  const results: BacktestResult[] = [];
  let lastAlertAt: Map<string, number> = new Map();
  const cooldownMs = cfg.strategy.duplicateAlertCooldownMinutes * 60_000;

  for (const pairAddress of pairs) {
    const all = snapsForPair(pairAddress);
    if (all.length < 2) continue;

    for (let i = 1; i < all.length; i++) {
      const cur = all[i]!;
      // Build the rolling-baseline window the same way the live scanner does.
      const cutoff = cur.timestamp - SCORING_LOOKBACK_MS;
      const window = all.slice(0, i + 1).filter((s) => s.timestamp >= cutoff);
      if (window.length < 2) continue;

      const score = scoreAnomaly(window);
      const priceChangeM5Abs = Math.abs(cur.price_change_m5 ?? 0);
      const tier = classifyTier(score, priceChangeM5Abs);
      if (!tier) continue;

      // Apply the same cooldown the live scanner uses.
      const lastTs = lastAlertAt.get(pairAddress) ?? 0;
      if (cur.timestamp - lastTs < cooldownMs) continue;
      lastAlertAt.set(pairAddress, cur.timestamp);

      const entry = cur.price_usd ?? 0;
      const future = all.slice(i + 1);
      const ret5  = pctReturn(entry, priceAtOrAfter(future, cur.timestamp +  5 * 60_000));
      const ret15 = pctReturn(entry, priceAtOrAfter(future, cur.timestamp + 15 * 60_000));
      const ret30 = pctReturn(entry, priceAtOrAfter(future, cur.timestamp + 30 * 60_000));
      const ret60 = pctReturn(entry, priceAtOrAfter(future, cur.timestamp + 60 * 60_000));

      results.push({
        pairAddress,
        alertTimestamp: cur.timestamp,
        tier,
        score: score.overall,
        volumeAcceleration: score.volumeAcceleration,
        priceAtAlert: entry,
        ret5, ret15, ret30, ret60,
      });
    }
  }

  // --- Summary by tier ---
  const tiers: AlertTier[] = ['WATCH', 'TRADE_RADAR', 'CAUTION'];
  console.log('\n' + '='.repeat(60));
  console.log('BACKTEST SUMMARY');
  console.log('='.repeat(60));
  console.log(`Total alerts: ${results.length}`);
  console.log();
  for (const t of tiers) {
    const subset = results.filter((r) => r.tier === t);
    if (subset.length === 0) continue;
    const r5  = subset.map((r) => r.ret5);
    const r15 = subset.map((r) => r.ret15);
    const r30 = subset.map((r) => r.ret30);
    const r60 = subset.map((r) => r.ret60);
    const winRate60 = r60.filter((r): r is number => r !== null && r > 0).length /
                      Math.max(1, r60.filter((r) => r !== null).length);
    console.log(`-- ${t} (${subset.length} alerts) --`);
    console.log(`  Avg return  5m / 15m / 30m / 60m: `
      + `${avg(r5).toFixed(2)}% / ${avg(r15).toFixed(2)}% / `
      + `${avg(r30).toFixed(2)}% / ${avg(r60).toFixed(2)}%`);
    console.log(`  Win rate (60m positive): ${(winRate60 * 100).toFixed(1)}%`);
    console.log(`  Max upside (60m):   ${maxUpside(r60).toFixed(2)}%`);
    console.log(`  Max drawdown (60m): ${maxDrawdown(r60).toFixed(2)}%`);
    console.log();
  }

  // --- CSV export ---
  const exportsDir = resolve(PROJECT_ROOT, 'data/exports');
  mkdirSync(exportsDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const csvPath = resolve(exportsDir, `backtest_${stamp}.csv`);
  const header = 'pair_address,alert_timestamp,tier,score,vol_accel,price_at_alert,ret_5m,ret_15m,ret_30m,ret_60m\n';
  const body = results.map((r) =>
    [
      r.pairAddress,
      new Date(r.alertTimestamp).toISOString(),
      r.tier,
      r.score.toFixed(2),
      r.volumeAcceleration.toFixed(2),
      r.priceAtAlert.toFixed(8),
      r.ret5  === null ? '' : r.ret5.toFixed(2),
      r.ret15 === null ? '' : r.ret15.toFixed(2),
      r.ret30 === null ? '' : r.ret30.toFixed(2),
      r.ret60 === null ? '' : r.ret60.toFixed(2),
    ].join(','),
  ).join('\n');
  writeFileSync(csvPath, header + body, 'utf-8');
  console.log(`CSV written: ${csvPath}`);
}

main().catch((e) => {
  log.error('backtest crashed', { err: (e as Error).message, stack: (e as Error).stack });
  process.exit(1);
});

// Silence unused import warning when recentSnapshots isn't used directly.
void recentSnapshots;
