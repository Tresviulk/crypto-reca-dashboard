#!/usr/bin/env python3
"""
CABAL Independent Machine Discovery v1.4 — FIL anti-miss patch.

Purpose:
- Detect compressed-base + rising-participation PRE-ACCUM patterns before price acceleration.
- Prevent PRE-ACCUM / strong EARLY-MOVE candidates from being crowded out of the retained top-30.
- Refine CHURN so high RVOL with constructive acceptance is not automatically treated as distribution.
- Preserve manual execution only; this scanner never trades.
"""
import json, os, statistics, time, math
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from urllib.parse import urlencode
from urllib.request import Request, urlopen

OUT=os.environ.get('CABAL_OUT','data/cabal-machine.json')
UA='CABAL-Discovery-Guard/1.4'
SCHEMA='1.4'
RETENTION_LIMIT=30
PREACCUM_RESERVE=8
EARLY_RESERVE=8
SECOND_LEG_RESERVE=4

STABLES={'usdt','usdc','dai','fdusd','tusd','usde','usds','pyusd','usdd','frax','crvusd','gho','usd1','usdp','gusd'}
WRAPPED=('wbtc','weth','wsteth','steth','cbeth','reth','weeth','ezeth','solvbtc')

def get(url,timeout=20,retries=2):
    last=None
    for i in range(retries+1):
        try:
            with urlopen(Request(url,headers={'User-Agent':UA,'Accept':'application/json'}),timeout=timeout) as r:
                return json.loads(r.read().decode())
        except Exception as e:
            last=e
            if i<retries: time.sleep(i+1)
    raise last

def pct(a,b): return ((a/b)-1)*100 if a and b else 0.0

def med_pos(xs,min_count=1):
    ys=[float(x) for x in xs if x is not None and float(x)>0]
    if len(ys)<min_count: return None
    return statistics.median(ys)

def gate_1h(pair,limit=168):
    q=urlencode({'currency_pair':pair,'interval':'1h','limit':str(limit)})
    rows=get('https://api.gateio.ws/api/v4/spot/candlesticks?'+q,15,2)
    if not isinstance(rows,list): raise RuntimeError('Gate malformed candles')
    now=int(time.time()); bars=[]
    for r in rows:
        if not isinstance(r,list) or len(r)<6: continue
        t=int(float(r[0]))
        if t+3600>now: continue
        bars.append({'t':t*1000,'o':float(r[5]),'h':float(r[3]),'l':float(r[4]),'c':float(r[2]),'v':float(r[1])})
    bars.sort(key=lambda x:x['t'])
    if len(bars)<30: raise RuntimeError('insufficient completed Gate 1h bars')
    return bars

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

def preaccum_metrics(b,m,btc,p1,p4,p24,r1):
    z=b[-1]
    base=b[-13:-1]
    if len(base)<8:
        return {'watch':False,'trigger':False,'baseRange12hPct':None,'volumeBuild6h':None,'triggerLevel':None,'turnoverToMarketCap':None,'move6hPct':None}

    bh=max(x['h'] for x in base)
    bl=min(x['l'] for x in base)
    br=pct(bh,bl) if bl>0 else None
    move6=pct(z['c'],b[-7]['c']) if len(b)>=7 else 0.0

    recent6=b[-7:-1]
    baseline=b[-31:-7] if len(b)>=31 else b[:-7]
    rv=med_pos([x['v'] for x in recent6],4)
    bv=med_pos([x['v'] for x in baseline],8)
    volume_build=(rv/bv) if rv and bv else None

    mc=float(m.get('market_cap') or 0)
    turn=float(m.get('total_volume') or 0)
    turn_ratio=(turn/mc) if mc>0 else None

    rs1=p1-btc['p1']
    near_high=z['c']>=bh*.97
    constructive6=move6>=.25
    not_vertical=p1<5 and p4<10 and p24<25
    interest=(r1>=1.15 or (volume_build is not None and volume_build>=1.20) or (turn_ratio is not None and turn_ratio>=.04) or rs1>=.20)
    watch=bool(br is not None and br<=12 and not_vertical and (near_high or constructive6) and interest)
    trigger=bool(watch and r1>=1.35 and z['c']>=bh*.99 and p1>=.15)

    return {
        'watch':watch,
        'trigger':trigger,
        'baseRange12hPct':round(br,4) if br is not None else None,
        'volumeBuild6h':round(volume_build,4) if volume_build is not None else None,
        'triggerLevel':bh,
        'turnoverToMarketCap':round(turn_ratio,6) if turn_ratio is not None else None,
        'move6hPct':round(move6,4)
    }

