# DATA CONTRACT — Crypto Reca Dashboard

## Purpose

`data/crypto-reca-state.json` is the operational source consumed by the PWA. This contract exists to prevent accidental corruption, hindsight reconstruction, or loss of confirmed trading records.

## Top-level fields

- `schemaVersion`: data schema version.
- `appVersion`: app version expected by the writer.
- `engineVersion`: Crypto Reca ruleset/version.
- `generatedAt`: ISO timestamp of the most recent successful radar sync, or `null` before first sync.
- `source`: origin of the last radar update, e.g. `Crypto Reca v3.0 Radar`.
- `scan`: latest contemporaneous scan metadata.
- `validationCapital`: reference capital used by the system.
- `radar`: exactly the current monitored universe unless the system rules change explicitly.
- `positions`: user-confirmed real positions only.
- `ledger`: user-confirmed real fills/transactions only.
- `audits`: contemporaneous audit records.
- `history`: compact scan history.
- `alerts` (optional): explicit app-facing alerts created contemporaneously by the scan writer.
- `journal` (optional): structured notes/events that have a real contemporaneous source.
- `positionRisk` (optional): latest rule-based risk/exit evaluation for currently open positions.
- `riskHistory` (optional): compact rolling history of PRS/action/thesis states.
- `newsOverlay`, `catalysts`, `newsHistory` (optional): high-signal public news/catalyst intelligence.
- `externalSignals`, `signalSources`, `externalSignalHistory` (optional): forward-captured public external signal validation data.

## `scan`

Recommended fields:

```json
{
  "id": "CR30-YYYYMMDD-HHMM",
  "timestampEuropeMadrid": "YYYY-MM-DD HH:MM",
  "dataQuality": "PASS | PARTIAL | FAIL",
  "bestCondition": "CORE | TACTICAL | A+ | NONE",
  "closestSetup": "...",
  "realOrderThisScan": "NO | CORE | TACTICAL | A+",
  "conclusion": "..."
}
```

Do not invent a scan ID or timestamp. Missing run = missing run.

## `radar[]`

Minimum supported structure:

```json
{
  "asset": "BTC",
  "pair": "BTC-USDC",
  "d": "D0/D1/D2/...",
  "e": "E0/E1/E2/...",
  "ers": 72,
  "entryConfirmation": 4,
  "decision": "WATCH / HOLD CORE",
  "entryState": "STRONG CONFIRMATION"
}
```

Optional detailed fields may be included only when they were calculated contemporaneously in that same scan:

```json
{
  "indicators": {
    "ema20_1h": 0,
    "ema50_1h": 0,
    "ema200_1h": 0,
    "vwap_1h": 0,
    "rsi14_1h": 0,
    "atr14_1h": 0,
    "macd_1h": "bullish / bearish / improving / ...",
    "rvol_1h": 0
  },
  "structure": {
    "location": "GOOD LOCATION | NEUTRAL | CHASE | ...",
    "support": "...",
    "resistance": "...",
    "trigger": "...",
    "invalidation": "...",
    "setup": "..."
  },
  "entryDimensions": {
    "trend": true,
    "location": true,
    "momentum": true,
    "volume": false,
    "trigger": true
  }
}
```

Rules:

- `ers` must be numeric only if contemporaneously calculated.
- `entryConfirmation` is `0..5` or `null` if unavailable/partial.
- Indicator values must never be reconstructed after the scan.
- `entryDimensions` must reflect the five binary Entry Engine dimensions from that run, or use `null`/omit when unavailable.
- Do not use a market price copied from the frontend as a scan decision variable after the fact.
- The frontend obtains its own public display price separately.

## `positions[]`

Real positions only. Example:

```json
{
  "id": "unique-id",
  "asset": "BTC",
  "pair": "BTC-USDC",
  "engine": "CORE",
  "setup": "C-RECLAIM",
  "status": "OPEN",
  "protection": "UNPROTECTED",
  "qty": 0.00946259,
  "entry": 77340.93,
  "fee": 1.17095282,
  "recommendedStop": 75300,
  "actualStop": null,
  "openedEuropeMadrid": "2026-08-22 18:58"
}
```

A position cannot be added because a recommendation was generated. It requires a confirmed fill.

