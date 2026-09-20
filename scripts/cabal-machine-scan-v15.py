#!/usr/bin/env python3
"""
CABAL Independent Machine Discovery v1.5 — true PRE-STAGE-A universe patch.

Key guarantees:
- Main CABAL discovery remains intact (roughly 15M-3B market cap, >=2M 24h volume).
- PRE-ACCUM is additive and uses its OWN >=250k USD-equivalent broad spot universe.
- The 250k-2M turnover band is explicitly counted and inspected.
- PRE-ACCUM deep-lite is capped at 10, with >=6 sub-2M slots when enough qualify.
- PRE-ACCUM candidates are emitted separately, so top-30 Stage-A retention cannot hide them.
- Bybit + KuCoin are preferred venues; Gate is a public fallback.
- Manual execution only. This scanner never trades.
"""
import json, os, statistics, time, math
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from urllib.parse import urlencode
from urllib.request import Request, urlopen

OUT=os.environ.get('CABAL_OUT','data/cabal-machine.json')
UA='CABAL-Discovery-Guard/1.5'
SCHEMA='1.5'
RETENTION_LIMIT=30
PREACCUM_LIMIT=10
PREACCUM_SUB2M_RESERVE=6
MAIN_MIN_TURNOVER=2_000_000
PRE_MIN_TURNOVER=250_000
MAX_BROAD=1200
CORE_ALWAYS_SCAN={'AVAX','ETH','SOL'}

STABLES={'usdt','usdc','dai','fdusd','tusd','usde','usds','pyusd','usdd','frax','crvusd','gho','usd1','usdp','gusd','usdt0','usd0','usdb'}
WRAPPED=('wbtc','weth','wsteth','steth','cbeth','reth','weeth','ezeth','solvbtc','wavax','wsol','wmatic')
LEVERAGED_SUFFIXES=('3l','3s','5l','5s','2l','2s','bull','bear','up','down')
TOKENIZED_HINTS=('xstock','tokenized stock','tokenized equity','tokenized etf','ondo tokenized','stock token')


def get(url,timeout=20,retries=2):
    last=None
    for i in range(retries+1):
        try:
            with urlopen(Request(url,headers={'User-Agent':UA,'Accept':'application/json'}),timeout=timeout) as r:
                return json.loads(r.read().decode())
        except Exception as e:
            last=e
            if i<retries: time.sleep(.7*(i+1))
    raise last


def pct(a,b):
    return ((a/b)-1)*100 if a is not None and b not in (None,0) else 0.0


def med_pos(xs,min_count=1):
    ys=[]
    for x in xs:
        try:
            v=float(x)
            if v>0 and math.isfinite(v): ys.append(v)
        except Exception:
            pass
    if len(ys)<min_count: return None
    return statistics.median(ys)


def is_noise_asset(m):
    s=str(m.get('symbol') or '').lower().strip()
    name=str(m.get('name') or '').lower()
    if not s or s in STABLES or s.startswith(WRAPPED): return True
    if any(h in name for h in TOKENIZED_HINTS): return True
    if s.endswith(LEVERAGED_SUFFIXES): return True
    return False


def fetch_coingecko():
    rows=[]
    for page in range(1,7):
        q=urlencode({'vs_currency':'usd','order':'market_cap_desc','per_page':'250','page':page,'sparkline':'false','price_change_percentage':'1h,24h,7d'})
        rows += get('https://api.coingecko.com/api/v3/coins/markets?'+q,20,2)
        time.sleep(.35)
    return rows


def fetch_bybit_pairs():
    d=get('https://api.bybit.com/v5/market/tickers?category=spot',20,2)
    out={}
    for x in ((d.get('result') or {}).get('list') or []):
        sym=str(x.get('symbol') or '')
        if not sym.endswith('USDT'): continue
        base=sym[:-4].upper()
        try: turn=float(x.get('turnover24h') or 0)
        except: turn=0.0
        out[base]={'symbol':sym,'turnover':turn}
    return out


def fetch_kucoin_pairs():
    d=get('https://api.kucoin.com/api/v1/market/allTickers',20,2)
    out={}
    for x in ((d.get('data') or {}).get('ticker') or []):
        sym=str(x.get('symbol') or '')
        if not sym.endswith('-USDT'): continue
        base=sym[:-5].upper()
        try: turn=float(x.get('volValue') or 0)
        except: turn=0.0
        out[base]={'symbol':sym,'turnover':turn}
    return out


