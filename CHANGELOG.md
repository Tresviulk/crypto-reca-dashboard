# Changelog

All material changes to Crypto Reca Dashboard are recorded here.

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
- Service worker upgraded to `crypto-reca-app-v0.3.0`.
- Data file uses network-first/no-store behavior with offline fallback.
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
