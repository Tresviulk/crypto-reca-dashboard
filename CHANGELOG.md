# Changelog

All material changes to Crypto Reca Dashboard are recorded here.

## [0.5.0] — 2026-08-24

### Position Risk v2.2 — thesis validity vs exit urgency
- Added canonical `docs/POSITION_RISK_SPEC_V2_2.md`.
- Fixed the second-order exit-engine flaw that treated a historically `INVALIDATED` setup as a permanent `EXIT SIGNAL` even after current price/regime/momentum recovered.
- Historical invalidation remains preserved and Structural Risk A remains 40; current B/C/D/E can improve or deteriorate independently.
- `INVALIDATED` no longer hard-overrides every future evaluation to `EXIT SIGNAL`.
- Base action is again determined by current PRS: 0–24 HOLD, 25–44 WATCH, 45–59 REDUCE REVIEW, 60–79 EXIT REVIEW, 80–100 EXIT SIGNAL.
- An open position still managed under an invalidated original thesis has an action floor of `EXIT REVIEW`.
- `EXIT SIGNAL` / red critical treatment is reserved for PRS >=80, touch of a contemporaneously frozen catastrophic boundary, or a documented market-discontinuity/execution-risk emergency.
- UI language now distinguishes “original thesis invalidated” from “current critical exit urgency”.
- SOL migration case with PRS 70 is reclassified from `EXIT SIGNAL` to `EXIT REVIEW`; prior historical EXIT SIGNAL records remain unchanged for audit.
- Updated `DATA_CONTRACT.md`, `AI_HANDOFF.md`, Position Risk UI and PWA cache.

## [0.4.9] — 2026-08-23

### Position Risk v2.1 — breach / reclaim
- Added canonical `docs/POSITION_RISK_SPEC_V2_1.md`.
- Fixed the exit-engine flaw that treated any intrabar print below technical invalidation as permanent thesis failure.
- New structural state machine: `INTACT -> BREACH -> CONFIRMED INVALIDATION`, with recovery path `BREACH -> RECLAIMED`.
- Confirmed invalidation now requires two consecutive completed 15m closes below invalidation, one completed 1H close below invalidation, touch of a contemporaneously defined catastrophic boundary, or an explicitly documented market-discontinuity override.
- Structural PRS mapping is now deterministic: `INTACT=0`, `RECLAIMED=15`, `BREACH=25`, `INVALIDATED=40`.
- A reclaimed wick no longer forces `EXIT SIGNAL`; the historical breach remains preserved for audit.
- Catastrophic boundaries may not be invented retroactively. If not frozen before/at entry, a later level must be labelled `RECOMMENDED` or `UNDEFINED`.
- Updated `DATA_CONTRACT.md` and `AI_HANDOFF.md` so future Position Risk writers must obey v2.1.
- SOL migration test case: post-fill 15m low near 93.36 with close 94.42 above technical invalidation 94.15 is classified `BREACH -> RECLAIMED`, not permanent `INVALIDATED`.

## [0.4.8] — 2026-08-23

### Fixed
- Radar now prints the **exact Crypto Reca indicator timestamp including seconds** in the Radar header and on every asset card; Coinbase live-price refresh time remains visibly separate.
- BTC price charts now mark the user's confirmed real entry with an on-chart point, dashed entry level and entry legend when the entry lies inside the displayed series window.
- Positions and Position Risk now use the same current public Coinbase price for the **live gross P/L** shown to the user.
- The Position Risk snapshot P/L is no longer presented as if it were current; it remains internal contemporaneous risk context only.
- `19.31 USDC`-style modeled figures are now explicitly labelled **risk potential to technical invalidation**, not current loss, preventing confusion with live P/L.
- Risk Dashboard now shows both live gross P/L and modeled invalidation risk as separate concepts.
- Visible app/cache version aligned to `0.4.8`.

## [0.4.5] — 2026-08-23

