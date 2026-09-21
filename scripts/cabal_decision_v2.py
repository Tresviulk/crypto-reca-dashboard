#!/usr/bin/env python3
"""CABAL v2 canonical decision engine.

One source of truth for WATCH / BUY_NOW / NONE.
Pure functions only: the live scanner and regression suite use the same rules.
"""

import math

CORE_ASSETS={"BTC","ETH","SOL","XRP","AVAX","HBAR","ONDO"}

def n(v, default=0.0):
    try:
        x=float(v)
        return x if math.isfinite(x) else default
    except Exception:
        return default

def b(v):
    return bool(v)

def tail_exchange_inclusion(turnover, change24h):
    """Allow low-rank exchange-native assets into discovery before they become obvious."""
    turn=n(turnover)
    p24=n(change24h)
    return turn >= 75_000 and 4.0 <= p24 < 25.0

def _quality_score(row):
    ft=row.get("fastPump15m") or {}
    score=n(row.get("stageAScore"))
    r1=max(0.0,n(row.get("rvol1h")))
    rv15=max(0.0,n(ft.get("rvol15m")))
    rs1=n(row.get("relativeStrength1hVsBTC"))
    rs4=n(row.get("relativeStrength4hVsBTC"))
    irs=n(row.get("intrahourRelativeStrengthVsBTC"))
    p1=n(row.get("priceChange1hPct"))
    p4=n(row.get("priceChange4hPct"))
    q=0.0
    q += min(22,max(0,rs1)*8)
    q += min(18,max(0,irs)*8)
    q += min(12,max(0,rs4)*3)
    q += min(12,math.log1p(r1)*4)
    q += min(12,math.log1p(rv15)*4)
    q += min(10,max(0,p1)*1.5)
    q += min(8,max(0,p4)*0.6)
    q += min(6,score/15)
    return round(min(100,q),2)

