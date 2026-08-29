# Crypto Reca v3.3 — Runtime Repair Patch

Effective: 2026-08-29 Europe/Madrid  
Status: mandatory additive runtime repair.  
Engine version is NOT changed. Canonical ERS formula, R1 weights, D/E meanings, risk caps, spot-long/no-leverage perimeter, position truth and Coinbase Preview requirement remain unchanged.

## 1. Purpose

This patch repairs two observed runtime failures without creating a new engine version:

1. the v3.3 EMA Early Reversal layer did not define its fast/slow EMA periods deterministically;
2. radar persistence repeatedly failed even when the complete `data/radar-state.json` payload was recoverable through the connector response resource.

## 2. Deterministic EMA configuration for v3.3

For the v3.3 Multi-Timeframe EMA Early Reversal Layer only, use the following fixed pair on every evaluated timeframe:

- `fast EMA = EMA20`
- `slow EMA = EMA50`

Apply EMA20/EMA50 independently to completed 15m, 1H and 2H candles.

The existing Entry Engine remains unchanged:
- 1H uses EMA20/EMA50/EMA200 as already defined by R1;
- 4H uses EMA20/EMA50 as already defined by R1;
- EMA200 is context/trend strength and is NOT the slow EMA of the v3.3 Early Reversal pair.

This definition is a runtime determinism repair only. It does not change ERS weights or formula.

## 3. EMA state rules

Use completed candles only.

### 3.1 15m

`BULLISH` when either:
- EMA20 crosses above EMA50 on a completed 15m candle; or
- close is above EMA20 and EMA50, EMA20 is rising over the last three completed candles, and EMA20 >= EMA50.

`IMPROVING` when EMA20 remains below EMA50 but the EMA20-EMA50 negative spread has narrowed over the last three completed candles and EMA20 slope is non-negative.

Otherwise `BEARISH/NOISE` according to price/EMA relation and slope.

### 3.2 1H

`CONVERGING` when EMA20 < EMA50 but the negative spread has narrowed over the last three completed 1H candles and EMA20 slope is improving/non-negative.

`BULLISH CROSS / HOLD` when EMA20 >= EMA50 on a completed 1H candle and price closes above both; stronger when the positive spread expands over the next completed candle.

`WIDENING BEARISH` when EMA20 < EMA50 and the negative spread expands over the last three completed 1H candles while EMA20 slope is negative.

### 3.3 2H

`PENDING/NON-ACCELERATING` when EMA20 < EMA50 but the negative spread is flat or narrowing over the last three completed 2H candles.

`MOMENTUM CONFIRMED` only when a completed 2H candle has EMA20 > EMA50, close above both EMAs, EMA20 slope positive, and the positive spread is stable or expanding; structure/RSI/volume must not materially contradict the move.

`ACCELERATING BEARISH` when EMA20 < EMA50, the negative spread expands over the last three completed 2H candles, and EMA20 slope remains negative.

## 4. v3.3 state mapping

- `EMA WATCH`: 15m BULLISH/IMPROVING but 1H is not yet sufficiently CONVERGING.
- `EARLY REVERSAL`: 15m BULLISH; 1H CONVERGING/improving; 2H PENDING/NON-ACCELERATING; valid support/base/reclaim and explicit invalidation; RSI/volume not materially contradictory; plausible net R/R.
- `1H CONFIRMING`: completed 1H BULLISH CROSS/HOLD after an Early Reversal or equivalent prospectively captured setup.
- `2H MOMENTUM CONFIRMED`: completed 2H satisfies section 3.3 MOMENTUM CONFIRMED.

A 15m bullish cross alone never authorizes a trade.

## 5. No-late-recognition persistence fields

At first contemporaneous `EARLY REVERSAL`, persist at minimum:

- asset/pair;
- Scan ID and Europe/Madrid timestamp;
- reference price;
- EMA20/EMA50 values and state for completed 15m, 1H and 2H;
- support/base/reclaim zone;
- structural invalidation;
- nearest confirmation trigger;
- nearest material resistance/target when defensible;
- current v3.3 state;
- lifecycle status.

Do not retrospectively create an Early Reversal record.

## 6. Radar sync recovery — authoritative procedure

The GitHub connector can return a truncated display while also returning a response resource containing the complete payload. The complete response resource is authoritative.

For every radar write:

1. Fetch latest `data/radar-state.json` from branch `main` and capture its current blob SHA.
2. If the visible tool output is truncated, immediately read the returned response resource until the complete `content` field is recovered.
3. Parse the complete JSON before mutation. A truncated display alone is never a failure reason.
4. Preserve every existing top-level field and all `history`, `shadowPortfolio`, `audits`, trigger-watch data and unknown forward-compatible fields unless the current run explicitly updates them.
5. Apply only the contemporaneous run mutations required by R2.
6. Dedupe `history` by Scan ID and cap at 168. Cap Shadow candidates at 300 without deleting required audit history.
7. Serialize the entire file with two-space indentation and a trailing newline.
8. Immediately before `update_file`, use the latest SHA from step 1; never reuse a SHA from an older run.
9. After write, fetch the file again and verify all of the following: valid JSON, expected Scan ID, expected `generatedAt`, six radar assets, preserved `history`, preserved `shadowPortfolio`, preserved `audits`.
10. If GitHub returns a SHA conflict, repeat steps 1-9 once against the new latest state.
11. Only after successful re-read verification may the run report `APP SYNC: OK | <Scan ID>`.

## 7. Recovery from a stale radar

A stale radar does NOT block a new analytical scan. It blocks claiming healthy persistence.

When the stored radar is >90 minutes stale:

- expose `STALE / RADAR FAILURE` at run start;
- perform the current scan normally from fresh market data;
- do not reconstruct missing historical scans;
- append only the new contemporaneous scan if the write succeeds;
- record the missing interval in the next 07:00 audit;
- after a successful write/re-read, freshness returns to FRESH for the new scan even though historical gaps remain documented.

Do not keep the system permanently failed merely because historical scans are missing. Historical gaps are an audit issue; successful current persistence restores runtime continuity prospectively.

## 8. ERS availability repair

Do not suppress ERS merely because optional indicators or derivatives are absent.

If current price plus sufficient completed 1D/4H/1H OHLCV exist for an asset, calculate D, P, M and ERS under R1. Derivatives unavailable = zero in that component and data quality PARTIAL. Missing 15m may make Momentum/Trigger partial but does not suppress a valid Pullback ERS.

Only genuine insufficiency of core completed 1D/4H/1H data after a fallback attempt may produce `ERS=null` / `E2 DATA BLOCKED`.

## 9. Change control

This patch is additive and must be applied after `docs/ENGINE_SPEC_V3_ERS.md` and `docs/RELIABILITY_PATCH_R2.md` in every v3.3 Radar/Guard run. If a conflict exists:

1. R1 remains authoritative for ERS/D/E/scoring formula;
2. R2 remains authoritative for reliability/trigger escalation/Guard rules;
3. this patch is authoritative only for v3.3 EMA20/EMA50 determinism and the repaired sync/recovery mechanics described above.
