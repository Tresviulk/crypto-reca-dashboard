#!/usr/bin/env python3
"""CABAL v1.5.1 — resilient exchange-native PRE-ACCUM wrapper.

Fixes the two live failures observed on GitHub Actions:
- CoinGecko 429 must not zero the PRE-STAGE-A universe.
- Bybit 403 must not zero the lane when KuCoin + Gate are healthy.

Main CABAL truth remains separately fail-closed. PRE-ACCUM gets its own operational flag.
"""
import importlib.util, json, os, time
from urllib.parse import urlencode

HERE=os.path.dirname(__file__)
BASE=os.path.join(HERE,'cabal-machine-scan-v15.py')
spec=importlib.util.spec_from_file_location('cabal_v15',BASE)
mod=importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

mod.SCHEMA='1.5.1'
mod.UA='CABAL-Discovery-Guard/1.5.1'
_state={'cgFallback':False,'cgPages':0}


def resilient_coingecko():
    """Try a lower-pressure CG pull; if rate-limited, synthesize universe metadata from exchanges.

    Synthetic rows intentionally leave market_cap unknown. PRE-ACCUM may still evaluate them,
    but the tightened unknown-market-cap gate below requires stronger independent evidence.
    """
    rows=[]
    try:
        for page in range(1,5):
            q=urlencode({'vs_currency':'usd','order':'market_cap_desc','per_page':'250','page':page,'sparkline':'false','price_change_percentage':'1h,24h,7d'})
            rows += mod.get('https://api.coingecko.com/api/v3/coins/markets?'+q,20,2)
            _state['cgPages']=page
            time.sleep(.9)
        if rows:
            return rows
    except Exception:
        pass

    _state['cgFallback']=True
    ku={}; by={}; gate={}
    try: ku=mod.fetch_kucoin_pairs()
    except Exception: pass
    try: by=mod.fetch_bybit_pairs()
    except Exception: pass
    try: gate=mod.fetch_gate_pairs()
    except Exception: pass

    # The independent broad universe is anchored to primary venues KuCoin/Bybit.
    # Gate is a data/venue fallback, not a source of Gate-only synthetic names, which
    # avoids xStock/tokenized-equity leakage when CoinGecko metadata is unavailable.
    bases=set(ku)|set(by)
    out=[]
    for a in bases:
        vals=[]
        for d in (ku,by,gate):
            if a in d:
                try: vals.append(float(d[a].get('turnover') or 0))
                except Exception: pass
        turn=max(vals) if vals else 0.0
        if turn < mod.PRE_MIN_TURNOVER: continue
        out.append({
            'id':'exchange:'+a.lower(),
            'symbol':a.lower(),
            'name':a,
            'market_cap':0,
            'total_volume':turn,
            'price_change_percentage_1h_in_currency':0,
            'price_change_percentage_24h_in_currency':0,
            'price_change_percentage_7d_in_currency':0,
        })
    return out

mod.fetch_coingecko=resilient_coingecko
_orig_metrics=mod.metrics_from_bars


def tightened_metrics(b,m,btc):
    met=_orig_metrics(b,m,btc)
    mc=float(m.get('market_cap') or 0)
    if mc<=0:
        # Unknown market cap: do not guess. Require stronger liquidity plus >=2
        # independent participation/relative-interest confirmations.
        turn=float(m.get('effectiveTurnover') or m.get('total_volume') or 0)
        sigs=sum([
            bool(met['r1']>=1.15),
            bool(met['volumeBuild'] is not None and met['volumeBuild']>=1.20),
            bool(met['rs1']>=.20),
            bool(met['p6']>=.25),
        ])
        met['watch']=bool(met['watch'] and turn>=500_000 and sigs>=2)
        met['trigger']=bool(met['watch'] and met['r1']>=1.35 and met['price']>=met['baseHigh']*.99 and met['p1']>=.15)
    return met

mod.metrics_from_bars=tightened_metrics
mod.main()

# Post-process source truth without rewriting failed main coverage as healthy.
out=mod.OUT
d=json.load(open(out,encoding='utf-8'))
d['schemaVersion']='1.5.1'
d['preAccumOperational']=bool(d.get('coverage',{}).get('preAccum')=='PASS')
d['mainMachineOperational']=bool(all(d.get('coverage',{}).get(k)=='PASS' for k in ('bucketA','bucketB','bucketC','bucketE')))
d['sourceMode']='EXCHANGE_NATIVE_FALLBACK' if _state['cgFallback'] else 'COINGECKO_ENRICHED'
if _state['cgFallback']:
    d['sources']['coinGecko']='FALLBACK_EXCHANGE_UNIVERSE'
    d.setdefault('warnings',[]).append('CoinGecko metadata unavailable/rate-limited; PRE-ACCUM universe built from primary exchange tickers. Market-cap-unknown names use stronger confirmation gates. Main CABAL market-cap coverage remains fail-closed.')
d['method']='v1.5.1: independent >=250k PRE-STAGE-A universe survives CoinGecko/Bybit source failures; KuCoin/Bybit primary ticker universe with Gate OHLCV fallback; explicit 250k-2M band; max-10 deep-lite and sub-2M reservation; unknown-market-cap names require stronger liquidity + >=2 independent confirmations; main CABAL A/B/C/E remains separately fail-closed; no auto-trading.'
tmp=out+'.v151.tmp'; json.dump(d,open(tmp,'w',encoding='utf-8'),ensure_ascii=False,indent=2); os.replace(tmp,out)
print(json.dumps({'schemaVersion':d['schemaVersion'],'preAccumOperational':d['preAccumOperational'],'mainMachineOperational':d['mainMachineOperational'],'sourceMode':d['sourceMode'],'coverage':d.get('coverage'),'sources':d.get('sources')},indent=2))
