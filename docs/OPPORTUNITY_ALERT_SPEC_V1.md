# OPPORTUNITY ALERT SPEC — v1

Effective: 2026-08-24. Engine: Crypto Reca v3.0 Radar.

## Purpose
Crypto Reca must surface a developing material move before a final A+/Tactical entry is complete. Silence is not acceptable merely because final execution gates are still incomplete.

This layer is advisory and separate from final trade approval. It never executes a trade and never bypasses ERS, Entry Engine, hard gates, risk controls or Coinbase Preview requirements.

## States
Each radar asset may expose:
- `QUIET` — no material opportunity development.
- `WATCH` — meaningful acceleration/improvement worth immediate attention.
- `PREPARE` — setup is forming and could become actionable soon.
- `ENTRY REVIEW` — conditions justify evaluating a complete entry package now; still not execution.

Optional companion fields: `opportunityReason`, `nearestTrigger`, `locationState`, `coreRegime`, `coreTargetExposurePct`, `currentConfirmedCoreExposurePct`, `change24hPct` when verified.

## Exposure-first priority
BTC and ETH must be evaluated first by regime and confirmed exposure. If regime is bullish/strong bullish and confirmed Core exposure is below target, this is an operational attention condition even when Tactical/A+ is not complete.

## Early-alert evidence
WATCH can be produced by a verified combination of improving 15m/1H structure, breakout/reclaim, momentum improvement with price confirmation, volume/RVOL expansion, relative-strength improvement, or BTC/ETH bullish regime with underexposure.

PREPARE normally requires Entry Engine >=3/5, ERS >=75 without fatal gate, or a valid BTC/ETH Core exposure-repair setup forming at defensible location.

ENTRY REVIEW normally requires Entry Engine >=4/5 with applicable hard gates satisfied, or a valid Core exposure-repair method with defensible structure and risk.

## Anti-late / anti-chase
A large move alone is never a buy signal. If price has already accelerated vertically and location or R/R is poor, the correct state can be `WATCH` with `locationState=DO NOT CHASE` and a retest trigger. The user must still be informed that the move is material.

## Notification escalation
Notify only on a new material escalation versus the prior contemporaneous radar state, including:
1. QUIET -> WATCH/PREPARE/ENTRY REVIEW or WATCH -> PREPARE/ENTRY REVIEW;
2. BTC/ETH becomes bullish/strong bullish while confirmed Core exposure is below target;
3. verified 24h move >=3% with constructive 1H structure/momentum, including `DO NOT CHASE` cases;
4. exceptional 1H acceleration with confirming structure/volume;
5. ERS rises >=10 points into >=70 or Entry Engine rises to >=3;
6. a material hard gate clears and the setup becomes actionable soon.

Do not repeat an unchanged alert every hour.

## Notification content
Include asset, current price, verified 24h change when available, state, D/E, P/M/ERS, Entry Engine, 15m/1H/4H/1D trend, reason, location/chase status, nearest trigger, relevant lane (CORE/TACTICAL/A+/NONE), and BTC/ETH confirmed Core exposure versus target when known. If no complete order exists, state `NO ORDER YET`.

## Reliability rules
- Read current canonical ERS spec and confirmed positions every run.
- Never use stale embedded position assumptions.
- Never invent scores, candles, exposure or triggers.
- Missing optional data may reduce confidence but must not suppress a valid early warning when core evidence is sufficient.
- Radar app sync continues hourly even when no user notification is emitted.
