import fs from "node:fs";
import vm from "node:vm";

let src=fs.readFileSync("cloudflare/cabal-scanner/src/index.js","utf8");
src=src.replace(/export default\s*\{/,"globalThis.__worker = {");
src += "\nglobalThis.__cabalTest={guardCandidates,guardPilotDecision};\n";

const context={
  console, URL, Date, Math, JSON, Number, String, Boolean, Array, Object,
  Set, Map, Promise, RegExp, Error, TypeError, parseInt, parseFloat, isFinite,
  setTimeout, clearTimeout, AbortController,
  fetch:async()=>{ throw new Error("fetch disabled in regression"); }
};
vm.createContext(context);
vm.runInContext(src,context,{filename:"cabal-worker-index.js"});

const {guardCandidates,guardPilotDecision}=context.__cabalTest;
if(typeof guardCandidates!=="function" || typeof guardPilotDecision!=="function"){
  throw new Error("worker test hooks unavailable");
}

const now=1_800_000_000_000;
const qntCurrent={
  t:now,
  a:{
    QNT:[224.66,773_000_000,-17.8,"BYBIT","QNTUSDT"]
  }
};
const qntHistory=[
  {t:now-5*60_000,a:{QNT:[210.00,760_000_000,-23.0,"BYBIT","QNTUSDT"]}},
  {t:now-3*60_000,a:{QNT:[216.00,765_000_000,-21.0,"BYBIT","QNTUSDT"]}},
  {t:now-1*60_000,a:{QNT:[220.00,770_000_000,-19.0,"BYBIT","QNTUSDT"]}}
];
const qntCandidates=guardCandidates(qntCurrent,qntHistory);
const qnt=qntCandidates.find(x=>x.base==="QNT");
if(!qnt) throw new Error("QNT recovery candidate was missed");
if(qnt.recoveryLane!==true) throw new Error("QNT recovery lane not tagged");

const qntMetrics={
  p15:2.0,p1:8.35,p4:-3.3,rs1:8.0,rs4:-2.5,
  rvol15m:2.1,rvol1h:1.8,
  lite:{secondLegTrigger:false},
  noChase:240.0,headroom:6.8,
  stop:218.0,stopDistancePct:2.965
};
const qntDecision=guardPilotDecision(qnt,qntMetrics);
if(qntDecision.buy!==true) throw new Error("QNT recovery failed execution decision");
if(qntDecision.reason!=="RECOVERY_ACCEL_CLOUD_CONFIRMED") throw new Error("QNT wrong recovery reason");
if(qntDecision.recoveryBuyEligible!==true) throw new Error("QNT recovery eligibility missing");

const wod={
  base:"WOD",venue:"KUCOIN",venueSymbol:"WOD-USDT",
  price:0.0054,turnover24h:85_401,change24h:3.0,
  change1m:0.8,change3m:1.1,change5m:1.5,
  volumeAccel5m:3.0,guardScore:70,recoveryLane:false
};
const wodMetrics={
  p15:1.0,p1:2.0,p4:3.0,rs1:1.5,rs4:1.0,
  rvol15m:2.0,rvol1h:2.0,
  lite:{secondLegTrigger:false},
  noChase:0.0058,headroom:7.4,
  stop:0.00525,stopDistancePct:2.78
};
const wodDecision=guardPilotDecision(wod,wodMetrics);
if(wodDecision.buy!==false) throw new Error("WOD thin-liquidity BUY was not blocked");

console.log("CABAL worker regression: PASS — QNT recovery caught, WOD thin BUY blocked");
