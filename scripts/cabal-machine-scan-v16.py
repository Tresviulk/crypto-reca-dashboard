#!/usr/bin/env python3
"""CABAL v1.6.3 PUMP RADAR + PILOT ENTRY. Manual SPOT only; never auto-trades."""
import importlib.util, json, math, os, statistics, time
from urllib.parse import urlencode

HERE=os.path.dirname(__file__); BASE=os.path.join(HERE,'cabal-machine-scan-v15.py')
spec=importlib.util.spec_from_file_location('cabal_v15',BASE); mod=importlib.util.module_from_spec(spec); spec.loader.exec_module(mod)
mod.SCHEMA='1.6'; mod.UA='CABAL-Discovery-Guard/1.6'; mod.PREACCUM_LIMIT=60; mod.PREACCUM_SUB2M_RESERVE=40
S={'cgPages':0,'tickers':{'kucoin':{},'bybit':{},'gate':{}},'synthetic':0,'fast15Attempts':0,'fast15Success':0}

def f(x,d=0.0):
    try:
        v=float(x); return v if math.isfinite(v) else d
    except: return d

def pct(a,b): return ((a/b)-1)*100 if a is not None and b not in (None,0) else 0.0

def ku_pairs():
    d=mod.get('https://api.kucoin.com/api/v1/market/allTickers',20,2); out={}
    for x in ((d.get('data') or {}).get('ticker') or []):
        sym=str(x.get('symbol') or '')
        if sym.endswith('-USDT'):
            out[sym[:-5].upper()]={'symbol':sym,'turnover':f(x.get('volValue')),'last':f(x.get('last'),None),'change24hPct':f(x.get('changeRate'))*100}
    S['tickers']['kucoin']=out; return out

def by_pairs():
    d=mod.get('https://api.bybit.com/v5/market/tickers?category=spot',20,2); out={}
    for x in ((d.get('result') or {}).get('list') or []):
        sym=str(x.get('symbol') or '')
        if sym.endswith('USDT'):
            out[sym[:-4].upper()]={'symbol':sym,'turnover':f(x.get('turnover24h')),'last':f(x.get('lastPrice'),None),'change24hPct':f(x.get('price24hPcnt'))*100}
    S['tickers']['bybit']=out; return out

def gate_pairs():
    rows=mod.get('https://api.gateio.ws/api/v4/spot/tickers',20,2); out={}
    for x in rows if isinstance(rows,list) else []:
        sym=str(x.get('currency_pair') or '')
        if sym.endswith('_USDT'):
            out[sym[:-5].upper()]={'symbol':sym,'turnover':f(x.get('quote_volume')),'last':f(x.get('last'),None),'change24hPct':f(x.get('change_percentage'))}
    S['tickers']['gate']=out; return out
mod.fetch_kucoin_pairs=ku_pairs; mod.fetch_bybit_pairs=by_pairs; mod.fetch_gate_pairs=gate_pairs

def market_universe():
    rows=[]
    for page in range(1,5):
        try:
            q=urlencode({'vs_currency':'usd','order':'market_cap_desc','per_page':'250','page':page,'sparkline':'false','price_change_percentage':'1h,24h,7d'})
            part=mod.get('https://api.coingecko.com/api/v3/coins/markets?'+q,20,2)
            if not isinstance(part,list) or not part: break
            rows+=part; S['cgPages']=page; time.sleep(.55)
        except: break
    ku={}; by={}
    try: ku=ku_pairs()
    except: pass
    try: by=by_pairs()
    except: pass
    known={str(r.get('symbol') or '').upper() for r in rows}; synth=[]
    for a in sorted(set(ku)|set(by)):
        s=a.lower()
        if a in known or not s or s in mod.STABLES or s.startswith(mod.WRAPPED) or s.endswith(mod.LEVERAGED_SUFFIXES): continue
        ds=[d[a] for d in (ku,by) if a in d]; turn=max([f(x.get('turnover')) for x in ds] or [0])
        if turn<mod.PRE_MIN_TURNOVER: continue
        lasts=[f(x.get('last'),None) for x in ds if x.get('last')]; ch=[f(x.get('change24hPct')) for x in ds]
        synth.append({'id':'exchange:'+s,'symbol':s,'name':a,'market_cap':0,'total_volume':turn,'current_price':lasts[0] if lasts else None,'price_change_percentage_1h_in_currency':0,'price_change_percentage_24h_in_currency':max(ch,key=abs) if ch else 0,'price_change_percentage_7d_in_currency':0})
    S['synthetic']=len(synth); return rows+synth
