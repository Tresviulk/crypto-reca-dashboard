#!/usr/bin/env python3
"""CABAL v2 notification relay.

The scanner is the single source of truth for quality. This relay never invents
or re-scores a BUY; it only checks freshness, persistence, cooldown and live
execution bounds before sending.
"""
import json, math, os, sys
from datetime import datetime, timezone

STATE_PATH=os.environ.get("CABAL_NTFY_STATE","data/ntfy-alert-state.json")
PAYLOAD_PATH=os.environ.get("CABAL_NTFY_PAYLOAD","/tmp/ntfy-payload.json")
CABAL_PATH=os.environ.get("CABAL_MACHINE_PATH","data/cabal-machine.json")
WHALES_PATH=os.environ.get("CABAL_WHALES_PATH","data/whales-early-entry-state.json")
GUARD_HEALTH_PATH=os.environ.get("CABAL_GUARD_HEALTH_PATH","/tmp/cabal-guard-health.json")

BUY_COOLDOWN_HOURS=6
WATCH_COOLDOWN_HOURS=12
WATCH_GLOBAL_COOLDOWN_MINUTES=30
CANCEL_WINDOW_MINUTES=20
MAX_MACHINE_AGE_MINUTES=10
ALERT_VALIDITY_MINUTES=10
MAX_BUYS_PER_PUSH=3
MAX_WATCH_PER_PUSH=1

def num(v):
    try:
        x=float(v)
        return x if math.isfinite(x) else None
    except Exception:
        return None

def fmt(v):
    x=num(v)
    if x is None: return "n/a"
    if abs(x)>=1000: return f"{x:,.2f}".replace(",","")
    if abs(x)>=1: return f"{x:.6f}".rstrip("0").rstrip(".")
    if abs(x)>=0.01: return f"{x:.6f}".rstrip("0").rstrip(".")
    return f"{x:.10f}".rstrip("0").rstrip(".")

def parse_time(s):
    if not s: return None
    try: return datetime.fromisoformat(str(s).replace("Z","+00:00"))
    except Exception: return None

def hours_since(now,s):
    t=parse_time(s)
    return 1e9 if not t else (now-t).total_seconds()/3600

def minutes_since(now,s):
    t=parse_time(s)
    return 1e9 if not t else (now-t).total_seconds()/60

def load(path,default):
    try:
        with open(path,encoding="utf-8") as f: return json.load(f)
    except Exception:
        return default

def machine_healthy(cabal,now):
    generated=parse_time(cabal.get("generatedAt"))
    age=((now-generated).total_seconds()/60) if generated else 1e9
    cov=cabal.get("coverage") or {}
    universe=int(cov.get("executionUniverseCount") or cov.get("mainEligibleUniverseCount") or 0)
    scanned=int(cov.get("mainScannedCount") or 0)
    ratio=(scanned/universe) if universe else 0
    return (
        cabal.get("ok") is True
        and cabal.get("mainMachineOperational") is True
        and age<=MAX_MACHINE_AGE_MINUTES
        and ratio>=0.90
        and not (cov.get("coreMissingAssets") or [])
    ),age,ratio

def market_guard_healthy(now):
    g=load(GUARD_HEALTH_PATH,{})
    t=parse_time(g.get("lastSuccessfulScan"))
    age=((now-t).total_seconds()) if t else 1e9
    # Guard scan health and notification transport health are separate.
    # A temporary ntfy quota/backoff must not make the market scanner itself
    # look unhealthy or trigger duplicate WATCH fallbacks that burn more quota.
    ok=bool(
        g.get("healthy") is True
        and age<=210
        and (num(g.get("schedulerLagSeconds")) or 0)<=120
        and (num(g.get("lastObservationGapSeconds")) or 0)<=180
    )
    return ok,g,age

