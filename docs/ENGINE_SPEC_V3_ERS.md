# Crypto Reca v3.0 — ERS Engine Repair R1

Effective: 2026-08-23 Europe/Madrid  
Status: canonical self-contained rulebook for D/E and deterministic ERS.  
Engine name remains `Crypto Reca v3.0`; this document repairs lost rule continuity and does not by itself create an order.

## 1. Non-negotiable principles

1. Universe: BTC, ETH, SOL, XRP, AVAX, HBAR; spot-long only; no leverage.
2. ERS is setup quality, not probability of profit.
3. ERS never overrides a hard gate, CORE exposure logic, Entry Engine timing, risk limits, event risk, execution validity or Coinbase Preview requirements.
4. Scores are contemporaneous only. Missing historical scores are never reconstructed with hindsight.
5. If sufficient core 1D/4H/1H price structure and volume exist, numeric lane scores and ERS must normally be produced. Missing optional inputs are scored conservatively, not used as an excuse to suppress the whole score.
6. If core market data are genuinely insufficient after fallbacks, ERS is `null`, `engineHealth.ers.status=FAIL/PARTIAL`, and the app must display `ERS NO CALCULADO`. Never substitute zero or a stale previous value.

## 2. D state — directional regime

`D` describes higher-timeframe direction only. It is not an entry trigger.

- `D0 DEFENSIVE`: 1D/4H materially contradict a new long thesis; verified bearish regime or structural invalidation dominates. New long entries are blocked.
- `D1 TRANSITIONAL`: mixed, range-bound or transitioning 1D/4H structure; no decisive higher-timeframe long alignment.
- `D2 CONSTRUCTIVE`: 1D and 4H are non-bearish and at least one is clearly bullish/constructive. Strongest when both align bullish.

A short-term 15m/1H decline does not automatically downgrade D2 if 4H/1D remain structurally constructive. Multi-timeframe trend must be reported separately.

### 2.1 Deterministic D-state anti-flicker patch

Use only completed 1D/4H candles. Classify each higher timeframe as `BULLISH`, `NEUTRAL` or `BEARISH` before assigning D.

A timeframe is `BULLISH` when at least two of these are true and there is no confirmed structural breakdown: (a) close above EMA20 and EMA20 slope is positive over the last three completed bars; (b) close above EMA50; (c) completed swing structure is higher-high/higher-low or the latest confirmed swing low remains intact.

A timeframe is `BEARISH` when at least two of these are true: (a) close below EMA20 and EMA20 slope is negative over the last three completed bars; (b) close below EMA50; (c) completed swing structure is lower-high/lower-low with the prior confirmed swing low broken on a completed close. Otherwise it is `NEUTRAL`.

Assign D mechanically:
- `D2` if neither 1D nor 4H is BEARISH and at least one is BULLISH.
- `D1` if neither condition for D2 nor D0 is met; this includes BULLISH+BEARISH conflict, NEUTRAL+NEUTRAL, or a genuine range/transition.
- `D0` if both 1D and 4H are BEARISH, or if a verified higher-timeframe structural invalidation directly contradicts a new long thesis.

15m/1H may change Entry Engine timing but may not change D. A single 4H wick or intrabar low may not change D; use completed-bar evidence. If D changes from the prior scan, record the exact completed higher-timeframe evidence that caused the change. Never downgrade D2 merely because 1H momentum is weak.

## 3. E state — execution gate state

`E` describes whether a long setup can be executed now. It is separate from ERS.

- `E0 CLEAR`: all mandatory non-score gates applicable to the candidate lane are currently satisfied. This does not guarantee an order; ERS/engine threshold, Entry Engine and execution package still apply.
- `E1 WATCH`: no fatal contradiction, but at least one timing/execution condition remains incomplete, such as location, trigger, confirmation, executable R/R or fresh continuation base. Not executable yet.
- `E2 BLOCKED`: one or more hard blockers exist: insufficient core data, D0 long contradiction, no defensible structural invalidation, net R/R below minimum at current executable entry, invalid/stale setup, unresolved critical event risk, exposure/risk cap breach, or final Coinbase Preview mismatch/expiry.

When core data are sufficient, an E2 setup may still have a numeric ERS for diagnostic quality; the decision remains blocked. When core data are insufficient, ERS is null.

## 4. Deterministic lane scoring

Every asset is scored on two independent routes. Do not average the routes.

### 4.1 Pullback / Structure score P — 100 points

- 1D/4H market regime: 20
- Structure and entry location: 20
- 1H/4H confirmation and momentum: 15
- Volume / liquidity quality: 10
- Crypto market alignment / relative strength: 10
- Derivatives positioning health when reliable: 10
- Event/news risk quality: 5
- Net reward/risk quality: 10

