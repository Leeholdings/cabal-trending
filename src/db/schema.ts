/**
 * SQLite schema and connection.
 *
 * Tables:
 *   pairs           — every distinct pair we've ever discovered (dedupe pool)
 *   snapshots       — append-only time-series of pair state per poll
 *   alerts          — every alert we've ever sent (used for cooldown dedup + backtest)
 */
import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { getConfig, PROJECT_ROOT } from '../config/loader.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS pairs (
    pair_address    TEXT PRIMARY KEY,
    chain_id        TEXT NOT NULL,
    base_address    TEXT,
    base_symbol     TEXT,
    base_name       TEXT,
    quote_address   TEXT,
    quote_symbol    TEXT,
    dex_id          TEXT,
    pair_url        TEXT,
    pair_created_at INTEGER,           -- unix ms from DexScreener
    first_seen      INTEGER NOT NULL,  -- unix ms when WE first saw it
    last_seen       INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pairs_chain ON pairs (chain_id);

CREATE TABLE IF NOT EXISTS snapshots (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    pair_address    TEXT NOT NULL,
    timestamp       INTEGER NOT NULL,  -- unix ms
    price_usd       REAL,
    market_cap      REAL,
    fdv             REAL,
    liquidity_usd   REAL,
    volume_m5       REAL,
    volume_h1       REAL,
    volume_h6       REAL,
    volume_h24      REAL,
    buys_m5         INTEGER,
    sells_m5        INTEGER,
    txns_m5         INTEGER,
    txns_h1         INTEGER,
    price_change_m5 REAL,
    price_change_h1 REAL,
    raw_json        TEXT NOT NULL,
    FOREIGN KEY (pair_address) REFERENCES pairs(pair_address) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_snap_pair_ts ON snapshots (pair_address, timestamp);
CREATE INDEX IF NOT EXISTS idx_snap_ts      ON snapshots (timestamp);

CREATE TABLE IF NOT EXISTS alerts (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    pair_address        TEXT NOT NULL,
    tier                TEXT NOT NULL,    -- 'WATCH' | 'TRADE_RADAR' | 'CAUTION'
    timestamp           INTEGER NOT NULL,
    score               REAL,
    volume_acceleration REAL,
    price_change_m5     REAL,
    market_cap          REAL,
    liquidity_usd       REAL,
    buy_ratio           REAL,
    snapshot_id         INTEGER,
    payload_json        TEXT NOT NULL,
    sent_to_telegram    INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (pair_address) REFERENCES pairs(pair_address) ON DELETE CASCADE,
    FOREIGN KEY (snapshot_id)  REFERENCES snapshots(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_alerts_pair_ts ON alerts (pair_address, timestamp);
CREATE INDEX IF NOT EXISTS idx_alerts_tier_ts ON alerts (tier, timestamp);
`;

let _db: Database.Database | null = null;

export function db(): Database.Database {
  if (_db) return _db;
  const cfg = getConfig();
  const path = resolve(PROJECT_ROOT, cfg.dbPath);
  mkdirSync(dirname(path), { recursive: true });
  _db = new Database(path);
  _db.pragma('journal_mode = WAL');
  _db.pragma('foreign_keys = ON');
  _db.exec(SCHEMA);
  return _db;
}

export function closeDb(): void {
  if (_db) {
    _db.close();
    _db = null;
  }
}