def evaluate(row):
    asset=str(row.get("asset") or "").upper()
    ft=row.get("fastPump15m") or {}
    price=n(row.get("price"),None)
    no_chase=n(row.get("noChase"),None)
    stop=n(row.get("protectiveStopReference"),None)
    if stop is None:
        stop=n(ft.get("invalidation15m"),None)
    if stop is None:
        stop=n(row.get("invalidation"),None)

    p1=n(row.get("priceChange1hPct"))
    p4=n(row.get("priceChange4hPct"))
    p6=n(row.get("priceChange6hPct"))
    p24=n(row.get("priceChange24hPct"))
    p72=n(row.get("priceChange72hPct"))
    p7=n(row.get("priceChange7dPct"))
    r1=n(row.get("rvol1h"))
    rv15=n(ft.get("rvol15m"))
    rs1=n(row.get("relativeStrength1hVsBTC"))
    rs4=n(row.get("relativeStrength4hVsBTC"))
    irs=n(row.get("intrahourRelativeStrengthVsBTC"))
    intra=n(row.get("intrahourMovePct"))
    score=n(row.get("stageAScore"))
    bb=b(row.get("bucketB"))
    bc=b(row.get("bucketC"))
    fast_watch=b(row.get("fastPumpWatch") or ft.get("watch"))
    fast_trigger=b(row.get("fastPumpTrigger") or ft.get("trigger"))
    wide_watch=b(ft.get("wideBaseWatch"))
    wide_trigger=b(ft.get("wideBaseTrigger"))
    fresh15=b(row.get("entryConfirmation15m") or fast_trigger)
    effort=str(row.get("effortVsResult") or "").upper()
    cls=str(row.get("classification") or "").upper()
    core=asset in CORE_ASSETS
    q=_quality_score(row)
    second_leg=bool(
        b(row.get("secondLegTrigger"))
        or cls=="SECOND-LEG TRIGGER"
        or str(row.get("pilotReason") or "").upper()=="SECOND_LEG_TRIGGER"
    )

    headroom=((no_chase-price)/price*100) if price and no_chase else None
    stop_dist=((price-stop)/price*100) if price and stop and price>stop else None

    reject=[]
    if effort=="POOR" or "CHURN" in cls or "DISTRIBUTION" in cls:
        reject.append("POOR_OR_DISTRIBUTION")
    if p24 >= 22:
        reject.append("MOVE_TOO_EXTENDED_24H")
    if price is not None and no_chase is not None and price >= no_chase:
        reject.append("NO_CHASE_EXCEEDED")
    if headroom is not None and headroom < 0.5:
        reject.append("NO_CHASE_HEADROOM_TOO_SMALL")
    if rs1 < -0.10:
        reject.append("NEGATIVE_RS1")
    if irs < -0.10:
        reject.append("NEGATIVE_INTRAHOUR_RS")

    executable=(
        price is not None and stop is not None and price>stop
        and stop_dist is not None and 1.0 <= stop_dist <= 4.5
        and (headroom is None or headroom >= 1.0)
        and p24 < 18
        and effort!="POOR"
        and "CHURN" not in cls and "DISTRIBUTION" not in cls
    )

    wide_buy=(
        executable and fresh15 and wide_trigger and bb
        and score>=80 and r1>=8 and rv15>=3
        and rs1>=1.0 and rs4>=2.0 and irs>=0.60
        and p1>=0.50
    )

    fast_buy=(
        executable and fresh15 and fast_trigger and bb and bc
        and score>=50 and rv15>=3.0
        and rs1>=0.40 and rs4>=0.10 and irs>=0.50
        and p1>=0.30
    )

    btc_confirm=(
        asset=="BTC"
        and rv15>=1.35 and intra>=0.40 and p1>=0.30
        and price is not None and n(ft.get("baseHigh4h15m"),None) is not None
        and price>=n(ft.get("baseHigh4h15m"))*.995
    )
    # CORE is scanned aggressively, but CORE status must never bypass quality.
    # 2026-09-21 ONDO failure: NO SETUP / B=False / q=24.21 was allowed to BUY.
    alt_core_buy=(
        executable and fresh15 and fast_trigger and core and asset!="BTC"
        and cls!="NO SETUP" and bb and q>=50
        and r1>=1.0 and rv15>=1.50
        and rs1>=0.30 and irs>=0.40
        and p1>=0.30 and p4>=0.50
    )
    btc_core_buy=(
        executable and btc_confirm
        and r1>=1.15 and p4>=0.50
    )
    core_buy=alt_core_buy or btc_core_buy

    pre_buy=(
        executable and fresh15
        and str(row.get("pilotReason") or "").upper() in {"PRE_ACCUM_TRIGGER","ABC_EARLY_STRUCTURE","SECOND_LEG_TRIGGER"}
        and bb and bc and score>=65 and r1>=5 and rs1>=0.20 and irs>=0.20
    )

    buy=wide_buy or fast_buy or core_buy or pre_buy

    # WATCH is deliberately earlier than BUY. It is informational only.
    # This is what prevents KMNO/AVAX-like moves from becoming visible only after the move.
    strong_1h=(
        p24 < 20 and p1>=0.75 and r1>=2.0 and rs1>=0.50
        and score>=35 and effort!="POOR"
    )
    strong_intrahour=(
        p24 < 20 and intra>=0.45 and irs>=0.35
        and rv15>=1.25 and effort!="POOR"
    )
    strong_structure=(
        p24 < 20 and bb and bc and score>=60
        and rs1>=0.30 and (fast_watch or r1>=2)
        and effort!="POOR"
    )
    core_watch=(
        core and p24 < 20
        and (p1>=0.45 or p4>=1.5 or intra>=0.45)
        and (
            (asset=="BTC" and (rv15>=1.0 or r1>=1.25))
            or
            (asset!="BTC" and rs1>=0.10 and irs>=0.10 and (fast_watch or rv15>=1.0 or r1>=1.25))
        )
    )
    wide_early=wide_watch and p24<18 and rs1>=0.5 and irs>=0.3

    watch=(not buy) and (strong_1h or strong_intrahour or strong_structure or core_watch or wide_early)
    if headroom is not None and headroom < 0.5:
        watch=False
    if p24>=22 or effort=="POOR" or "CHURN" in cls or "DISTRIBUTION" in cls:
        watch=False

    if buy:
        tier="BUY_NOW"
        if wide_buy:
            reason="WIDE_BASE_CONFIRMED"
        elif core_buy:
            reason="CORE_ACCEL_CONFIRMED"
        elif pre_buy:
            reason="STRUCTURE_CONFIRMED"
        else:
            reason="FAST_ACCEL_CONFIRMED"
    elif watch:
        tier="WATCH"
        if core_watch:
            reason="CORE_EARLY_WATCH"
        elif wide_early:
            reason="WIDE_BASE_EARLY_WATCH"
        elif strong_intrahour:
            reason="INTRAHOUR_ACCEL_WATCH"
        elif strong_1h:
            reason="ONE_HOUR_MOMENTUM_WATCH"
        else:
            reason="STRUCTURE_WATCH"
    else:
        tier="NONE"
        reason=reject[0] if reject else "NO_EDGE"

    required=1 if (buy and (wide_buy or core_buy or q>=65)) else (2 if buy else 1)

    # USER-FACING CABAL has two separate lanes:
    # SCALP = immediate, executable +2%/+3% objective.
    # RUNNER = early expansion candidate / confirmed runner with room for a larger move.
    # Generic WATCH stays internal and is NEVER pushed to the user.
    vol_build=n(row.get("preAccumVolumeBuild6h"))
    base12=n(row.get("preAccumBaseRange12hPct"))
    pre_watch=b(row.get("preAccumWatch"))
    pre_trigger=b(row.get("preAccumTrigger"))

    scalp_buy=bool(
        buy
        and (asset=="BTC" or q>=50)
        and p24 < 12.0
        and p1 < 4.0
        and stop_dist is not None and 1.0 <= stop_dist <= 3.8
        and (headroom is None or headroom >= 3.0)
        and (rv15 >= 1.5 or r1 >= 2.0)
        and (
            asset=="BTC"
            or (rs1>=0.30 and irs>=0.20)
        )
    )

    # RUNNER WATCH is informational and intentionally earlier than BUY.
    # Do NOT apply BUY/no-chase headroom rules to an informational early warning:
    # OPG/PHA were seen with ~1% headroom on 2026-09-21 and then ran materially.
    # A 72h extension guard blocks stale M-like momentum unless this is a real second leg.
    runner_context_ok=(p72 < 22.0 or second_leg)
    runner_early_limits=(
        p1 >= 0.25 and p1 < 3.5
        and p6 < 10.0
        and p24 < 20.0
        and runner_context_ok
    )
    runner_structure=(
        (
            bb
            and effort!="POOR"
            and "CHURN" not in cls and "DISTRIBUTION" not in cls
            and (
                pre_watch or pre_trigger or wide_watch
                or score>=55
            )
        )
        # UAI-type early accumulation can be valuable before Bucket B completes.
        or (
            pre_watch and q>=45
            and rs1>=1.0 and rs4>=2.0
            and intra>=1.0
            and effort!="POOR"
        )
    )
    runner_flow=(
        (asset=="BTC" and (r1>=2.0 or rv15>=1.8))
        or
        (
            asset!="BTC"
            and rs1>=0.65 and rs4>=0.80
            and (
                r1>=2.5 or rv15>=1.8 or vol_build>=1.35
                or (pre_watch and intra>=1.0 and rs1>=1.0 and rs4>=2.0)
                or (pre_trigger and r1>=1.5)
            )
        )
    )
    runner_location=(
        # 0.5% is enough for a WATCH. BUY keeps its much stricter execution headroom.
        (headroom is None or headroom>=0.5)
        and stop_dist is not None and 1.0<=stop_dist<=6.0
        and (base12<=16.0 or wide_watch or pre_watch or pre_trigger)
    )
    runner_early_candidate=bool(
        not buy
        and runner_early_limits
        and runner_structure
        and runner_flow
        and runner_location
        and q>=45
        and not reject
    )

    # Fallback for scans that arrive after the earliest window. This never authorizes
    # a BUY; it prevents KMNO-like genuine acceleration from becoming invisible.
    runner_confirmed_candidate=bool(
        not buy
        and 3.5 <= p1 < 10.0
        and p6 < 18.0 and p24 < 20.0
        and q>=65
        and r1>=5.0
        and rs1>=1.5 and rs4>=1.5
        and effort!="POOR"
        and "CHURN" not in cls and "DISTRIBUTION" not in cls
        and (headroom is None or headroom>=0.5)
        and not reject
    )
    runner_candidate=bool(runner_early_candidate or runner_confirmed_candidate)

    # A user-facing RUNNER candidate is, by definition, a WATCH.
    # Keep canonical tier/watch fields coherent for scanner + NTFY.
    if runner_candidate and not buy and tier=="NONE":
        watch=True
        tier="WATCH"
        reason="RUNNER_EARLY_WATCH" if runner_early_candidate else "RUNNER_CONFIRMED_WATCH"

    runner_buy=bool(
        buy
        and (asset=="BTC" or q>=55)
        and p24<14.0
        and p1<4.5
        and (headroom is None or headroom>=3.5)
        and stop_dist is not None and 1.0<=stop_dist<=4.5
        and (
            wide_buy
            or pre_buy
            or pre_trigger
            or (
                score>=70
                and rs4>=1.5
                and (r1>=4.0 or rv15>=3.0 or vol_build>=1.5)
            )
        )
    )

    # Defense in depth: no non-BTC BUY reaches the user below quality 50.
    notify_buy=bool((scalp_buy or runner_buy) and (asset=="BTC" or q>=50))
    notify_watch=bool(runner_candidate)

    # Scanner may have produced no pilotEntryMax for WATCH; BUY always gets a tight max.
    entry_max=n(row.get("pilotEntryMax"),None)
    if buy and entry_max is None and price is not None:
        entry_max=min(no_chase*0.995 if no_chase else price*1.005, price*1.005)

    return {
        "decisionTier":tier,
        "decisionReason":reason,
        "buyNowEligible":buy,
        "watchEligible":watch,
        "notifyWatchEligible":notify_watch,
        "notifyBuyEligible":notify_buy,
        "scalpBuyEligible":scalp_buy,
        "runnerBuyEligible":runner_buy,
        "runnerCandidateEligible":runner_candidate,
        "runnerCandidateStage":("EARLY" if runner_early_candidate else ("CONFIRMED" if runner_confirmed_candidate else None)),
        "scalpTarget2Pct":round(price*1.02,12) if price is not None else None,
        "scalpTarget3Pct":round(price*1.03,12) if price is not None else None,
        "signalLane":("SCALP+RUNNER" if scalp_buy and runner_buy else ("RUNNER" if runner_buy or runner_candidate else ("SCALP" if scalp_buy else "INTERNAL"))),
        "qualityScore":q,
        "requiredFreshScans":required,
        "decisionEntryMax":entry_max,
        "decisionStop":stop,
        "decisionStopDistancePct":round(stop_dist,4) if stop_dist is not None else None,
        "decisionNoChaseHeadroomPct":round(headroom,4) if headroom is not None else None,
        "rejectReasons":reject,
        "isCoreAsset":core,
    }