def fetch_gate_pairs():
    rows=get('https://api.gateio.ws/api/v4/spot/tickers',20,2)
    out={}
    for x in rows if isinstance(rows,list) else []:
        pair=str(x.get('currency_pair') or '')
        if not pair.endswith('_USDT'): continue
        base=pair[:-5].upper()
        try: turn=float(x.get('quote_volume') or 0)
        except: turn=0.0
        out[base]={'symbol':pair,'turnover':turn}
    return out


def bybit_1h(symbol,limit=180):
    q=urlencode({'category':'spot','symbol':symbol,'interval':'60','limit':str(min(limit,200))})
    d=get('https://api.bybit.com/v5/market/kline?'+q,15,2)
    rows=((d.get('result') or {}).get('list') or [])
    now=int(time.time()*1000); bars=[]
    for r in rows:
        if not isinstance(r,list) or len(r)<6: continue
        t=int(r[0])
        if t+3600000>now: continue
        bars.append({'t':t,'o':float(r[1]),'h':float(r[2]),'l':float(r[3]),'c':float(r[4]),'v':float(r[5])})
    bars.sort(key=lambda x:x['t'])
    if len(bars)<30: raise RuntimeError('insufficient completed Bybit 1h bars')
    return bars


def kucoin_1h(symbol,limit=180):
    d=get('https://api.kucoin.com/api/v1/market/candles?'+urlencode({'type':'1hour','symbol':symbol}),15,2)
    rows=d.get('data') or []
    now=int(time.time()); bars=[]
    for r in rows[:max(limit+3,183)]:
        if not isinstance(r,list) or len(r)<6: continue
        t=int(float(r[0]))
        if t+3600>now: continue
        bars.append({'t':t*1000,'o':float(r[1]),'c':float(r[2]),'h':float(r[3]),'l':float(r[4]),'v':float(r[5])})
    bars.sort(key=lambda x:x['t'])
    if len(bars)>limit: bars=bars[-limit:]
    if len(bars)<30: raise RuntimeError('insufficient completed KuCoin 1h bars')
    return bars


def gate_1h(symbol,limit=180):
    q=urlencode({'currency_pair':symbol,'interval':'1h','limit':str(limit)})
    rows=get('https://api.gateio.ws/api/v4/spot/candlesticks?'+q,15,2)
    now=int(time.time()); bars=[]
    for r in rows if isinstance(rows,list) else []:
        if not isinstance(r,list) or len(r)<6: continue
        t=int(float(r[0]))
        if t+3600>now: continue
        bars.append({'t':t*1000,'o':float(r[5]),'h':float(r[3]),'l':float(r[4]),'c':float(r[2]),'v':float(r[1])})
    bars.sort(key=lambda x:x['t'])
    if len(bars)<30: raise RuntimeError('insufficient completed Gate 1h bars')
    return bars


def candles_for(asset,venues,limit=180):
    errs=[]
    if asset in venues['bybit']:
        try: return bybit_1h(venues['bybit'][asset]['symbol'],limit),'Bybit Spot'
        except Exception as e: errs.append('Bybit:'+str(e))
    if asset in venues['kucoin']:
        try: return kucoin_1h(venues['kucoin'][asset]['symbol'],limit),'KuCoin Spot'
        except Exception as e: errs.append('KuCoin:'+str(e))
    if asset in venues['gate']:
        try: return gate_1h(venues['gate'][asset]['symbol'],limit),'Gate Spot'
        except Exception as e: errs.append('Gate:'+str(e))
    raise RuntimeError('OHLCV unavailable; '+'; '.join(errs[:3]))


def rvols(bars):
    hist=[x['v'] for x in bars[-21:-1]]
    m1=med_pos(hist,12)
    blocks=[sum(x['v'] for x in bars[i:i+4]) for i in range(max(0,len(bars)-44),len(bars)-4,4)]
    m4=med_pos(blocks,6)
    if m1 is None or m4 is None: raise RuntimeError('unreliable sparse volume history')
    r1=bars[-1]['v']/m1
    r4=sum(x['v'] for x in bars[-4:])/m4
    if not math.isfinite(r1) or not math.isfinite(r4): raise RuntimeError('invalid RVOL')
    return min(r1,50.0),min(r4,50.0)


