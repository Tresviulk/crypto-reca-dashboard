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

BUY_COOLDOWN_HOURS=12
WATCH_COOLDOWN_HOURS=6
CANCEL_WINDOW_MINUTES=20
MAX_MACHINE_AGE_MINUTES=10
ALERT_VALIDITY_MINUTES=10
MAX_BUYS_PER_PUSH=3
MAX_WATCH_PER_PUSH=3

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

def execution_valid(row):
    if row.get("decisionTier")!="BUY_NOW" or row.get("buyNowEligible") is not True:
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
    parts=[
        f'🚨 {r.get("asset")}',
        f'PLATAFORMA: {r.get("venue") or "n/a"}',
        f'CALIDAD: {fmt(r.get("qualityScore"))}/100',
        f'MOTIVO: {r.get("decisionReason") or "CONFIRMED"}',
        f'CONFIRMACIONES: {seen}/{int(r.get("requiredFreshScans") or 1)}',
        f'PRECIO AHORA: {fmt(r.get("price"))}',
        f'COMPRA MÁX.: {fmt(r.get("decisionEntryMax") or r.get("pilotEntryMax"))}',
        f'STOP: {fmt(r.get("decisionStop") or r.get("protectiveStopReference"))}',
    ]
    if r.get("_whaleConfirmed"): parts.append("WHALES: CONFIRMACIÓN POSITIVA")
    return "\n".join(parts)

def watch_card(r):
    return "\n".join([
        f'⚡ {r.get("asset")}',
        f'PLATAFORMA: {r.get("venue") or "n/a"}',
        f'CALIDAD: {fmt(r.get("qualityScore"))}/100',
        f'MOTIVO: {r.get("decisionReason") or "EARLY WATCH"}',
        f'PRECIO: {fmt(r.get("price"))}',
        f'24H: {fmt(r.get("priceChange24hPct"))}%',
        "ACCIÓN: VIGILAR. NO ES ORDEN DE COMPRA."
    ])

def build():
    now=datetime.now(timezone.utc)
    now_iso=now.isoformat().replace("+00:00","Z")
    cabal=load(CABAL_PATH,{})
    whales=load(WHALES_PATH,{})
    healthy,age,scan_ratio=machine_healthy(cabal,now)

    prev=load(STATE_PATH,{
        "lastAlertAt":{},"lastWatchAt":{},"lastCancelAt":{},
        "qualifiedSeenCount":{},"lastCabalGeneratedAt":None
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
        if x.get("decisionTier")=="WATCH" and x.get("watchEligible") is True
    ]
    watches.sort(key=lambda r:num(r.get("qualityScore")) or 0,reverse=True)

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
    if healthy and not ready_buy:
        buy_assets={str(r.get("asset") or "").upper() for r in buys}
        for key,r in active_watch.items():
            if str(r.get("asset") or "").upper() in buy_assets: continue
            if hours_since(now,last_watch.get(key))<WATCH_COOLDOWN_HOURS: continue
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
        payload={
            "title":"🟢 CABAL v2 — COMPRAR AHORA",
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
            "message":f'{names}\nLa señal anterior ya NO es válida.\nACCIÓN: NO COMPRAR. No es una orden de venta si ya ejecutaste.'
        }
    elif ready_watch:
        for r in ready_watch:
            last_watch[f'CABAL:{str(r.get("asset") or "").upper()}']=now_iso
        payload={
            "title":"🟡 CABAL v2 — VIGILAR",
            "priority":"default","kind":"WATCH","buyAssets":[],
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
        "qualifiedSeenCount":seen,
        "lastCabalGeneratedAt":scan_id,
        "health":{"healthy":healthy,"cabalGeneratedAt":cabal.get("generatedAt"),"ageMinutes":round(age,2) if age<1e8 else None,"executionScanRatio":round(scan_ratio,4)}
    }
    with open("/tmp/ntfy-alert-state.json","w",encoding="utf-8") as f:
        json.dump(state,f,ensure_ascii=False,indent=2)
    with open(PAYLOAD_PATH,"w",encoding="utf-8") as f:
        json.dump(payload,f,ensure_ascii=False)
    print(json.dumps({"healthy":healthy,"buyNow":len(buys),"watch":len(watches),"readyBuy":[r.get("asset") for r in ready_buy],"readyWatch":[r.get("asset") for r in ready_watch],"cancels":cancels,"willNotify":bool(payload)},ensure_ascii=False))

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
    valid=[]
    for asset in payload.get("buyAssets") or []:
        r=by_asset.get(asset)
        if r and execution_valid(r):
            valid.append(asset)
    if set(valid)!=set(payload.get("buyAssets") or []):
        # Do not send a partially stale multi-asset BUY. Next 5m run will rebuild cleanly.
        with open(PAYLOAD_PATH,"w",encoding="utf-8") as f: json.dump(None,f)
        print("BUY suppressed: one or more assets failed send-time revalidation")
        return
    print("BUY send-time revalidation PASS:", ",".join(valid))

if __name__=="__main__":
    if len(sys.argv)>=2 and sys.argv[1]=="revalidate":
        if len(sys.argv)<3: raise SystemExit("usage: cabal_ntfy_v2.py revalidate <latest-cabal.json>")
        revalidate(sys.argv[2])
    else:
        build()
