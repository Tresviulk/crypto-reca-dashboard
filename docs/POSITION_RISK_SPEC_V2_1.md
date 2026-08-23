# POSITION RISK SPEC — v2.1 Breach / Reclaim

Effective: 2026-08-23. Engine: Crypto Reca v3.0. Module: Position Risk.

## 1. Purpose

This revision fixes a structural flaw in the previous exit logic: an intrabar print below a technical invalidation level must not, by itself, be treated as permanent thesis invalidation.

The engine now separates **price breach** from **confirmed thesis failure**. This prevents ordinary crypto wick/noise from forcing an exit when price immediately reclaims the technical level, while preserving a separate catastrophic safety boundary.

This is a prospective system rule. It is not an exception for one asset or one open position.

## 2. State machine

For long positions the structural state is:

`INTACT -> BREACH -> CONFIRMED INVALIDATION -> EXIT SIGNAL`

A breach may instead resolve as:

`BREACH -> RECLAIMED -> WATCH / HOLD`

The thesis states are:

- `INTACT` — no verified breach of technical invalidation.
- `BREACH` — price traded below technical invalidation intrabar, but confirmation criteria are not met.
- `RECLAIMED` — a breach occurred, but a completed 15m candle recovered and closed back at/above technical invalidation before confirmation.
- `INVALIDATED` — confirmation criteria were met, or the catastrophic boundary was touched.

A historical low below invalidation is therefore evidence of a `BREACH`, not automatically evidence of `INVALIDATED`.

## 3. Deterministic confirmation rules

A long-position technical invalidation becomes **CONFIRMED INVALIDATION** when any one of these conditions is verified:

1. **Two consecutive completed 15m candles close below technical invalidation**; or
2. **One completed 1H candle closes below technical invalidation**; or
3. **The pre-defined catastrophic boundary is touched**; or
4. There is verified market discontinuity / execution-risk evidence that makes waiting for candle confirmation unsafe. This fourth path must be explicitly documented and cannot be inferred from ordinary volatility alone.

An intrabar low below invalidation without one of the above is only `BREACH`.

## 4. Reclaim rule

A position becomes `RECLAIMED` when, after a breach and before confirmed invalidation, a completed 15m candle closes back at or above the technical invalidation.

After reclaim:

- do not force `EXIT SIGNAL` solely because the earlier wick existed;
- action is normally `WATCH` while the reclaim proves durable;
- a later completed 1H close above invalidation with no new confirmed breach may allow the thesis to return to `INTACT`, subject to regime/momentum/structure checks;
- a new breach restarts the confirmation process.

Reclaim does not erase the historical breach. The event remains in `riskHistory`.

## 5. Structural PRS mapping

Structural Risk component A (0-40):

- `INTACT`: 0
- `RECLAIMED`: 15
- `BREACH`: 25
- `INVALIDATED`: 40

Other PRS components remain unchanged. `INVALIDATED` still forces `EXIT SIGNAL` regardless of total PRS.

`BREACH` does not automatically force exit. It normally maps to at least `EXIT REVIEW` if the position is unprotected and confirmation risk is elevated, but the final action still reflects total PRS and proximity.

`RECLAIMED` normally maps to `WATCH` unless other PRS components independently justify reduction or exit review.

## 6. Catastrophic boundary

The catastrophic boundary is separate from the ordinary technical invalidation.

Rules:

- It must be defined contemporaneously from structure/volatility and frozen before or at entry whenever the setup permits.
- It must never be invented retroactively after a breach.
- Touching it forces `INVALIDATED / EXIT SIGNAL` without waiting for candle confirmation.
- If a defensible catastrophic boundary would make planned loss exceed the system risk ceiling, the correct response before entry is smaller position size or no trade — never an artificially tight stop.
- For an already-open position where no catastrophic boundary was frozen, the engine may recommend one prospectively, but must label it `RECOMMENDED`, not pretend it was part of the original setup.

## 7. CORE vs TACTICAL weighting

The same breach/confirmation state machine applies to both lanes, but context weighting remains different:

- CORE: 4H/1D structure has greater thesis weight; ordinary 15m/1H noise cannot by itself rewrite the higher-timeframe thesis.
- TACTICAL: 15m/1H confirmation matters more, but a wick alone is still not permanent invalidation.

## 8. Data fields

Each open position risk object should support:

```json
{
  "policyVersion": "2.1",
  "structuralState": "INTACT|BREACH|RECLAIMED|INVALIDATED",
  "technicalInvalidation": 0,
  "breach": {
    "occurred": false,
    "firstBreachAt": null,
    "lowestVerifiedPrice": null,
    "confirmed15mClosesBelow": 0,
    "confirmed1hCloseBelow": false,
    "reclaimedAt": null
  },
  "catastrophicBoundary": {
    "price": null,
    "status": "FROZEN|RECOMMENDED|UNDEFINED",
    "basis": null
  }
}
```

Legacy `thesisState` and `invalidationStatus` may remain for UI compatibility, but must be consistent with `structuralState`.

## 9. No-hindsight requirement

Later price action may classify whether a previously recorded breach was reclaimed or confirmed, but the original entry, technical invalidation, target, ERS, Entry Engine and gates must not be rewritten.

A policy migration may reclassify the consequence of already-recorded market evidence if the evidence itself is contemporaneous and preserved. The migration must be documented in the changelog and risk history.

## 10. SOL migration example from contemporaneous evidence

For the open SOL TACTICAL position entered at 95.30 with technical invalidation 94.15, verified post-fill 15m data on 2026-08-23 show a candle low near 93.36 but a close at 94.42, above 94.15. Under v2.1 this event is `BREACH -> RECLAIMED`, not automatic permanent invalidation.

This example documents the migration test case; it does not create an asset-specific rule.
