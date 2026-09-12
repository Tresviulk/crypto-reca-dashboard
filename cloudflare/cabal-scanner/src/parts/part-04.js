  const secondLegTrigger = secondLegWatch && freshParticipation && positiveReaccel && last.c >= breakoutLevel * 0.985;

  const supportWindow = a60.slice(Math.max(0,a60.length-8));
  const support = Math.min(...supportWindow.map(x=>x.l));

  return {
    currentPrice:last.c,
    move1hPct:move1h,
    move6hPct:move6h,
    move24hPct:move24h,
    move72hPct:move72h,
    move7dApproxPct:move7d,
    rvol1h:Math.round(rvol1h*100)/100,
    baseRange12hPct:baseRangePct == null ? null : Math.round(baseRangePct*100)/100,
    volumeCooledDuringBase:volumeCooled,
    breakoutLevel,
    structuralSupport1h:support,
    priorLegMaterial,
    secondLegWatch,
    secondLegTrigger
  };
}

function deepAnalysis(a15, a60, a240){
  if(!a15.length || !a60.length || !a240.length) return null;

  const l15 = a15[a15.length-1];
  const l60 = a60[a60.length-1];
  const l240 = a240[a240.length-1];

  const base15 = median(a15.slice(Math.max(0,a15.length-21),a15.length-1).map(x=>x.v)) || l15.v;
  const base60 = median(a60.slice(Math.max(0,a60.length-21),a60.length-1).map(x=>x.v)) || l60.v;
  const base240 = median(a240.slice(Math.max(0,a240.length-9),a240.length-1).map(x=>x.v)) || l240.v;

  const r15 = l15.v/base15;
  const r60 = l60.v/base60;
  const r240 = l240.v/base240;

  let upperWicks = 0;
  for(const x of a15.slice(Math.max(0,a15.length-4))){
    const range = x.h-x.l;
    if(range > 0 && (x.h-Math.max(x.o,x.c))/range >= 0.45) upperWicks++;
  }

  const move60 = pct(l60.c,l60.o);
  const closePos = (l60.h-l60.l) > 0 ? (l60.c-l60.l)/(l60.h-l60.l) : 0.5;

  let volumeState = "NORMAL";
  if(r15 >= 3 && r60 < 1.2) volumeState = "ONE-OFF SHOCK";
  else if(r60 >= 1.8 && r15 >= 1.4) volumeState = "VOLUME ACCELERATING";
  else if(r60 >= 1.3 || r15 >= 1.5) volumeState = "VOLUME HIGH";
  else if(r60 < 0.8 && r15 < 0.8) volumeState = "VOLUME DECELERATING";

  let effort = "NEUTRAL";
  if((r60 >= 2 && Math.abs(move60) < 0.8) || upperWicks >= 2){
    effort = "CHURN/DISTRIBUTION RISK";
  }else if(r60 >= 1.4 && move60 >= 0.8 && closePos >= 0.65){
    effort = "EFFICIENT POSITIVE / PRICE ACCEPTANCE";
  }else if(r60 >= 1.2 && move60 > 0 && closePos >= 0.55){
    effort = "POSITIVE BUT UNCONFIRMED";
  }

  const last6 = a60.slice(Math.max(0,a60.length-6));
  const last4 = a60.slice(Math.max(0,a60.length-4));
  const recentHigh = Math.max(...last6.map(x=>x.h));
  const support = Math.min(...last4.map(x=>x.l));

  return {
    currentPrice:l15.c,
    move15mPct:pct(l15.c,l15.o),
    move1hPct:move60,
    move4hPct:pct(l240.c,l240.o),
    rvol15m:Math.round(r15*100)/100,
    rvol1h:Math.round(r60*100)/100,
    rvol4h:Math.round(r240*100)/100,
    volumeState,
    effortVsResult:effort,
    upperWickCountLast4x15m:upperWicks,
    recent6hHigh:recentHigh,
    structuralSupport4h:support,
    distanceFrom6hHighPct:Math.round(pct(l15.c,recentHigh)*100)/100
  };
}