mod.fetch_coingecko=market_universe

orig_metrics=mod.metrics_from_bars
def metrics(b,m,btc):
    z=orig_metrics(b,m,btc); mc=f(m.get('market_cap'))
    if mc<=0:
        turn=f(m.get('effectiveTurnover') or m.get('total_volume')); sig=sum([z['r1']>=1.15,z['volumeBuild'] is not None and z['volumeBuild']>=1.2,z['rs1']>=.2,z['p6']>=.25])
        z['watch']=bool(z['watch'] and turn>=500000 and sig>=2); z['trigger']=bool(z['watch'] and z['r1']>=1.35 and z['price']>=z['baseHigh']*.99 and z['p1']>=.15)
    return z
mod.metrics_from_bars=metrics

def vk(v):
    v=str(v or '').lower(); return 'kucoin' if 'kucoin' in v else ('bybit' if 'bybit' in v else ('gate' if 'gate' in v else None))
def live(asset,venue=None):
    order=[vk(venue)] if vk(venue) else []
    order += [x for x in ('kucoin','bybit','gate') if x not in order]
    for k in order:
        r=S['tickers'].get(k,{}).get(str(asset).upper())
        if r and r.get('last'): return f(r['last']),k
    return None,None

def ku15(sym,limit=96):
    d=mod.get('https://api.kucoin.com/api/v1/market/candles?'+urlencode({'type':'15min','symbol':sym}),12,1); now=int(time.time()); out=[]
    for r in (d.get('data') or [])[:100]:
        if isinstance(r,list) and len(r)>=6:
            t=int(float(r[0]))
            if t+900<=now: out.append({'t':t*1000,'h':f(r[3]),'l':f(r[4]),'c':f(r[2]),'v':f(r[5])})
    out.sort(key=lambda x:x['t'])
    if len(out)<24: raise RuntimeError('KuCoin 15m insufficient')
    return out[-limit:]
def gate15(sym,limit=96):
    rows=mod.get('https://api.gateio.ws/api/v4/spot/candlesticks?'+urlencode({'currency_pair':sym,'interval':'15m','limit':str(limit)}),12,1); now=int(time.time()); out=[]
    for r in rows if isinstance(rows,list) else []:
        if isinstance(r,list) and len(r)>=6:
            t=int(float(r[0]))
            if t+900<=now: out.append({'t':t*1000,'h':f(r[3]),'l':f(r[4]),'c':f(r[2]),'v':f(r[1])})
    out.sort(key=lambda x:x['t'])
    if len(out)<24: raise RuntimeError('Gate 15m insufficient')
    return out[-limit:]
