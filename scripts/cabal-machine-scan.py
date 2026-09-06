#!/usr/bin/env python3
import json, os, statistics, time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from urllib.parse import urlencode
from urllib.request import Request, urlopen

OUT = os.environ.get('CABAL_OUT', 'data/cabal-machine.json')
UA = 'CABAL-Discovery-Guard/1.1'
STABLES = {'usdt','usdc','dai','fdusd','tusd','usde','usds','pyusd','usdd','frax','crvusd','gho','usd1','usdp','gusd'}
WRAPPED_PREFIXES = ('wbtc','weth','wsteth','steth','cbeth','reth','weeth','ezeth','solvbtc')

def http_json(url, timeout=20, retries=2):
    last = None
    for i in range(retries + 1):
        try:
            req = Request(url, headers={'User-Agent': UA, 'Accept': 'application/json'})
            with urlopen(req, timeout=timeout) as r:
                return json.loads(r.read().decode('utf-8'))
        except Exception as e:
            last = e
            if i < retries:
                time.sleep(i + 1)
    raise last

def pct(a, b):
    return ((a / b) - 1) * 100 if a and b else 0.0

def med(xs):
    xs = [x for x in xs if x is not None and x >= 0]
    return statistics.median(xs) if xs else 0.0

def gate_1h(pair, limit=168):
    q = urlencode({'currency_pair':pair,'interval':'1h','limit':str(limit)})
    rows = http_json('https://api.gateio.ws/api/v4/spot/candlesticks?' + q, 15, 2)
    if not isinstance(rows, list):
        raise RuntimeError('Gate malformed candles')
    now_s = int(time.time())
    bars = []
    for r in rows:
        if not isinstance(r, list) or len(r) < 6:
            continue
        t = int(float(r[0]))
        if t + 3600 > now_s:
            continue
        bars.append({'t':t*1000,'o':float(r[5]),'h':float(r[3]),'l':float(r[4]),'c':float(r[2]),'v':float(r[1])})
    bars.sort(key=lambda x:x['t'])
    if len(bars) < 30:
        raise RuntimeError('insufficient completed Gate 1h bars')
    return bars

