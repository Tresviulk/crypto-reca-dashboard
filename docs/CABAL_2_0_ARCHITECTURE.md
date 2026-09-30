# CABAL 2.0 — clean rebuild architecture

Status: parallel rebuild. CABAL production remains untouched until CABAL 2.0 passes objective detection and decision gates.

## Why rebuild

The current stack mixes discovery, setup quality, execution readiness and notification policy. That creates two material failure modes:

1. A market move can be detected internally but never become user-visible because it fails later quality/notification gates.
2. A five-minute GitHub decision cycle is too slow to be the primary early-move detector.

CABAL 2.0 separates those concerns.

## Architecture

1. MARKET RADAR — every minute, deterministic, no BUY logic.
   - Scan tradable spot markets.
   - Current priority venues: Coinbase and KuCoin.
   - Track 1m / 3m / 5m movement, acceleration, 24h turnover, venue confirmation and 24h extension.
   - Never suppress a genuine mover because it is already extended; flag it as extended instead.
   - Output: MOVING / ACCELERATING / SURGE, never BUY.

2. SETUP ENGINE — consumes Radar candidates.
   - Structure, volume, relative strength, liquidity, spread and multi-timeframe context.
   - Output: NO_SETUP / WATCH / READY.

3. EXECUTION ENGINE — only READY setups.
   - Entry window, stop, no-chase, slippage and position-size checks.
   - Output: BUY_READY / EXPIRED / REJECTED.
   - Manual execution only unless explicitly changed later.

4. RISK ENGINE — independent hard gate.
   - Maximum position size, maximum daily loss, exposure caps, kill switch.
   - Cannot be bypassed by strategy logic.

5. AUDIT / REPLAY.
   - Every Radar detection and every later decision must be reconstructable.
   - Missed-mover audit is a first-class test, not a post-hoc explanation.

## Phase 1 acceptance gate — Market Radar

Before any CABAL 2.0 BUY logic is enabled, the Radar must prove that it sees the market.

Required tests:
- One-minute scan cadence on Cloudflare.
- Coinbase + KuCoin public spot coverage with explicit source failures.
- Movers are surfaced independently of BUY-quality filters.
- Extended movers remain visible with an EXTENDED flag.
- Synthetic regressions for fast 1m, 3m and 5m moves, flat markets and low-liquidity noise.
- Persisted health: last scan, universe size, source status, detection count and scan duration.

## Production rule

CABAL 1.x/current production stays live as reference only. CABAL 2.0 is built and validated in parallel. No production replacement until detection coverage is demonstrated and the user explicitly approves the cutover.
