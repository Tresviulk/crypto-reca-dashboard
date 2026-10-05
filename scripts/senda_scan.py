#!/usr/bin/env python3
# SENDA validation trigger 2026-10-05
import json,math,os,time,statistics
from datetime import datetime,timezone
from urllib.request import Request,urlopen
from urllib.parse import urlencode

OUT="data/senda-ranking.json"; TOP=20; DEEP=70; MIN_TURN=250000
STABLE={"USDT","USDC","DAI","FDUSD","TUSD","USDE","PYUSD","USDS","FRAX","USDD","LUSD","GHO","EURC","USD1","USDG","RLUSD"}
WRAP={"WBTC","WETH","STETH","WSTETH","CBETH","RETH","WEETH"}
LEV=("UP","DOWN","BULL","BEAR","2L","2S","3L","3S","5L","5S")
TV_COLS=["close","change","change|60","change|240","volume","volume|60","volume|240"]

def n(v,d=None):
    try:
        x=float(v); return x if math.isfinite(x) else d
    except: return d

def clamp(v,a,b): return max(a,min(b,v))
def pct(a,b): return (a/b-1)*100 if a is not None and b not in (None,0) else None
def okbase(b):
    b=str(b or "").upper()
    return bool(b and b not in STABLE and b not in WRAP and not b.endswith(LEV))

def get(url,timeout=20,retries=2):
    last=None
    for i in range(retries+1):
        try:
            req=Request(url,headers={"User-Agent":"SENDA/1.0","Accept":"application/json"})
            with urlopen(req,timeout=timeout) as r: return json.loads(r.read().decode())
        except Exception as e:
            last=e
            if i<retries: time.sleep(.8*(i+1))
    raise RuntimeError(f"GET {url}: {last}")

def post(url,payload,timeout=24,retries=2):
    body=json.dumps(payload).encode(); last=None
    for i in range(retries+1):
        try:
            req=Request(url,data=body,method="POST",headers={"User-Agent":"SENDA/1.0","Content-Type":"application/json"})
            with urlopen(req,timeout=timeout) as r: return json.loads(r.read().decode())
        except Exception as e:
            last=e
            if i<retries: time.sleep(.8*(i+1))
    raise RuntimeError(f"POST {url}: {last}")

def coinbase():
    rows=get("https://api.exchange.coinbase.com/products"); out=[]
    for x in rows if isinstance(rows,list) else []:
        b=str(x.get("base_currency") or "").upper(); q=str(x.get("quote_currency") or "").upper(); p=str(x.get("id") or "")
        if q not in {"USD","USDC","USDT","EUR"} or not okbase(b): continue
        if x.get("trading_disabled") or x.get("cancel_only") or x.get("status") not in (None,"online"): continue
        out.append({"base":b,"venue":"COINBASE","pair":p,"tv":"COINBASE:"+p.replace("-","")})
    return out

def kucoin():
    j=get("https://api.kucoin.com/api/v1/market/allTickers"); out=[]
    rows=((j.get("data") or {}).get("ticker") or []) if isinstance(j,dict) else []
    for x in rows:
        p=str(x.get("symbol") or "").split("-")
        if len(p)!=2 or p[1] not in {"USDT","USDC"} or not okbase(p[0]): continue
        out.append({"base":p[0],"venue":"KUCOIN","pair":"-".join(p),"tv":"KUCOIN:"+"".join(p),
                    "price":n(x.get("last")),"c24":(n(x.get("changeRate"),0) or 0)*100,"turn":n(x.get("volValue"),0) or 0})
    return out

def tvscan(markets):
    out={}; errors=[]; tick=[x["tv"] for x in markets]
    for i in range(0,len(tick),150):
        try:
            j=post("https://scanner.tradingview.com/crypto/scan",{"symbols":{"tickers":tick[i:i+150],"query":{"types":[]}},"columns":TV_COLS})
            for r in j.get("data") or []:
                d=r.get("d") or []
                if len(d)>=7: out[r.get("s")]={"price":n(d[0]),"c24":n(d[1]),"c1":n(d[2]),"c4":n(d[3]),"vol":n(d[4]),"v1":n(d[5]),"v4":n(d[6])}
        except Exception as e: errors.append(str(e))
    return out,errors