def metrics_from_bars(b,m,btc):
    z=b[-1]
    p1=pct(z['c'],b[-2]['c']); p4=pct(z['c'],b[-5]['c']); p6=pct(z['c'],b[-7]['c'])
    p24=pct(z['c'],b[-25]['c']) if len(b)>=25 else float(m.get('price_change_percentage_24h') or 0)
    p72=pct(z['c'],b[-73]['c']) if len(b)>=73 else None
    p7=float(m.get('price_change_percentage_7d_in_currency') or 0)
    r1,r4=rvols(b)
    base=b[-13:-1]
    bh=max(x['h'] for x in base); bl=min(x['l'] for x in base); br=pct(bh,bl) if bl>0 else None
    recent6=b[-7:-1]; baseline=b[-31:-7] if len(b)>=31 else b[:-7]
    rv=med_pos([x['v'] for x in recent6],4); bv=med_pos([x['v'] for x in baseline],8)
    vb=(rv/bv) if rv and bv else None
    h6=max(x['h'] for x in b[-7:-1]); h24=max(x['h'] for x in b[-24:])
    breakout=z['c']>h6*1.002
    reclaim=z['c']>h6*.998 and b[-2]['c']<=h6
    rs1=p1-btc['p1']; rs4=p4-btc['p4']
    mc=float(m.get('market_cap') or 0); turn=float(m.get('effectiveTurnover') or m.get('total_volume') or 0)
    ratio=turn/mc if mc>0 else None
    near_high=z['c']>=bh*.97
    constructive6=p6>=.25
    not_vertical=p1<5 and p4<10 and p24<25
    interest=(r1>=1.15 or (vb is not None and vb>=1.20) or (ratio is not None and ratio>=.04) or rs1>=.20)
    watch=bool(br is not None and br<=12 and not_vertical and (near_high or constructive6) and interest)
    trigger=bool(watch and r1>=1.35 and z['c']>=bh*.99 and p1>=.15)
    support=min(x['l'] for x in b[-6:]); invalidation=support*.997; no_chase=h24*1.01
    return dict(price=z['c'],p1=p1,p4=p4,p6=p6,p24=p24,p72=p72,p7=p7,r1=r1,r4=r4,baseHigh=bh,baseLow=bl,baseRange=br,volumeBuild=vb,breakout=breakout,reclaim=reclaim,rs1=rs1,rs4=rs4,turnRatio=ratio,watch=watch,trigger=trigger,support=support,invalidation=invalidation,noChase=no_chase)


def second_leg(b,met):
    sw=st=False; t0=None
    if len(b)>=72:
        best=(-999,None)
        for i in range(max(24,len(b)-168),max(24,len(b)-8)):
            mv=pct(b[i]['c'],b[i-24]['c'])
            if mv>best[0]: best=(mv,i)
        leg,le=best
        if le and leg>=12 and len(b)-le>=4:
            cons=b[le+1:-1]
            if len(cons)>=4:
                ch=max(x['h'] for x in cons); cl=min(x['l'] for x in cons)
                lv=med_pos([x['v'] for x in b[max(0,le-8):le+1]],4); cv=med_pos([x['v'] for x in cons],3)
                cooled=bool(lv and cv and cv<=lv*.85)
                reset=pct(ch,cl)<=14 and b[-1]['c']<=cl*1.14
                renewed=met['r1']>=1.25 or met['r4']>=1.15 or met['rs1']>=1.2
                sw=cooled and reset and b[-1]['c']>=ch*.985
                st=cooled and reset and renewed and b[-1]['c']>ch*1.002
                if st: t0=b[-1]['t']
    return sw,st,t0