def execution_valid(row):
    if row.get("decisionTier")!="BUY_NOW" or row.get("buyNowEligible") is not True or row.get("notifyBuyEligible") is not True:
        return False
    asset=str(row.get("asset") or "").upper()
    quality=num(row.get("qualityScore"))
    classification=str(row.get("baseClassification") or row.get("classification") or "").upper()
    # Defense in depth: never relay another ONDO-2026-09-21 style low-quality CORE BUY.
    if asset!="BTC" and (quality is None or quality<55):
        return False
    if row.get("isCoreAsset") is True and asset!="BTC" and classification=="NO SETUP":
        return False
    price=num(row.get("price"))
    entry=num(row.get("decisionEntryMax") or row.get("pilotEntryMax"))
    stop=num(row.get("decisionStop") or row.get("protectiveStopReference"))
    head=num(row.get("decisionNoChaseHeadroomPct") or row.get("noChaseHeadroomPct"))
    sd=num(row.get("decisionStopDistancePct") or row.get("pilotStopDistancePct"))
    if price is None or entry is None or stop is None or price>entry or price<=stop:
        return False
    if head is not None and head<1.0:
        return False
    if sd is not None and not (1.0<=sd<=4.5):
        return False
    return True

def buy_card(r,seen):
    lane=r.get("signalLane") or "SCALP"
    parts=[
        f'🚨 {r.get("asset")} — {lane}',
        f'PLATAFORMA: {r.get("executionVenue") or r.get("venue") or "n/a"}',
        f'CALIDAD: {fmt(r.get("qualityScore"))}/100',
        f'MOTIVO: {r.get("decisionReason") or "CONFIRMED"}',
        f'CONFIRMACIONES: {seen}/{int(r.get("requiredFreshScans") or 1)}',
        f'PRECIO AHORA: {fmt(r.get("price"))}',
        f'COMPRA MÁX.: {fmt(r.get("decisionEntryMax") or r.get("pilotEntryMax"))}',
        f'STOP: {fmt(r.get("decisionStop") or r.get("protectiveStopReference"))}',
    ]
    if r.get("scalpBuyEligible"):
        parts += [
            f'OBJETIVO SCALP +2%: {fmt(r.get("scalpTarget2Pct"))}',
            f'OBJETIVO SCALP +3%: {fmt(r.get("scalpTarget3Pct"))}',
        ]
    if r.get("runnerBuyEligible"):
        parts.append("RUNNER: estructura compatible con recorrido mayor; puedes igualmente asegurar +2/+3%.")
    if r.get("pilotBuyEligible"):
        pct=int(r.get("pilotSizePctOfPlannedPosition") or 20)
        parts.append(f'ENTRADA PILOT: {pct}% de la posición prevista. Añadir solo si CABAL vuelve a confirmar; STOP obligatorio.')
    if r.get("_whaleConfirmed"): parts.append("WHALES: CONFIRMACIÓN POSITIVA")
    return "\n".join(parts)

def watch_card(r):
    stage=str(r.get("runnerCandidateStage") or "EARLY").upper()
    label="RUNNER TEMPRANO" if stage=="EARLY" else "RUNNER CONFIRMADO — NO CHASE"
    action=(
        "ACCIÓN: RUNNER CANDIDATE. NO COMPRAR AÚN; CABAL espera confirmación de entrada."
        if stage=="EARLY"
        else "ACCIÓN: MOVIMIENTO CONFIRMADO, PERO NO ES BUY. No perseguir precio; esperar entrada ejecutable."
    )
    return "\n".join([
        f'🚀 {r.get("asset")} — {label}',
        f'PLATAFORMA: {r.get("executionVenue") or r.get("venue") or "n/a"}',
        f'CALIDAD: {fmt(r.get("qualityScore"))}/100',
        f'PRECIO: {fmt(r.get("price"))}',
        f'MARGEN NO-CHASE: {fmt(r.get("decisionNoChaseHeadroomPct") or r.get("noChaseHeadroomPct"))}%',
        f'1H / 6H / 24H: {fmt(r.get("priceChange1hPct"))}% / {fmt(r.get("priceChange6hPct"))}% / {fmt(r.get("priceChange24hPct"))}%',
        f'RS 1H / 4H vs BTC: {fmt(r.get("relativeStrength1hVsBTC"))}% / {fmt(r.get("relativeStrength4hVsBTC"))}%',
        action
    ])

