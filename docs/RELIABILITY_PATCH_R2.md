# Crypto Reca — Reliability Patch R2

Effective: 2026-08-27 Europe/Madrid
Status: mandatory operational patch. This patch does NOT change ERS weights, ERS=max(P,M), risk limits, spot-long/no-leverage perimeter, or Coinbase Preview requirement. It repairs detection, verification, persistence and alerting failures observed during the SOL move of 2026-08-26/27.

## 1. Incident finding

The 2026-08-26 20:01 Europe/Madrid radar stored SOL around 97 with a named upgrade condition: acceptance above approximately 97.8 followed by hold/retest with renewed participation. Subsequent completed candles satisfied that path and SOL advanced materially, while the persisted radar trail did not contain the required later scans. This is classified as PROCESS MISS — VERIFICATION LAG + RADAR SYNC FAILURE. Missing historical ERS values remain MISSING and must never be hindsight-reconstructed.

## 2. No silent scan failure

Every scheduled radar run MUST end in exactly one of:
- SUCCESS: a fresh Scan ID is calculated, written to `data/radar-state.json`, re-read and verified;
- PARTIAL: core calculation completed but a non-critical input is unavailable; fresh Scan ID is still written and verified;
- FAIL: core scan cannot be completed or the write/re-read verification fails.

A run may never disappear silently. On FAIL, preserve the prior valid radar data, append/record a system-health failure when writable, and expose the exact failure to the independent Guard alert task.

## 3. Freshness watchdog

At the start of each radar/Guard run, read `data/radar-state.json` and compare its `generatedAt` with current Europe/Madrid time.

- <=75 minutes old: FRESH.
- >75 and <=90 minutes: LATE WARNING.
- >90 minutes: STALE / RADAR FAILURE.

STALE is a notification condition for the Guard. A stale stored scan must never be presented as current analysis.

## 4. Persistent Trigger Watch — mandatory

A named trigger from a completed scan MUST be persisted even when ERS is below 80 if all of the following are true:
- D is D1 or D2, not D0;
- the trigger is objective and price-based (reclaim, breakout, retest/hold, rejection-high or higher-low confirmation);
- there is no known E2 hard blocker that makes the trigger irrelevant;
- the trigger level has not already been invalidated.

Persist for each active Trigger Watch: asset, trigger type, named level/zone, created Scan ID/time, invalidation/expiry condition, nearest execution path and current status WAITING/HIT/INVALIDATED/EXPIRED.

A low prior ERS MUST NOT prevent later verification of a trigger that the system itself named.

## 5. Trigger-hit escalation — fixes the SOL failure mode

On every run, before assigning the final current ERS, compare completed 15m/1H candles since the last successful scan against all active Trigger Watches.

If a named trigger was HIT on completed candles:
1. Mark Trigger Watch = HIT contemporaneously.
2. Immediately run the full execution-verification package for that asset in the SAME run, regardless of the prior scan ERS.
3. Calculate fresh P, M, ERS, D, E and all five Entry dimensions from current completed data.
4. Calculate EMA20/50/200 1H when history allows, EMA20/50 4H, RSI14 1H, MACD12/26/9 1H, ATR14 1H, RVOL1H vs prior 20 completed candles, required 15m hold/retest evidence, defended level, ATR distance, invalidation, target, cost allowance and net R/R.
5. If the current location is already >1 ATR beyond the defended trigger/base, classify WATCH — CHASE and immediately define a BUY RETEST/BASE path if defensible. Do not pretend the missed earlier price is still executable.
6. If verification cannot be completed because of a process/data failure, classify PROCESS MISS — VERIFICATION FAILURE and make it a Guard notification condition. Do not silently return WATCH.

No historical ERS is reconstructed. The scan evaluates the current actionable state while preserving the fact that the trigger was hit between successful scans.

## 6. Early momentum / EMA pre-alert

The existing EMA Momentum Confirmation Layer remains a priority momentum input, not an autonomous buy trigger. When a bullish EMA momentum cross/stack is confirmed on the configured timeframe and price is above the relevant EMAs with constructive slope, the asset must be promoted to an EARLY MOMENTUM WATCH even if the current ERS is below 80.