### Structural hardening
- Added canonical self-contained ERS/D/E rulebook at `docs/ENGINE_SPEC_V3_ERS.md`.
- ERS is now defined deterministically as the best contemporaneous Pullback/Momentum lane score with both lane scores preserved; missing core-data scores remain `null` and are shown as `ERS NO CALCULADO`.
- Added `engineHealth.ers` PASS/PARTIAL/FAIL contract so a broken scoring engine cannot look like a valid low score.
- Split operational writers into isolated module files: radar, confirmed positions/ledger, position risk, intelligence, and external signals.
- `data/crypto-reca-state.json` becomes migration/compatibility fallback instead of a multi-writer transaction surface.
- Service worker now treats all `data/*.json` as network-first and caches the expanded v0.4.5 module set.

### Added
- System Health screen and dashboard health card.
- Decision Matrix combining ERS, Entry Engine, D/E, multi-timeframe trend, PRS, news and external consensus without averaging them.
- Protection Assistant with modeled invalidation loss and 25/50/75% reduction scenarios.
- Scenario Lab for hypothetical position prices; explicitly mechanical and not a future ERS/PRS reconstruction.
- Correlation & Cluster Risk using recent public 1H returns when enough data exist, plus total/Core/high-beta exposure buckets.
- Dedicated Gurús / External Signals screen with forward source validation statistics.
- Shadow Portfolio screen and data contract for prospective PREPARE/rejected-setup research without hindsight.
- Single `CR4` screen/action registry for all new structural modules, reducing additional global show-handler chaining.

### Review fixes before final validation
- Decision Matrix now prefers the Position Risk Engine's contemporaneous `trendTimeframes`/`trendConclusion` for an open position before using frontend display-only trend fallbacks.
- Protection Assistant now prefers the PRS engine's `modeledLossUSDC`; a price-distance fallback is explicitly labelled as gross and excluding fees/slippage.
- Scenario Lab explicitly labels P/L as gross and uses the current risk-engine technical invalidation when available.
- Risk Dashboard was hardened so a recommended technical stop can **never** count as actual protected risk; protected risk requires both `PROTECTED` status and a confirmed `actualStop`/`stopPlaced` level.
- PWA cache bumped to `crypto-reca-app-v0.4.7` for the reviewed safety patch.

### Safety / integrity
- Empty migration module files cannot erase non-empty confirmed legacy data.
- Every writer is restricted to its own file after migration.
- Real positions/ledger/protection remain user-confirmed Coinbase truth only.
- External signals, news, frontend trend and correlation remain contextual overlays; none can mark a fill or override hard gates.

## [0.4.0] — 2026-08-23

### Added
- Full per-asset detail view accessible by tapping any Radar asset.
- Opportunity Center ranking the current universe by operational state, Entry Engine and ERS without presenting it as win probability.
- Risk Dashboard separating open exposure, modeled risk and confirmed protected risk.
- Intelligent in-app alerts for stale sync, unprotected positions and Entry Engine PREPARE/STRONG states.
- Automatic journal combining confirmed Coinbase ledger events and contemporaneous scan history.
- System analytics by asset with scan count, average ERS, PREPARE+ and STRONG+ counts, with explicit insufficient-sample protection.
- Position timeline combining confirmed Coinbase events with stored Crypto Reca scan history.
- Historical ERS and Entry Engine charts per asset.
- Manual `Actualizar ahora` action.
- Clear data-origin labels: LIVE, SCAN and CONFIRMED COINBASE.
- Public display-only technical analytics from completed Coinbase 1H candles: EMA20/50/200, RSI14, MACD 12/26, ATR14, standard 24H VWAP and RVOL vs prior 20 completed candles.
- Position Risk / Exit Advisory module with PRS 0-100, thesis state and rule-based actions: HOLD / WATCH / REDUCE REVIEW / EXIT REVIEW / EXIT SIGNAL.
- News & Catalysts overlay for only material market-moving items plus upcoming 7-day catalysts and action context.
- External Signals / Guru validation model designed to accept only explicit public entry/exit calls on BTC/ETH/SOL/XRP/AVAX/SUI and qualify sources only from forward-captured performance.
- Multi-timeframe trend panel for every asset: 15m / 1H / 4H / 1D, with explicit timeframe-by-timeframe labels and one plain-language combined conclusion.
- Multi-timeframe trend fields inside Position Risk so short-term bearishness can be distinguished from higher-timeframe CORE deterioration.
- `features-v04.js`, `features-v04.css`, `live-indicators-v04.js`, `position-risk-v04.js`, `news-v04.js`, `trend-v04.js` and associated CSS as isolated feature modules so the stable v0.3 core remains recoverable.

