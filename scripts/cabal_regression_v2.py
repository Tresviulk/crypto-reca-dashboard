#!/usr/bin/env python3
"""Deterministic CABAL v2 regression suite built from real failure/success archetypes."""
from cabal_decision_v2 import evaluate, tail_exchange_inclusion, CORE_ASSETS

def base(asset):
    return {
        "asset":asset,
        "price":1.0,
        "noChase":1.05,
        "protectiveStopReference":0.97,
        "priceChange1hPct":1.0,
        "priceChange4hPct":2.0,
        "priceChange6hPct":3.0,
        "priceChange24hPct":5.0,
        "rvol1h":5.0,
        "relativeStrength1hVsBTC":1.0,
        "relativeStrength4hVsBTC":1.0,
        "intrahourMovePct":1.0,
        "intrahourRelativeStrengthVsBTC":1.0,
        "stageAScore":70,
        "bucketB":True,
        "bucketC":True,
        "effortVsResult":"EFFICIENT",
        "classification":"EARLY-MOVE",
        "entryConfirmation15m":True,
        "fastPumpTrigger":True,
        "fastPumpWatch":True,
        "fastPump15m":{"rvol15m":5.0,"trigger":True,"watch":True,"wideBaseWatch":False,"wideBaseTrigger":False,"invalidation15m":0.97},
    }

def expect(name,row,tier):
    got=evaluate(row)
    assert got["decisionTier"]==tier, f"{name}: expected {tier}, got {got}"
    return got

# VVV: real good alert archetype -> BUY.
vvv=base("VVV")
vvv.update({
    "price":27.946,"noChase":29.68087,"protectiveStopReference":27.009528,
    "priceChange1hPct":1.3745,"priceChange4hPct":3.4815,"priceChange24hPct":-2.3783,
    "rvol1h":4.8227,"relativeStrength1hVsBTC":1.3686,"relativeStrength4hVsBTC":3.6941,
    "intrahourRelativeStrengthVsBTC":1.3945,"stageAScore":52.2646,
    "fastPump15m":{"rvol15m":42.4481,"trigger":True,"watch":True,"wideBaseWatch":False,"wideBaseTrigger":False,"invalidation15m":27.009528}
})
vvv_result=expect("VVV",vvv,"BUY_NOW")
assert vvv_result["notifyBuyEligible"] is True
assert vvv_result["scalpBuyEligible"] is True
assert vvv_result["signalLane"] in {"SCALP","SCALP+RUNNER"}

# PROVE: moderate/flat signal -> never BUY.
prove=base("PROVE")
prove.update({
    "price":0.2249,"noChase":0.228058,"protectiveStopReference":0.2195184,
    "priceChange1hPct":0.2244,"priceChange4hPct":1.5924,"priceChange24hPct":2.0,
    "rvol1h":5.35,"relativeStrength1hVsBTC":0.4436,"relativeStrength4hVsBTC":1.59,
    "intrahourRelativeStrengthVsBTC":0.7666,"stageAScore":41.5005,
    "fastPump15m":{"rvol15m":4.3218,"trigger":True,"watch":True,"wideBaseWatch":False,"wideBaseTrigger":False,"invalidation15m":0.2195184}
})
assert evaluate(prove)["decisionTier"]!="BUY_NOW"

# BABY: negative 1h alpha -> never BUY.
baby=base("BABY")
baby.update({
    "price":0.01191,"noChase":0.012019,"protectiveStopReference":0.01157352,
    "priceChange1hPct":-1.269,"priceChange4hPct":0.2577,
    "relativeStrength1hVsBTC":-1.0498,"relativeStrength4hVsBTC":0.2554,
    "intrahourRelativeStrengthVsBTC":2.1066,"stageAScore":64.5434,
    "bucketC":False,"fastPump15m":{"rvol15m":2.6991,"trigger":True,"watch":True,"wideBaseWatch":False,"wideBaseTrigger":False,"invalidation15m":0.01157352}
})
assert evaluate(baby)["decisionTier"]!="BUY_NOW"

# CELR archetype: wide base + exceptional early alpha -> BUY.
celr=base("CELR")
celr.update({
    "price":0.00260,"noChase":0.002717,"protectiveStopReference":0.00252,
    "priceChange1hPct":2.2,"priceChange4hPct":5.5,"priceChange24hPct":12.3,
    "rvol1h":31.5,"relativeStrength1hVsBTC":2.85,"relativeStrength4hVsBTC":9.09,
    "intrahourRelativeStrengthVsBTC":1.1,"stageAScore":89,
    "fastPump15m":{"rvol15m":4.75,"trigger":True,"watch":True,"wideBaseWatch":True,"wideBaseTrigger":True,"invalidation15m":0.00252}
})
celr_result=expect("CELR",celr,"BUY_NOW")
assert celr_result["notifyBuyEligible"] is True
assert celr_result["runnerBuyEligible"] is True
assert celr_result["signalLane"] in {"RUNNER","SCALP+RUNNER"}

