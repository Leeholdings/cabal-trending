/**
 * Minimal Solscan Pro v2 client used ONLY for the dev/holder check.
 * No retries or rate-limiting beyond a request timeout — alerts must
 * never block on this. Failures are caught upstream and rendered as
 * "Unknown" so the alert still fires.
 */
const BASE = 'https://pro-api.solscan.io/v2.0';
const TIMEOUT_MS = 5000;

function key(): string | null {
  const k = process.env.SOLSCAN_API_KEY;
  return k && k.trim() ? k.trim() : null;
}

async function get<T = any>(path: string, params: Record<string, string | number>): Promise<T | null> {
  const k = key();
  if (!k) return null;
  const qs = new URLSearchParams();
  for (const [kk, vv] of Object.entries(params)) qs.set(kk, String(vv));
  const url = BASE + path + '?' + qs.toString();
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(url, {
      headers: { token: k, Accept: 'application/json' },
      signal: ctrl.signal,
    });
    if (!r.ok) return null;
    const j: any = await r.json();
    // Solscan v2 wraps payload under "data" sometimes, sometimes top-level
    return (j?.data ?? j) as T;
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

export interface TokenMeta {
  creator?: string | null;
  mintAuthority?: string | null;
  freezeAuthority?: string | null;
  supply?: number | string | null;
  decimals?: number | null;
  symbol?: string | null;
  name?: string | null;
}

export async function getTokenMeta(mint: string): Promise<TokenMeta | null> {
  const d = await get<any>('/token/meta', { address: mint });
  if (!d) return null;
  // v2 field names vary slightly across endpoints — normalize
  return {
    creator: d.creator ?? d.created_by ?? null,
    mintAuthority: d.mint_authority ?? d.mintAuthority ?? null,
    freezeAuthority: d.freeze_authority ?? d.freezeAuthority ?? null,
    supply: d.supply ?? null,
    decimals: typeof d.decimals === 'number' ? d.decimals : null,
    symbol: d.symbol ?? null,
    name: d.name ?? null,
  };
}

export interface HolderRow {
  owner: string;
  amount: number;
  rank: number;
}

export async function getTopHolders(mint: string, limit = 20): Promise<HolderRow[] | null> {
  const d = await get<any>('/token/holders', { address: mint, page: 1, page_size: limit });
  if (!d) return null;
  const items: any[] = d.items ?? d ?? [];
  return items.map((it: any, i: number) => ({
    owner: it.owner ?? it.address ?? '',
    amount: Number(it.amount ?? it.balance ?? 0),
    rank: i + 1,
  })).filter(h => h.owner);
}
