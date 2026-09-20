#!/usr/bin/env python3
"""CABAL v2.0 — full-universe discovery + canonical WATCH/BUY engine. Manual SPOT only."""
import importlib.util, json, math, os, statistics, time
from urllib.parse import urlencode
from cabal_decision_v2 import evaluate, tail_exchange_inclusion

HERE=os.path.dirname(__file__); BASE=os.path.join(HERE,'cabal-machine-scan-v15.py')
spec=importlib.util.spec_from_file_location('cabal_v15',BASE); mod=importlib.util.module_from_spec(spec); spec.loader.exec_module(mod)
mod.SCHEMA='1.6'; mod.UA='CABAL-Discovery-Guard/1.6.4'; mod.PREACCUM_LIMIT=60; mod.PREACCUM_SUB2M_RESERVE=40; mod.MAX_BROAD=1800
S={'cgPages':0,'tickers':{'kucoin':{},'bybit':{},'gate':{}},'synthetic':0,'tailMomentum':0,'fast15Attempts':0,'fast15Success':0}

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
    ku={}; by={}; gate={}
    try: ku=ku_pairs()
    except: pass
    try: by=by_pairs()
    except: pass
    try: gate=gate_pairs()
    except: pass
    known={str(r.get('symbol') or '').upper() for r in rows}; synth=[]; tail_count=0
    for a in sorted(set(ku)|set(by)|set(gate)):
        sym=a.lower()
        if a in known or not sym or sym in mod.STABLES or sym.startswith(mod.WRAPPED) or sym.endswith(mod.LEVERAGED_SUFFIXES): continue
        ds=[d[a] for d in (ku,by,gate) if a in d]
        turn=max([f(x.get('turnover')) for x in ds] or [0])
        lasts=[f(x.get('last'),None) for x in ds if x.get('last')]
        ch=[f(x.get('change24hPct')) for x in ds]
        p24=max(ch,key=abs) if ch else 0
        # Deep-tail momentum reserve: catches low-rank microcaps before they leave
        # the early window. It expands DISCOVERY only; BUY NOW still requires all
        # 15m/RS/no-chase/stop quality gates downstream.
        tail=tail_exchange_inclusion(turn,p24)
        if turn<mod.PRE_MIN_TURNOVER and not tail: continue
        item={'id':'exchange:'+sym,'symbol':sym,'name':a,'market_cap':0,'total_volume':turn,'current_price':lasts[0] if lasts else None,'price_change_percentage_1h_in_currency':0,'price_change_percentage_24h_in_currency':p24,'price_change_percentage_7d_in_currency':0}
        if tail:
            item['_tailMomentumReserve']=True
            tail_count+=1
        synth.append(item)
    S['synthetic']=len(synth); S['tailMomentum']=tail_count; return rows+synth
mod.fetch_coingecko=market_universe

# Reserve dedicated PRE slots for exchange-native microcaps already accelerating.
# This prevents low-rank assets from being crowded out by larger-cap candidates.
orig_pre_shortlist=mod.build_pre_shortlist
def build_pre_shortlist_v164(broad):
    base=orig_pre_shortlist(broad)
    tail=sorted(
        [m for m in broad if m.get('_tailMomentumReserve')],
        key=lambda m:(f(m.get('price_change_percentage_24h_in_currency')),f(m.get('effectiveTurnover') or m.get('total_volume'))),
        reverse=True
    )
    out=[]; seen=set()
    for m in tail[:15]:
        a=str(m.get('symbol') or '').upper()
        if a and a not in seen:
            out.append(m); seen.add(a)
    for m in base:
        if len(out)>=mod.PREACCUM_LIMIT: break
        a=str(m.get('symbol') or '').upper()
        if a and a not in seen:
            out.append(m); seen.add(a)
    return out[:mod.PREACCUM_LIMIT]