def universe():
    errs=[]; cb=[]; kc=[]
    try: cb=coinbase()
    except Exception as e: errs.append("Coinbase: "+str(e))
    try: kc=kucoin()
    except Exception as e: errs.append("KuCoin: "+str(e))
    if not cb and not kc: raise RuntimeError("No exchange universe")
    raw=cb+kc; tv,tve=tvscan(raw); errs += ["TradingView: "+x for x in tve]
    for m in raw:
        t=tv.get(m["tv"]) or {}
        for k,v in t.items():
            if v is not None: m[k]=v
        if not m.get("turn") and m.get("price") and m.get("vol"): m["turn"]=m["price"]*m["vol"]
        m["va"]=m.get("v1")/(m.get("v4")/4) if m.get("v1") and m.get("v4") else None
    by={}
    for m in raw: by.setdefault(m["base"],[]).append(m)
    u=[]
    for b,a in by.items():
        a.sort(key=lambda x:(n(x.get("turn"),0) or 0,x["venue"]=="COINBASE"),reverse=True)
        z=dict(a[0]); z["venues"]=sorted({x["venue"] for x in a}); z["pairs"]=sorted({x["venue"]+":"+x["pair"] for x in a}); u.append(z)
    return cb,kc,raw,u,errs

def hour_metrics(m):
    bars=cb_candles(m["pair"],3600) if m["venue"]=="COINBASE" else kc_candles(m["pair"],"1hour")
    if len(bars)<14: raise RuntimeError("insufficient 1H bars "+str(len(bars)))
    last=bars[-1]; prev=bars[-2]; four=bars[-5] if len(bars)>=5 else prev
    hist=[x["v"] for x in bars[-13:-1] if x["v"]>0]
    med=statistics.median(hist) if hist else None
    m["c1"]=pct(last["c"],prev["c"]) or 0
    m["c4"]=pct(last["c"],four["c"]) or 0
    m["va"]=last["v"]/med if med and med>0 else None
    if not m.get("price"): m["price"]=last["c"]
    return m

def broad(m,b1,b4):
    c1=n(m.get("c1"),0) or 0; c4=n(m.get("c4"),0) or 0; c24=n(m.get("c24"),0) or 0; va=n(m.get("va"),1) or 1; turn=n(m.get("turn"),0) or 0
    s=clamp(c1*7,-8,28)+clamp(c4*2.2,-8,24)+clamp((va-1)*18,-5,24)+clamp((c1-b1)*3.5,-6,12)+clamp((c4-b4)*1.2,-5,10)+clamp(math.log10(max(turn,1))-5.4,0,4)*2.5
    if c1>5:s-=(c1-5)*5
    if c4>10:s-=(c4-10)*3
    if c24>25:s-=(c24-25)*1.3
    if c1<-2 or c4<-5:s-=15
    return round(s,2)

def cb_candles(pair,g):
    rows=get("https://api.exchange.coinbase.com/products/"+pair+"/candles?"+urlencode({"granularity":g}),retries=1); out=[]; now=int(time.time())
    for r in rows if isinstance(rows,list) else []:
        if isinstance(r,list) and len(r)>=6 and int(r[0])+int(g)<=now: out.append({"t":int(r[0]),"l":n(r[1]),"h":n(r[2]),"o":n(r[3]),"c":n(r[4]),"v":n(r[5])})
    out=[x for x in out if None not in (x["l"],x["h"],x["o"],x["c"],x["v"])]; out.sort(key=lambda x:x["t"]); return out[-220:]

def kc_candles(pair,t):
    j=get("https://api.kucoin.com/api/v1/market/candles?"+urlencode({"symbol":pair,"type":t}),retries=1); rows=(j.get("data") or []) if isinstance(j,dict) else []; out=[]; now=int(time.time())
    sec={"1hour":3600,"4hour":14400,"1day":86400}[t]
    for r in rows:
        if isinstance(r,list) and len(r)>=6 and int(float(r[0]))+sec<=now: out.append({"t":int(float(r[0])),"o":n(r[1]),"c":n(r[2]),"h":n(r[3]),"l":n(r[4]),"v":n(r[5])})
    out=[x for x in out if None not in (x["l"],x["h"],x["o"],x["c"],x["v"])]; out.sort(key=lambda x:x["t"]); return out[-220:]

def candles(m):
    return (cb_candles(m["pair"],14400),cb_candles(m["pair"],86400)) if m["venue"]=="COINBASE" else (kc_candles(m["pair"],"4hour"),kc_candles(m["pair"],"1day"))

def ema(v,p):
    if len(v)<p:return None
    e=statistics.mean(v[:p]); k=2/(p+1)
    for x in v[p:]: e=x*k+e*(1-k)
    return e

def rsi(v,p=14):
    if len(v)<=p:return None
    g=[]; l=[]
    for a,b in zip(v[-p-1:-1],v[-p:]):
        d=b-a; g.append(max(d,0)); l.append(max(-d,0))
    ag,al=statistics.mean(g),statistics.mean(l)
    return 100 if al==0 else 100-100/(1+ag/al)

def atr(b,p=14):
    if len(b)<=p:return None
    tr=[max(b[i]["h"]-b[i]["l"],abs(b[i]["h"]-b[i-1]["c"]),abs(b[i]["l"]-b[i-1]["c"])) for i in range(1,len(b))]
    return statistics.mean(tr[-p:])

