/**
 * Smoke test for the new dev/holder check.
 * Runs runDevCheck against a few known mints and prints the verdict.
 *
 *   npx tsx tools/test-dev-check.ts
 */
import 'dotenv/config';
import { runDevCheck, riskEmoji } from '../src/dev_check/check.js';

const TARGETS: Array<[string, string, string?]> = [
  ['CATCOIN', '5gTPspC2ricuGWiYQ4Ghausg8fsq7uCrGgSVACatcoin', '6fNWjfFN6kDKybWK5PFLWqZnpTmoBAswUWvxiG3g5D2D'],
  ['GAYTES',  'HSznAnNhSFgyRWiZh4m7pBmtjHsSLi4Dbmjp18zppump', '69vfyvsbzcgfbkiqqwsxmuhaqt2a1zuxyvwzavzpqhvm'],
  ['HANTA',   'HANTAYLiPiQ8d8dkJizcL8gJQHWBKF5ZeL1neeLqwbzc',  'b4wct2ow4hy8gwtzdbtjs4xjsjys5291qj3ahs2gwnsk'],
];

async function main() {
  if (!process.env.SOLSCAN_API_KEY) {
    console.error('SOLSCAN_API_KEY not in env — check your .env');
    process.exit(1);
  }
  for (const [sym, mint, pool] of TARGETS) {
    process.stdout.write(`\n=== ${sym} (${mint.slice(0,8)}...) ===\n`);
    const dc = await runDevCheck(mint, pool);
    if (!dc) { console.log('  Solscan returned no data (Unknown)'); continue; }
    console.log(`  Risk    : ${riskEmoji(dc.rugRisk)} ${dc.rugRisk}`);
    console.log(`  Summary : ${dc.summary}`);
    console.log(`  top10   : ${dc.top10Pct?.toFixed(1) ?? '-'}%`);
    console.log(`  top1    : ${dc.top1Pct?.toFixed(1) ?? '-'}%`);
    console.log(`  dev     : ${dc.devHoldsPct?.toFixed(2) ?? '-'}%`);
    console.log(`  mintAuth: ${dc.mintAuthLive === null ? '?' : dc.mintAuthLive ? 'ACTIVE ⚠' : 'revoked 🔒'}`);
    console.log(`  freeze  : ${dc.freezeAuthLive === null ? '?' : dc.freezeAuthLive ? 'ACTIVE ⚠' : 'revoked 🔒'}`);
    if (dc.reasons.length) {
      console.log('  Reasons :');
      for (const r of dc.reasons) console.log('    • ' + r);
    }
  }
}
main().catch(e => { console.error(e); process.exit(1); });