If that EMA condition coexists with a named reclaim/breakout level within a defensible distance, the Trigger Watch in section 4 is mandatory. RSI overbought or nearby resistance may downgrade timing/location but may not suppress the watch by themselves.

## 7. Mandatory execution escalation

Existing canonical high-ERS escalation remains in force. Additionally:
- Trigger Watch HIT => full verification regardless of prior ERS.
- Current ERS >=80 => full verification in same run.
- Current ERS >=85 => priority verification; final state must be BLOCKED, WATCH — CHASE, ARMED, PREVIEW_REQUIRED or EXECUTABLE with an exact reason.
- ERS>=80 + Entry>=4 and no hard blocker => at minimum ARMED; generic NO ENTRY is prohibited.

## 8. Independent Guard alert conditions

The independent Crypto Reca Guard MUST notify the user when any of these occurs:
- `data/radar-state.json` is >90 minutes stale;
- a scheduled radar run fails to write/verify a fresh Scan ID;
- any active Trigger Watch becomes HIT and the radar has not contemporaneously completed verification;
- ERS >=80 and Entry >=4;
- executionStatus becomes ARMED, PREVIEW_REQUIRED or EXECUTABLE;
- ERS >=85 with WATCH — CHASE, so the user receives the exact retest/base path rather than discovering the move after extension;
- a PROCESS MISS — VERIFICATION LAG/FAILURE is detected.

Do NOT notify ordinary WATCH conditions. Alerts must contain asset, reference price, ERS, Entry X/5, executionStatus, trigger/level, exact remaining gate and whether the current price is actionable or CHASE.

## 9. Sync transaction — mandatory

For every radar write:
1. Read latest full `data/radar-state.json` immediately before mutation.
2. Obtain current blob SHA.
3. Preserve all existing history/audits/shadow/trigger-watch data except valid forward-only lifecycle updates.
4. Write complete valid JSON.
5. Re-read the file.
6. Verify JSON validity, new Scan ID and `generatedAt`.
7. On SHA conflict, re-read/merge/retry once.
8. If verification still fails, system state = FAIL and Guard must notify.

A tool response being truncated is not a sync failure; recover complete content before mutation.

## 10. Audit classification

The next 07:00 audit must explicitly record the SOL 2026-08-26/27 incident as PROCESS MISS — VERIFICATION LAG + RADAR SYNC FAILURE. Do not fabricate the missing contemporaneous ERS. Report the observable trigger sequence and the missing scan trail separately.

## 11. Change control

This patch must be read after `docs/ENGINE_SPEC_V3_ERS.md` at the start of every Crypto Reca Radar and Guard run. If the two conflict, the canonical ERS/scoring definitions remain authoritative; this patch governs reliability, trigger escalation, persistence and alert delivery. Silent drift is prohibited.

## 12. Mandatory v3.3 runtime repair handoff

For every Crypto Reca v3.3 Radar and Guard run, after loading this R2 file, also load and apply `docs/V3_3_RUNTIME_REPAIR.md`.

That repair is mandatory and additive. It does not create a new engine version. It is authoritative for:
- deterministic v3.3 Early Reversal EMA configuration (`EMA20` fast / `EMA50` slow on completed 15m, 1H and 2H candles);
- exact EMA state mapping for EMA WATCH / EARLY REVERSAL / 1H CONFIRMING / 2H MOMENTUM CONFIRMED;
- resource-backed recovery of complete `radar-state.json` content when connector display is truncated;
- prospective recovery from a stale radar after a successful current write/re-read;
- the rule that sufficient current 1D/4H/1H core OHLCV must produce numeric ERS even when optional derivatives or secondary inputs are unavailable.

If `docs/V3_3_RUNTIME_REPAIR.md` cannot be read in a v3.3 run, set the v3.3 runtime repair health to FAIL and do not silently revert to undefined EMA periods or the old truncated-display failure mode.