Total: 100.

Additional Pullback requirements: defensible technical location, no uncontrolled chase, meaningful structural invalidation and entry inside the authorized zone.

### 4.2 Momentum / Breakout score M — 100 points

- Higher-timeframe trend / regime: 20
- Breakout / continuation structure quality: 20
- 1H/4H momentum confirmation: 15
- 15m intrahour confirmation / hold quality: 10
- Volume/liquidity expansion and participation: 10
- Crypto breadth / relative-strength alignment: 10
- Derivatives positioning health when reliable: 5
- Event/news risk quality: 5
- Net reward/risk quality: 5

Total: 100.

Additional Momentum requirements: a high/session-high price is not itself a rejection. The setup is rejected when structural invalidation or net R/R is no longer defensible. RVOL below 1.0 downgrades breakout confirmation and prevents `FULL CONFIRMATION` in the Entry Engine.

### 4.3 Scoring-anchor patch — no freehand component scores

Every component must use the following discrete anchors. Intermediate arbitrary values are prohibited unless an explicit measurable interpolation is shown in the scan notes.

**Regime / higher-timeframe trend (max 20):** D2 with both 1D+4H BULLISH=20; D2 with one BULLISH and one NEUTRAL=16; D1=8; D0=0.

**Pullback structure/location (max 20):** 20 = confirmed support/retest/reclaim zone, entry within 0.50 ATR1H of the defended level and structural invalidation defined; 15 = good location within 1.00 ATR1H; 10 = neutral location/base not yet confirmed; 5 = extended 1.00–1.50 ATR beyond support/reclaim; 0 = no defensible location, stale setup or invalidation unavailable.

**Momentum breakout/continuation structure (max 20):** 20 = completed breakout plus hold/retest or fresh continuation base; 15 = completed reclaim/base with breakout level defined; 10 = constructive but incomplete continuation; 5 = extension without base or failed first breakout; 0 = no valid continuation structure.

**1H/4H confirmation and momentum (max 15):** 15 = both constructive and aligned; 10 = one constructive, other neutral; 5 = mixed/conflicting; 0 = both bearish for the lane. RSI alone cannot earn this component.

**15m confirmation/hold for Momentum (max 10):** 10 = completed verified hold/retest trigger; 5 = constructive 15m but trigger incomplete; 0 = absent, adverse or unverified.

**Volume/liquidity (max 10):** 10 = RVOL1H >=1.50 with direction supportive; 7 = RVOL>=1.20; 5 = RVOL 0.80–1.19 or healthy pullback contraction; 2 = RVOL<0.80; 0 = adverse-volume expansion. Missing verified RVOL scores 0 and data quality becomes PARTIAL.

**Market alignment / relative strength (max 10):** 10 = BTC plus at least four of the other five monitored assets are non-bearish on 4H and the asset is not materially underperforming; 7 = broad alignment positive but incomplete; 5 = mixed; 2 = broad weakness; 0 = asset materially diverges negatively from a weak market. Use contemporaneous monitored-universe data only.

**Derivatives:** if reliable data are unavailable, score 0 exactly. If reliable, Pullback max10/Momentum max5: full points only for healthy/non-crowded positioning, half points for neutral, 0 for adverse/crowded.

**Event/news risk (max 5):** 5 = no unresolved high-impact event inside 24h; 3 = known high-impact event inside 24h but outside 6h; 1 = inside 6h but outside 2h; 0 = inside 2h or unresolved critical direct asset event unless an existing lane-specific rule explicitly tolerates it. A 0 event component is not automatically E2 unless the current hard-gate rule says the event window is blocking.

**Net R/R:** use executable entry, structural invalidation, defensible target and cost allowance. Pullback max10: >=3.0=10; >=2.5=8; >=2.0=6; >=1.8=5; >=1.5=2; <1.5=0. Momentum max5: >=3.0=5; >=2.0=4; >=1.8=3; >=1.5=1; <1.5=0. If stop or target is not defensible, score 0; if no defensible structural invalidation exists, E2 applies.

These anchors do not change weights or ERS=max(P,M). They make R1 reproducible.

## 5. ERS definition

`ERS = max(P, M)` using the two contemporaneously calculated lane scores. Store the winning lane in `ersLane = PULLBACK | MOMENTUM` and preserve both `pullbackScore` and `momentumScore` when available.

If scores tie, prefer the lane whose mandatory setup-specific gates are already satisfied; if both or neither are equally valid, set `ersLane=MIXED`.

