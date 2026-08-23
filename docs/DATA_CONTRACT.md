# DATA CONTRACT — Crypto Reca Dashboard

## Purpose

`data/crypto-reca-state.json` is the operational source consumed by the PWA. This contract exists to prevent accidental corruption, hindsight reconstruction, or loss of confirmed trading records.

## Top-level fields

- `schemaVersion`: data schema version.
- `appVersion`: app version expected by the writer.
- `engineVersion`: Crypto Reca ruleset/version.
- `generatedAt`: ISO timestamp of the most recent successful sync, or `null` before first sync.
- `source`: origin of the update, e.g. `Crypto Reca v3.0 Radar`.
- `scan`: latest contemporaneous scan metadata.
- `validationCapital`: reference capital used by the system.
- `radar`: exactly the current monitored universe unless the system rules change explicitly.
- `positions`: user-confirmed real positions only.
- `ledger`: user-confirmed real fills/transactions only.
- `audits`: contemporaneous audit records.
- `history`: compact scan history.

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

Each asset may include:

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

Rules:

- `ers` must be numeric only if contemporaneously calculated.
- `entryConfirmation` is `0..5` or `null` if unavailable/partial.
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
  "openedEuropeMadrid": "2026-08-22 18:58"
}
```

A position cannot be added because a recommendation was generated. It requires a confirmed fill.

`protection` must distinguish recommendation from actual protection. Never mark `PROTECTED` unless a real stop/protection has been confirmed.

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

## Merge/write rules

A radar automation updating the file must:

1. read current JSON first;
2. preserve `positions`, `ledger`, and existing `audits` unless it has contemporaneous authority to change them;
3. replace `scan` and `radar` with the current run;
4. append one `history` record;
5. deduplicate by scan ID;
6. cap rolling history to 168 records;
7. write valid JSON atomically through one GitHub file update;
8. if write fails, report sync failure but never fabricate success.

## Security

Forbidden fields include API secrets, private keys, passwords, session cookies, Coinbase JWTs, recovery codes, or any credential material.