function classify(c, d, lite){
  if(c.stageAChurnRisk || (d && d.effortVsResult === "CHURN/DISTRIBUTION RISK")){
    return "CHURN/DISTRIBUTION RISK";
  }

  if(lite && lite.secondLegTrigger) return "SECOND-LEG TRIGGER";
  if(lite && lite.secondLegWatch) return "SECOND-LEG WATCH";

  if(c.microcapAnomaly) return "MICROCAP ANOMALY WATCH";

  if((c.change24h || 0) >= 40 || (c.change4h || 0) >= 15 || (c.change1h || 0) >= 8){
    return "LATE/POST-PUMP";
  }

  if((c.change4h || 0) >= 8) return "MID-MOVE";

  if(
    d &&
    d.volumeState === "VOLUME ACCELERATING" &&
    d.effortVsResult === "EFFICIENT POSITIVE / PRICE ACCEPTANCE" &&
    (c.change4h || 0) >= 2 &&
    (c.change4h || 0) < 8 &&
    (c.rs4h || 0) > 0.5
  ){
    return "EARLY STARTER";
  }

  if(
    d &&
    (d.volumeState === "VOLUME ACCELERATING" || d.volumeState === "VOLUME HIGH") &&
    d.effortVsResult !== "CHURN/DISTRIBUTION RISK" &&
    (c.change1h || 0) >= 0.3 &&
    (c.change4h || 0) < 4 &&
    (c.rs1h || 0) > 0.3
  ){
    return "PRE-MOVE";
  }

  if((c.change4h || 0) >= 4 && (c.change4h || 0) < 8 && (c.volAccel || 0) >= 1.2){
    return "EARLY-MOVE";
  }

  // Lite-only fallback so a real second-leg/turnover candidate is not erased merely because full deep was not selected.
  if(lite && lite.rvol1h >= 1.3 && (c.change1h || 0) >= 0.3 && (c.rs1h || 0) > 0.2){
    return "PRE-MOVE";
  }

  if((c.bucketHits || []).includes("T")) return "TURNOVER ANOMALY WATCH";
  if(c.whaleInjected) return "WHALE-INJECTED WATCH";

  return "NO SETUP";
}

function deepPriority(c){
  let x = c.stageAScore || 0;
  const b = new Set(c.bucketHits || []);
  if(b.has("WHALE_INJECT")) x += 50;
  if(b.has("E")) x += 35;
  if(b.has("T")) x += 18;
  if(b.has("M")) x += 15;
  if(b.has("B")) x += 8;
  return x;
}

function selectDeepTargets(candidates){
  return [...candidates]
    .sort((a,b)=>deepPriority(b)-deepPriority(a))
    .slice(0,MAX_DEEP_LITE);
}

function fullDeepPriority(x){
  let p = deepPriority(x);
  if(x.lite && x.lite.secondLegTrigger) p += 80;
  else if(x.lite && x.lite.secondLegWatch) p += 45;
  if(x.lite && x.lite.rvol1h >= 1.5) p += 15;
  return p;
}

function isWhaleTrigger(c){
  const cls = c.classification;
  if([
    "PRE-MOVE","EARLY STARTER","EARLY-MOVE",
    "SECOND-LEG WATCH","SECOND-LEG TRIGGER",
    "TURNOVER ANOMALY WATCH","MICROCAP ANOMALY WATCH",
    "WHALE-INJECTED WATCH"
  ].includes(cls)) return true;

  const b = new Set(c.bucketHits || []);
  return b.has("E") || b.has("T") || b.has("M") || b.has("WHALE_INJECT");
}

async function runWhaleDeep(env, c){
  if(!isWhaleTrigger(c)) return {requested:false,status:"NOT_TRIGGERED"};

  if(!env.WHALES_DEEP_URL){
    return {
      requested:true,
      status:"WHALE DATA GAP",
      reason:"WHALES_DEEP_URL_NOT_CONFIGURED"
    };
  }

  try{
    const headers = {"content-type":"application/json"};
    if(env.WHALES_DEEP_TOKEN){
      headers.authorization = "Bearer " + env.WHALES_DEEP_TOKEN;
    }

    const r = await fetch(env.WHALES_DEEP_URL, {
      method:"POST",
      headers,
      body:JSON.stringify({
        source:"CABAL",
        patchVersion:PATCH_VERSION,
        action:"WHALES_DEEP",
        windowsHours:[6,24,72],
        token:{
          base:c.base,
          symbol:c.symbol,
          venue:c.venue,
          marketCap:c.marketCap,
          turnover24h:c.turnover24h,
          classification:c.classification,
          bucketHits:c.bucketHits
        }
      })
    });

    if(!r.ok){
      return {requested:true,status:"WHALE DATA GAP",reason:"HTTP_"+r.status};
    }

    const data = await r.json();
