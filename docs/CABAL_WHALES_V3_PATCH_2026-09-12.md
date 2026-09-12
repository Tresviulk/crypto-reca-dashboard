# CABAL + WHALES V3 PATCH

Effective date: 2026-09-12 Europe/Madrid

## Objective
Prevent repeats of POP/STORJ-type discovery misses by making CABAL and WHALES bidirectional, broad-market and anti-bottleneck. This patch changes discovery and validation only. It does not auto-trade, alter confirmed fills, or lower execution/risk controls.

## Confirmed pre-patch bottlenecks
1. TradingView market sweep requests up to 1,800 rows, but Worker Stage A is truncated to top 30 candidates.
2. Deep validation is truncated to the first 10 Stage-A assets that have a Bybit USDT/USDC spot pair.
3. A Stage-A asset without Bybit spot does not receive full deep validation and may default to NO SETUP/LATE solely because the preferred venue is unavailable.
4. Stage-A scoring is dominated by current 1h/4h acceleration and volume acceleration. A multi-day mover that temporarily cools can fall out even if a valid second leg is forming.
5. Known-wallet monitoring alone cannot discover whales that were not pre-registered.
6. A top-N or known-wallet bottleneck must never be reported as full market/whale coverage.

## PATCH A — Broad market candidate generation
- Preserve market-wide TradingView scan up to at least 1,800 rows.
- Add independent anomaly lanes before top-N truncation:
  - PRICE_ACCEL
  - VOLUME_ACCEL
  - PRICE_X_VOLUME
  - SECOND_LEG_1D_7D
  - TURNOVER_ANOMALY
  - MICROCAP_ANOMALY_WATCH
- Primary actionable CABAL band remains approximately $15M-$3B market cap with >=$2M 24h spot volume.
- Add MICROCAP_ANOMALY_WATCH below $15M only as research/watch, requiring credible execution/liquidity and exceptional turnover/volume. It cannot become a trade without the normal deep validation, anti-chase, invalidation and protection rules.
- A token may enter through any anomaly lane even when it would not rank in the top current 1h/4h score.

## PATCH B — Remove top-30/top-10 single-point failure
- Increase Worker Stage-A retention target from 30 to 60, subject to runtime limits.
- Increase deep-validation target from 10 to 30, subject to runtime limits.
- More importantly, preserve lane quotas so one high-volume theme cannot crowd out all other candidates. Minimum target allocation when available:
  - 12 PRICE_ACCEL
  - 12 VOLUME_ACCEL
  - 12 PRICE_X_VOLUME
  - 12 SECOND_LEG_1D_7D
  - 6 TURNOVER/MICROCAP anomaly
- Deduplicate by base asset after lane selection.
- Return per-lane candidate counts and truncation flags in coverage metadata.

## PATCH C — Multi-venue deep validation
- Bybit remains preferred OHLCV source when available.
- Lack of Bybit spot is NOT a NO SETUP reason.
- Fallback to another reliable spot venue/data source with completed 15m/1h/4h OHLCV.
- Output `deepValidationSource` and `deepValidationStatus`.
- Only classify DATA GAP after at least one fallback attempt.

## PATCH D — Mandatory second-leg market sweep
Every run must independently inspect assets with material 1-7 day moves, not only current Stage-A leaders.

SECOND_LEG_WATCH requires:
1. timestampable prior leg;
2. several completed 1h candles of consolidation/base/controlled pullback/compression;
3. no longer vertically extended from the defended base;
4. volume cooled/normalized during reset;
5. new 1h/4h volume or relative-strength re-acceleration, reclaim or breakout.

A strong 7d move is not a veto. No reset/base = LATE/NO CHASE.

## PATCH E — CABAL -> WHALES reverse trigger
Any CABAL anomaly candidate that meets an EARLY/PRE-MOVE/SECOND-LEG/turnover anomaly condition automatically requests WHALES DEEP for that token. The user does not need to type a second command.

WHALES DEEP token-centric checks, when provider/network data is available:
- large token transfers;
- net accumulators over 6h/24h/72h;
- exchange withdrawals vs deposits;
- new large wallets;
- repeated accumulation by independent wallets;
- overlap with known smart-money cohorts;
- concentration change where reliably measurable;
- exclude known CEX hot/cold wallets, bridges, treasury, vesting, LP contracts and obvious internal transfers where identifiable.

If on-chain/provider access is unavailable, output WHALE DATA GAP. Never convert missing whale data into `no whales`.

## PATCH F — WHALES -> CABAL forward trigger
Any material buy/accumulation/convergence signal from a watched known wallet/cohort automatically sends that token into CABAL Stage A + deep validation even if it was absent from the market anomaly list.

Known-wallet watch and token-centric discovery are independent lanes.

## PATCH G — Dynamic temporary cohorts
When token-centric WHALES DEEP finds multiple independent accumulators that pass quality filters, create a temporary token cohort for 72h and track:
- wallet address/id;
- first observed accumulation time;
- net token accumulation;
- USD-equivalent estimate when verifiable;
- exchange interaction classification;
- repeated buys/sells;
- convergence count.

Temporary cohorts expire unless renewed by new material activity. They do not automatically become permanent trusted whales.

## PATCH H — Coverage truth
A run can report PASS only if it explicitly states:
- market rows received / total available;
- deduped universe count;
- anomaly-lane counts;
- Stage-A retained count;
- deep-validation attempted/completed count;
- second-leg sweep status;
- known-wallet WHALES status;
- token-centric WHALES status or explicit DATA GAP;
- truncation flags;
- fallback status.

Top-N truncation, unavailable whale provider, or missing multi-venue fallback must be PARTIAL, not silently PASS.

## PATCH I — Process-miss audit
For any material mover not surfaced early, determine prospectively/verifiably:
- earliest objectively detectable window;
- which lane should have caught it;
- whether it was outside source coverage, filtered by threshold, crowded out by top-N, blocked by venue-only validation, missed by second-leg logic, or missed by WHALES;
- exact corrective action.

Do not reconstruct a buy signal with hindsight.

## Unified manual command
`TODO`

From this patch onward, TODO means one complete on-demand cycle:
1. market regime/context;
2. CORE assets;
3. CABAL broad market anomaly sweep;
4. CABAL second-leg sweep;
5. CABAL deep validation with multi-venue fallback;
6. WHALES known-wallet watch;
7. automatic WHALES DEEP for every qualifying CABAL anomaly;
8. WHALES -> CABAL reverse candidate injection;
9. process-miss / coverage audit;
10. all confirmed open-position P/L and risk/FAST-DROP checks;
11. exchange/project/listing/catalyst risk;
12. final single action table: BUY CANDIDATE / WATCH / HOLD / REDUCE REVIEW / EXIT REVIEW / NO TRADE / DATA GAP.

No automatic order execution. Exchange evidence remains execution truth.

## Deployment constraint
The production Cloudflare source must be exported/compared before redeployment. The File Library `cabal-scanner-worker.js` is a development snapshot and is not proven byte-for-byte identical to current production. Do not overwrite production blindly.