def watch_priority(r):
    core=1 if r.get("isCoreAsset") else 0
    early=1 if str(r.get("runnerCandidateStage") or "EARLY").upper()=="EARLY" else 0
    p1=num(r.get("priceChange1hPct")) or 0
    p6=num(r.get("priceChange6hPct")) or 0
    p24=num(r.get("priceChange24hPct")) or 0
    momentum=max(p1,p6,p24)
    fast=1 if (p6>=8 or p1>=3 or p24>=10) else 0
    # Urgency first: CORE, then strongest active mover, then model quality.
    # This prevents a KMNO-like +15% move from being hidden behind quieter high-score WATCHes.
    return (core,early,fast,momentum,num(r.get("qualityScore")) or 0)

def urgent_watch(r):
    # Fast/CORE/exceptional runners may bypass only the GLOBAL throttle.
    # Per-asset cooldown still prevents repeated spam.
    p1=num(r.get("priceChange1hPct")) or 0
    p6=num(r.get("priceChange6hPct")) or 0
    q=num(r.get("qualityScore")) or 0
    stage=str(r.get("runnerCandidateStage") or "EARLY").upper()
    return bool(r.get("isCoreAsset") or stage=="CONFIRMED" or p1>=3.0 or p6>=8.0 or q>=70)

def build():
    now=datetime.now(timezone.utc)
    now_iso=now.isoformat().replace("+00:00","Z")
    cabal=load(CABAL_PATH,{})
    whales=load(WHALES_PATH,{})
    healthy,age,scan_ratio=machine_healthy(cabal,now)
    guard_ok,guard,guard_age=market_guard_healthy(now)

    prev=load(STATE_PATH,{
        "lastAlertAt":{},"lastWatchAt":{},"lastCancelAt":{},
        "qualifiedSeenCount":{},"lastCabalGeneratedAt":None,
        "systemLastWatchAt":None
    })
    last_alert=dict(prev.get("lastAlertAt") or {})
    last_watch=dict(prev.get("lastWatchAt") or {})
    last_cancel=dict(prev.get("lastCancelAt") or {})
    seen=dict(prev.get("qualifiedSeenCount") or {})

    whale_assets=set()
    for w in whales.get("buyCandidates") or []:
        if w.get("cabalValidatedForEntry") is True and w.get("marketHealthy") is True and w.get("noChase") is not True and (num(w.get("netTokenFlow")) or 0)>0:
            a=str(w.get("asset") or w.get("symbol") or w.get("tokenSymbol") or "").upper()
            if a: whale_assets.add(a)

    buys=[]
    for x in cabal.get("buyCandidates") or []:
        if not execution_valid(x): continue
        r=dict(x)
        if str(r.get("asset") or "").upper() in whale_assets:
            r["_whaleConfirmed"]=True
        buys.append(r)
    buys.sort(key=lambda r:(bool(r.get("_whaleConfirmed")),num(r.get("qualityScore")) or 0),reverse=True)

    watches=[
        dict(x) for x in (cabal.get("watchCandidates") or [])
        if x.get("decisionTier")=="WATCH"
        and x.get("runnerCandidateEligible") is True
        and x.get("notifyWatchEligible") is True
    ]
    watches.sort(key=watch_priority,reverse=True)

    scan_id=str(cabal.get("generatedAt") or "")
    is_new=bool(scan_id and scan_id!=str(prev.get("lastCabalGeneratedAt") or ""))
    active_buy={f'CABAL:{str(r.get("asset") or "").upper()}':r for r in buys}
    active_watch={f'CABAL:{str(r.get("asset") or "").upper()}':r for r in watches}

    if is_new:
        for key,r in active_buy.items():
            seen[key]=min(99,int(seen.get(key,0))+1)
        for key in list(seen):
            if key not in active_buy:
                seen.pop(key,None)

    ready_buy=[]
    if healthy:
        for key,r in active_buy.items():
            req=int(r.get("requiredFreshScans") or 1)
            if int(seen.get(key,0))<req: continue
            if hours_since(now,last_alert.get(key))<BUY_COOLDOWN_HOURS: continue
            ready_buy.append(r)
    ready_buy=ready_buy[:MAX_BUYS_PER_PUSH]

    # Explicitly revoke a recent BUY when the scanner no longer considers it executable.
    cancels=[]
    for key,ts in last_alert.items():
        age_alert=minutes_since(now,ts)
        if 0<=age_alert<=CANCEL_WINDOW_MINUTES and key not in active_buy:
            if minutes_since(now,last_cancel.get(key))>CANCEL_WINDOW_MINUTES:
                cancels.append(key)
    cancels=cancels[:3]

    ready_watch=[]
    watch_global_ready=minutes_since(now,prev.get("systemLastWatchAt"))>=WATCH_GLOBAL_COOLDOWN_MINUTES
    if healthy and not ready_buy and not guard_ok:
        buy_assets={str(r.get("asset") or "").upper() for r in buys}
        ordered=sorted(active_watch.items(),key=lambda kv:watch_priority(kv[1]),reverse=True)
        for key,r in ordered:
            if str(r.get("asset") or "").upper() in buy_assets: continue
            if hours_since(now,last_watch.get(key))<WATCH_COOLDOWN_HOURS: continue
            # CORE and fast movers bypass the global WATCH throttle once per asset.
            if not watch_global_ready and not urgent_watch(r): continue
            ready_watch.append(r)
        ready_watch=ready_watch[:MAX_WATCH_PER_PUSH]

    payload=None
    if ready_buy:
        cards=[]
        for r in ready_buy:
            key=f'CABAL:{str(r.get("asset") or "").upper()}'
            cards.append(buy_card(r,int(seen.get(key,0))))
            last_alert[key]=now_iso
        prefix=""
        if cancels:
            names=", ".join(k.split(":",1)[-1] for k in cancels)
            prefix=f'🔴 CANCELAR ALERTA PREVIA: {names}\nNO COMPRAR esas señales.\n\n'
            for k in cancels: last_cancel[k]=now_iso
        has_runner=any(r.get("runnerBuyEligible") for r in ready_buy)
        has_scalp=any(r.get("scalpBuyEligible") for r in ready_buy)
        has_pilot=any(r.get("pilotBuyEligible") for r in ready_buy)
        if has_pilot and not (has_runner or has_scalp):
            title="⚡ CABAL PILOT — COMPRAR AHORA"
        elif has_runner and has_scalp:
            title="🟢🚀 CABAL — SCALP / RUNNER BUY"
        elif has_runner:
            title="🚀 CABAL RUNNER — COMPRAR AHORA"
        elif has_scalp:
            title="🟢 CABAL SCALP — COMPRAR AHORA"
        else:
            title="🟢 CABAL — COMPRAR AHORA"
        payload={
            "title":title,
            "priority":"high",
            "kind":"BUY",
            "buyAssets":[str(r.get("asset") or "").upper() for r in ready_buy],
            "message":prefix+"\n\n".join(cards)+f'\n\nVENTANA: {ALERT_VALIDITY_MINUTES} min. Ejecutar SPOT solo si precio <= COMPRA MÁX. y no llega cancelación. Tú decides el importe.'
        }
    elif cancels:
        names=", ".join(k.split(":",1)[-1] for k in cancels)
        for k in cancels: last_cancel[k]=now_iso
        payload={
            "title":"🔴 CABAL v2 — CANCELAR COMPRA",
            "priority":"high","kind":"CANCEL","buyAssets":[],
            "message":f'{names}\nLa señal anterior ya NO es válida.\nSI NO ENTRASTE: NO COMPRAR.\nSI YA ENTRASTE: esta cancelación no ordena vender; no añadas posición y mantén como referencia el STOP comunicado en la alerta original.'
        }
    elif ready_watch:
        for r in ready_watch:
            last_watch[f'CABAL:{str(r.get("asset") or "").upper()}']=now_iso
        prev["systemLastWatchAt"]=now_iso
        payload={
            "title":"🚀 CABAL RUNNER — CANDIDATO TEMPRANO",
            "priority":"default","kind":"RUNNER","buyAssets":[],
            "message":"\n\n".join(watch_card(r) for r in ready_watch)
        }

    state={
        "schemaVersion":"2.0",
        "generatedAt":now_iso,
        "activeBuy":sorted(active_buy),
        "activeWatch":sorted(active_watch),
        "lastAlertAt":last_alert,
        "lastWatchAt":last_watch,
        "lastCancelAt":last_cancel,
        "systemLastWatchAt":prev.get("systemLastWatchAt"),
        "qualifiedSeenCount":seen,
        "lastCabalGeneratedAt":scan_id,
        "health":{"healthy":bool(healthy and guard_ok),"machineHealthy":healthy,"marketGuardHealthy":guard_ok,"cabalGeneratedAt":cabal.get("generatedAt"),"ageMinutes":round(age,2) if age<1e8 else None,"executionScanRatio":round(scan_ratio,4),"guardAgeSeconds":round(guard_age,2) if guard_age<1e8 else None,"schedulerLagSeconds":guard.get("schedulerLagSeconds"),"lastObservationGapSeconds":guard.get("lastObservationGapSeconds"),"maxObservationGapSeconds":guard.get("maxObservationGapSeconds"),"lastSuccessfulScan":guard.get("lastSuccessfulScan"),"guardLastError":guard.get("lastError"),"guardNotificationHealthy":guard.get("notificationHealthy"),"guardNotificationMode":guard.get("notificationMode"),"guardNotificationStatus":guard.get("lastNotificationStatus"),"guardNotificationError":guard.get("lastNotificationError"),"guardNotificationBackoffUntil":guard.get("notificationBackoffUntil"),"notificationDegraded":guard.get("notificationHealthy") is False,"watchFallbackMode":not guard_ok}
    }
    with open("/tmp/ntfy-alert-state.json","w",encoding="utf-8") as f:
        json.dump(state,f,ensure_ascii=False,indent=2)
    with open(PAYLOAD_PATH,"w",encoding="utf-8") as f:
        json.dump(payload,f,ensure_ascii=False)
    print(json.dumps({"healthy":healthy,"userBuySignals":len(buys),"runnerCandidates":len(watches),"readyBuy":[{"asset":r.get("asset"),"lane":r.get("signalLane")} for r in ready_buy],"readyRunner":[r.get("asset") for r in ready_watch],"cancels":cancels,"willNotify":bool(payload)},ensure_ascii=False))