### Changed
- PWA cache generation upgraded to `crypto-reca-app-v0.4.4` during initial v0.4 build.
- Asset cards and positions are interactive.
- Audit, Positions and Ledger screens link into the new intelligence views.
- `docs/DATA_CONTRACT.md` expanded for optional detailed scan fields, alerts, journal events, position risk, multi-timeframe trend and intelligence overlays.
- Trend is no longer presented as a single undifferentiated label: 15m/1H describe shorter-term timing, while 4H/1D receive greater weight for CORE thesis management.
- A bearish 15m/1H reading must not automatically be interpreted as a global bearish trend if 4H/1D remain constructive.

### Safety
- Live technical indicators and frontend trend labels are explicitly display analytics and do not replace the contemporaneous Crypto Reca decision engine.
- Position Risk uses its own verified contemporaneous OHLCV; frontend calculations cannot silently change PRS.
- Win rates and efficacy claims are suppressed until there is enough real contemporaneous history.
- `PROTECTED` risk only counts real protection that has been confirmed; recommended stops remain modeled risk.
- News never creates a buy signal by itself.
- External guru/signals data never overrides Crypto Reca hard gates; sources remain VALIDATING until our own forward sample qualifies them.
- No Coinbase credentials, JWTs, private keys, Telegram/X credentials or trading secrets are stored in the frontend or repository.
- The app remains read-only and cannot execute trades.

### Still requires private backend / later phase
- Direct authenticated Coinbase balances, orders and fills without user confirmation.
- Private authentication/access control for financial data.
- True external push notifications originating from the PWA itself.
- Automatic trade execution.

## [0.3.1] — 2026-08-23

### Fixed
- Radar now shows the exact date/time of the latest Crypto Reca scan prominently.
- Radar distinguishes scan time from live Coinbase price refresh time.
- Added freshness status: `ACTUAL`, `RETRASADO`, `ANTIGUO` or `SINCRONIZACIÓN PENDIENTE`.
- Updated PWA cache so the timestamp visibility patch propagates to installed devices.

## [0.3.0] — 2026-08-23

### Added
- Structured operational data source at `data/crypto-reca-state.json`.
- Automatic-consumption architecture for Crypto Reca radar data.
- Public Coinbase market price enrichment with safe fallback.
- Public Coinbase 1H candle sparklines when available.
- Live approximate unrealized P/L from public market price.
- Sync/data-quality status in the UI.
- Recent-scan history rendering.
- System-status section.
- `docs/AI_HANDOFF.md` for continuation by another AI/developer.
- `docs/CRYPTO_RECA_APP_MASTER_GUIDE.md` for full reconstruction.
- `docs/DATA_CONTRACT.md` for safe machine updates.

### Changed
- App data is no longer hard-coded as the intended operational source.
- Service worker upgraded to cache generation `crypto-reca-app-v0.3.1`.
- Data file uses network-first/no-store behavior with canonical offline fallback.
- Navigation requests use network-first behavior to reduce stale PWA versions.
- PWA metadata no longer describes the public GitHub Pages site as private.

### Security
- No Coinbase private credentials are used or stored.
- The app remains read-only and cannot execute trades.

## [0.2.0] — 2026-08-23

### Added
- Initial PWA shell.
- Dashboard, radar, positions, operations and audit screens.
- Android-installable manifest and icons.
- GitHub Pages deployment workflow.

### Known limitations
- Operational data initially embedded in `app.js`.
- No automatic radar synchronization.
- No live market enrichment.
