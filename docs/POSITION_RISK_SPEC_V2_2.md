# POSITION RISK SPEC — v2.2 Thesis Validity vs Exit Urgency

Effective: 2026-08-24. Engine: Crypto Reca v3.0. Module: Position Risk.

## 1. Purpose

v2.2 fixes a second-order flaw in v2.1: a setup can be historically `INVALIDATED` without the current market state still justifying a permanent red/critical `EXIT SIGNAL`.

The engine must keep two questions separate:

1. **Thesis validity** — did the original setup remain valid?
2. **Current exit urgency** — how urgent is action now, given current structure, regime, momentum, adverse move and protection?

Historical invalidation is never erased, but it no longer hard-overrides every future risk evaluation to `EXIT SIGNAL`.

## 2. Structural state remains factual

The structural state machine from v2.1 remains:

`INTACT -> BREACH -> RECLAIMED` or `INVALIDATED`.

Confirmed invalidation still requires one of:

- two consecutive completed 15m closes below technical invalidation;
- one completed 1H close below technical invalidation;
- touch of a contemporaneously frozen catastrophic boundary;
- explicitly documented market discontinuity / execution-risk override.

Once confirmed, the original thesis remains `INVALIDATED` for audit. A later price recovery does not rewrite history.

## 3. Structural PRS remains unchanged

Structural component A remains:

- `INTACT`: 0
- `RECLAIMED`: 15
- `BREACH`: 25
- `INVALIDATED`: 40

The remaining components B/C/D/E continue to measure **current** regime, momentum, adverse move and operational protection.

This is deliberate: A remembers the failed thesis; B/C/D/E determine whether the present situation is calm, deteriorating or critical.

## 4. Action map and invalidated floor

Base action remains determined by current PRS:

- 0–24 `HOLD`
- 25–44 `WATCH`
- 45–59 `REDUCE REVIEW`
- 60–79 `EXIT REVIEW`
- 80–100 `EXIT SIGNAL`

For a position whose original thesis is `INVALIDATED`, the action may never be lower than `EXIT REVIEW` while that same position remains open under the invalidated setup.

Therefore:

- `INVALIDATED` + PRS below 60 => `EXIT REVIEW` floor;
- `INVALIDATED` + PRS 60–79 => `EXIT REVIEW`;
- `INVALIDATED` + PRS 80–100 => `EXIT SIGNAL`.

**There is no longer a structural-invalidation hard override that forces `EXIT SIGNAL` regardless of current PRS.**

## 5. What counts as CRITICAL / EXIT SIGNAL

`EXIT SIGNAL` means current urgency is critical, not merely that the original thesis failed.

It is permitted only when:

1. current PRS is at least 80; or
2. a contemporaneously frozen catastrophic boundary is touched; or
3. a verified market discontinuity / execution-risk event makes normal review unsafe.

Ordinary historical invalidation alone is insufficient.

The UI must apply red `risk-critical` treatment only to `EXIT SIGNAL`, never merely because `thesisState=INVALIDATED`.

## 6. Recovery after invalidation

After confirmed invalidation, later recovery may reduce B/C/D as current conditions improve.

Examples:

- price back near/above entry can reduce adverse-move risk;
- 1H reclaim and improving 4H can reduce regime deterioration;
- RSI/MACD/volume recovery can remove momentum penalties.

A remains 40 because the original thesis did fail. The action can therefore fall from `EXIT SIGNAL` to `EXIT REVIEW`, but not to HOLD/WATCH while the position is still being managed under that invalidated original setup.

A truly new long thesis requires a separately documented contemporaneous setup with its own entry logic and invalidation. It must not be invented retrospectively to rescue the old setup.

## 7. UI language

The UI must distinguish:

- `INVALIDATED` = **original thesis failed**;
- `EXIT REVIEW` = **review/plan exit; not currently critical**;
- `EXIT SIGNAL` = **current critical exit urgency**.

For `INVALIDATED + EXIT REVIEW`, preferred explanatory text is: “Tesis original invalidada; revisar/planificar salida. Urgencia actual no crítica.”

## 8. Data fields

Existing schema 2.0 remains compatible. Writers should include `policyVersion: "2.2"` where supported.

Optional field:

```json
"exitUrgency": "NORMAL|ELEVATED|CRITICAL"
```

Suggested mapping:

- HOLD/WATCH => NORMAL
- REDUCE REVIEW/EXIT REVIEW => ELEVATED
- EXIT SIGNAL => CRITICAL

Historical `riskHistory` records must remain unchanged. A policy migration appends a new record rather than rewriting previous EXIT SIGNAL records.

## 9. SOL migration example

