/**
 * Config loader. Singleton-style getConfig().
 */
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
export const PROJECT_ROOT = resolve(__dirname, '../..');

function envStr(name: string, fallback = ''): string {
  return (process.env[name] ?? fallback).trim();
}
function envInt(name: string, fallback: number): number {
  const v = envStr(name);
  const n = v ? Number(v) : fallback;
  return Number.isFinite(n) ? n : fallback;
}

export interface AlertTierThresholds {
  volumeAccelerationMin: number;
  volumeAccelerationMax?: number;
  priceChangeM5Max?: number;
  priceChangeM5Min?: number;
}

export interface MoneyFlowAnomalyConfig {
  enabled: boolean;
  minScore: number;
  rankBoostTopPercent: number;
  rankBoostAmount: number;
  rankBoostMinBase?: number;
  cooldownMinutes: number;
  escalationRefireScoreIncrease: number;
  lookbackHours: number;
  minLiquidityHardReject: number;
  minM5VolumeUsd?: number;
  minM5Txns?: number;
  maxLiquidityDropPct: number;
  maxM5VolumeLiquidityRatio: number;
}

export interface RunnerConfig {
  enabled: boolean;
  // Pair age window (days)
  minAgeDays: number;
  maxAgeDays: number;
  // Market cap window (USD)
  minCapUsd: number;
  maxCapUsd: number;
  // H24 volume must be >= this % of market cap
  turnoverMinPct: number;
  // H6 vol rate / H24 vol rate must be >= this
  h6AccelMin: number;
  // Liquidity must have grown by >= this % across scan window
  liqGrowthMinPct: number;
  // H24 buy ratio window (%)
  buyRatioMin: number;
  buyRatioMax: number;
  // H1 price change window (%)
  h1PriceMin: number;
  h1PriceMax: number;
  // H24 price change window (%)
  h24PriceMin: number;
  h24PriceMax: number;
  // H24 transaction count floor
  h24TxnsMin: number;
  // DEX allow-list (substring match, lowercase)
  dexAllowlist?: string[];
  // Alert plumbing
  cooldownMinutes: number;
  lookbackHours: number;
}

export interface StrategyConfig {
  chainId: 'solana';
  tieredAlertsEnabled?: boolean;
  moneyFlowAnomaly?: MoneyFlowAnomalyConfig;
  runner?: RunnerConfig;
  marketCapMin: number;
  marketCapMax: number;
  liquidityMin: number;
  liquidityMax: number;
  volumeH24Min: number;
  pairAgeMaxDays: number;
  pollIntervalSeconds: number;
  minM5Txns?: number;
  minM5VolumeUsd?: number;
  buyRatioMaxExtreme?: number;
  buyRatioMinExtreme?: number;
  maxVolumeOverLiquidityRatio?: number;
  maxLiquidityDropPct?: number;
  watchAlert: AlertTierThresholds;
  tradeRadarAlert: AlertTierThresholds;
  cautionAlert: AlertTierThresholds;
  buyRatioIdealMin: number;
  buyRatioIdealMax: number;
  duplicateAlertCooldownMinutes: number;
}

export interface DiscoveryConfig {
  seedQueries: string[];
  discoveryIntervalMinutes: number;
}

export interface WatchlistConfig {
  pairs: string[];
}

export interface Config {
  strategy: StrategyConfig;
  discovery: DiscoveryConfig;
  watchlist: WatchlistConfig;
  telegram: { botToken: string; chatId: string };
  dexscreenerBaseUrl: string;
  pollIntervalSeconds: number;
  chainId: string;
  dbPath: string;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
}

function readJson<T>(rel: string): T {
  const p = resolve(PROJECT_ROOT, rel);
  return JSON.parse(readFileSync(p, 'utf-8')) as T;
}

function validateStrategy(s: StrategyConfig): void {
  if (s.chainId !== 'solana') {
    throw new Error('Only chainId=solana supported. Got: ' + s.chainId);
  }
  if (s.marketCapMin >= s.marketCapMax) throw new Error('marketCapMin >= marketCapMax');
  if (s.liquidityMin >= s.liquidityMax) throw new Error('liquidityMin >= liquidityMax');
  if (s.buyRatioIdealMin >= s.buyRatioIdealMax) throw new Error('buyRatio bounds inverted');
  if (s.duplicateAlertCooldownMinutes < 0) throw new Error('cooldown < 0');
}

export function loadConfig(): Config {
  const strategy = readJson<StrategyConfig>('config/strategy.solana.json');
  validateStrategy(strategy);

  const discovery = readJson<DiscoveryConfig>('config/discovery.json');
  const watchlist = readJson<WatchlistConfig>('config/watchlist.json');

  const chainId = envStr('CHAIN_ID', 'solana');
  if (chainId !== 'solana') {
    throw new Error('Only CHAIN_ID=solana supported. Got: ' + chainId);
  }

  return {
    strategy,
    discovery,
    watchlist,
    telegram: {
      botToken: envStr('TELEGRAM_BOT_TOKEN'),
      chatId: envStr('TELEGRAM_CHAT_ID'),
    },
    dexscreenerBaseUrl: envStr('DEXSCREENER_BASE_URL', 'https://api.dexscreener.com'),
    pollIntervalSeconds: envInt('POLL_INTERVAL_SECONDS', strategy.pollIntervalSeconds),
    chainId,
    dbPath: envStr('DB_PATH', 'data/cabal.sqlite'),
    logLevel: (envStr('LOG_LEVEL', 'info') as Config['logLevel']),
  };
}

let _config: Config | null = null;
export function getConfig(): Config {
  if (!_config) _config = loadConfig();
  return _config;
}