def fast15(asset,venue,px,intra,intra_rs,row):
    S['fast15Attempts']+=1; order=[vk(venue)] if vk(venue) else []
    order += [x for x in ('kucoin','gate') if x not in order]; b=None; src=None
    for k in order:
        t=S['tickers'].get(k,{}).get(asset)
        if not t: continue
        try: b=ku15(t['symbol']) if k=='kucoin' else gate15(t['symbol']); src=k; break
        except: pass
    if not b: raise RuntimeError('15m DATA GAP')
    S['fast15Success']+=1; hist=[x['v'] for x in b[-21:-1] if x['v']>0]; mv=statistics.median(hist) if len(hist)>=12 else None; rv=b[-1]['v']/mv if mv else None
    base=b[-17:-1]; bh=max(x['h'] for x in base); bl=min(x['l'] for x in base); br=pct(bh,bl)
    support8=min(x['l'] for x in b[-8:]); inv8=support8*.996
    support4=min(x['l'] for x in b[-4:]); inv4=support4*.996
    recent_stop_dist=pct(px,inv4) if px>inv4>0 else 999
    interest=(rv is not None and rv>=1.15) or f(row.get('rvol1h'))>=1.15 or f(row.get('turnoverToMarketCap'))>=.04 or intra_rs>=.2

    normal_watch=bool(br<=10 and px>=bh*.97 and intra>=.35 and intra<5 and intra_rs>=.1 and f(row.get('priceChange24hPct'))<25 and interest)
    normal_trigger=bool(normal_watch and px>=bh*.995 and intra>=.60 and intra_rs>=.20 and ((rv is not None and rv>=1.35) or f(row.get('rvol1h'))>=1.35))

    # v1.6.3 WIDE-BASE EARLY ACCELERATION:
    # A 10-18% 4h/15m base is allowed ONLY when the move is still early and
    # breadth/volume/relative-strength are exceptional. This catches CELR-type
    # expansion before NO_CHASE without opening the gate to ordinary volatile pumps.
    wide_watch=bool(
        br>10 and br<=18
        and px>=bh*.965
        and intra>=.60 and intra<4
        and intra_rs>=.60
        and f(row.get('priceChange24hPct'))<18
        and f(row.get('rvol1h'))>=8
        and f(row.get('relativeStrength1hVsBTC'))>=1.0
        and f(row.get('relativeStrength4hVsBTC'))>=2.0
        and row.get('bucketB')
        and row.get('effortVsResult')!='POOR'
        and rv is not None and rv>=2.5
        and recent_stop_dist>=1.0 and recent_stop_dist<=4.5
    )
    wide_trigger=bool(wide_watch and px>=bh*.965 and rv>=3.0)
    watch=bool(normal_watch or wide_watch)
    trigger=bool(normal_trigger or wide_trigger)
    support=support4 if wide_trigger else support8
    inv=inv4 if wide_trigger else inv8
    return {
        'source':src,'rvol15m':round(rv,4) if rv is not None else None,
        'baseHigh4h15m':bh,'baseLow4h15m':bl,'baseRange4h15mPct':round(br,4),
        'support15m':support,'invalidation15m':inv,'watch':watch,'trigger':trigger,
        'wideBaseWatch':wide_watch,'wideBaseTrigger':wide_trigger,
        'wideBaseRecentSupport15m':support4,'wideBaseInvalidation15m':inv4,
        'wideBaseStopDistancePct':round(recent_stop_dist,4) if recent_stop_dist<998 else None
    }

