#!/usr/bin/env python3
"""CABAL v2 canonical decision engine.

One source of truth for WATCH / BUY_NOW / NONE.
Pure functions only: the live scanner and regression suite use the same rules.
"""

import math

CORE_ASSETS={"AVAX","ETH","SOL"}

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

    core_buy=(
        executable and fresh15 and fast_trigger and core
        and rv15>=1.35 and rs1>=0.20 and irs>=0.40
        and p1>=0.30 and p4>=0.50
    )

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
        and rs1>=0.10 and irs>=0.10
        and (fast_watch or rv15>=1.0 or r1>=1.25)
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

    q=_quality_score(row)
    required=1 if (buy and (wide_buy or core_buy or q>=65)) else (2 if buy else 1)

    # Scanner may have produced no pilotEntryMax for WATCH; BUY always gets a tight max.
    entry_max=n(row.get("pilotEntryMax"),None)
    if buy and entry_max is None and price is not None:
        entry_max=min(no_chase*0.995 if no_chase else price*1.005, price*1.005)

    return {
        "decisionTier":tier,
        "decisionReason":reason,
        "buyNowEligible":buy,
        "watchEligible":watch,
        "qualityScore":q,
        "requiredFreshScans":required,
        "decisionEntryMax":entry_max,
        "decisionStop":stop,
        "decisionStopDistancePct":round(stop_dist,4) if stop_dist is not None else None,
        "decisionNoChaseHeadroomPct":round(headroom,4) if headroom is not None else None,
        "rejectReasons":reject,
        "isCoreAsset":core,
    }