mod.build_pre_shortlist=build_pre_shortlist_v164

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
def by15(sym,limit=96):
    d=mod.get('https://api.bybit.com/v5/market/kline?'+urlencode({'category':'spot','symbol':sym,'interval':'15','limit':str(min(limit,200))}),12,1)
    rows=((d.get('result') or {}).get('list') or []); now=int(time.time()*1000); out=[]
    for r in rows:
        if isinstance(r,list) and len(r)>=6:
            t=int(r[0])
            if t+900000<=now:
                out.append({'t':t,'h':f(r[2]),'l':f(r[3]),'c':f(r[4]),'v':f(r[5])})
    out.sort(key=lambda x:x['t'])
    if len(out)<24: raise RuntimeError('Bybit 15m insufficient')
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
        try:
            if k=='kucoin': b=ku15(t['symbol'])
            elif k=='bybit': b=by15(t['symbol'])
            else: b=gate15(t['symbol'])
            src=k; break
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

    # v1.6.3 EXECUTION SAFETY:
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

    pilot_reason=None
    if pilot and fastq:
        pilot_reason='WIDE_BASE_ACCEL_15M' if (ft or {}).get('wideBaseTrigger') else 'FAST_PUMP_15M'
    elif pilot and pre_exec:
        pilot_reason='PRE_ACCUM_TRIGGER'
    elif pilot and old_exec:
        pilot_reason='ABC_EARLY_STRUCTURE'
    elif pilot and sec_exec:
        pilot_reason='SECOND_LEG_TRIGGER'

    r.update({
        'entryConfirmation15m':fresh15,
        'entryConfirmation15mSource':(ft or {}).get('source'),
        'fastPumpQualifiedForPilot':fastq,
        'pilotEntryEligible':pilot,
        'pilotReason':pilot_reason,
        'pilotSizePctOfPlannedPosition':25 if pilot and old_exec else (20 if pilot else 0),
        'pilotEntryMax':min(no*.995 if no else px*1.005,px*1.005) if pilot else None,
        'confirmationAddTrigger':max([x for x in [px,f(r.get('preAccumTriggerLevel')),f((ft or {}).get('baseHigh4h15m'))] if x>0]) if pilot else None,
        'protectiveStopReference':stop if pilot else None,
        'pilotStopDistancePct':round(sd,4) if pilot else None,
        'requiresProtectiveStop':pilot,
        'protectionState':'UNARMED' if pilot else None,
        'executionSignal':sig,
        'whalesRequiredForPilot':False,
        'whalesPolicy':'BONUS_NOT_VETO_UNLESS_VERIFIED_NEGATIVE_DISTRIBUTION'
    })
    # Canonical v2 decision. This is the ONLY quality decision NTFY should relay.
    r.update(evaluate(r))
    return r
mod.result_from_bars=result
mod.main()

out=mod.OUT; d=json.load(open(out,encoding='utf-8')); d['schemaVersion']='2.0'; complete=S['cgPages']>=4; d['sourceMode']='COINGECKO_PLUS_EXCHANGE_NATIVE' if complete else ('PARTIAL_CG_PLUS_EXCHANGE_NATIVE' if S['cgPages'] else 'EXCHANGE_NATIVE_FALLBACK'); d['sources']['coinGecko']='PASS' if complete else (f'PARTIAL_{S["cgPages"]}_PAGES_EXCHANGE_ENRICHED' if S['cgPages'] else 'FALLBACK_EXCHANGE_UNIVERSE')
vc=d.get('coverage',{}).get('venueCoverage') or {}
cov=d.get('coverage') or {}
scan_universe=int(cov.get('executionUniverseCount') or cov.get('mainEligibleUniverseCount') or 0)
scan_done=int(cov.get('mainScannedCount') or 0)
scan_ratio=(scan_done/scan_universe) if scan_universe else 0.0
core_missing=cov.get('coreMissingAssets') or []
venue_operational=bool((vc.get('KuCoin')=='PASS' or vc.get('Bybit')=='PASS') and vc.get('GateFallback')=='PASS')
d['metadataCoverage']={
    'coinGeckoPages':S['cgPages'],
    'fullCoinGeckoFourPages':complete,
    'mode':'FULL' if complete else ('PARTIAL_BUT_EXCHANGE_ENRICHED' if S['cgPages'] else 'EXCHANGE_NATIVE_FALLBACK')
}
d['preAccumOperational']=bool(cov.get('preAccum')=='PASS' and venue_operational)
# v2 health is based on measured execution coverage, not an arbitrary provider-page count.
# A partial CoinGecko response is acceptable only when the exchange-enriched universe is
# still broad, scan success is >=90%, CORE assets are present, and venue fallbacks are healthy.
d['mainMachineOperational']=bool(
    venue_operational
    and scan_universe>=300
    and scan_ratio>=0.90
    and not core_missing
)
for k in ('bucketA','bucketB','bucketC','bucketE'):
    if d['mainMachineOperational']:
        d['coverage'][k]='PASS'
    elif d['coverage'].get(k)=='PASS':
        d['coverage'][k]='FAIL_EXECUTION_COVERAGE'
