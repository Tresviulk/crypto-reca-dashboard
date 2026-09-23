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
assert kmno_result["runnerCandidateEligible"] is True
assert kmno_result["runnerCandidateStage"]=="CONFIRMED"
assert kmno_result["notifyWatchEligible"] is True

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

# 2026-09-21 ONDO failure: CORE must NOT bypass setup quality.
ondo_bad=base("ONDO")
ondo_bad.update({
    "price":0.43602,"noChase":0.48378,"protectiveStopReference":0.42211476,
    "priceChange1hPct":0.6805,"priceChange4hPct":1.3153,"priceChange6hPct":-0.7633,"priceChange24hPct":4.8559,
    "rvol1h":0.5743,"relativeStrength1hVsBTC":0.4896,"relativeStrength4hVsBTC":0.6415,
    "intrahourMovePct":1.6222,"intrahourRelativeStrengthVsBTC":1.2952,"stageAScore":20,
    "bucketB":False,"bucketC":False,"effortVsResult":"NEUTRAL","classification":"NO SETUP",
    "entryConfirmation15m":True,"fastPumpTrigger":True,
    "fastPump15m":{"rvol15m":1.8,"trigger":True,"watch":True,"wideBaseWatch":False,"wideBaseTrigger":False,"invalidation15m":0.42211476}
})
ondo_bad_result=evaluate(ondo_bad)
assert ondo_bad_result["decisionTier"]!="BUY_NOW"
assert ondo_bad_result["notifyBuyEligible"] is False

# OPG-type case: ~1% no-chase headroom may block BUY but must NOT hide an early RUNNER watch.
opg=base("OPG")
opg.update({
    "price":0.11808,"noChase":0.119301,"protectiveStopReference":0.11336,
    "priceChange1hPct":3.4882,"priceChange4hPct":1.5742,"priceChange6hPct":2.1453,"priceChange24hPct":5.3721,
    "priceChange72hPct":8.0,"rvol1h":9.7725,"relativeStrength1hVsBTC":3.3481,"relativeStrength4hVsBTC":1.2598,
    "intrahourMovePct":0.2,"intrahourRelativeStrengthVsBTC":0.2,"stageAScore":60,
    "bucketB":True,"bucketC":True,"preAccumWatch":True,"preAccumTrigger":True,
    "effortVsResult":"CONSTRUCTIVE","classification":"PRE-ACCUMULATION TRIGGER",
    "entryConfirmation15m":False,"fastPumpTrigger":False,
    "fastPump15m":{"rvol15m":1.4,"trigger":False,"watch":True,"wideBaseWatch":False,"wideBaseTrigger":False,"invalidation15m":0.11336}
})
opg_result=expect("OPG_RUNNER",opg,"WATCH")
assert opg_result["runnerCandidateEligible"] is True
assert opg_result["runnerCandidateStage"]=="EARLY"
assert opg_result["notifyWatchEligible"] is True

# UAI-type case: strong pre-accumulation may surface before Bucket B completes.
uai=base("UAI")
uai.update({
    "price":0.43233,"noChase":0.44183,"protectiveStopReference":0.416,
    "priceChange1hPct":1.8175,"priceChange4hPct":3.089,"priceChange6hPct":2.1578,"priceChange24hPct":9.0902,
    "priceChange72hPct":8.0,"rvol1h":1.2852,"relativeStrength1hVsBTC":1.4377,"relativeStrength4hVsBTC":2.9689,
    "intrahourMovePct":2.4892,"intrahourRelativeStrengthVsBTC":2.4059,"stageAScore":50,
    "bucketB":False,"bucketC":False,"preAccumWatch":True,"preAccumTrigger":False,
    "effortVsResult":"CONSTRUCTIVE","classification":"PRE-ACCUMULATION WATCH",
    "entryConfirmation15m":False,"fastPumpTrigger":False,
    "fastPump15m":{"rvol15m":1.2,"trigger":False,"watch":False,"wideBaseWatch":False,"wideBaseTrigger":False,"invalidation15m":0.416}
})
uai_result=expect("UAI_RUNNER",uai,"WATCH")
assert uai_result["runnerCandidateEligible"] is True
assert uai_result["runnerCandidateStage"]=="EARLY"
assert uai_result["notifyWatchEligible"] is True