# KMNO: real early momentum archetype must at least surface as WATCH even if stop is too wide for BUY.
kmno=base("KMNO")
kmno.update({
    "price":0.031502,"noChase":0.03200488,"protectiveStopReference":0.029057304,
    "priceChange1hPct":9.3037,"priceChange4hPct":13.9882,"priceChange6hPct":15.5487,"priceChange24hPct":11.0457,
    "rvol1h":15.8459,"relativeStrength1hVsBTC":8.7947,"relativeStrength4hVsBTC":12.946,
    "intrahourMovePct":1.1463,"intrahourRelativeStrengthVsBTC":1.2398,"stageAScore":118.798,
    "fastPumpTrigger":False,"entryConfirmation15m":False,
    "fastPump15m":{"rvol15m":4.5811,"trigger":False,"watch":False,"wideBaseWatch":False,"wideBaseTrigger":False,"invalidation15m":0.029057304}
})
kmno_result=expect("KMNO",kmno,"WATCH")
assert kmno_result["runnerCandidateEligible"] is False
assert kmno_result["notifyWatchEligible"] is False

# EARLY RUNNER: not a BUY yet, but should surface as a rare runner candidate.
runner=base("RUNNERX")
runner.update({
    "price":1.0,"noChase":1.08,"protectiveStopReference":0.96,
    "priceChange1hPct":1.6,"priceChange4hPct":3.0,"priceChange6hPct":4.2,"priceChange24hPct":6.0,
    "rvol1h":5.0,"relativeStrength1hVsBTC":1.8,"relativeStrength4hVsBTC":2.5,
    "intrahourMovePct":0.7,"intrahourRelativeStrengthVsBTC":0.8,"stageAScore":75,
    "bucketB":True,"bucketC":False,"preAccumWatch":True,"preAccumVolumeBuild6h":1.8,
    "preAccumBaseRange12hPct":8.0,
    "entryConfirmation15m":False,"fastPumpTrigger":False,
    "fastPump15m":{"rvol15m":3.0,"trigger":False,"watch":True,"wideBaseWatch":False,"wideBaseTrigger":False,"invalidation15m":0.96}
})
runner_result=expect("RUNNERX",runner,"WATCH")
assert runner_result["runnerCandidateEligible"] is True
assert runner_result["notifyWatchEligible"] is True
assert runner_result["signalLane"]=="RUNNER"

# AGLD: too little headroom to no-chase -> no BUY.
agld=base("AGLD")
agld.update({"price":0.1888,"noChase":0.190284,"protectiveStopReference":0.183,"stageAScore":102.07})
assert evaluate(agld)["decisionTier"]!="BUY_NOW"

# AWE: stale/no 15m execution confirmation -> no BUY.
awe=base("AWE")
awe.update({"entryConfirmation15m":False,"fastPumpTrigger":False,"fastPump15m":{"rvol15m":0.0841,"trigger":False,"watch":False,"invalidation15m":0.0670}})
assert evaluate(awe)["decisionTier"]!="BUY_NOW"

# AVAX: CORE acceleration must surface at least as WATCH even before a perfect BUY structure.
avax=base("AVAX")
avax.update({
    "price":10.406,"noChase":10.9,"protectiveStopReference":10.02,
    "priceChange1hPct":6.5,"priceChange4hPct":8.0,"priceChange24hPct":9.0,
    "rvol1h":1.8,"relativeStrength1hVsBTC":2.5,"relativeStrength4hVsBTC":3.0,
    "intrahourMovePct":1.5,"intrahourRelativeStrengthVsBTC":1.3,"stageAScore":45,
    "bucketC":False,"entryConfirmation15m":False,"fastPumpTrigger":False,
    "fastPump15m":{"rvol15m":2.0,"trigger":False,"watch":True,"wideBaseWatch":False,"wideBaseTrigger":False,"invalidation15m":10.02}
})
expect("AVAX",avax,"WATCH")

# Deep-tail discovery: RARI-like exchange-native mover outside CoinGecko top-1000 must enter discovery.
assert tail_exchange_inclusion(120_000,8.0) is True
assert tail_exchange_inclusion(50_000,8.0) is False
assert tail_exchange_inclusion(120_000,30.0) is False



# CORE contract must never silently shrink.
assert CORE_ASSETS=={"BTC","ETH","SOL","XRP","AVAX","HBAR","ONDO"}

# BTC is its own benchmark: absolute momentum/volume can confirm CORE BUY without RS-vs-BTC.
btc=base("BTC")
btc.update({
    "price":81000,"noChase":83000,"protectiveStopReference":79000,
    "priceChange1hPct":0.9,"priceChange4hPct":1.8,"priceChange24hPct":4.0,
    "rvol1h":1.7,"relativeStrength1hVsBTC":0.0,"relativeStrength4hVsBTC":0.0,
    "intrahourMovePct":0.7,"intrahourRelativeStrengthVsBTC":0.0,"stageAScore":35,
    "fastPumpTrigger":False,"entryConfirmation15m":False,
    "fastPump15m":{"rvol15m":1.8,"trigger":False,"watch":True,"baseHigh4h15m":80900,"invalidation15m":79000}
})
expect("BTC",btc,"BUY_NOW")

print("CABAL v2 regression: PASS")