def result_from_bars(asset,m,b,venue,btc,pre_lane=False):
    met=metrics_from_bars(b,m,btc)
    sw,st,t0=second_leg(b,met)
    A=met['p1']>=1.2 or met['p4']>=3.0
    B=met['r1']>=1.45 or met['r4']>=1.35
    C=(met['breakout'] or met['reclaim']) and (met['r1']>=1.15 or met['rs1']>=1.0 or met['rs4']>=2.0)
    poor=(met['r1']>=1.8 or met['r4']>=1.6) and met['p4']<1.0 and met['p1']<.25 and not met['breakout'] and not met['reclaim'] and not met['watch']
    if met['r1']>=2.5 and poor: vs='CHURN-DISTRIBUTION'
    elif met['r1']>=2.2 and met['r4']<1.15: vs='ONE-OFF SHOCK'
    elif met['r1']>=1.35 and met['r4']>=1.15: vs='VOLUME ACCELERATING'
    elif met['r1']<.8 and met['r4']<.9: vs='VOLUME DECELERATING'
    else: vs='VOLUME HIGH' if max(met['r1'],met['r4'])>=1.25 else 'VOLUME DECELERATING'
    if st: cls='SECOND-LEG TRIGGER'
    elif sw: cls='SECOND-LEG WATCH'
    elif met['trigger']: cls='PRE-ACCUMULATION TRIGGER'
    elif met['watch']: cls='PRE-ACCUMULATION WATCH'
    elif poor: cls='CHURN-DISTRIBUTION RISK'
    elif met['p24']>=35: cls='LATE-POST-PUMP'
    elif C and met['p24']<18 and met['p4']<8: cls='EARLY STARTER'
    elif B and met['p24']<12 and met['p4']<5: cls='PRE-MOVE'
    elif A and met['p24']<25: cls='EARLY-MOVE'
    elif A or B or C or sw or st: cls='MID-MOVE'
    else: cls='NO SETUP'
    headroom=pct(met['noChase'],met['price'])
    score=max(met['p1'],0)*2+max(met['p4'],0)*.8+min(max(met['r1']-1,0),8)*5+min(max(met['r4']-1,0),8)*4+min(max(met['rs1'],0),8)*1.5+(5 if C else 0)+(8 if st else 0)+(10 if met['watch'] else 0)+(10 if met['trigger'] else 0)
    return {'asset':asset,'name':m.get('name'),'venue':venue,'price':met['price'],'marketCap':m.get('market_cap'),'volume24h':m.get('effectiveTurnover'),'coinGeckoVolume24h':m.get('total_volume'),'priceChange1hPct':round(met['p1'],4),'priceChange4hPct':round(met['p4'],4),'priceChange6hPct':round(met['p6'],4),'priceChange24hPct':round(met['p24'],4),'priceChange72hPct':round(met['p72'],4) if met['p72'] is not None else None,'priceChange7dPct':round(met['p7'],4),'rvol1h':round(met['r1'],4),'rvol4h':round(met['r4'],4),'preAccumVolumeBuild6h':round(met['volumeBuild'],4) if met['volumeBuild'] is not None else None,'preAccumBaseRange12hPct':round(met['baseRange'],4) if met['baseRange'] is not None else None,'preAccumBaseHigh':met['baseHigh'],'preAccumBaseLow':met['baseLow'],'relativeStrength1hVsBTC':round(met['rs1'],4),'relativeStrength4hVsBTC':round(met['rs4'],4),'turnoverToMarketCap':round(met['turnRatio'],6) if met['turnRatio'] is not None else None,'breakout6h':met['breakout'],'reclaim6h':met['reclaim'],'support':met['support'],'invalidation':met['invalidation'],'preAccumTriggerLevel':met['baseHigh'],'noChase':met['noChase'],'preAccumWatch':met['watch'],'preAccumTrigger':met['trigger'],'bucketA':A,'bucketB':B,'bucketC':C,'bucketE':bool(sw or st),'secondLegWatch':sw,'secondLegTrigger':st,'secondLegT0':t0,'classification':cls,'stageAScore':round(score,4),'volumeState':vs,'effortVsResult':'POOR' if poor else ('EFFICIENT' if met['p4']>=2 and met['r4']>=1.1 else ('CONSTRUCTIVE' if met['watch'] else 'NEUTRAL')),'noChaseHeadroomPct':round(headroom,4),'preStageA':bool(pre_lane),'executionSignal':'WAIT_CONFIRMATION' if cls in {'PRE-ACCUMULATION TRIGGER','PRE-MOVE','EARLY STARTER','SECOND-LEG TRIGGER'} else 'OBSERVE','decisionUrgency':'HIGH' if cls in {'PRE-ACCUMULATION TRIGGER','EARLY-MOVE','EARLY STARTER','SECOND-LEG TRIGGER'} else 'NORMAL'}


def choose_effective_turnover(asset,m,venues):
    vals=[float(m.get('total_volume') or 0)]
    for v in ('bybit','kucoin','gate'):
        if asset in venues[v]: vals.append(float(venues[v][asset].get('turnover') or 0))
    return max(vals) if vals else 0.0