def analyze(pair,m,btc):
    b=gate_1h(pair); z=b[-1]
    p1=pct(z['c'],b[-2]['c']); p4=pct(z['c'],b[-5]['c']); p24=pct(z['c'],b[-25]['c']) if len(b)>=25 else float(m.get('price_change_percentage_24h') or 0)
    p7=float(m.get('price_change_percentage_7d_in_currency') or 0)
    r1,r4=rvols(b)
    h6=max(x['h'] for x in b[-7:-1]); h24=max(x['h'] for x in b[-24:])
    breakout=z['c']>h6*1.002; reclaim=z['c']>h6*.998 and b[-2]['c']<=h6
    rs1=p1-btc['p1']; rs4=p4-btc['p4']

    pa=preaccum_metrics(b,m,btc,p1,p4,p24,r1)
    pre_watch=pa['watch']; pre_trigger=pa['trigger']

    # v1.4 CHURN refinement: large RVOL is not distribution by itself. Require weak price
    # acceptance and no constructive PRE-ACCUM structure before assigning churn.
    if r1>=2.5 and p1<.25 and p4<1.0 and not breakout and not reclaim and not pre_watch:
        vs='CHURN-DISTRIBUTION'
    elif r1>=2.2 and r4<1.15:
        vs='ONE-OFF SHOCK'
    elif r1>=1.35 and r4>=1.15:
        vs='VOLUME ACCELERATING'
    elif r1<.8 and r4<.9:
        vs='VOLUME DECELERATING'
    else:
        vs='VOLUME HIGH' if max(r1,r4)>=1.25 else 'VOLUME DECELERATING'

    A=p1>=1.2 or p4>=3.0
    B=r1>=1.45 or r4>=1.35
    C=(breakout or reclaim) and (r1>=1.15 or rs1>=1.0 or rs4>=2.0)

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
                cooled=bool(lv and cv and cv<=lv*.85); reset=pct(ch,cl)<=14 and z['c']<=cl*1.14; renewed=r1>=1.25 or r4>=1.15 or rs1>=1.2
                sw=cooled and reset and z['c']>=ch*.985
                st=cooled and reset and renewed and z['c']>ch*1.002
                if st: t0=z['t']
    E=sw or st

    poor=(r1>=1.8 or r4>=1.6) and p4<1.0 and p1<.25 and not breakout and not reclaim and not pre_watch
    if st: cls='SECOND-LEG TRIGGER'
    elif sw: cls='SECOND-LEG WATCH'
    elif pre_trigger: cls='PRE-ACCUMULATION TRIGGER'
    elif pre_watch: cls='PRE-ACCUMULATION WATCH'
    elif poor: cls='CHURN-DISTRIBUTION RISK'
    elif p24>=35: cls='LATE-POST-PUMP'
    elif C and p24<18 and p4<8: cls='EARLY STARTER'
    elif B and p24<12 and p4<5: cls='PRE-MOVE'
    elif A and p24<25: cls='EARLY-MOVE'
    elif A or B or C or E: cls='MID-MOVE'
    else: cls='NO SETUP'

    support=min(x['l'] for x in b[-6:])
    invalidation=support*.997
    no_chase=h24*1.01
    headroom=pct(no_chase,z['c'])
    effort='POOR' if poor else ('EFFICIENT' if p4>=2 and r4>=1.1 else ('CONSTRUCTIVE' if pre_watch else 'NEUTRAL'))

    pilot_quality=(cls in {'PRE-MOVE','EARLY STARTER'} and A and B and C and not poor and rs1>0 and rs4>0 and p24<18 and p4<8)
    pilot_location=(z['c']<no_chase and headroom>=.75)
    pilot=bool(pilot_quality and pilot_location)
    if z['c']>=no_chase:
        execution='NO_CHASE'
    elif pilot:
        execution='PILOT_ENTRY_WINDOW'
    elif cls in {'PRE-MOVE','EARLY STARTER','SECOND-LEG TRIGGER','PRE-ACCUMULATION TRIGGER'}:
        execution='WAIT_CONFIRMATION'
    else:
        execution='OBSERVE'
    pilot_entry_max=min(no_chase*.995,z['c']*1.0075) if pilot else None
    add_trigger=max(h6*1.002,z['c']) if pilot else None

    score=max(p1,0)*2+max(p4,0)*.8+min(max(r1-1,0),8)*5+min(max(r4-1,0),8)*4+min(max(rs1,0),8)*1.5+(5 if C else 0)+(8 if st else 0)+(3 if pilot else 0)
    if pre_watch: score+=10
    if pre_trigger: score+=10
    if A and B and C and p24<25: score+=6

    urgency='IMMEDIATE' if pilot else ('HIGH' if cls in {'EARLY STARTER','EARLY-MOVE','SECOND-LEG TRIGGER','PRE-ACCUMULATION TRIGGER'} else 'NORMAL')

    return {
      'asset':m['symbol'].upper(),'symbol':pair,'venue':'Gate Spot','name':m.get('name'),'price':z['c'],'marketCap':m.get('market_cap'),'volume24h':m.get('total_volume'),
      'priceChange1hPct':round(p1,4),'priceChange4hPct':round(p4,4),'priceChange24hPct':round(p24,4),'priceChange7dPct':round(p7,4),'rvol1h':round(r1,4),'rvol4h':round(r4,4),'volumeState':vs,
      'relativeStrength1hVsBTC':round(rs1,4),'relativeStrength4hVsBTC':round(rs4,4),'breakout6h':breakout,'reclaim6h':reclaim,'support':support,'invalidation':invalidation,'noChase':no_chase,
      'bucketA':A,'bucketB':B,'bucketC':C,'bucketE':E,'secondLegWatch':sw,'secondLegTrigger':st,'secondLegT0':t0,
      'preAccumWatch':pre_watch,'preAccumTrigger':pre_trigger,'preAccumBaseRange12hPct':pa['baseRange12hPct'],'preAccumVolumeBuild6h':pa['volumeBuild6h'],'preAccumTriggerLevel':pa['triggerLevel'],'turnoverToMarketCap':pa['turnoverToMarketCap'],'priceChange6hPct':pa['move6hPct'],
      'classification':cls,'stageAScore':round(score,4),'effortVsResult':effort,
      'executionSignal':execution,'decisionUrgency':urgency,
      'pilotEntryEligible':pilot,'pilotSizePctOfPlannedPosition':25 if pilot else 0,'pilotEntryMax':pilot_entry_max,'confirmationAddTrigger':add_trigger,
      'noChaseHeadroomPct':round(headroom,4),'requiresProtectiveStop':bool(pilot),'protectiveStopReference':invalidation if pilot else None,'protectionState':'UNARMED' if pilot else None,
      'executionPolicy':'For PILOT_ENTRY_WINDOW: immediate human review; at most 25% of the planned position before full confirmation; never auto-execute; do not enter above pilotEntryMax/noChase; add only after confirmation; protective order required.' if pilot else None
    }