ERS display bands are descriptive only:

- 0–59: NO SETUP
- 60–74: WATCH
- 75–84: PREPARE RANGE
- 85–89: STRONG WATCH
- 90–100: HIGH QUALITY

A band is not a trade authorization. Existing pair/engine thresholds and all hard gates remain binding.

## 6. Missing-data discipline

Core data: current reference price plus sufficient completed 1D, 4H and 1H structure/volume. 15m is additionally required for full Momentum timing assessment.

- Missing optional derivatives data: give the derivatives component 0 and label data quality PARTIAL; do not invent it.
- Missing optional external/news context after reasonable search: score only what is verifiable and state the limitation.
- Missing 15m while 1D/4H/1H are sufficient: P remains numeric; M may be conservative/partial, but ERS should still be numeric from the valid lane.
- Missing core 1D/4H/1H: affected asset `ERS=null`, D/E only if genuinely inferable, otherwise null; `ERS ENGINE` cannot be PASS.

## 7. Entry Engine relationship

Entry Engine remains separate and binary across Trend / Location / Momentum / Volume / Trigger:

- 0–1/5 NO TIMING
- 2/5 EARLY WATCH
- 3/5 PREPARE
- 4/5 STRONG CONFIRMATION
- 5/5 FULL CONFIRMATION

A 4/5 can be sufficient when all hard gates and the relevant engine/ERS rules pass and the missing dimension is non-critical. 5/5 is preferred, not universally required.

ERS answers `how good is the setup?`; Entry Engine answers `is the timing ready?`; D answers `is higher-timeframe direction supportive?`; E answers `is execution currently clear or blocked?`.

### 7.1 Deterministic Entry dimensions

`Trend=true` only when price > EMA50 1H, EMA20 1H >= EMA50 1H, and 4H is non-bearish. If EMA50>EMA200 1H it is stronger but not required.

`Location=true` only when a named support/retest/VWAP/EMA/prior-breakout level exists and the proposed entry is no more than 1.00 ATR1H from that defended level. A breakout entry more than 1.00 ATR1H above its breakout/reclaim level without a fresh base is CHASE and Location=false. `GOOD` means <=0.50 ATR1H; `NEUTRAL` means >0.50 and <=1.00 ATR1H; `CHASE` means >1.00 ATR1H or no defensible local invalidation.

`Momentum=true` only with a completed constructive combination: MACD12/26/9 line/histogram improving plus RSI14 >=50, or a verified completed reclaim/reversal with RSI>=50. RSI alone never qualifies.

`Volume=true` for breakout/reclaim only when completed 1H RVOL >=1.20. For a pullback, contraction may be acceptable but Volume becomes true only after renewed buying participation on the trigger/reclaim candle. RVOL<1.0 prevents Full Confirmation.

`Trigger=true` only from completed candles. Valid trigger forms:
- 1H reclaim: completed 1H close above the named level AND the next completed 15m candle closes at/above that level;
- breakout-retest hold: completed breakout close, subsequent 15m/1H retest of the named level, then completed close back above/holding it;
- rejection-high close: completed 15m candle rejects the named support and closes above the prior 15m candle high;
- higher-low confirmation: a completed higher low plus completed close above the intervening minor swing high.

An open/current candle never sets Trigger=true. If 15m required for the selected trigger is unavailable, Trigger=false/PARTIAL rather than inferred.

### 7.2 Execution-status patch

Every asset must expose an explicit `executionStatus` separate from ERS and Entry state:
- `BLOCKED`: E2 or another explicit hard gate.
- `WATCH`: ERS<80 or Entry<4, with no active executable package.
- `ARMED`: ERS>=80 and Entry>=4, hard gates analytically clear/incomplete only for final package; trigger path and levels must be named.
- `PREVIEW_REQUIRED`: all analytical gates, lane threshold, location, invalidation, sizing and net R/R pass; only fresh Coinbase Advanced Preview remains before final recommendation.
- `EXECUTABLE`: fresh Coinbase Preview has been checked and still passes max price/slippage/R/R/risk. This is still a recommendation state, never auto-execution.

For ERS>=85, anti-paralysis remains binding: after two consecutive qualifying scans without a hard gate, a generic NO ENTRY is prohibited. The scan must expose BUY NOW CANDIDATE, BUY RETEST CANDIDATE or BUY BREAKOUT CANDIDATE and its exact remaining gate.

### 7.3 Mandatory verification escalation for high-ERS setups

A high ERS may never remain artificially non-actionable merely because indicators derivable from already-available OHLCV were not calculated.