def pre_rank(m):
    turn=float(m.get('effectiveTurnover') or 0); mc=float(m.get('market_cap') or 0); p1=float(m.get('price_change_percentage_1h_in_currency') or 0); p24=float(m.get('price_change_percentage_24h_in_currency') or 0)
    ratio=turn/mc if mc>0 else 0
    return ratio*120 + math.log10(max(turn,1))*1.5 + max(min(p1,4),-1)*2 + max(min(p24,12),-3)*.15


def build_pre_shortlist(broad):
    viable=[]
    for m in broad:
        p1=float(m.get('price_change_percentage_1h_in_currency') or 0); p24=float(m.get('price_change_percentage_24h_in_currency') or 0)
        if p1>=5 or p24>=25: continue
        m=dict(m); m['_preRank']=pre_rank(m); viable.append(m)
    sub=sorted([m for m in viable if float(m.get('effectiveTurnover') or 0)<MAIN_MIN_TURNOVER],key=lambda x:x['_preRank'],reverse=True)
    out=[]; seen=set(); reserve=min(PREACCUM_SUB2M_RESERVE,len(sub))
    for m in sub[:reserve]: out.append(m); seen.add(m['symbol'].upper())
    for m in sorted(viable,key=lambda x:x['_preRank'],reverse=True):
        if len(out)>=PREACCUM_LIMIT: break
        a=m['symbol'].upper()
        if a in seen: continue
        out.append(m); seen.add(a)
    return out


def select_retained(stage,limit=RETENTION_LIMIT):
    selected=[]; seen=set()
    def take(items,n):
        added=0
        for x in sorted(items,key=lambda y:y['stageAScore'],reverse=True):
            if len(selected)>=limit or added>=n: break
            if x['asset'] in seen: continue
            selected.append(x); seen.add(x['asset']); added+=1
    # CORE assets can never be crowded out by Stage-A ranking.
    take([x for x in stage if x.get('asset') in CORE_ALWAYS_SCAN],len(CORE_ALWAYS_SCAN))
    take([x for x in stage if x.get('preAccumTrigger') or x.get('preAccumWatch')],8)
    take([x for x in stage if x.get('secondLegTrigger') or x.get('secondLegWatch')],4)
    take([x for x in stage if x.get('classification') in {'PRE-MOVE','EARLY STARTER','EARLY-MOVE'}],8)
    take(stage,limit)
    return selected[:limit]


def merge_lifecycle(current,now):
    try: prev=json.load(open(OUT,encoding='utf-8')) if os.path.exists(OUT) else {}
    except Exception: prev={}
    old={x.get('asset'):x for x in (prev.get('preAccumLifecycle') or []) if x.get('asset')}
    new=[]
    for x in current:
        if not (x.get('preAccumWatch') or x.get('preAccumTrigger')): continue
        p=old.get(x['asset']); item={'asset':x['asset'],'status':'TRIGGER' if x.get('preAccumTrigger') else 'WATCH','lastSeenAt':now,'lastPrice':x.get('price'),'support':x.get('support'),'invalidation':x.get('invalidation'),'triggerLevel':x.get('preAccumTriggerLevel')}
        if p:
            for k in ('firstDetectionAt','firstDetectionPrice','firstTurnover24h','firstMarketCap','firstTurnoverToMarketCap','firstBaseRange12hPct','firstSupport','firstInvalidation','firstTriggerLevel'):
                if k in p: item[k]=p[k]
        else:
            item.update({'firstDetectionAt':now,'firstDetectionPrice':x.get('price'),'firstTurnover24h':x.get('volume24h'),'firstMarketCap':x.get('marketCap'),'firstTurnoverToMarketCap':x.get('turnoverToMarketCap'),'firstBaseRange12hPct':x.get('preAccumBaseRange12hPct'),'firstSupport':x.get('support'),'firstInvalidation':x.get('invalidation'),'firstTriggerLevel':x.get('preAccumTriggerLevel')})
        new.append(item)
    return new