def select_retained(stage,limit=RETENTION_LIMIT):
    selected=[]; seen=set()
    def take(items,n):
        added=0
        for x in sorted(items,key=lambda y:y['stageAScore'],reverse=True):
            if len(selected)>=limit or added>=n: break
            if x['asset'] in seen: continue
            selected.append(x); seen.add(x['asset']); added+=1

    # Anti-crowdout reserves. A FIL-like compressed-base trigger cannot lose all visibility
    # just because already-moving names have higher raw acceleration scores.
    take([x for x in stage if x.get('preAccumTrigger') or x.get('preAccumWatch')],PREACCUM_RESERVE)
    take([x for x in stage if x.get('secondLegTrigger') or x.get('secondLegWatch')],SECOND_LEG_RESERVE)
    take([x for x in stage if x.get('classification') in {'PRE-MOVE','EARLY STARTER','EARLY-MOVE'} or (x.get('bucketA') and x.get('bucketB') and x.get('bucketC') and x.get('priceChange24hPct',0)<25)],EARLY_RESERVE)
    take(stage,limit)
    return selected[:limit]

def main():
    now=datetime.now(timezone.utc).isoformat().replace('+00:00','Z'); src={'coinGecko':'FAIL','gateSpot':'FAIL'}; errors=[]; mk=[]
    try:
        for page in range(1,5):
            q=urlencode({'vs_currency':'usd','order':'market_cap_desc','per_page':'250','page':page,'sparkline':'false','price_change_percentage':'1h,24h,7d'})
            mk+=get('https://api.coingecko.com/api/v3/coins/markets?'+q,20,2); time.sleep(.8)
        src['coinGecko']='PASS'
    except Exception as e: errors.append('CoinGecko: '+repr(e))
    try:
        gt=get('https://api.gateio.ws/api/v4/spot/tickers',20,2); pairs={x.get('currency_pair') for x in gt if isinstance(x,dict) and str(x.get('currency_pair','')).endswith('_USDT')}; src['gateSpot']='PASS'
    except Exception as e: pairs=set(); errors.append('Gate tickers: '+repr(e))

    eligible=[]; seen=set()
    for m in mk:
        s=(m.get('symbol') or '').lower(); mc=m.get('market_cap') or 0; vol=m.get('total_volume') or 0
        if not s or s in seen or s in STABLES or s.startswith(WRAPPED): continue
        if not (15_000_000<=mc<=3_000_000_000 and vol>=2_000_000): continue
        gp=s.upper()+'_USDT'
        if gp not in pairs: continue
        seen.add(s); m=dict(m); m['gatePair']=gp; eligible.append(m)
    eligible.sort(key=lambda x:x.get('total_volume') or 0,reverse=True)

    try:
        b=gate_1h('BTC_USDT'); btc={'venue':'Gate Spot','price':b[-1]['c'],'p1':pct(b[-1]['c'],b[-2]['c']),'p4':pct(b[-1]['c'],b[-5]['c']),'timestamp':b[-1]['t']}
    except Exception as e: btc=None; errors.append('BTC reference: '+repr(e))

    res=[]; fails=[]
    if btc:
        with ThreadPoolExecutor(max_workers=6) as ex:
            fs={ex.submit(analyze,m['gatePair'],m,btc):m for m in eligible}
            for f in as_completed(fs):
                m=fs[f]
                try: res.append(f.result())
                except Exception as e: fails.append({'asset':m.get('symbol'),'error':str(e)[:160]})

    res.sort(key=lambda x:x['stageAScore'],reverse=True)
    stage=[x for x in res if x['bucketA'] or x['bucketB'] or x['bucketC'] or x['bucketE'] or x.get('preAccumWatch') or x.get('preAccumTrigger')]
    retained=select_retained(stage)

    total=len(eligible); scanned=len(res); ratio=scanned/total if total else 0
    healthy=src['coinGecko']=='PASS' and src['gateSpot']=='PASS' and btc is not None
    passed=healthy and total>=20 and ratio>=.90
    cov={'bucketA':'PASS' if passed else 'FAIL','bucketB':'PASS' if passed else 'FAIL','bucketC':'PASS' if passed else 'FAIL','bucketD':'EXTERNAL_STAGE0_REQUIRED','bucketE':'PASS' if passed else 'FAIL','preAccum':'PASS' if passed else 'FAIL','eligibleUniverseCount':total,'scannedCount':scanned,'scanSuccessRatio':round(ratio,4)}

    out={
      'schemaVersion':SCHEMA,'module':'cabalMachineDiscovery','ok':passed,'generatedAt':now,'sources':src,'coverage':cov,
      'candidateCountStageA':len(stage),'deepValidatedCount':len(retained),'btcReference':btc,'candidates':retained,
      'retention':{
        'limit':RETENTION_LIMIT,'preAccumReserve':PREACCUM_RESERVE,'earlyReserve':EARLY_RESERVE,'secondLegReserve':SECOND_LEG_RESERVE,
        'preAccumEligible':sum(1 for x in stage if x.get('preAccumWatch') or x.get('preAccumTrigger')),
        'preAccumRetained':sum(1 for x in retained if x.get('preAccumWatch') or x.get('preAccumTrigger')),
        'earlyMoveEligible':sum(1 for x in stage if x.get('classification') in {'PRE-MOVE','EARLY STARTER','EARLY-MOVE'}),
        'earlyMoveRetained':sum(1 for x in retained if x.get('classification') in {'PRE-MOVE','EARLY STARTER','EARLY-MOVE'})
      },
      'failures':fails[:25],'errors':errors,
      'method':'CoinGecko dynamic eligibility + Gate Spot completed 1h OHLCV. v1.4 adds completed-candle PRE-ACCUM base/volume/RS detection before retention, reserved retention slots for PRE-ACCUM/second-leg/early-move candidates, and a refined churn rule that requires weak acceptance instead of treating high RVOL alone as distribution. Manual execution only.'
    }
    os.makedirs(os.path.dirname(OUT) or '.',exist_ok=True)
    json.dump(out,open(OUT+'.tmp','w',encoding='utf-8'),ensure_ascii=False,indent=2)
    os.replace(OUT+'.tmp',OUT)
    print(json.dumps({'ok':passed,'generatedAt':now,'eligible':total,'scanned':scanned,'stageA':len(stage),'retained':len(retained),'preAccum':out['retention']['preAccumEligible'],'preAccumRetained':out['retention']['preAccumRetained'],'earlyRetained':out['retention']['earlyMoveRetained'],'sources':src,'failures':len(fails),'errors':errors},indent=2))

if __name__=='__main__': main()