`protection` must distinguish recommendation from actual protection. Never mark `PROTECTED` unless a real stop/protection has been confirmed.

## `positionRisk`

This field is written by the separate Position Risk / Exit Engine and must never be treated as an executed sale. Recommended structure:

```json
{
  "generatedAt": "2026-08-23T05:05:00+02:00",
  "source": "Crypto Reca Position Risk",
  "dataQuality": "PASS",
  "positions": {
    "btc-position-id": {
      "asset": "BTC",
      "engine": "CORE",
      "prs": 35,
      "breakdown": {"structural":15,"regime":10,"momentum":0,"adverseMove":0,"protection":10},
      "thesisState": "INTACT",
      "action": "WATCH",
      "protection": "UNPROTECTED",
      "trendTimeframes": {
        "15m": "BAJISTA",
        "1h": "BAJISTA",
        "4h": "NEUTRAL-ALCISTA",
        "1d": "ALCISTA"
      },
      "trendConclusion": "Corrección bajista de corto plazo; tesis de marco superior aún intacta.",
      "technicalInvalidation": 75300,
      "invalidationStatus": "CURRENT",
      "modeledLossUSDC": 0,
      "modeledLossPctCapital": 0,
      "distanceToInvalidationPct": 0,
      "distanceToInvalidationATR": 0,
      "unrealizedPnLUSDC": 0,
      "unrealizedPnLPct": 0,
      "reason": "...",
      "upgradeCondition": "...",
      "downgradeCondition": "..."
    }
  }
}
```

Multi-timeframe rules:

- 15m and 1H describe short-term timing/deterioration; they must not be displayed as if they alone define the global trend.
- 4H and 1D carry greater weight for CORE thesis management.
- A 1H bearish state with constructive 4H/1D may result in `WATCH` rather than `EXIT`.
- 1H + 4H bearish deterioration raises risk materially; 4H + 1D bearish/invalidated structure may force `EXIT REVIEW` or `EXIT SIGNAL` under the deterministic PRS rules.
- `trendConclusion` must explain the timeframe conflict in plain language.
- Public frontend trend calculations are display analytics; the risk writer must use its own verified contemporaneous OHLCV for any PRS decision.

## `ledger[]`

Append-only in normal operation. Never rewrite history to improve presentation. Corrections must preserve an audit trail or note explaining the correction.

## `history[]`

Compact rolling history. Recommended structure:

```json
{
  "id": "CR30-YYYYMMDD-HHMM",
  "timestampEuropeMadrid": "YYYY-MM-DD HH:MM",
  "dataQuality": "PASS",
  "bestCondition": "CORE",
  "realOrderThisScan": "NO",
  "radar": {
    "BTC": {"ers":72,"entryConfirmation":4},
    "ETH": {"ers":67,"entryConfirmation":null}
  }
}
```

Default retention target: latest 168 hourly scans. Longer-term audit archives may later move to a dedicated historical file/database.

## `alerts[]` (optional)

May contain explicit contemporaneous alerts such as a new PREPARE/STRONG state, material deterioration, or risk warning. The frontend also derives local alerts from the current state. Do not store duplicate alerts every hour if nothing changed materially.

## `journal[]` (optional)

May contain structured contemporaneous events such as user-confirmed order actions, protection changes, or explicit system decisions. It must never be used to hindsight-create a trade narrative that did not exist at the time.

## Merge/write rules

A radar automation updating the file must:

1. read current JSON first;
2. preserve `positions`, `ledger`, `journal`, `positionRisk`, `riskHistory`, intelligence overlays and existing `audits` unless it has contemporaneous authority to change them;
3. replace `scan` and `radar` with the current run;
4. append one `history` record;
5. deduplicate by scan ID;
6. cap rolling history to 168 records;
7. preserve any optional detailed radar fields only when they are contemporaneously generated in the current run;
8. write valid JSON atomically through one GitHub file update;
9. if write fails, report sync failure but never fabricate success.

A dedicated risk/intelligence writer must update only its documented top-level fields and preserve the rest of the file.

## Security

Forbidden fields include API secrets, private keys, passwords, session cookies, Coinbase JWTs, recovery codes, private Telegram/X credentials, or any credential material.
