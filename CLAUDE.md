# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this system does

`cabal-trending` is the **front-line scanner** of a two-repo Solana memecoin trading system. Sister repo `smart-wallet-lab` lives at `~/OneDrive/smart-wallet-lab/`.

Every 15 min, cron-job.org pings GitHub Actions → the workflow runs one scan → poll DexScreener for hundreds of Solana pairs → fire a RUNNER alert when a token matches a 10-condition mechanical setup → post to the Telegram "SOL CABAL TRENDING" channel. `smart-wallet-lab` ingests these alerts and posts a follow-up forensic analysis.

User is a Solana memecoin **swing trader** (in/out within hours), trades on **GMGN**.

## Stack

TypeScript + Node 20 ESM, `better-sqlite3` for storage, DexScreener REST (free tier), Solscan for on-chain dev checks, Telegram for alerting, GitHub Actions for execution.

## Commands

```
npm run scan          # one-shot scan + exit (what CI runs)
npm run dev           # long-running scanner with tsx watch (local dev)
npm run start         # long-running scanner (production-style, no watch)
npm run backtest      # replay stored snapshots, output CSV + win-rate stats
npm run test-alert    # send a fake alert to verify Telegram works
npm run get-chat-id   # find your Telegram channel's chat_id
npm run prune-db      # trim snapshots/alerts/pairs to keep SQLite < 100 MB
npm run typecheck     # tsc --noEmit
npm run lint          # eslint . --ext .ts
npm run build         # tsc -> dist/
```

There are **two entrypoints**: `src/run-once.ts` (single-shot, used by GitHub Actions) and `src/index.ts` (long-running loop, used by `npm run dev` / `start`). They share `runDiscovery()` and `runPoll()` from `src/scanner/poll.ts` — the loop variant just schedules them on intervals.

## Architecture

### Active vs dormant detectors

The codebase contains three scoring systems but **only the RUNNER detector is enabled in production.** Don't assume code in `src/scoring/` is live just because it exists.

| System | File | Status | Toggle |
|---|---|---|---|
| RUNNER detector | `src/scoring/runner.ts` | **ACTIVE** | `runner.enabled: true` |
| Tiered WATCH/TRADE_RADAR/CAUTION | `src/scoring/engine.ts`, `tiers.ts` | dormant | `tieredAlertsEnabled: false` |
| Money-flow anomaly | `src/scoring/money_flow.ts` | dormant | `moneyFlowAnomaly.enabled: false` |

The README documents the dormant tiered system because it's the historical design. The RUNNER detector replaced it. Treat the dormant code as reference, not a fallback.

### RUNNER detection criteria (`config/strategy.solana.json` → `runner`)

- Age 1-730 days
- MC $500K - $15M
- Turnover ≥25% of MC (h24 vol / cap)
- H1 vol rate / H6 avg ≥ `h1AccelMin` (currently 0.9 — loose)
- Liquidity growth ≥2% over scan window
- Buy ratio 50-65%
- H1 price -10% to +25%
- H24 price -10% to +200%
- ≥500 H24 txns
- DEX in allowlist (raydium, pumpfun, pump, pumpswap, bonk, letsbonk, meteora, orca)
- Cooldown: 24 hours per pair (1440 min)

### Dev check (appended to every RUNNER alert)

`src/dev_check/check.ts` runs after a RUNNER fires:
- Top 10 holder concentration %
- Mint authority status (revoked = good)
- Freeze authority status (revoked = good)
- Cluster funder analysis (multi-wallet from same source)
- Returns LOW / MEDIUM / HIGH risk verdict

The RUNNER detector is the **mechanical filter** (finds the technical setup). The dev check is the **rug filter** (surfaces obvious supply-control / mintable risks). Qualitative judgment lives in `smart-wallet-lab`, not here.

### Key files

- `src/scoring/runner.ts` — the 10-condition RUNNER detector
- `src/scanner/poll.ts` — discovery + poll orchestrator
- `src/dexscreener/client.ts` — rate-limited REST wrapper (~60 search req/min self-throttle)
- `src/dev_check/check.ts`, `solscan.ts` — dev/holder check + Solscan client
- `src/alerts/formatter.ts`, `telegram.ts`, `dedup.ts` — formatting, sending, cooldown
- `src/db/schema.ts`, `snapshots.ts` — SQLite schema + CRUD
- `config/strategy.solana.json` — all tunable thresholds
- `config/discovery.json` — seed search terms that surface candidate pairs
- `config/watchlist.json` — explicit pair addresses always polled

### Database

SQLite at `data/cabal.sqlite`, committed back to repo on each scan run. Tables:
- `pairs` — known pair metadata (cached)
- `snapshots` — full polling history with raw_json
- `alerts` — RUNNER alerts that fired

The CI workflow (`.github/workflows/scan.yml`) runs `prune-db.ts` after every scan (snapshots > 8h, alerts > 7d, pairs > 14d) to keep the DB under GitHub's 100 MB push limit. `concurrency: cabal-trending-state` with `cancel-in-progress: false` serializes runs so they don't race on the SQLite file. The commit step does `git pull --rebase || true` then push, which is best-effort — concurrent commit conflicts recover on the next 15-min run.

### Environment (`.env`, gitignored — example in `.env.example`)

```
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=         # Note: CHAT_ID here, CHANNEL_ID in smart-wallet-lab
SOLSCAN_API_KEY=          # for the dev check
DEXSCREENER_BASE_URL=https://api.dexscreener.com
CHAIN_ID=solana
DB_PATH=data/cabal.sqlite
LOG_LEVEL=info
POLL_INTERVAL_SECONDS=20
```

### Cron-job.org

| Job | Schedule | Workflow |
|-----|----------|----------|
| CABAL | every 15 min at :00 :15 :30 :45 | `.github/workflows/scan.yml` |

GitHub's own `schedule:` cron is intentionally not used — it's best-effort and unreliable at short cadences. cron-job.org pings `workflow_dispatch` directly.

## Sister repo integration

`smart-wallet-lab` reads this repo's `data/cabal.sqlite` directly via:
1. **Local:** OneDrive sync makes both folders mutually accessible.
2. **CI:** smart-wallet-lab's workflow does `git clone --depth=1` of this repo to get the latest DB.

If the DB schema changes here, check `runner_tracker.ingest_cabal_runners()` in `smart-wallet-lab`.

## Known limitations

- DexScreener exposes only 5m / 1h / 6h / 24h aggregates — no candle wicks, no intra-bucket extremes.
- `pairCreatedAt` is sometimes missing for pump.fun tokens; those pairs aren't filtered by age.
- DB binary commits can conflict between back-to-back runs; the workflow tolerates this and recovers next run.

## Recent tuning history

- `h1AccelMin` loosened 1.3 → 0.9 (was too strict, only 5 alerts in 12h).
- `cooldownMinutes` 720 → 1440 (was firing same token 4×/day).
- DEX allowlist expanded to include raydium, meteora, orca, bonk.