orig_result=mod.result_from_bars
def result(asset,m,b,venue,btc,pre_lane=False):
    r=orig_result(asset,m,b,venue,btc,pre_lane); base=r['classification']; r['baseClassification']=base; r['completed1hPrice']=r['price']; r['completedBucketA']=bool(r.get('bucketA'))
    px,src=live(asset,venue); px=px or f(r['price']); bpx,_=live('BTC',(btc or {}).get('venue')); intra=pct(px,f(r['completed1hPrice'])); bintra=pct(bpx,f((btc or {}).get('price'))) if bpx and f((btc or {}).get('price')) else 0; irs=intra-bintra
    r.update({'price':px,'priceSource':'LIVE_'+str(src).upper() if src else 'COMPLETED_1H','intrahourMovePct':round(intra,4),'intrahourRelativeStrengthVsBTC':round(irs,4)})
    ft=None
    if (.30<=intra<5) or r.get('preAccumWatch') or r.get('preAccumTrigger') or base in {'PRE-MOVE','EARLY STARTER','SECOND-LEG TRIGGER'} or f(r.get('rvol1h'))>=1.35:
        try: ft=fast15(asset,venue,px,intra,irs,r)
        except Exception as e: r['fast15DataGap']=str(e)
    fw=bool(ft and ft['watch']); trg=bool(ft and ft['trigger']); r.update({'fastPump15m':ft,'fastPumpWatch':fw,'fastPumpTrigger':trg,'pumpRadarState':'FAST_PUMP_TRIGGER' if trg else ('FAST_PUMP_WATCH' if fw else 'NONE')})
    if trg: r['bucketA']=True; r['decisionUrgency']='IMMEDIATE'
    no=f(r.get('noChase')); head=pct(no,px) if no else None; r['noChaseHeadroomPct']=round(head,4) if head is not None else None
    old=bool(base in {'PRE-MOVE','EARLY STARTER'} and r['completedBucketA'] and r.get('bucketB') and r.get('bucketC') and r.get('effortVsResult')!='POOR' and f(r.get('relativeStrength1hVsBTC'))>0 and f(r.get('relativeStrength4hVsBTC'))>0 and f(r.get('priceChange24hPct'))<18 and f(r.get('priceChange4hPct'))<8)
    pre=bool(r.get('preAccumTrigger') and f(r.get('rvol1h'))>=1.35 and px>=f(r.get('preAccumTriggerLevel'))*.995 and (f(r.get('relativeStrength1hVsBTC'))>0 or irs>=.2) and r.get('effortVsResult')!='POOR')
    sec=bool(r.get('secondLegTrigger') and r.get('effortVsResult')!='POOR' and irs>=0)
    rv15=f((ft or {}).get('rvol15m')); score=f(r.get('stageAScore'))
    fastq=bool(trg and rv15>=2.0 and irs>=.2 and r.get('bucketB') and (r.get('bucketC') or score>=35))

    # v1.6.2 EXECUTION SAFETY:
    # 1h PRE-ACCUM / ABC / SECOND-LEG states remain discovery signals only.
    # A real PILOT_ENTRY_WINDOW now requires a CURRENT completed-15m trigger.
    # This prevents a stale 1h trigger from authorizing a late/chased BUY.
    fresh15=bool(ft and ft.get('trigger'))
    pre_exec=bool(pre and fresh15)
    old_exec=bool(old and fresh15)
    sec_exec=bool(sec and fresh15)

    stop=f(ft.get('invalidation15m')) if fastq and ft else f(r.get('invalidation')); sd=pct(px,stop) if px>stop>0 else 999
    loc=bool(px>stop>0 and sd<=5 and (not no or px<no) and (head is None or head>=.5) and intra<5 and f(r.get('priceChange24hPct'))<25)
    pilot=bool(loc and (fastq or pre_exec or old_exec or sec_exec))
    sig='NO_CHASE' if no and px>=no else ('PILOT_ENTRY_WINDOW' if pilot else ('WAIT_CONFIRMATION' if base in {'PRE-ACCUMULATION TRIGGER','PRE-MOVE','EARLY STARTER','SECOND-LEG TRIGGER'} or fw else r.get('executionSignal','OBSERVE')))
    r.update({'entryConfirmation15m':fresh15,'entryConfirmation15mSource':(ft or {}).get('source'),'fastPumpQualifiedForPilot':fastq,'pilotEntryEligible':pilot,'pilotReason':('WIDE_BASE_ACCEL_15M' if pilot and fastq and (ft or {}).get('wideBaseTrigger') else ('FAST_PUMP_15M' if pilot and fastq else ('PRE_ACCUM_TRIGGER' if pilot and pre_exec else ('ABC_EARLY_STRUCTURE' if pilot and old_exec else ('SECOND_LEG_TRIGGER' if pilot and sec_exec else None)))),'pilotSizePctOfPlannedPosition':25 if pilot and old_exec else (20 if pilot else 0),'pilotEntryMax':min(no*.995 if no else px*1.005,px*1.005) if pilot else None,'confirmationAddTrigger':max([x for x in [px,f(r.get('preAccumTriggerLevel')),f((ft or {}).get('baseHigh4h15m'))] if x>0]) if pilot else None,'protectiveStopReference':stop if pilot else None,'pilotStopDistancePct':round(sd,4) if pilot else None,'requiresProtectiveStop':pilot,'protectionState':'UNARMED' if pilot else None,'executionSignal':sig,'whalesRequiredForPilot':False,'whalesPolicy':'BONUS_NOT_VETO_UNLESS_VERIFIED_NEGATIVE_DISTRIBUTION'})
    return r
mod.result_from_bars=result
mod.main()

out=mod.OUT; d=json.load(open(out,encoding='utf-8')); d['schemaVersion']='1.6'; complete=S['cgPages']>=4; d['sourceMode']='COINGECKO_PLUS_EXCHANGE_NATIVE' if complete else ('PARTIAL_CG_PLUS_EXCHANGE_NATIVE' if S['cgPages'] else 'EXCHANGE_NATIVE_FALLBACK'); d['sources']['coinGecko']='PASS' if complete else (f'PARTIAL_{S["cgPages"]}_PAGES_EXCHANGE_ENRICHED' if S['cgPages'] else 'FALLBACK_EXCHANGE_UNIVERSE')
vc=d.get('coverage',{}).get('venueCoverage') or {}; d['preAccumOperational']=bool(d.get('coverage',{}).get('preAccum')=='PASS' and (vc.get('KuCoin')=='PASS' or vc.get('Bybit')=='PASS') and vc.get('GateFallback')=='PASS'); d['mainMachineOperational']=bool(complete and all(d.get('coverage',{}).get(k)=='PASS' for k in ('bucketA','bucketB','bucketC','bucketE')))
if not complete:
    for k in ('bucketA','bucketB','bucketC','bucketE'): d['coverage'][k]='FAIL_METADATA_PARTIAL'
rows=[]; seen=set()
for x in (d.get('preAccumCandidates') or [])+(d.get('candidates') or []):
    if x.get('asset') and x['asset'] not in seen: seen.add(x['asset']); rows.append(x)
pump=sorted([x for x in rows if x.get('fastPumpWatch') or x.get('fastPumpTrigger')],key=lambda x:(bool(x.get('fastPumpTrigger')),bool(x.get('pilotEntryEligible')),f(x.get('intrahourMovePct')),f(x.get('stageAScore'))),reverse=True); pilots=sorted([x for x in rows if x.get('pilotEntryEligible') and x.get('executionSignal')=='PILOT_ENTRY_WINDOW'],key=lambda x:(f(x.get('stageAScore')),f(x.get('intrahourMovePct'))),reverse=True)
d['pumpRadar']=pump[:40]; d['pilotEntries']=pilots[:20]; d['pumpRadarStats']={'fast15Attempts':S['fast15Attempts'],'fast15Success':S['fast15Success'],'fast15SuccessRatio':round(S['fast15Success']/S['fast15Attempts'],4) if S['fast15Attempts'] else 1.0,'fastPumpWatchCount':sum(bool(x.get('fastPumpWatch')) for x in pump),'fastPumpTriggerCount':sum(bool(x.get('fastPumpTrigger')) for x in pump),'pilotEntryCount':len(pilots),'exchangeSyntheticAdded':S['synthetic'],'coinGeckoPages':S['cgPages'],'preAccumLimit':mod.PREACCUM_LIMIT,'preAccumSub2mReserve':mod.PREACCUM_SUB2M_RESERVE}; d['executionEngine']={'version':'CABAL_PUMP_PILOT_V1.6.3','manualOnly':True,'autoTrade':False,'pilotMaxPctOfPlannedPosition':25,'whalesRole':'CONFIRMATION_PRIORITY_NOT_MANDATORY_VETO','protectiveStopRequired':True,'fastLayer':'LIVE_INTRAHOUR_PLUS_SELECTIVE_COMPLETED_15M','fresh15mRequiredForBuy':True,'wideBaseEarlyAcceleration':True}; d['method']='v1.6.3: PRE-ACCUM/ABC/SECOND-LEG require CURRENT completed-15m confirmation; FAST_PUMP keeps RVOL + RS gates; WIDE_BASE_ACCEL_15M permits 10-18% bases only with exceptional early volume/RS and a recent structural stop <=4.5%; exchange-native PRE universe remains merged; PILOT_ENTRY_WINDOW 20-25% max with stop/no-chase; WHALES additive, never bypasses execution confirmation; manual SPOT only.'
tmp=out+'.v16.tmp'; json.dump(d,open(tmp,'w',encoding='utf-8'),ensure_ascii=False,indent=2); os.replace(tmp,out); print(json.dumps({'schemaVersion':'1.6','preAccumOperational':d['preAccumOperational'],'mainMachineOperational':d['mainMachineOperational'],'sourceMode':d['sourceMode'],'pumpRadarStats':d['pumpRadarStats'],'pilotEntries':[x.get('asset') for x in d['pilotEntries'][:10]]},indent=2))