def analyze(pair, meta, btc):
    bars = gate_1h(pair)
    last = bars[-1]
    p1 = pct(last['c'], bars[-2]['c'])
    p4 = pct(last['c'], bars[-5]['c']) if len(bars) >= 5 else 0
    p24 = pct(last['c'], bars[-25]['c']) if len(bars) >= 25 else float(meta.get('price_change_percentage_24h') or 0)
    p7 = float(meta.get('price_change_percentage_7d_in_currency') or 0)
    rvol1 = last['v'] / max(med([x['v'] for x in bars[-21:-1]]), 1e-12)
    v4 = sum(x['v'] for x in bars[-4:])
    blocks = [sum(x['v'] for x in bars[i:i+4]) for i in range(max(0,len(bars)-44), len(bars)-4, 4)]
    rvol4 = v4 / max(med(blocks), 1e-12)
    h6 = max(x['h'] for x in bars[-7:-1])
    h24 = max(x['h'] for x in bars[-24:])
    breakout = last['c'] > h6 * 1.002
    reclaim = last['c'] > h6 * 0.998 and bars[-2]['c'] <= h6
    rs1 = p1 - btc['p1']
    rs4 = p4 - btc['p4']

    if rvol1 >= 2.5 and abs(p1) < 0.7:
        vstate = 'CHURN-DISTRIBUTION'
    elif rvol1 >= 2.2 and rvol4 < 1.15:
        vstate = 'ONE-OFF SHOCK'
    elif rvol1 >= 1.35 and rvol4 >= 1.15:
        vstate = 'VOLUME ACCELERATING'
    elif rvol1 < 0.8 and rvol4 < 0.9:
        vstate = 'VOLUME DECELERATING'
    else:
        vstate = 'VOLUME HIGH' if max(rvol1,rvol4) >= 1.25 else 'VOLUME DECELERATING'

    A = p1 >= 1.2 or p4 >= 3.0
    B = rvol1 >= 1.45 or rvol4 >= 1.35
    C = (breakout or reclaim) and (rvol1 >= 1.15 or rs1 >= 1.0 or rs4 >= 2.0)

    second_watch = second_trigger = False
    second_t0 = None
    if len(bars) >= 72:
        best = (-999, None)
        for i in range(max(24,len(bars)-168), max(24,len(bars)-8)):
            m = pct(bars[i]['c'], bars[i-24]['c'])
            if m > best[0]:
                best = (m, i)
        leg_move, leg_end = best
        if leg_end and leg_move >= 12 and len(bars)-leg_end >= 4:
            cons = bars[leg_end+1:-1]
            if len(cons) >= 4:
                ch = max(x['h'] for x in cons); cl = min(x['l'] for x in cons)
                legv = med([x['v'] for x in bars[max(0,leg_end-8):leg_end+1]])
                conv = med([x['v'] for x in cons])
                cooled = bool(legv and conv <= legv * 0.85)
                reset = pct(ch, cl) <= 14 and last['c'] <= cl * 1.14
                renewed = rvol1 >= 1.25 or rvol4 >= 1.15 or rs1 >= 1.2
                second_watch = cooled and reset and last['c'] >= ch * 0.985
                second_trigger = cooled and reset and renewed and last['c'] > ch * 1.002
                if second_trigger:
                    second_t0 = last['t']
    E = second_watch or second_trigger

    poor = (rvol1 >= 1.8 or rvol4 >= 1.6) and p4 < 1.0
    if poor:
        cls = 'CHURN-DISTRIBUTION RISK'
    elif second_trigger:
        cls = 'SECOND-LEG TRIGGER'
    elif second_watch:
        cls = 'SECOND-LEG WATCH'
    elif p24 >= 35:
        cls = 'LATE-POST-PUMP'
    elif C and p24 < 18 and p4 < 8:
        cls = 'EARLY STARTER'
    elif B and p24 < 12 and p4 < 5:
        cls = 'PRE-MOVE'
    elif A and p24 < 25:
        cls = 'EARLY-MOVE'
    elif A or B or C or E:
        cls = 'MID-MOVE'
    else:
        cls = 'NO SETUP'

    support = min(x['l'] for x in bars[-6:])
    score = max(p1,0)*2 + max(p4,0)*0.8 + max(rvol1-1,0)*5 + max(rvol4-1,0)*4 + max(rs1,0)*1.5 + (5 if C else 0) + (8 if second_trigger else 0)
    return {
        'asset':meta['symbol'].upper(),'symbol':pair,'venue':'Gate Spot','name':meta.get('name'),'price':last['c'],
        'marketCap':meta.get('market_cap'),'volume24h':meta.get('total_volume'),
        'priceChange1hPct':round(p1,4),'priceChange4hPct':round(p4,4),'priceChange24hPct':round(p24,4),'priceChange7dPct':round(p7,4),
        'rvol1h':round(rvol1,4),'rvol4h':round(rvol4,4),'volumeState':vstate,
        'relativeStrength1hVsBTC':round(rs1,4),'relativeStrength4hVsBTC':round(rs4,4),
        'breakout6h':breakout,'reclaim6h':reclaim,'support':support,'invalidation':support*0.997,'noChase':h24*1.01,
        'bucketA':A,'bucketB':B,'bucketC':C,'bucketE':E,
        'secondLegWatch':second_watch,'secondLegTrigger':second_trigger,'secondLegT0':second_t0,
        'classification':cls,'stageAScore':round(score,4),'effortVsResult':'POOR' if poor else ('EFFICIENT' if p4 >= 2 and rvol4 >= 1.1 else 'NEUTRAL')
    }