When any asset reaches **ERS >=80**, the same run MUST actively attempt the full execution-verification package for that asset before final decision:
- completed 1H EMA20, EMA50 and EMA200 when sufficient history exists;
- completed 4H EMA20 and EMA50;
- RSI14 1H;
- MACD12/26/9 1H;
- ATR14 1H;
- completed 1H RVOL versus the previous 20 completed 1H candles;
- completed 15m trigger/hold evidence when required by the selected path;
- named defended/reclaim/base level and ATR distance for Location;
- defensible structural invalidation, target, cost allowance and net R/R for every technically plausible execution path.

When **ERS >=85**, this escalation is mandatory and has priority over optional contextual work. `Trend`, `Location` or `Momentum` may not be left `PARTIAL` solely because the run did not calculate indicators that can be calculated from sufficient OHLCV already obtained. If sufficient candle history is available, calculate them. If the primary source lacks enough history, make at least one reliable public OHLCV fallback attempt before declaring the dimension unavailable.

For ERS >=85, the final state must be one of these with an exact reason:
- `BLOCKED`: a real hard gate exists; name it.
- `WATCH — CHASE`: quality is high but current executable location is >1.00 ATR from the defended level or no local invalidation exists; immediately define a prospective retest/base path when technically defensible.
- `ARMED`: ERS>=80, Entry>=4 and analytical gates pass, but final execution package/Preview is not yet complete.
- `PREVIEW_REQUIRED`: all analytical and risk gates pass and only fresh Coinbase Advanced Preview remains.
- `EXECUTABLE`: Preview is fresh and still passes.

A generic `PARTIAL because EMA/MACD/RSI were not revalidated` is prohibited for ERS>=85 when sufficient OHLCV exists to calculate them.

**Anti-late-entry rule:** when an asset first crosses ERS 80, freeze or update a prospective execution path contemporaneously if defensible. If the asset later becomes CHASE, the scan must state whether a valid earlier ARMED/PREVIEW_REQUIRED state existed. Never reconstruct such a state with hindsight; if it was not captured contemporaneously, record it as a process miss in the next 07:00 leakage audit rather than pretending an earlier entry existed.

This section does not lower any ERS threshold, does not weaken anti-chase, does not override hard gates, and does not remove the Coinbase Preview requirement. Its purpose is to prevent avoidable analytical incompleteness from causing the system to recognize a high-quality setup only after the actionable window has passed.

## 8. System-health contract

Each radar run must write:

```json
"engineHealth": {
  "ers": {
    "status": "PASS | PARTIAL | FAIL",
    "spec": "docs/ENGINE_SPEC_V3_ERS.md",
    "specRevision": "R1",
    "reason": "plain-language reason"
  }
}
```

PASS requires all six assets to have a contemporaneous numeric ERS when their core data are available, with D/E and lane traceability. PARTIAL is allowed for isolated asset/source limitations. FAIL applies when the scoring rulebook cannot be loaded/applied or ERS is suppressed despite sufficient core data.

## 9. Required radar record per asset

Whenever core data permit:

```json
{
  "asset": "BTC",
  "pair": "BTC-USDC",
  "d": "D0|D1|D2",
  "e": "E0|E1|E2",
  "pullbackScore": 0,
  "momentumScore": 0,
  "ers": 0,
  "ersLane": "PULLBACK|MOMENTUM|MIXED",
  "entryConfirmation": 0,
  "entryState": "NO TIMING|EARLY WATCH|PREPARE|STRONG CONFIRMATION|FULL CONFIRMATION|PARTIAL",
  "executionStatus": "BLOCKED|WATCH|ARMED|PREVIEW_REQUIRED|EXECUTABLE",
  "decision": "..."
}
```

Never populate a missing current value from an old seed or earlier scan.

## 10. Change control

Any future change to weights, D/E meaning, ERS formula or execution thresholds must update this file, `CHANGELOG.md`, the automation prompt and the data contract together. Silent rule drift is prohibited.

## 11. Deterministic risk-display arithmetic

For an OPEN long position, modeled heat to a technical invalidation is purely position arithmetic and MUST NOT depend on current market price:

`modeledHeatUSDC = qty * max(entryPrice - technicalInvalidation, 0)`

If the technical invalidation is above entry, modeled downside heat is 0 and any locked-profit concept must be reported separately. Fees/slippage may be shown as a separate cost allowance, never silently added to `modeledHeatUSDC`.

`ACTUAL PROTECTED HEAT` may be numeric only when `positions-state.json` confirms a real protective order/stop. Without confirmed protection it must read `NOT ESTABLISHED`, regardless of the recommended technical invalidation.