def adx(b,p=14):
    if len(b)<p*2+1:return None
    tr=[]; pd=[]; md=[]
    for i in range(1,len(b)):
        up=b[i]["h"]-b[i-1]["h"]; dn=b[i-1]["l"]-b[i]["l"]
        pd.append(up if up>dn and up>0 else 0); md.append(dn if dn>up and dn>0 else 0)
        tr.append(max(b[i]["h"]-b[i]["l"],abs(b[i]["h"]-b[i-1]["c"]),abs(b[i]["l"]-b[i-1]["c"])))
    dx=[]
    for i in range(p-1,len(tr)):
        s=sum(tr[i-p+1:i+1])
        if s<=0:continue
        pi=100*sum(pd[i-p+1:i+1])/s; mi=100*sum(md[i-p+1:i+1])/s; den=pi+mi
        if den:dx.append(100*abs(pi-mi)/den)
    return statistics.mean(dx[-p:]) if len(dx)>=p else None

def ichi(b):
    if len(b)<52:return None
    mid=lambda q:(max(x["h"] for x in b[-q:])+min(x["l"] for x in b[-q:]))/2
    t=mid(9); k=mid(26); return {"t":t,"k":k,"a":(t+k)/2,"b":mid(52)}

def supertrend(b,p=10,m=3):
    if len(b)<p+3:return None
    up=True; fu=fl=None
    for i in range(p,len(b)):
        a=atr(b[:i+1],p)
        if a is None:continue
        h=(b[i]["h"]+b[i]["l"])/2; bu=h+m*a; bl=h-m*a
        if fu is None: fu,fl=bu,bl
        else:
            pc=b[i-1]["c"]; fu=bu if bu<fu or pc>fu else fu; fl=bl if bl>fl or pc<fl else fl
        c=b[i]["c"]
        if up and c<fl: up=False
        elif not up and c>fu: up=True
    return up

def features(b):
    if len(b)<60: raise RuntimeError("insufficient bars "+str(len(b)))
    c=[x["c"] for x in b]; return {"close":c[-1],"rsi":rsi(c),"adx":adx(b),"ichi":ichi(b),"st":supertrend(b),"ema20":ema(c,20),"ema50":ema(c,50)}

def analyze(m):
    b4,bd=candles(m); f4,fd=features(b4),features(bd); px=n(m.get("price")) or f4["close"]; s=25+clamp(m["broad"],-20,40)*.25; reasons=[]; penalties=[]
    for lab,f,w in (("4H",f4,1),("1D",fd,1.15)):
        ic=f["ichi"]; top=max(ic["a"],ic["b"]); bot=min(ic["a"],ic["b"])
        if f["close"]>top:s+=7*w;reasons.append(lab+" above cloud")
        elif f["close"]<bot:s-=7*w;penalties.append(lab+" below cloud")
        if f["close"]>ic["k"] and ic["t"]>=ic["k"]:s+=3*w;reasons.append(lab+" Tenkan/Kijun bullish")
        if f["st"]:s+=6*w;reasons.append(lab+" Supertrend bullish")
        else:s-=6*w;penalties.append(lab+" Supertrend bearish")
        if f["adx"] is not None and 18<=f["adx"]<=40:s+=4*w;reasons.append(lab+f" ADX {f['adx']:.1f}")
        elif f["adx"] is not None and f["adx"]>55:s-=3*w;penalties.append(lab+" ADX overheated")
    if f4["rsi"] is not None and 50<=f4["rsi"]<=68:s+=4;reasons.append("4H RSI constructive")
    elif f4["rsi"] is not None and f4["rsi"]>74:s-=8;penalties.append("4H RSI extended")
    if fd["rsi"] is not None and 48<=fd["rsi"]<=66:s+=3;reasons.append("1D RSI constructive")
    elif fd["rsi"] is not None and fd["rsi"]>74:s-=7;penalties.append("1D RSI extended")
    c1=n(m.get("c1"),0) or 0;c4=n(m.get("c4"),0) or 0;c24=n(m.get("c24"),0) or 0;va=n(m.get("va"),1) or 1;nochase=False
    if .2<=c1<=3.5:s+=3;reasons.append("early 1H momentum")
    if .5<=c4<=8:s+=3;reasons.append("controlled 4H momentum")
    if va>=1.35:s+=min(5,(va-1)*4);reasons.append(f"volume acceleration {va:.2f}x")
    if c1>6:s-=(c1-6)*5;nochase=True;penalties.append(f"1H already {c1:.1f}%")
    if c4>12:s-=(c4-12)*3;nochase=True;penalties.append(f"4H already {c4:.1f}%")
    if c24>25:s-=(c24-25)*1.5;nochase=True;penalties.append(f"24H already {c24:.1f}%")
    dk=pct(px,f4["ichi"]["k"])
    if dk is not None and dk>10:s-=min(12,(dk-10)*1.4);nochase=True;penalties.append(f"{dk:.1f}% above 4H Kijun")
    if nochase:s-=15
    s=round(clamp(s,0,100),1); trend=f4["st"] and fd["st"]; cloud=px>max(f4["ichi"]["a"],f4["ichi"]["b"])
    state="BUY" if s>=78 and trend and cloud and not nochase else ("NEAR BUY" if s>=66 and not nochase else "WATCH")
    return {"asset":m["base"],"venue":m["venue"],"pair":m["pair"],"availableVenues":m["venues"],"availablePairs":m["pairs"],"state":state,"score":s,"price":px,
            "change1hPct":n(m.get("c1")),"change4hPct":n(m.get("c4")),"change24hPct":n(m.get("c24")),"turnover24hUsdApprox":n(m.get("turn")),"volumeAcceleration":n(m.get("va")),"noChase":nochase,
            "technical":{"4h":{"rsi14":round(f4["rsi"],2) if f4["rsi"] is not None else None,"adx14":round(f4["adx"],2) if f4["adx"] is not None else None,"supertrendUp":f4["st"],"aboveCloud":f4["close"]>max(f4["ichi"]["a"],f4["ichi"]["b"])},
                         "1d":{"rsi14":round(fd["rsi"],2) if fd["rsi"] is not None else None,"adx14":round(fd["adx"],2) if fd["adx"] is not None else None,"supertrendUp":fd["st"],"aboveCloud":fd["close"]>max(fd["ichi"]["a"],fd["ichi"]["b"])}},
            "reasons":reasons[:6],"penalties":penalties[:4],"broadScore":m["broad"]}