def revalidate(latest_path):
    payload=load(PAYLOAD_PATH,None)
    if not payload or payload.get("kind")!="BUY":
        return
    cabal=load(latest_path,{})
    now=datetime.now(timezone.utc)
    healthy,_,_=machine_healthy(cabal,now)
    if not healthy:
        with open(PAYLOAD_PATH,"w",encoding="utf-8") as f: json.dump(None,f)
        print("BUY suppressed: newest machine unhealthy/stale")
        return
    by_asset={str(x.get("asset") or "").upper():x for x in cabal.get("buyCandidates") or []}
    state=load("/tmp/ntfy-alert-state.json",{})
    seen=state.get("qualifiedSeenCount") or {}
    valid_rows=[]
    for asset in payload.get("buyAssets") or []:
        r=by_asset.get(asset)
        if r and execution_valid(r):
            valid_rows.append(r)
    if not valid_rows:
        with open(PAYLOAD_PATH,"w",encoding="utf-8") as f: json.dump(None,f)
        print("BUY suppressed: all assets failed send-time revalidation")
        return
    if len(valid_rows)!=len(payload.get("buyAssets") or []):
        payload["buyAssets"]=[str(r.get("asset") or "").upper() for r in valid_rows]
        payload["message"]="\n\n".join(
            buy_card(r,int(seen.get(f'CABAL:{str(r.get("asset") or "").upper()}',0)))
            for r in valid_rows
        ) + f'\n\nVENTANA: {ALERT_VALIDITY_MINUTES} min. Ejecutar SPOT solo si precio <= COMPRA MÁX. y no llega cancelación. Tú decides el importe.'
        with open(PAYLOAD_PATH,"w",encoding="utf-8") as f: json.dump(payload,f,ensure_ascii=False)
        print("BUY partially revalidated:", ",".join(payload["buyAssets"]))
        return
    print("BUY send-time revalidation PASS:", ",".join(payload.get("buyAssets") or []))

if __name__=="__main__":
    if len(sys.argv)>=2 and sys.argv[1]=="revalidate":
        if len(sys.argv)<3: raise SystemExit("usage: cabal_ntfy_v2.py revalidate <latest-cabal.json>")
        revalidate(sys.argv[2])
    else:
        build()
