# Crypto Reca v3.0 — ERS Engine Repair R1

Effective: 2026-08-23 Europe/Madrid  
Status: canonical self-contained rulebook for D/E and deterministic ERS.  
Engine name remains `Crypto Reca v3.0`; this document repairs lost rule continuity and does not by itself create an order.

## 1. Non-negotiable principles

1. Universe: BTC, ETH, SOL, XRP, AVAX, SUI; spot-long only; no leverage.
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
  "decision": "..."
}
```

Never populate a missing current value from an old seed or earlier scan.

## 10. Change control

Any future change to weights, D/E meaning, ERS formula or execution thresholds must update this file, `CHANGELOG.md`, the automation prompt and the data contract together. Silent rule drift is prohibited.
