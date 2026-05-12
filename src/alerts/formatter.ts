import type { DexScreenerPair } from '../dexscreener/client.js';
import type { ScoreOutput } from '../scoring/engine.js';
import type { AlertTier } from '../scoring/tiers.js';
import type { MoneyFlowScore } from '../scoring/money_flow.js';
import type { RunnerSignal } from '../scoring/runner.js';
import { gmgnTokenUrl } from '../scoring/runner.js';
import type { DevCheck } from '../dev_check/check.js';
import { riskEmoji } from '../dev_check/check.js';

const escHtml = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const fmtUsd = (v: number | null | undefined): string => {
  if (v === null || v === undefined) return '-';
  if (v >= 1_000_000) return '$' + (v / 1_000_000).toFixed(2) + 'M';
  if (v >= 1_000) return '$' + (v / 1_000).toFixed(1) + 'K';
  return '$' + v.toFixed(2);
};

const fmtPrice = (v: string | number | null | undefined): string => {
  if (v === null || v === undefined) return '-';
  const n = typeof v === 'string' ? Number(v) : v;
  if (!Number.isFinite(n)) return '-';
  if (n < 0.0001) return '$' + n.toExponential(2);
  if (n < 1) return '$' + n.toFixed(6);
  return '$' + n.toFixed(4);
};

export interface FormattedAlert { text: string; parseMode: 'HTML'; }

export function formatAlert(args: { tier: AlertTier; pair: DexScreenerPair; score: ScoreOutput }): FormattedAlert {
  const { tier, pair, score } = args;
  const sym = escHtml(pair.baseToken?.symbol ?? '???');
  const url = escHtml(pair.url ?? 'https://dexscreener.com/' + pair.chainId + '/' + pair.pairAddress);
  const lines: string[] = [];
  lines.push('<b>' + tier + ' - ' + sym + '</b>');
  lines.push('<a href="' + url + '">View on DexScreener</a>');
  lines.push('Score: ' + score.overall.toFixed(1) + '/100, VolAccel: ' + score.volumeAcceleration.toFixed(2) + 'x');
  lines.push('MC: ' + fmtUsd(pair.marketCap ?? pair.fdv) + ', Liq: ' + fmtUsd(pair.liquidity?.usd) + ', Price: ' + fmtPrice(pair.priceUsd));
  return { text: lines.join('\n'), parseMode: 'HTML' };
}

export function formatMoneyFlowAlert(args: { pair: DexScreenerPair; score: MoneyFlowScore }): FormattedAlert {
  const { pair, score } = args;
  const sym = escHtml(pair.baseToken?.symbol ?? '???');
  const url = escHtml(pair.url ?? 'https://dexscreener.com/' + pair.chainId + '/' + pair.pairAddress);
  const lines: string[] = [];
  lines.push('<b>🔥 MONEY_FLOW_ANOMALY - ' + sym + '</b>');
  lines.push('<a href="' + url + '">View on DexScreener</a>');
  lines.push('Score: <b>' + score.overall.toFixed(1) + '/100</b>');
  lines.push('MC: ' + fmtUsd(pair.marketCap ?? pair.fdv) + ', Liq: ' + fmtUsd(pair.liquidity?.usd));
  if (score.reasons.length) {
    lines.push('');
    lines.push('<b>WHY:</b>');
    for (const r of score.reasons) lines.push('• ' + escHtml(r));
  }
  return { text: lines.join('\n'), parseMode: 'HTML' };
}

export function formatRunnerAlert(args: { pair: DexScreenerPair; signal: RunnerSignal; devCheck?: DevCheck | null }): FormattedAlert {
  const { pair, signal, devCheck } = args;
  const sym = escHtml(pair.baseToken?.symbol ?? '???');
  const name = escHtml(pair.baseToken?.name ?? '');
  const tokenAddress = pair.baseToken?.address ?? '';
  const url = escHtml(pair.url ?? 'https://dexscreener.com/' + pair.chainId + '/' + pair.pairAddress);
  const gUrl = tokenAddress ? gmgnTokenUrl(tokenAddress) : null;

  const lines: string[] = [];
  lines.push('<b>🚀 RUNNER candidate - ' + sym + (name && name !== sym ? ' (' + name + ')' : '') + '</b>');
  lines.push('<a href="' + url + '">View on DexScreener</a>');
  lines.push('');
  lines.push('<b>Market Cap:</b> ' + fmtUsd(signal.marketCap) + '   <i>(sweet spot)</i>');
  lines.push('<b>Liquidity:</b>  ' + fmtUsd(signal.liquidityUsd) + (signal.liquidityGrowthPct > 0 ? ' (+' + signal.liquidityGrowthPct.toFixed(1) + '%)' : ''));
  lines.push('<b>Pair Age:</b>   ' + signal.ageDays.toFixed(1) + 'd');
  lines.push('<b>Price:</b>      ' + fmtPrice(pair.priceUsd));
  lines.push('<b>DEX:</b>        ' + escHtml(signal.dexId));
  lines.push('');
  lines.push('<b>WHY:</b>');
  for (const r of signal.reasons) lines.push('• ' + escHtml(r));
  lines.push('');

  // DEV CHECK — replaces the static "Unknown" line with real signal
  if (devCheck) {
    lines.push('<b>DEV/HOLDER CHECK:</b> ' + riskEmoji(devCheck.rugRisk) + ' <b>' + devCheck.rugRisk + '</b> — ' + escHtml(devCheck.summary));
    if (devCheck.reasons.length) {
      for (const r of devCheck.reasons) lines.push('• ⚠ ' + escHtml(r));
    } else if (devCheck.rugRisk === 'LOW') {
      lines.push('• ✓ No active mint/freeze authorities, holder distribution looks healthy');
    }
  } else {
    lines.push('<b>DEV/HOLDER CHECK:</b> ⚪ Unknown — Solscan unreachable, verify manually');
  }
  lines.push('');

  if (gUrl) lines.push('🔗 <a href="' + escHtml(gUrl) + '">GMGN: dev wallet + holder analysis</a>');
  lines.push('');
  lines.push('<i>⚠ Runner pattern, NOT a guarantee. Observation only.</i>');

  return { text: lines.join('\n'), parseMode: 'HTML' };
}