If an open SOL TACTICAL position has historical confirmed invalidation at 94.15 but has subsequently recovered close to entry, with current PRS 70 (`A40+B20+C0+D0+E10`), v2.2 classifies:

- thesis: `INVALIDATED`;
- PRS: 70;
- action: `EXIT REVIEW`;
- urgency: `ELEVATED`, **not CRITICAL**.

The historical invalidation remains true. The current operational label becomes less severe because present adverse move and momentum no longer justify a critical exit.

## 10. Deterministic modeled-loss arithmetic

For an OPEN long position, modeled downside to the current technical invalidation is position arithmetic only:

`modeledLossUSDC = qty * max(entryPrice - technicalInvalidation, 0)`

This value MUST NOT depend on current market price. Fees and slippage, if modeled, must be stored and displayed separately and must never be silently folded into `modeledLossUSDC`.

For BTC CORE `0.00946259 BTC @ 77,340.93` with technical invalidation `75,300`, the modeled downside is approximately `19.31 USDC`.

`actualProtectedHeat` or any equivalent protected-risk field may be numeric only when `data/positions-state.json` confirms a real protective stop/order. A recommended technical stop does not constitute protection. If protection is `UNPROTECTED`, actual protected heat is `NOT ESTABLISHED`.

## 11. Missing-entry-lineage management patch — effective 2026-08-27

A user-confirmed real fill may occasionally exist without a contemporaneously persisted Crypto Reca engine/setup/invalidation. That is a process/persistence gap, but the Position Risk engine must not leave the position unmanaged indefinitely.

### 11.1 Preserve historical truth

If `data/positions-state.json` confirms an OPEN fill but its engine/setup/technical invalidation is absent or explicitly unclassified:

- NEVER invent or backfill the original entry thesis;
- keep `originalThesisState = UNKNOWN` (or equivalent) for audit;
- keep the confirmed execution fields exactly as recorded;
- do not mutate `data/positions-state.json` merely to make Position Risk calculable.

### 11.2 Create a prospective management thesis

The Position Risk engine MUST create a separate prospective `managementThesis` from the first successful run after the gap is detected. This is current risk management, not a reconstruction of why the user bought.

Use completed candles only and require sufficient 1H + 4H structure. 15m may refine timing; 1D supplies regime context.

For an unclassified long, assign `managementLane = MANAGEMENT_ONLY` and derive a current management invalidation as follows:

1. identify the nearest defensible completed support below current price, preferring a completed 4H swing/base/reclaim low that has not been invalidated;
2. if no usable 4H level exists, use a completed 1H support/base that has been respected by at least two completed 1H closes;
3. place the management invalidation below that support using a structural buffer of `max(0.25 * ATR14(1H), 0.15% of current price)`;
4. the level must be below current price and technically defensible; never force an invalidation simply to create a numeric PRS;
5. freeze the first valid level contemporaneously in `data/position-risk.json` with `invalidationStatus = MANAGEMENT_CURRENT`, `managementThesisCreatedAt`, source timeframe and defended support.

### 11.3 Ratchet rule

For a long position, once a `managementInvalidation` is frozen it may NEVER be moved lower merely to avoid an exit or reduce PRS. It may only:

- remain unchanged; or
- move upward after a new completed higher support/base is established and defended.

Every upward change must be contemporaneously logged in `riskHistory` with the old level, new level and structural evidence.

### 11.4 PRS calculation under management thesis

When the original thesis is UNKNOWN but a valid management invalidation exists:

- calculate Structural A from `managementStructuralState` using the same 0/15/25/40 scale;
- calculate B/C/D/E normally from current verified market state and protection;
- produce a numeric PRS and normal action map;
- keep `thesisState = UNKNOWN_ORIGINAL` and expose a separate `managementThesisState = ACTIVE|BREACH|INVALIDATED|RECLAIMED`;
- never report `original thesis intact` or `original thesis invalidated` because those facts are unknown.

If the management thesis later invalidates, the action floor rules apply to the MANAGEMENT thesis, while the audit must still state that original entry lineage was unknown.

### 11.5 Data-gap fallback

If a defensible prospective management invalidation cannot be established after the primary OHLCV source plus one reliable fallback attempt:

- `prs = null` is allowed temporarily;
- action must be `WATCH — RISK DATA GAP` rather than a fabricated HOLD/EXIT signal;
- retry on every subsequent run;
- expose the missing requirement explicitly.

A confirmed OPEN position with missing original lineage must therefore transition as soon as data permit from `PRS null` to a prospectively managed numeric PRS; it must not remain permanently unscored simply because the original entry record was incomplete.
