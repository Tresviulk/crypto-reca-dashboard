# DATA CONTRACT — Crypto Reca Dashboard v2 modular

Effective: 2026-08-23. App target: v0.4.5+. Engine: Crypto Reca v3.0.

## 1. Architecture

The dashboard no longer relies on one shared JSON writer. `data/crypto-reca-state.json` remains a **legacy read-only compatibility snapshot** during migration. New writes are split by authority:

| File | Writer / authority | May contain |
|---|---|---|
| `data/radar-state.json` | Crypto Reca v3.0 Radar | scan, radar, D/E, P/M/ERS, Entry Engine, history, audits, ERS health, Shadow Portfolio |
| `data/positions-state.json` | user-confirmed Coinbase evidence only | real positions, ledger, actual protection, confirmed journal events |
| `data/position-risk.json` | Crypto Reca Position Risk | PRS evaluations and risk history only |
| `data/intelligence.json` | Crypto Reca Intelligence Watch | news, catalysts, news history only |
| `data/external-signals.json` | Crypto Reca Intelligence Watch | external calls, source validation, signal history only |

The frontend merges these modules at read time. A module writer must never rewrite another module's file.

## 2. Truth classes

The UI must keep these classes separate:

- **SCAN** — contemporaneous Crypto Reca outputs: ERS, D/E, Entry Engine, decision, trigger, structure.
- **LIVE / CALCULATED** — public Coinbase market data and frontend-derived display analytics.
- **CONFIRMED COINBASE** — actual fills, fees, quantity, status and protection confirmed from execution evidence.
- **RISK MODEL** — advisory PRS and modeled invalidation loss; never an executed sale.
- **INTELLIGENCE** — public news/catalysts and externally published trade calls; never a Crypto Reca trade trigger by themselves.

## 3. Radar module

Minimum `data/radar-state.json`:

```json
{
  "schemaVersion": "2.0",
  "module": "radar",
  "generatedAt": "ISO timestamp",
  "source": "Crypto Reca v3.0 Radar",
  "engineVersion": "Crypto Reca v3.0",
  "validationCapital": 14687.25,
  "scan": {},
  "radar": [],
  "history": [],
  "audits": [],
  "engineHealth": {},
  "shadowPortfolio": {"generatedAt": null, "candidates": []}
}
```