# VVV-type second acceleration: +14% 24h must not automatically hide a fresh early runner.
vvv_second=base("VVV")
vvv_second.update({
    "price":30.568,"noChase":31.63926,"protectiveStopReference":29.200728,
    "priceChange1hPct":2.4088,"priceChange4hPct":8.5242,"priceChange6hPct":7.4635,"priceChange24hPct":14.0469,
    "priceChange72hPct":19.0806,"priceChange7dPct":39.3,
    "rvol1h":3.1494,"relativeStrength1hVsBTC":3.1658,"relativeStrength4hVsBTC":8.4324,
    "intrahourMovePct":0.0,"intrahourRelativeStrengthVsBTC":-0.0369,"stageAScore":79.1325,
    "bucketB":True,"bucketC":False,"preAccumWatch":True,"preAccumTrigger":True,
    "preAccumVolumeBuild6h":1.761,"preAccumBaseRange12hPct":11.0293,
    "effortVsResult":"EFFICIENT","classification":"PRE-ACCUMULATION TRIGGER",
    "entryConfirmation15m":False,"fastPumpTrigger":False,
    "fastPump15m":{"rvol15m":0.6455,"trigger":False,"watch":False,"wideBaseWatch":False,"wideBaseTrigger":False,"invalidation15m":29.200728}
})
vvv_second_result=expect("VVV_SECOND_RUNNER",vvv_second,"WATCH")
assert vvv_second_result["runnerCandidateEligible"] is True
assert vvv_second_result["notifyWatchEligible"] is True

# PHA 2026-09-21: fresh re-accumulation after an extended 72h move must still surface as RUNNER.
pha_reaccum=base("PHA")
pha_reaccum.update({
    "price":0.0391,"noChase":0.039491,"protectiveStopReference":0.0377484,
    "priceChange1hPct":2.3684,"priceChange4hPct":3.7333,"priceChange6hPct":4.8518,
    "priceChange24hPct":10.5114,"priceChange72hPct":26.2987,"priceChange7dPct":41.5,
    "rvol1h":1.6607,"relativeStrength1hVsBTC":2.2283,"relativeStrength4hVsBTC":3.4189,
    "intrahourMovePct":0.5141,"intrahourRelativeStrengthVsBTC":0.7232,
    "stageAScore":41.2454,"bucketB":True,"bucketC":True,
    "preAccumWatch":True,"preAccumTrigger":True,"preAccumVolumeBuild6h":1.2021,
    "preAccumBaseRange12hPct":8.7079,
    "effortVsResult":"CONSTRUCTIVE","classification":"PRE-ACCUMULATION TRIGGER",
    "entryConfirmation15m":False,"fastPumpTrigger":False,
    "fastPump15m":{"rvol15m":1.7703,"trigger":False,"watch":True,"wideBaseWatch":False,"wideBaseTrigger":False,"invalidation15m":0.0377484}
})
pha_reaccum_result=expect("PHA_REACCUM",pha_reaccum,"WATCH")
assert pha_reaccum_result["runnerCandidateEligible"] is True
assert pha_reaccum_result["runnerCandidateStage"]=="EARLY"
assert pha_reaccum_result["notifyWatchEligible"] is True

# M-type stale extension: strong short-term stats after a large 72h move should not generate a fresh RUNNER.
m_stale=base("M")
m_stale.update({
    "price":1.5414,"noChase":1.7957,"protectiveStopReference":1.48,
    "priceChange1hPct":3.3424,"priceChange4hPct":4.6523,"priceChange6hPct":3.7706,"priceChange24hPct":0.3284,
    "priceChange72hPct":26.0,"priceChange7dPct":35.0,
    "rvol1h":2.0153,"relativeStrength1hVsBTC":2.7861,"relativeStrength4hVsBTC":3.9983,
    "intrahourMovePct":0.9166,"intrahourRelativeStrengthVsBTC":0.7946,"stageAScore":70,
    "bucketB":True,"bucketC":True,"preAccumWatch":True,
    "effortVsResult":"CONSTRUCTIVE","classification":"PRE-ACCUMULATION WATCH",
    "entryConfirmation15m":False,"fastPumpTrigger":False,
    "fastPump15m":{"rvol15m":1.5,"trigger":False,"watch":True,"wideBaseWatch":False,"wideBaseTrigger":False,"invalidation15m":1.48}
})
m_stale_result=expect("M_STALE",m_stale,"WATCH")
assert m_stale_result["runnerCandidateEligible"] is False
assert m_stale_result["notifyWatchEligible"] is False

