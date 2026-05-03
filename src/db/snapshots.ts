/**
 * CRUD for pairs / snapshots / alerts.
 */
import { db } from './schema.js';
import type { DexScreenerPair } from '../dexscreener/client.js';

export interface SnapshotRow {
  id: number;
  pair_address: string;
  timestamp: number;
  price_usd: number | null;
  market_cap: number | null;
  fdv: number | null;
  liquidity_usd: number | null;
  volume_m5: number | null;
  volume_h1: number | null;
  volume_h6: number | null;
  volume_h24: number | null;
  buys_m5: number | null;
  sells_m5: number | null;
  txns_m5: number | null;
  txns_h1: number | null;
  price_change_m5: number | null;
  price_change_h1: number | null;
  raw_json: string;
}

export function upsertPair(p: DexScreenerPair): void {
  const now = Date.now();
  db().prepare(`
    INSERT INTO pairs
      (pair_address, chain_id, base_address, base_symbol, base_name,
       quote_address, quote_symbol, dex_id, pair_url, pair_created_at,
       first_seen, last_seen)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(pair_address) DO UPDATE SET
      last_seen       = excluded.last_seen,
      base_symbol     = excluded.base_symbol,
      base_name       = excluded.base_name,
      pair_url        = excluded.pair_url
  `).run(
    p.pairAddress,
    p.chainId,
    p.baseToken?.address ?? null,
    p.baseToken?.symbol ?? null,
    p.baseToken?.name ?? null,
    p.quoteToken?.address ?? null,
    p.quoteToken?.symbol ?? null,
    p.dexId ?? null,
    p.url ?? null,
    p.pairCreatedAt ?? null,
    now,
    now,
  );
}

export function insertSnapshot(p: DexScreenerPair): number {
  const txns = p.txns ?? {};
  const m5  = txns.m5  ?? { buys: 0, sells: 0 };
  const h1  = txns.h1  ?? { buys: 0, sells: 0 };
  const txnsM5 = (m5.buys ?? 0) + (m5.sells ?? 0);
  const txnsH1 = (h1.buys ?? 0) + (h1.sells ?? 0);

  const result = db().prepare(`
    INSERT INTO snapshots
      (pair_address, timestamp, price_usd, market_cap, fdv, liquidity_usd,
       volume_m5, volume_h1, volume_h6, volume_h24,
       buys_m5, sells_m5, txns_m5, txns_h1,
       price_change_m5, price_change_h1, raw_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    p.pairAddress,
    Date.now(),
    p.priceUsd ? Number(p.priceUsd) : null,
    p.marketCap ?? null,
    p.fdv ?? null,
    p.liquidity?.usd ?? null,
    p.volume?.m5 ?? null,
    p.volume?.h1 ?? null,
    p.volume?.h6 ?? null,
    p.volume?.h24 ?? null,
    m5.buys ?? null,
    m5.sells ?? null,
    txnsM5,
    txnsH1,
    p.priceChange?.m5 ?? null,
    p.priceChange?.h1 ?? null,
    JSON.stringify(p),
  );
  return Number(result.lastInsertRowid);
}

export function recentSnapshots(pairAddress: string, withinMs: number): SnapshotRow[] {
  const cutoff = Date.now() - withinMs;
  return db().prepare(`
    SELECT * FROM snapshots
    WHERE pair_address = ? AND timestamp >= ?
    ORDER BY timestamp ASC
  `).all(pairAddress, cutoff) as SnapshotRow[];
}

export function allTrackedPairs(chainId: string): string[] {
  return (db().prepare(
    `SELECT pair_address FROM pairs WHERE chain_id = ? ORDER BY last_seen DESC`,
  ).all(chainId) as { pair_address: string }[]).map((r) => r.pair_address);
}

export function lastAlertForPair(pairAddress: string): {
  tier: string;
  timestamp: number;
} | null {
  const row = db().prepare(`
    SELECT tier, timestamp FROM alerts
    WHERE pair_address = ?
    ORDER BY timestamp DESC LIMIT 1
  `).get(pairAddress) as { tier: string; timestamp: number } | undefined;
  return row ?? null;
}

export interface AlertInsert {
  pairAddress: string;
  tier: 'WATCH' | 'TRADE_RADAR' | 'CAUTION';
  score: number;
  volumeAcceleration: number;
  priceChangeM5: number | null;
  marketCap: number | null;
  liquidityUsd: number | null;
  buyRatio: number | null;
  snapshotId: number | null;
  payload: unknown;
  sent: boolean;
}

export function insertAlert(a: AlertInsert): number {
  const r = db().prepare(`
    INSERT INTO alerts
      (pair_address, tier, timestamp, score, volume_acceleration,
       price_change_m5, market_cap, liquidity_usd, buy_ratio,
       snapshot_id, payload_json, sent_to_telegram)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    a.pairAddress, a.tier, Date.now(), a.score, a.volumeAcceleration,
    a.priceChangeM5, a.marketCap, a.liquidityUsd, a.buyRatio,
    a.snapshotId, JSON.stringify(a.payload), a.sent ? 1 : 0,
  );
  return Number(r.lastInsertRowid);
}

export function snapshotsBetween(startMs: number, endMs: number): SnapshotRow[] {
  return db().prepare(`
    SELECT * FROM snapshots
    WHERE timestamp BETWEEN ? AND ?
    ORDER BY timestamp ASC
  `).all(startMs, endMs) as SnapshotRow[];
}

export function snapshotsForPair(pairAddress: string): SnapshotRow[] {
  return db().prepare(`
    SELECT * FROM snapshots
    WHERE pair_address = ?
    ORDER BY timestamp ASC
  `).all(pairAddress) as SnapshotRow[];
}