def main():
    now=datetime.now(timezone.utc).isoformat().replace('+00:00','Z')
    src={'coinGecko':'FAIL','bybitSpot':'FAIL','kucoinSpot':'FAIL','gateSpot':'FAIL'}; errors=[]
    try: mk=fetch_coingecko(); src['coinGecko']='PASS'
    except Exception as e: mk=[]; errors.append('CoinGecko: '+repr(e))
    venues={'bybit':{},'kucoin':{},'gate':{}}
    for key,fn,label in [('bybit',fetch_bybit_pairs,'bybitSpot'),('kucoin',fetch_kucoin_pairs,'kucoinSpot'),('gate',fetch_gate_pairs,'gateSpot')]:
        try: venues[key]=fn(); src[label]='PASS'
        except Exception as e: errors.append(label+': '+repr(e))
    dedup=[]; seen=set()
    for m in mk:
        if is_noise_asset(m): continue
        a=str(m.get('symbol') or '').upper()
        if not a or a in seen: continue
        if not any(a in venues[v] for v in venues): continue
        m=dict(m); m['effectiveTurnover']=choose_effective_turnover(a,m,venues)
        if m['effectiveTurnover']<PRE_MIN_TURNOVER and not m.get('_tailMomentumReserve'): continue
        seen.add(a); dedup.append(m)
    dedup.sort(key=lambda x:float(x.get('effectiveTurnover') or 0),reverse=True)
    broad=dedup[:MAX_BROAD]
    sub2=[m for m in broad if PRE_MIN_TURNOVER<=float(m.get('effectiveTurnover') or 0)<MAIN_MIN_TURNOVER]
    main=[
        m for m in broad
        if (
            (
                15_000_000<=float(m.get('market_cap') or 0)<=3_000_000_000
                and float(m.get('effectiveTurnover') or 0)>=MAIN_MIN_TURNOVER
            )
            or str(m.get('symbol') or '').upper() in CORE_ALWAYS_SCAN
        )
    ]
    btc=None
    try:
        b,venue=candles_for('BTC',venues,180); btc={'venue':venue,'price':b[-1]['c'],'p1':pct(b[-1]['c'],b[-2]['c']),'p4':pct(b[-1]['c'],b[-5]['c']),'timestamp':b[-1]['t']}
    except Exception as e: errors.append('BTC reference: '+repr(e))
    pre_short=build_pre_shortlist(broad); pre_res=[]; pre_fails=[]
    if btc:
        with ThreadPoolExecutor(max_workers=5) as ex:
            fs={ex.submit(candles_for,m['symbol'].upper(),venues,180):m for m in pre_short}
            for f in as_completed(fs):
                m=fs[f]; a=m['symbol'].upper()
                try: b,venue=f.result(); pre_res.append(result_from_bars(a,m,b,venue,btc,True))
                except Exception as e: pre_fails.append({'asset':a,'error':str(e)[:180]})
    pre_res.sort(key=lambda x:(1 if x.get('preAccumTrigger') else 0,1 if x.get('preAccumWatch') else 0,x.get('stageAScore',0)),reverse=True)
    main_res=[]; main_fails=[]
    if btc:
        with ThreadPoolExecutor(max_workers=6) as ex:
            fs={ex.submit(candles_for,m['symbol'].upper(),venues,168):m for m in main}
            for f in as_completed(fs):
                m=fs[f]; a=m['symbol'].upper()
                try: b,venue=f.result(); main_res.append(result_from_bars(a,m,b,venue,btc,False))
                except Exception as e: main_fails.append({'asset':a,'error':str(e)[:180]})
    main_res.sort(key=lambda x:x['stageAScore'],reverse=True)
    stage=[x for x in main_res if x['bucketA'] or x['bucketB'] or x['bucketC'] or x['bucketE'] or x.get('preAccumWatch') or x.get('asset') in CORE_ALWAYS_SCAN]
    retained=select_retained(stage)
    # Execution candidates are independent from Stage-A top-30 retention.
    # A fresh 15m WATCH/TRIGGER or PILOT must never disappear merely because
    # another asset has a higher general Stage-A score.
    execution_candidates=[
        x for x in main_res
        if x.get('fastPumpWatch') or x.get('fastPumpTrigger')
        or x.get('pilotEntryEligible')
        or x.get('executionSignal')=='PILOT_ENTRY_WINDOW'
    ]
    execution_candidates.sort(
        key=lambda x:(
            bool(x.get('pilotEntryEligible')),
            bool(x.get('fastPumpTrigger')),
            f(x.get('intrahourMovePct')) if 'f' in globals() else float(x.get('intrahourMovePct') or 0),
            float(x.get('stageAScore') or 0)
        ),
        reverse=True
    )
    core_candidates=[x for x in main_res if x.get('asset') in CORE_ALWAYS_SCAN]
    core_present={x.get('asset') for x in core_candidates}
    core_missing=sorted(CORE_ALWAYS_SCAN-core_present)
    broad_count=len(broad); main_count=len(main); sub_count=len(sub2)
    main_ratio=len(main_res)/main_count if main_count else 0; pre_ratio=len(pre_res)/len(pre_short) if pre_short else 1
    venue_ok=(src['bybitSpot']=='PASS' or src['kucoinSpot']=='PASS') and src['gateSpot']=='PASS'
    main_pass=src['coinGecko']=='PASS' and venue_ok and btc is not None and main_count>=20 and main_ratio>=.90 and not core_missing
    pre_pass=src['coinGecko']=='PASS' and venue_ok and btc is not None and broad_count>=50 and sub_count>0 and pre_ratio>=.80 and len(pre_short)>0
    lifecycle=merge_lifecycle(pre_res,now); sub_short=sum(1 for m in pre_short if float(m.get('effectiveTurnover') or 0)<MAIN_MIN_TURNOVER)
    coverage={'bucketA':'PASS' if main_pass else 'FAIL','bucketB':'PASS' if main_pass else 'FAIL','bucketC':'PASS' if main_pass else 'FAIL','bucketD':'EXTERNAL_STAGE0_REQUIRED','bucketE':'PASS' if main_pass else 'FAIL','preAccum':'PASS' if pre_pass else 'FAIL','broadUniverseCount':broad_count,'preAccum250kTo2mUniverseCount':sub_count,'mainEligibleUniverseCount':main_count,'mainScannedCount':len(main_res),'mainScanSuccessRatio':round(main_ratio,4),'preAccumShortlistCount':len(pre_short),'preAccumSub2mShortlistCount':sub_short,'preAccumDeepLiteCompleted':len(pre_res),'preAccumDeepLiteSuccessRatio':round(pre_ratio,4),'coreRequiredAssets':sorted(CORE_ALWAYS_SCAN),'coreScannedAssets':sorted(core_present),'coreMissingAssets':core_missing,'executionPoolCount':len(execution_candidates),'venueCoverage':{'Bybit':src['bybitSpot'],'KuCoin':src['kucoinSpot'],'GateFallback':src['gateSpot']}}
    retention={'limit':RETENTION_LIMIT,'stageAEligible':len(stage),'stageARetained':len(retained),'executionIndependentCount':len(execution_candidates),'top30DoesNotGateExecution':True,'preAccumIndependentLimit':PREACCUM_LIMIT,'preAccumIndependentEligible':len(pre_short),'preAccumIndependentRetained':len(pre_res),'sub2mReserveRequired':PREACCUM_SUB2M_RESERVE,'sub2mReserveFilled':sub_short,'top30DoesNotGatePreAccum':True}
    out={'schemaVersion':SCHEMA,'module':'cabalMachineDiscovery','ok':bool(main_pass and pre_pass),'generatedAt':now,'sources':src,'coverage':coverage,'retention':retention,'candidateCountStageA':len(stage),'deepValidatedCount':len(retained),'btcReference':btc,'coreCandidates':core_candidates,'executionCandidates':execution_candidates,'preAccumCandidates':pre_res,'preAccumLifecycle':lifecycle,'candidates':retained,'failures':(pre_fails+main_fails)[:40],'errors':errors,'method':'v1.5: CoinGecko broad market metadata + preferred Bybit/KuCoin spot venue coverage + Gate fallback; independent >=250k PRE-STAGE-A universe; explicit 250k-2M coverage; max-10 PRE-ACCUM deep-lite with >=6 sub-2M reserve when available; separate preAccumCandidates output bypasses Stage-A top-30 retention; main CABAL >=2M/15M-3B lane preserved; completed 1h OHLCV; no auto-trading.'}
    os.makedirs(os.path.dirname(OUT) or '.',exist_ok=True); tmp=OUT+'.tmp'; json.dump(out,open(tmp,'w',encoding='utf-8'),ensure_ascii=False,indent=2); os.replace(tmp,OUT)
    print(json.dumps({'ok':out['ok'],'generatedAt':now,'broad':broad_count,'sub2mBand':sub_count,'main':main_count,'mainScanned':len(main_res),'preShort':len(pre_short),'preSub2m':sub_short,'preDone':len(pre_res),'preTriggers':sum(1 for x in pre_res if x.get('preAccumTrigger')),'preWatches':sum(1 for x in pre_res if x.get('preAccumWatch')),'sources':src,'errors':errors},indent=2))

if __name__=='__main__': main()
