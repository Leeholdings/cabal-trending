/**
 * DexScreener REST client. Self-throttled to stay under 300 req/min.
 * Endpoints used:
 *   GET /latest/dex/search?q=<query>
 *   GET /latest/dex/pairs/{chainId}/{pairAddress}
 *   GET /token-pairs/v1/{chainId}/{tokenAddress}
 */
import axios, { AxiosError, AxiosInstance } from 'axios';
import { getConfig } from '../config/loader.js';
import { log } from '../util/logger.js';
import { sleep } from '../util/sleep.js';

// DexScreener docs: pair-related endpoints = 300 rpm. Profile/boost = 60 rpm.
// We sit a bit under the cap to leave headroom for retries.
const RPM_PAIR    = 270;
const RPM_PROFILE = 50;

class RateLimiter {
  private calls: number[] = [];
  constructor(private readonly rpm: number) {}
  async wait(): Promise<void> {
    const now = Date.now();
    const cutoff = now - 60_000;
    while (this.calls.length && this.calls[0]! < cutoff) this.calls.shift();
    if (this.calls.length >= this.rpm) {
      const sleepFor = 60_000 - (now - this.calls[0]!) + 50;
      if (sleepFor > 0) {
        log.debug(`rate limit: sleeping ${sleepFor}ms`);
        await sleep(sleepFor);
      }
    }
    this.calls.push(Date.now());
  }
}

export interface DexScreenerToken {
  address: string;
  name?: string;
  symbol?: string;
}

export interface DexScreenerTxnsBucket {
  buys: number;
  sells: number;
}

export interface DexScreenerPair {
  chainId: string;
  dexId?: string;
  url?: string;
  pairAddress: string;
  baseToken: DexScreenerToken;
  quoteToken: DexScreenerToken;
  priceUsd?: string;
  priceNative?: string;
  liquidity?: { usd?: number; base?: number; quote?: number };
  volume?: { h24?: number; h6?: number; h1?: number; m5?: number };
  priceChange?: { h24?: number; h6?: number; h1?: number; m5?: number };
  txns?: { h24?: DexScreenerTxnsBucket; h6?: DexScreenerTxnsBucket; h1?: DexScreenerTxnsBucket; m5?: DexScreenerTxnsBucket };
  fdv?: number;
  marketCap?: number;
  pairCreatedAt?: number; // unix ms
}

export class DexScreenerClient {
  private readonly http: AxiosInstance;
  private readonly pairLimiter = new RateLimiter(RPM_PAIR);
  private readonly profileLimiter = new RateLimiter(RPM_PROFILE);

  constructor() {
    const cfg = getConfig();
    this.http = axios.create({
      baseURL: cfg.dexscreenerBaseUrl,
      timeout: 20_000,
      headers: { 'User-Agent': 'cabal-trending/0.1' },
    });
  }

  private async getJson<T>(path: string, profile = false, attempt = 0): Promise<T> {
    const limiter = profile ? this.profileLimiter : this.pairLimiter;
    await limiter.wait();
    try {
      const res = await this.http.get<T>(path);
      return res.data;
    } catch (err) {
      const e = err as AxiosError;
      // Retry on 429/5xx with exponential backoff up to 4 tries.
      const status = e.response?.status ?? 0;
      const transient = status === 429 || status >= 500;
      if (transient && attempt < 4) {
        const backoff = Math.min(30_000, 500 * 2 ** attempt);
        log.warn(`DexScreener ${status} on ${path}; retry in ${backoff}ms`);
        await sleep(backoff);
        return this.getJson<T>(path, profile, attempt + 1);
      }
      throw err;
    }
  }

  /** Free-text search across all chains. We filter to Solana downstream. */
  async search(query: string): Promise<DexScreenerPair[]> {
    const data = await this.getJson<{ pairs?: DexScreenerPair[] }>(
      `/latest/dex/search?q=${encodeURIComponent(query)}`,
    );
    return data.pairs ?? [];
  }

  /** Single-pair lookup. Used by the polling loop to refresh tracked pairs. */
  async pair(chainId: string, pairAddress: string): Promise<DexScreenerPair | null> {
    const data = await this.getJson<{ pairs?: DexScreenerPair[] }>(
      `/latest/dex/pairs/${chainId}/${pairAddress}`,
    );
    return data.pairs?.[0] ?? null;
  }

  /** All pairs that involve a given token on a given chain. */
  async tokenPairs(chainId: string, tokenAddress: string): Promise<DexScreenerPair[]> {
    const data = await this.getJson<DexScreenerPair[]>(
      `/token-pairs/v1/${chainId}/${tokenAddress}`,
    );
    return Array.isArray(data) ? data : [];
  }

  /** Latest boosted tokens (trending). Profile endpoint, lower rate limit. */
  async boostedTokensLatest(): Promise<Array<{ chainId: string; tokenAddress: string }>> {
    const data = await this.getJson<Array<{ chainId: string; tokenAddress: string }>>(
      '/token-boosts/latest/v1',
      true,
    );
    return Array.isArray(data) ? data : [];
  }

  /** Top boosted tokens (most paid for visibility). Profile endpoint. */
  async boostedTokensTop(): Promise<Array<{ chainId: string; tokenAddress: string }>> {
    const data = await this.getJson<Array<{ chainId: string; tokenAddress: string }>>(
      '/token-boosts/top/v1',
      true,
    );
    return Array.isArray(data) ? data : [];
  }
}

let _client: DexScreenerClient | null = null;
export function dex(): DexScreenerClient {
  if (!_client) _client = new DexScreenerClient();
  return _client;
}