# KMNO-like fallback: if the earliest scan was missed, exceptional acceleration must still reach NTFY as WATCH, never BUY.
kmno_fallback=evaluate(kmno)
assert kmno_fallback["runnerCandidateEligible"] is True
assert kmno_fallback["runnerCandidateStage"]=="CONFIRMED"
assert kmno_fallback["notifyWatchEligible"] is True
assert kmno_fallback["notifyBuyEligible"] is False

# Deep-tail discovery: RARI-like exchange-native mover outside CoinGecko top-1000 must enter discovery.
assert tail_exchange_inclusion(120_000,8.0) is True
assert tail_exchange_inclusion(50_000,8.0) is False
assert tail_exchange_inclusion(120_000,30.0) is False



# SECOND-LEG live-confirmation regression (UB 2026-09-23 archetype):
# a real continuation trigger with strong live participation must become a small
# executable PILOT BUY when a fresh 15m stop is available. The stale 1h stop
# must not veto the setup.
ub=base("UB")
ub.update({
    "price":0.154624,"noChase":0.16049203,"protectiveStopReference":None,
    "priceChange1hPct":5.1303,"priceChange4hPct":4.6055,"priceChange6hPct":4.7777,
    "priceChange24hPct":5.9154,"priceChange72hPct":17.8209,
    "rvol1h":21.9475,"relativeStrength1hVsBTC":5.7565,"relativeStrength4hVsBTC":6.5436,
    "intrahourMovePct":0.3928,"intrahourRelativeStrengthVsBTC":0.4817,
    "stageAScore":93.1453,"bucketB":True,"bucketC":True,
    "secondLegWatch":True,"secondLegTrigger":True,
    "effortVsResult":"EFFICIENT","classification":"SECOND-LEG TRIGGER",
    "entryConfirmation15m":True,"fastPumpTrigger":False,
    "fastPump15m":{
        "rvol15m":2.3066,"trigger":False,"watch":False,
        "wideBaseWatch":False,"wideBaseTrigger":False,
        "invalidation15m":0.14206944,"wideBaseInvalidation15m":0.151258536
    }
})
ub_result=expect("UB_SECOND_LEG_LIVE",ub,"BUY_NOW")
assert ub_result["secondLegBuyEligible"] is True
assert ub_result["pilotBuyEligible"] is True
assert ub_result["notifyBuyEligible"] is True
assert ub_result["signalLane"]=="SECOND-LEG PILOT"
assert 1.0 <= ub_result["decisionStopDistancePct"] <= 3.5

# The same structural label without live 15m confirmation must remain WATCH/NONE.
ub_stale=dict(ub)
ub_stale["entryConfirmation15m"]=False
ub_stale["fastPump15m"]=dict(ub["fastPump15m"],rvol15m=0.6)
ub_stale_result=evaluate(ub_stale)
assert ub_stale_result["decisionTier"]!="BUY_NOW"
assert ub_stale_result["notifyBuyEligible"] is False

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


# MEW 2026-09-21: discovered only after +12% 24h. Keep internal WATCH if useful,
# but never notify the user as an "EARLY" runner unless a real second-leg/re-accum exists.
mew_late=base("MEW")
mew_late.update({
    "price":0.000466,"noChase":0.00049086,"protectiveStopReference":0.00044322,
    "priceChange1hPct":3.1111,"priceChange4hPct":4.0359,"priceChange6hPct":5.4545,
    "priceChange24hPct":12.3487,"priceChange72hPct":12.3487,
    "rvol1h":25.1535,"relativeStrength1hVsBTC":2.6574,"relativeStrength4hVsBTC":2.3762,
    "intrahourMovePct":0.431,"intrahourRelativeStrengthVsBTC":0.2831,"stageAScore":89.9343,
    "bucketB":True,"bucketC":True,"preAccumWatch":False,"preAccumTrigger":False,
    "effortVsResult":"EFFICIENT","classification":"EARLY STARTER",
    "entryConfirmation15m":False,"fastPumpTrigger":False,"fastPumpWatch":True,
    "fastPump15m":{"rvol15m":208.2022,"trigger":False,"watch":True,"wideBaseWatch":False,"wideBaseTrigger":False,"invalidation15m":0.00044322}
})
mew_late_result=expect("MEW_LATE_WATCH",mew_late,"WATCH")
assert mew_late_result["notifyWatchEligible"] is False
assert mew_late_result["userWatchSuppressedLateMove"] is True
