#!/usr/bin/env python3
import importlib.util
from pathlib import Path

p=Path(__file__).with_name("cabal_ntfy_v2.py")
spec=importlib.util.spec_from_file_location("cabal_ntfy_v2",p)
m=importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)

base={
    "asset":"WOD",
    "decisionTier":"BUY_NOW",
    "buyNowEligible":True,
    "notifyBuyEligible":True,
    "qualityScore":70,
    "classification":"SECOND-LEG TRIGGER",
    "price":0.00540,
    "decisionEntryMax":0.00550,
    "decisionStop":0.00525,
    "decisionNoChaseHeadroomPct":1.85,
    "decisionStopDistancePct":2.78,
    "volume24h":85_401,
}
assert m.execution_valid(base) is False, "thin-liquidity WOD-style BUY must be blocked"
liquid=dict(base,asset="TEST",volume24h=500_000)
assert m.execution_valid(liquid) is True, "liquid equivalent should pass relay execution gate"

print("CABAL NTFY regression: PASS")