def main():
    start=time.time(); cb,kc,raw,u,errs=universe(); liquid=[]; hour_errors=[]
    for m in u:
        if (n(m.get("turn"),0) or 0)<MIN_TURN:continue
        try: liquid.append(hour_metrics(m))
        except Exception as e: hour_errors.append({"asset":m["base"],"venue":m["venue"],"error":str(e)})
        time.sleep(.10)
    btc=next((x for x in liquid if x["base"]=="BTC"),{})
    b1=n(btc.get("c1"),0) or 0;b4=n(btc.get("c4"),0) or 0; eligible=[]
    for m in liquid:
        m["broad"]=broad(m,b1,b4);eligible.append(m)
    eligible.sort(key=lambda x:x["broad"],reverse=True); deep=eligible[:DEEP]; ranked=[]; de=[]
    for m in deep:
        try:ranked.append(analyze(m))
        except Exception as e:de.append({"asset":m["base"],"venue":m["venue"],"error":str(e)})
        time.sleep(.06)
    ranked.sort(key=lambda x:x["score"],reverse=True); top=ranked[:TOP]
    for i,x in enumerate(top,1):x["rank"]=i
    p={"system":"SENDA","version":"SENDA_1.0_FULL_CB_KC_TOP20","generatedAt":datetime.now(timezone.utc).isoformat(),"mode":"FULL_COINBASE_KUCOIN_DYNAMIC_TOP20","manualTradingOnly":True,
       "coverage":{"coinbasePairsDiscovered":len(cb),"kucoinPairsDiscovered":len(kc),"rawPairs":len(raw),"uniqueAssets":len(u),"liquidEligibleAssets":len(eligible),"deepCandidatesRequested":len(deep),"deepCandidatesAnalyzed":len(ranked),"topN":len(top),"minTurnoverUsdApprox":MIN_TURN},
       "statusCounts":{"BUY":sum(x["state"]=="BUY" for x in top),"NEAR BUY":sum(x["state"]=="NEAR BUY" for x in top),"WATCH":sum(x["state"]=="WATCH" for x in top)},
       "ranking":top,"errors":{"sources":errs,"hourly":hour_errors[:25],"deep":de[:25]},"elapsedSeconds":round(time.time()-start,2),
       "notes":["Every run rebuilds the ranking from the current Coinbase + KuCoin universe.","Only the dynamic TOP-20 is surfaced.","SENDA never trades automatically."]}
    os.makedirs("data",exist_ok=True);json.dump(p,open(OUT,"w",encoding="utf-8"),indent=2,ensure_ascii=False)
    print(json.dumps({"ok":True,"coverage":p["coverage"],"statusCounts":p["statusCounts"],"top":[{"rank":x["rank"],"asset":x["asset"],"state":x["state"],"score":x["score"],"venue":x["venue"]} for x in top]},ensure_ascii=False))

if __name__=="__main__":main()