Each radar asset should contain, when core data permit:

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
  "entryState": "...",
  "decision": "..."
}
```

Canonical D/E and ERS rules live in `docs/ENGINE_SPEC_V3_ERS.md`. If sufficient core data exist, a missing optional source must not suppress every numeric score. If core data are genuinely insufficient, set `ers=null` and report ERS health accordingly. Never reuse an old score.

## 4. ERS health

Every radar run must write:

```json
"engineHealth": {
  "ers": {
    "status": "PASS|PARTIAL|FAIL",
    "spec": "docs/ENGINE_SPEC_V3_ERS.md",
    "specRevision": "R1",
    "reason": "..."
  }
}
```

The frontend must display missing ERS as `ERS NO CALCULADO`, never as zero or a numeric-looking stale value.

## 5. Positions / ledger module

`data/positions-state.json` is the only new modular source allowed to state that a real trade happened.

A position requires user-confirmed Coinbase evidence. Recommendation, signal, trigger, public market price or external guru call is not evidence of a fill.

`PROTECTED` requires confirmed real protection. A recommended technical stop remains `UNPROTECTED` until confirmed.

Normal ledger behavior is append-only. Corrections must leave an audit note.

## 6. Position Risk module

Canonical rules live in `docs/POSITION_RISK_SPEC_V2_2.md`; v2.2 supersedes the action-urgency semantics of v2.1 while preserving its breach/reclaim confirmation logic.

`data/position-risk.json` may contain only:

```json
{
  "generatedAt": "...",
  "positionRisk": {
    "generatedAt": "...",
    "source": "Crypto Reca Position Risk",
    "policyVersion": "2.2",
    "dataQuality": "PASS|PARTIAL|FAIL",
    "positions": {}
  },
  "riskHistory": []
}
```

PRS actions remain `HOLD / WATCH / REDUCE REVIEW / EXIT REVIEW / EXIT SIGNAL`. They are advisory only. The risk writer cannot close, resize or mark a real position sold.

Each open-position risk object should support the structural state machine fields:

```json
{
  "policyVersion": "2.2",
  "structuralState": "INTACT|BREACH|RECLAIMED|INVALIDATED",
  "technicalInvalidation": 0,
  "exitUrgency": "NORMAL|ELEVATED|CRITICAL",
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

An intrabar low below `technicalInvalidation` is a `BREACH`, not permanent invalidation by itself. Confirmed invalidation requires two consecutive completed 15m closes below the level, one completed 1H close below the level, touch of a contemporaneously defined catastrophic boundary, or an explicitly documented market-discontinuity override.

If a completed 15m candle reclaims and closes at/above the technical invalidation before confirmation, structural state becomes `RECLAIMED`. The historical breach must remain preserved in `riskHistory`.

Structural PRS mapping remains: `INTACT=0`, `RECLAIMED=15`, `BREACH=25`, `INVALIDATED=40`. Other PRS components remain independent and describe current conditions.

**v2.2 separates thesis validity from current exit urgency.** Historical `INVALIDATED` no longer hard-overrides every future evaluation to `EXIT SIGNAL`. The base action is determined by PRS: 0–24 HOLD, 25–44 WATCH, 45–59 REDUCE REVIEW, 60–79 EXIT REVIEW, 80–100 EXIT SIGNAL. An `INVALIDATED` position has a minimum action floor of `EXIT REVIEW` while it remains open under that original setup.

`EXIT SIGNAL` / red critical treatment is reserved for current PRS >=80, a contemporaneously frozen catastrophic-boundary touch, or a documented market-discontinuity/execution-risk emergency. A recovered invalidated thesis may remain `INVALIDATED` while action falls to `EXIT REVIEW`; history is not rewritten.

Suggested urgency mapping: HOLD/WATCH=`NORMAL`; REDUCE REVIEW/EXIT REVIEW=`ELEVATED`; EXIT SIGNAL=`CRITICAL`.

For CORE positions, 4H/1D structure has greater thesis weight than ordinary 15m/1H noise. Trend by timeframe should be stored when available rather than collapsed into one ambiguous “trend”.

A catastrophic boundary may never be reconstructed as though it existed before entry. If no such level was frozen contemporaneously, a later proposed level must be labelled `RECOMMENDED` or `UNDEFINED`, never `FROZEN`.

## 7. Intelligence module

`data/intelligence.json` contains high-signal public news only. Positive news never creates a buy order. High-impact scheduled events may change event-risk posture; severe verified negative events may prompt `REDUCE REVIEW` or `EXIT REVIEW`, never a fabricated execution.

## 8. External signals module

`data/external-signals.json` contains only forward-captured, publicly verifiable, spot-long compatible calls for BTC/ETH/SOL/XRP/AVAX/SUI under the strict source-validation rules.

A source remains `VALIDATING` until the forward sample meets the configured qualification standard. Popularity, screenshots, marketing win rates and retrospective claims do not qualify a source.

## 9. Shadow Portfolio

`shadowPortfolio.candidates` belongs to the radar module because only the radar knows the contemporaneous rejected/prepared setup state.

Freeze a candidate prospectively when useful for system research (for example PREPARE, strong ERS rejected by a gate, CHASE, or R/R failure). Store the original scan ID, asset, setup/lane, ERS, Entry Engine, frozen entry/zone, invalidation/target only when defensible, rejection reason and lifecycle. Later price outcomes may update lifecycle, but original decision variables must never be reconstructed or edited with hindsight.

## 10. System Health

System Health is computed by the frontend from module availability, freshness and engine-health fields. It does not need a separate writer. Expected current cadences are approximately hourly for Radar, Position Risk and Intelligence. Missing/stale modules are shown as PASS/PARTIAL/FAIL independently.

## 11. Correlation & cluster risk

Correlation shown by the frontend is display analytics from public completed market series. It does not change historical ERS. Cluster exposure separates at minimum total crypto, BTC+ETH Core and higher-beta SOL/AVAX/SUI exposure. Several correlated crypto positions must not be presented as independent diversification.

## 12. No-hindsight rules

- Every scan/history/shadow record must have a real contemporaneous timestamp/ID.
- Missing run = missing run.
- Do not reconstruct original ERS, P/M, Entry Engine, stop, target or gates from later price action.
- Subsequent market data may be used only to evaluate a setup that was already frozen contemporaneously.
- Ambiguous intrabar outcome remains ambiguous when ordering cannot be verified.
- A policy migration may reclassify the consequence of preserved contemporaneous evidence, but may not alter the underlying historical price/fill/setup evidence.

## 13. Security

Never write API secrets, private keys, passwords, JWTs, cookies, recovery codes or private X/Telegram/Coinbase credentials to GitHub. The current Pages repository is public; sensitive account balances or authenticated Coinbase data require a private backend before they are introduced.

## 14. Migration compatibility

During v0.4.5 migration, the PWA first loads `data/crypto-reca-state.json` and then overlays any non-empty modular files. Empty migration placeholders therefore cannot erase the confirmed legacy state. After all active writers have migrated and modular files are populated, `crypto-reca-state.json` becomes compatibility-only and should no longer receive routine writes.