rows=[]; seen=set()
for x in (d.get('buyCandidates') or [])+(d.get('watchCandidates') or [])+(d.get('executionCandidates') or [])+(d.get('preAccumCandidates') or [])+(d.get('candidates') or []):
    if x.get('asset') and x['asset'] not in seen:
        seen.add(x['asset']); rows.append(x)
pump=sorted(
    [x for x in rows if x.get('decisionTier') in {'BUY_NOW','WATCH'}],
    key=lambda x:(1 if x.get('decisionTier')=='BUY_NOW' else 0,f(x.get('qualityScore')),f(x.get('stageAScore'))),
    reverse=True
)
buys=sorted(d.get('buyCandidates') or [],key=lambda x:(f(x.get('qualityScore')),f(x.get('stageAScore'))),reverse=True)
watches=sorted(d.get('watchCandidates') or [],key=lambda x:(f(x.get('qualityScore')),f(x.get('stageAScore'))),reverse=True)
d['pumpRadar']=pump[:80]
# Backward-compatible field; in v2 it mirrors canonical BUY_NOW only.
d['pilotEntries']=buys[:30]
d['decisionRadar']={'buyNow':[x.get('asset') for x in buys[:30]],'watch':[x.get('asset') for x in watches[:50]]}
d['pumpRadarStats']={
    'fast15Attempts':S['fast15Attempts'],
    'fast15Success':S['fast15Success'],
    'fast15SuccessRatio':round(S['fast15Success']/S['fast15Attempts'],4) if S['fast15Attempts'] else 1.0,
    'buyNowCount':len(buys),
    'watchCount':len(watches),
    'exchangeSyntheticAdded':S['synthetic'],
    'tailMomentumReserveCount':S['tailMomentum'],
    'coinGeckoPages':S['cgPages'],
    'preAccumLimit':mod.PREACCUM_LIMIT,
    'preAccumSub2mReserve':mod.PREACCUM_SUB2M_RESERVE
}
d['executionEngine']={
    'version':'CABAL_V2.0',
    'decisionEngine':'CANONICAL_V2',
    'manualOnly':True,
    'autoTrade':False,
    'protectiveStopRequiredForBuy':True,
    'fullExecutionUniverse':True,
    'watchBeforeBuy':True,
    'fresh15mRequiredForBuy':True,
    'deepTailMomentumReserve':True,
    'coreAlwaysScan':['BTC','ETH','SOL','XRP','AVAX','HBAR','ONDO'],
    'executionPoolIndependentOfTop30':True,
    'ntfyReScoresBuy':False
}
d['method']='CABAL v2.0: every supported broad spot asset reaches execution analysis; Stage-A/top-30 never gates execution. One canonical engine emits WATCH or BUY_NOW. CORE assets are mandatory, low-rank exchange-native momentum has a guarded reserve, BUY requires fresh 15m confirmation plus stop/no-chase safety, and NTFY relays/revalidates rather than re-scoring. Missed movers are recorded with reject reasons. Manual SPOT only.'
tmp=out+'.v16.tmp'; json.dump(d,open(tmp,'w',encoding='utf-8'),ensure_ascii=False,indent=2); os.replace(tmp,out); print(json.dumps({'schemaVersion':'2.0','preAccumOperational':d['preAccumOperational'],'mainMachineOperational':d['mainMachineOperational'],'sourceMode':d['sourceMode'],'pumpRadarStats':d['pumpRadarStats'],'buyNow':[x.get('asset') for x in d.get('buyCandidates',[])[:10]],'watch':[x.get('asset') for x in d.get('watchCandidates',[])[:10]]},indent=2))