def main():
    generated = datetime.now(timezone.utc).isoformat().replace('+00:00','Z')
    sources = {'coinGecko':'FAIL','gateSpot':'FAIL'}
    errors=[]; markets=[]
    try:
        for page in range(1,5):
            q=urlencode({'vs_currency':'usd','order':'market_cap_desc','per_page':'250','page':page,'sparkline':'false','price_change_percentage':'1h,24h,7d'})
            markets += http_json('https://api.coingecko.com/api/v3/coins/markets?' + q, 20, 2)
            time.sleep(0.8)
        sources['coinGecko']='PASS'
    except Exception as e:
        errors.append('CoinGecko: '+repr(e))

    try:
        gt=http_json('https://api.gateio.ws/api/v4/spot/tickers',20,2)
        pairs={x.get('currency_pair') for x in gt if isinstance(x,dict) and str(x.get('currency_pair','')).endswith('_USDT')}
        sources['gateSpot']='PASS'
    except Exception as e:
        pairs=set(); errors.append('Gate tickers: '+repr(e))

    eligible=[]; seen=set()
    for m in markets:
        s=(m.get('symbol') or '').lower(); mc=m.get('market_cap') or 0; vol=m.get('total_volume') or 0
        if not s or s in seen or s in STABLES or s.startswith(WRAPPED_PREFIXES): continue
        if not (15_000_000 <= mc <= 3_000_000_000 and vol >= 2_000_000): continue
        gp=s.upper()+'_USDT'
        if gp not in pairs: continue
        seen.add(s); m=dict(m); m['gatePair']=gp; eligible.append(m)
    eligible.sort(key=lambda x:x.get('total_volume') or 0, reverse=True)

    try:
        b=gate_1h('BTC_USDT')
        btc={'venue':'Gate Spot','price':b[-1]['c'],'p1':pct(b[-1]['c'],b[-2]['c']),'p4':pct(b[-1]['c'],b[-5]['c']),'timestamp':b[-1]['t']}
    except Exception as e:
        btc=None; errors.append('BTC reference: '+repr(e))

    results=[]; failures=[]
    if btc:
        with ThreadPoolExecutor(max_workers=6) as ex:
            futs={ex.submit(analyze,m['gatePair'],m,btc):m for m in eligible}
            for f in as_completed(futs):
                m=futs[f]
                try: results.append(f.result())
                except Exception as e: failures.append({'asset':m.get('symbol'),'error':str(e)[:180]})
    results.sort(key=lambda x:x['stageAScore'], reverse=True)
    stage=[x for x in results if x['bucketA'] or x['bucketB'] or x['bucketC'] or x['bucketE']]
    deep=stage[:30]
    total=len(eligible); scanned=len(results); ratio=scanned/total if total else 0
    healthy=sources['coinGecko']=='PASS' and sources['gateSpot']=='PASS' and btc is not None
    passed=healthy and total >= 20 and ratio >= 0.90
    coverage={'bucketA':'PASS' if passed else 'FAIL','bucketB':'PASS' if passed else 'FAIL','bucketC':'PASS' if passed else 'FAIL','bucketD':'EXTERNAL_STAGE0_REQUIRED','bucketE':'PASS' if passed else 'FAIL','eligibleUniverseCount':total,'scannedCount':scanned,'scanSuccessRatio':round(ratio,4)}
    out={'schemaVersion':'1.1','module':'cabalMachineDiscovery','ok':passed,'generatedAt':generated,'sources':sources,'coverage':coverage,'candidateCountStageA':len(stage),'deepValidatedCount':len(deep),'btcReference':btc,'candidates':deep,'failures':failures[:25],'errors':errors,'method':'CoinGecko dynamic eligibility + Gate Spot completed 1h OHLCV; 4h metrics derived from completed 1h; independent A/B/C/E screening; Bucket D external.'}
    os.makedirs(os.path.dirname(OUT) or '.', exist_ok=True)
    with open(OUT+'.tmp','w',encoding='utf-8') as f: json.dump(out,f,ensure_ascii=False,indent=2)
    os.replace(OUT+'.tmp',OUT)
    print(json.dumps({'ok':passed,'generatedAt':generated,'eligible':total,'scanned':scanned,'stageA':len(stage),'deep':len(deep),'sources':sources,'errors':errors},indent=2))

if __name__=='__main__': main()
