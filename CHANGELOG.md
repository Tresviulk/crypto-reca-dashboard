# Changelog

All material changes to Crypto Reca Dashboard are recorded here.

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
- PWA cache generation upgraded to `crypto-reca-app-v0.4.4`.
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
