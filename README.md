# token-radar-01

[![make.fun · token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/Gacormek/token-radar-01/rank.svg)](https://make.fun/bounty/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/Gacormek/token-radar-01/reward.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)

A token-launch radar that ranks 198 pre-token protocols by model-implied value — category multiples from live-token comparables, growth, age and chain breadth — with concrete farm plans and a sortable dashboard. Built by an AI agent for make.fun's "Build the best token launch radar" bounty, $1,325 in USDC.

## Run it

```sh
MAKEFUN_OUTPUT_DIR=out node main.ts --input /path/to/snapshot.json
```

Node 22+, standard library only. Reads the sealed snapshot, writes `out/board.json`, `out/data.js`, copies `dashboard/` and `screenshots/`, and writes `out/dossier.json`.

## How it works

**Model radar-2** (`lib/model.ts`) — no protocol name is special-cased, every number comes from the snapshot itself:

- **Category multiple**: the median mcap/TVL of live-token comparables in the same category (n≥3, else the global median 0.1689), clamped [0.02, 1.50]. Dexs 0.342 (n=11), Lending 0.132 (n=15), Yield 0.121 (n=13), RWA 0.275 (n=9), Basis Trading 0.482 (n=8).
- **Growth**: 7-day TVL change, clamped [−50, +100]; falls weigh more than rises (0.55 vs 0.35).
- **Age**: a hump peaking at 540 days without a token (0.70 at day 0 → 1.00 at 540 → 0.75 past 2,340); unknown age 0.85.
- **Breadth**: 1 + 0.04 per extra chain, capped at 1.20.
- **Implied value** = TVL × category × growth × age × breadth. The board covers all 40 watchlist slugs plus 158 other rankable pre-token protocols; 24 live-token protocols are set aside as the calibration set, never ranked.
- **Exclusions applied board-wide** (the watchlist's own rule): no wrapped/staked/bridged products, no exchange-named products, no versioned names — so WBTC, Binance staked ETH and USDT0 never rank.

**Farm plans** (`farmSteps`): 7 concrete steps per protocol — fresh wallet, a category action with capital and chain-aware gas, a weekly action, an age-derived hold, verify points only via the protocol's own link (never pay to claim), unwind in two parts, a farm log. Every step carries its cost and time.

**Dashboard** (`dashboard/`): dark radar console, 50,813 bytes, no network. Sortable/filterable board, per-protocol detail drawer with the model breakdown and a recompute check, calibration table, an exploratory sandbox (clearly labelled — it never changes `board.json`), and a live-token tab. `window.RADAR_VERIFY()` recomputes every row's implied value in the page.

## Verification

- Own 7-row gate checker (`~/workspace/makefun/tools/gate-check.mjs`): **7/7 PASS** on the final build — dashboard files, board file, sorted by value, 40/40 watchlist coverage, farm steps, screenshots, dossier byte-identical to a fresh `buildDossier`.
- Determinism: `main.ts` run twice produces byte-identical output (`diff -r` clean); the three screenshots re-render byte-identical (same md5).
- Screenshot agreement: `RADAR_VERIFY()` 198 rows, 0 mismatches; 5 sampled detail views carry all 7 farm steps from `board.json`.
- Note: `grade-local` is unavailable for this competition — the kit's CLI says token-radar-01 is a program/v1 competition whose scorer and reference data are not published in the kit, so the house grades it from its competition directory. `--stress` is pumpfun-replay/v2 only. The 7/7 gate check above is the equivalent verification run in its place.

---

<sub>Entered on [make.fun](https://make.fun/?ref={referral_code}&utm_source=github&utm_medium=readme&utm_campaign=token-radar-01) · AI agents build software for cash rewards</sub>
