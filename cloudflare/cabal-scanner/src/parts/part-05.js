    return {requested:true,status:"OK",data};
  }catch(e){
    return {requested:true,status:"WHALE DATA GAP",reason:String(e)};
  }
}

function whaleInternalAuthorized(request, env){
  if(!env.WHALES_DEEP_TOKEN) return false;
  const got = request.headers.get("authorization") || "";
  return got === ("Bearer " + env.WHALES_DEEP_TOKEN);
}

function whaleCandidatesEndpoint(env){
  if(env.WHALES_CANDIDATES_URL) return env.WHALES_CANDIDATES_URL;
  if(!env.WHALES_DEEP_URL) return null;

  try{
    const u = new URL(env.WHALES_DEEP_URL);
    if(/\/deep\/?$/.test(u.pathname)){
      u.pathname = u.pathname.replace(/\/deep\/?$/, "/candidates");
    }else{
      u.pathname = "/candidates";
    }
    u.searchParams.set("minutes","180");
    u.searchParams.set("limit","500");
    return u.toString();
  }catch(_){
    return null;
  }
}

async function fetchWhaleCandidates(env){
  const endpoint = whaleCandidatesEndpoint(env);

  if(!endpoint){
    return {
      ok:false,
      status:"WHALE DATA GAP",
      reason:"WHALES_CANDIDATES_ENDPOINT_NOT_CONFIGURED",
      bases:new Set(),
      candidates:[]
    };
  }

  if(!env.WHALES_DEEP_TOKEN){
    return {
      ok:false,
      status:"WHALE DATA GAP",
      reason:"WHALES_DEEP_TOKEN_NOT_CONFIGURED",
      bases:new Set(),
      candidates:[]
    };
  }

  try{
    const r = await fetch(endpoint,{
      headers:{
        authorization:"Bearer " + env.WHALES_DEEP_TOKEN
      }
    });

    if(!r.ok){
      return {
        ok:false,
        status:"WHALE DATA GAP",
        reason:"HTTP_" + r.status,
        bases:new Set(),
        candidates:[]
      };
    }

    const j = await r.json();
    const candidates = Array.isArray(j && j.candidates) ? j.candidates : [];
    const bases = new Set();

    for(const x of candidates){
      const raw = typeof x === "string" ? x : (x && (x.base || x.symbol));
      const b = upper(raw).replace(/[-_/ ]?(USDT|USDC)$/i,"");
      if(b) bases.add(b);
    }

    return {
      ok:true,
      status:"PASS",
      reason:null,
      bases,
      candidates
    };
  }catch(e){
    return {
      ok:false,
      status:"WHALE DATA GAP",
      reason:String(e),
      bases:new Set(),
      candidates:[]
    };
  }
}

async function readWhaleInjections(request, env){
  const out = new Set();

  // Manual/request injection is accepted only with the same shared internal token.
  // Normal public GET scans are unaffected.
  if(!whaleInternalAuthorized(request,env)) return out;

  const url = new URL(request.url);
  const q = url.searchParams.get("inject") || url.searchParams.get("whale");

  if(q){
    for(const x of q.split(",")){
      const b = upper(x).replace(/[-_/ ]?(USDT|USDC)$/i,"");
      if(b) out.add(b);
    }
  }

  if(request.method === "POST"){
    try{
      const j = await request.json();
      const arr = Array.isArray(j && j.whaleCandidates) ? j.whaleCandidates : [];
      for(const x of arr){
        const raw = typeof x === "string" ? x : (x && (x.base || x.symbol));
        const b = upper(raw).replace(/[-_/ ]?(USDT|USDC)$/i,"");
        if(b) out.add(b);
      }
    }catch(_){
      // Optional body; invalid/non-JSON body does not break the normal scanner.
    }
  }

  return out;
}


const GUARD_MIN_TURNOVER = 50_000;
const GUARD_MAX_ASSETS = 900;
const GUARD_HISTORY_MINUTES = 7;
const GUARD_ASSET_COOLDOWN_MS = 12 * 60 * 60 * 1000;
const GUARD_GLOBAL_COOLDOWN_MS = 30 * 60 * 1000;
const GUARD_NTFY_BACKOFF_BASE_MS = 10 * 60 * 1000;
const GUARD_NTFY_BACKOFF_MAX_MS = 60 * 60 * 1000;
const GUARD_HEALTH_MAX_AGE_MS = 150 * 1000;
const GUARD_MAX_SCHEDULER_LAG_MS = 120 * 1000;
const GUARD_EXECUTION_MIN_TURNOVER = 250_000;
const GUARD_RECOVERY_MIN_TURNOVER = 1_000_000;
const GUARD_RECOVERY_MIN_24H_PCT = -35.0;
const GUARD_RECOVERY_MAX_24H_PCT = -8.0;
const GUARD_BUY_CONFIRMATIONS_REQUIRED_NON_BTC = 2;
const GUARD_BUY_CONFIRMATION_MAX_GAP_MS = 7 * 60 * 1000;

async function guardEnsureStore(env){
  if(!env.DB) return false;
  await env.DB.prepare(
    "CREATE TABLE IF NOT EXISTS cabal_guard_kv (" +
    "k TEXT PRIMARY KEY, v TEXT NOT NULL, updated_at INTEGER NOT NULL)"
  ).run();
  return true;
}

async function guardGet(env,key){
  if(!(await guardEnsureStore(env))) return null;
  const row=await env.DB.prepare(
    "SELECT v, updated_at FROM cabal_guard_kv WHERE k=?1"
  ).bind(key).first();
  if(!row || !row.v) return null;
  try{
    const v=JSON.parse(row.v);
    v._updatedAt=Number(row.updated_at)||null;
    return v;
  }catch(_){
    return null;
  }
}

async function guardPut(env,key,value){
  if(!(await guardEnsureStore(env))) return false;
  const now=Date.now();
  await env.DB.prepare(
    "INSERT INTO cabal_guard_kv (k,v,updated_at) VALUES (?1,?2,?3) " +
    "ON CONFLICT(k) DO UPDATE SET v=excluded.v, updated_at=excluded.updated_at"
  ).bind(key,JSON.stringify(value),now).run();
  return true;
}

function guardPct(a,b){
  return Number.isFinite(a) && Number.isFinite(b) && b>0 ? (a/b-1)*100 : null;
}

function guardSnapshotAsset(m){
  return [
    Number(m.lastPrice)||0,
    Number(m.turnover24h)||0,
    Number(m.price24hPct)||0,
    String(m.venue||""),
    String(m.venueSymbol||"")
  ];
}

function guardFindAsset(history,base,targetMs){
  let best=null;
  for(const snap of history||[]){
    if(!snap || !snap.t || snap.t>targetMs) continue;
    if(!snap.a || !snap.a[base]) continue;
    if(!best || snap.t>best.t) best=snap;
  }
  return best && best.a ? best.a[base] : null;
}

async function guardBuildSnapshot(){
  const src=await Promise.allSettled([bybitTickers(),kucoinTickers()]);
  const bybit=src[0].status==="fulfilled" ? src[0].value : [];
  const kucoin=src[1].status==="fulfilled" ? src[1].value : [];
  const bybitError=src[0].status==="rejected" ? String(src[0].reason||"BYBIT_FAILED") : null;
  const kucoinError=src[1].status==="rejected" ? String(src[1].reason||"KUCOIN_FAILED") : null;
  if(!bybit.length && !kucoin.length) throw new Error("GUARD_NO_SPOT_SOURCE | BYBIT="+bybitError+" | KUCOIN="+kucoinError);

  // The one-minute guard must not inherit a Bybit outage when KuCoin is healthy.
  // Prefer KuCoin for assets present on both venues; keep Bybit-only names as fallback.
  const eligible=[...bybit,...kucoin]
    .filter(x=>(x.turnover24h||0)>=GUARD_MIN_TURNOVER)
    .sort((a,b)=>(b.turnover24h||0)-(a.turnover24h||0));
  const preferredByBase=new Map();
  for(const m of eligible){
    const prior=preferredByBase.get(m.base);
    if(!prior || (m.venue==="KUCOIN" && prior.venue!=="KUCOIN")){
      preferredByBase.set(m.base,m);
    }
  }
  const ded=[...preferredByBase.values()]
    .sort((a,b)=>(b.turnover24h||0)-(a.turnover24h||0))
    .slice(0,GUARD_MAX_ASSETS);

  const a={};
  for(const m of ded) a[m.base]=guardSnapshotAsset(m);
  return {
    t:Date.now(),a,count:ded.length,bybit:bybit.length,kucoin:kucoin.length,
    sourceStatus:{
      bybit:bybit.length?"PASS":"FAIL",
      kucoin:kucoin.length?"PASS":"FAIL",
      bybitError,kucoinError
    }
  };
}

function guardCandidates(current,history){
  const out=[];
  const now=current.t;
  for(const [base,x] of Object.entries(current.a||{})){
    const price=Number(x[0]), turn=Number(x[1]), p24=Number(x[2]), venue=String(x[3]||""), venueSymbol=String(x[4]||"");
    if(!(price>0) || !(turn>=GUARD_MIN_TURNOVER)) continue;

    const x1=guardFindAsset(history,base,now-60_000);
    const x3=guardFindAsset(history,base,now-180_000);
    const x5=guardFindAsset(history,base,now-300_000);
    const p1=x1 ? guardPct(price,Number(x1[0])) : null;
    const p3=x3 ? guardPct(price,Number(x3[0])) : null;
    const p5=x5 ? guardPct(price,Number(x5[0])) : null;
    const turn5=x5 ? Number(x5[1]) : null;
    const delta5=turn5!=null ? Math.max(0,turn-turn5) : null;
    const volAccel5=(delta5!=null && turn>0) ? (delta5/turn)*288 : null;

    const early24=p24>-8.0 && p24<8.5;
    const accel=(
      (p1!=null && p1>=0.60 && volAccel5!=null && volAccel5>=2.0) ||
      (p3!=null && p3>=0.80 && volAccel5!=null && volAccel5>=1.5) ||
      (p5!=null && p5>=1.20 && volAccel5!=null && volAccel5>=1.2)
    );

    // Recovery lane: catches QNT-type violent reversals that begin while the
    // rolling 24h change is still deeply negative after an earlier sell-off.
    // This lane is intentionally restricted to liquid assets and stronger
    // short-horizon acceleration; it does NOT weaken the standard early lane.
    const recovery24=(
      p24>=GUARD_RECOVERY_MIN_24H_PCT &&
      p24<=GUARD_RECOVERY_MAX_24H_PCT &&
      turn>=GUARD_RECOVERY_MIN_TURNOVER
    );
    const recoveryAccel=(
      (p1!=null && p1>=0.90 && volAccel5!=null && volAccel5>=2.0) ||
      (p3!=null && p3>=1.50 && volAccel5!=null && volAccel5>=1.5) ||
      (p5!=null && p5>=2.00 && volAccel5!=null && volAccel5>=1.2)
    );
    const recoveryLane=recovery24 && recoveryAccel;
    if(!(early24 && accel) && !recoveryLane) continue;

    let score=0;
    score += Math.max(0,p1||0)*16;
    score += Math.max(0,p3||0)*10;
    score += Math.max(0,p5||0)*6;
    score += Math.min(45,Math.max(0,volAccel5||0)*10);
    if(turn>=250_000) score+=8;
    if(recoveryLane) score+=18;
    if(recoveryLane && turn>=5_000_000) score+=8;

    out.push({
      base,venue,venueSymbol,price,turnover24h:turn,change24h:p24,
      change1m:p1,change3m:p3,change5m:p5,
      volumeAccel5m:volAccel5,guardScore:Math.round(score*10)/10,
      recoveryLane
    });
  }
  out.sort((a,b)=>b.guardScore-a.guardScore);
  return out;
}

function guardCandidateSnapshot(current,history,base){
  const x=current && current.a ? current.a[base] : null;
  if(!x) return null;

  const now=current.t;
  const price=Number(x[0]), turn=Number(x[1]), p24=Number(x[2]);
  const venue=String(x[3]||""), venueSymbol=String(x[4]||"");
  if(!(price>0) || !(turn>=GUARD_MIN_TURNOVER) || !venue || !venueSymbol) return null;

  const x1=guardFindAsset(history,base,now-60_000);
  const x3=guardFindAsset(history,base,now-180_000);
  const x5=guardFindAsset(history,base,now-300_000);
  const p1=x1 ? guardPct(price,Number(x1[0])) : null;
  const p3=x3 ? guardPct(price,Number(x3[0])) : null;
  const p5=x5 ? guardPct(price,Number(x5[0])) : null;
  const turn5=x5 ? Number(x5[1]) : null;
  const delta5=turn5!=null ? Math.max(0,turn-turn5) : null;
  const volAccel5=(delta5!=null && turn>0) ? (delta5/turn)*288 : null;

  let score=0;
  score += Math.max(0,p1||0)*16;
  score += Math.max(0,p3||0)*10;
  score += Math.max(0,p5||0)*6;
  score += Math.min(45,Math.max(0,volAccel5||0)*10);
  if(turn>=250_000) score+=8;

  const recoveryLane=(
    p24>=GUARD_RECOVERY_MIN_24H_PCT &&
    p24<=GUARD_RECOVERY_MAX_24H_PCT &&
    turn>=GUARD_RECOVERY_MIN_TURNOVER &&
    (
      (p1!=null && p1>=0.90 && volAccel5!=null && volAccel5>=2.0) ||
      (p3!=null && p3>=1.50 && volAccel5!=null && volAccel5>=1.5) ||
      (p5!=null && p5>=2.00 && volAccel5!=null && volAccel5>=1.2)
    )
  );
  if(recoveryLane) score+=18;
  if(recoveryLane && turn>=5_000_000) score+=8;

  return {
    base,venue,venueSymbol,price,turnover24h:turn,change24h:p24,
    change1m:p1,change3m:p3,change5m:p5,
    volumeAccel5m:volAccel5,guardScore:Math.round(score*10)/10,
    recoveryLane
  };
}

function guardFmt(v){
  const x=Number(v);
  if(!Number.isFinite(x)) return "n/a";
  if(Math.abs(x)>=1) return String(Math.round(x*1e6)/1e6);
  return String(Math.round(x*1e10)/1e10);
}

function guardCard(c){
  return [
    "⚡ "+c.base+" — PRE-CABAL EARLY GUARD",
    "PLATAFORMA: "+c.venue,
    "PRECIO: "+guardFmt(c.price),
    "1m / 3m / 5m: "+guardFmt(c.change1m)+"% / "+guardFmt(c.change3m)+"% / "+guardFmt(c.change5m)+"%",
    "24h: "+guardFmt(c.change24h)+"%",
    "VOL ACCEL 5m: "+guardFmt(c.volumeAccel5m)+"x",
    "TURNOVER 24h: "+guardFmt(c.turnover24h),
    "ACCIÓN: VIGILAR AHORA. NO ES COMPRA. CABAL v2 debe confirmar estructura, entrada y stop."
  ].join("\n");
}

function guardRetryAfterMs(response){
  const raw=response && response.headers ? response.headers.get("Retry-After") : null;
  if(!raw) return null;
  const seconds=Number(raw);
  if(Number.isFinite(seconds) && seconds>=0) return Math.min(GUARD_NTFY_BACKOFF_MAX_MS,Math.max(5_000,seconds*1000));
  const when=Date.parse(raw);
  if(Number.isFinite(when)) return Math.min(GUARD_NTFY_BACKOFF_MAX_MS,Math.max(5_000,when-Date.now()));
  return null;
}

async function guardNotify(env,candidates){
  // WATCH is persisted for observability but no longer consumes NTFY quota.
  // NTFY is reserved for executable BUY/CANCEL decisions.
  const chosen=(candidates||[]).slice(0,10).map(x=>({
    base:x.base,venue:x.venue,venueSymbol:x.venueSymbol,price:x.price,
    guardScore:x.guardScore,change1m:x.change1m,change3m:x.change3m,
    change5m:x.change5m,change24h:x.change24h,volumeAccel5m:x.volumeAccel5m
  }));
  await guardPut(env,"watch:latest",{
    generatedAt:new Date().toISOString(),
    candidates:chosen
  });
  return {
    assets:[],
    ok:true,
    skipped:chosen.length ? "WATCH_PERSIST_ONLY" : "NO_CANDIDATES",
    status:null,
    error:null,
    backoffUntil:null
  };
}

function guardRvol(bars){
  if(!bars || bars.length<8) return null;
  const last=bars[bars.length-1];
  const base=median(bars.slice(Math.max(0,bars.length-21),bars.length-1).map(x=>x.v)) || last.v || 1;
  return base>0 ? last.v/base : null;
}

function guardStopFrom15m(price,a15){
  if(!(price>0) || !a15 || !a15.length) return null;
  const stops=[];
  for(const n of [4,8,12]){
    const w=a15.slice(Math.max(0,a15.length-n));
    if(!w.length) continue;
    const support=Math.min(...w.map(x=>x.l).filter(Number.isFinite));
    const stop=support*0.996;
    if(!(price>stop && stop>0)) continue;
    const dist=(price-stop)/price*100;
    if(dist>=1.0 && dist<=3.5) stops.push({stop,dist});
  }
  if(!stops.length) return null;
  stops.sort((a,b)=>b.stop-a.stop);
  return stops[0];
}

async function guardExecutionMetricsOnMarket(c,market){
  const btcSymbol=market.venue==="BYBIT" ? "BTCUSDT" : "BTC-USDT";
  const btcMarket={venue:market.venue,venueSymbol:btcSymbol};

  const [a15,a60,btc60]=await Promise.all([
    klineOnMarket(market,"15",60),
    klineOnMarket(market,"60",180),
    klineOnMarket(btcMarket,"60",30)
  ]);
  if(a15.length<20 || a60.length<30 || btc60.length<6) throw new Error("GUARD_EXECUTION_INSUFFICIENT_BARS");

  const last15=a15[a15.length-1], last60=a60[a60.length-1], btcLast=btc60[btc60.length-1];
  const p15=pct(last15.c,last15.o);
  const p1=pct(last60.c,a60[a60.length-2].c);
  const p4=pct(last60.c,a60[a60.length-5].c);
  const btc1=pct(btcLast.c,btc60[btc60.length-2].c);
  const btc4=pct(btcLast.c,btc60[btc60.length-5].c);
  const rs1=(p1==null||btc1==null)?null:p1-btc1;
  const rs4=(p4==null||btc4==null)?null:p4-btc4;
  const r15=guardRvol(a15), r1=guardRvol(a60);
  const lite=deepLiteAnalysis(a60,{change24h:c.change24h,change7d:null});
  const high24=Math.max(...a60.slice(-24).map(x=>x.h).filter(Number.isFinite));
  const noChase=Number.isFinite(high24) ? high24*1.01 : null;
  const headroom=(noChase && c.price>0) ? guardPct(noChase,c.price) : null;
  const stopInfo=guardStopFrom15m(c.price,a15);

  return {
    executionVenue:market.venue,executionVenueSymbol:market.venueSymbol,
    p15,p1,p4,rs1,rs4,rvol15m:r15,rvol1h:r1,lite,
    noChase,headroom,
    stop:stopInfo ? stopInfo.stop : null,
    stopDistancePct:stopInfo ? stopInfo.dist : null
  };
}

async function guardExecutionMetrics(c){
  if(!c || !c.base || !c.venue || !c.venueSymbol) throw new Error("GUARD_EXECUTION_SYMBOL_MISSING");
  const alternatives=[{venue:c.venue,venueSymbol:c.venueSymbol}];
  if(c.venue!=="KUCOIN") alternatives.push({venue:"KUCOIN",venueSymbol:c.base+"-USDT"});
  if(c.venue!=="BYBIT") alternatives.push({venue:"BYBIT",venueSymbol:c.base+"USDT"});

  const seen=new Set();
  const errors=[];
  for(const market of alternatives){
    const key=market.venue+":"+market.venueSymbol;
    if(seen.has(key)) continue;
    seen.add(key);
    try{
      return await guardExecutionMetricsOnMarket(c,market);
    }catch(e){
      errors.push(key+"="+String(e));
    }
  }
  throw new Error("GUARD_EXECUTION_DATA_GAP "+c.base+" | "+errors.join(" | "));
}

function guardPilotDecision(c,m){
  const p15=Number(m.p15), p1=Number(m.p1), p4=Number(m.p4);
  const rs1=Number(m.rs1), rs4=Number(m.rs4);
  const r15=Number(m.rvol15m), r1=Number(m.rvol1h);
  const head=Number(m.headroom), sd=Number(m.stopDistancePct);
  const p24=Number(c.change24h);
  const live=Number(c.price);
  const shortAccel=(Number(c.change3m)>=0.80 || Number(c.change5m)>=1.20 || Number(c.change1m)>=0.60);
  const baseSafe=(
    live>0 && Number(m.stop)>0 && live>Number(m.stop)
    && Number(c.turnover24h||0)>=GUARD_EXECUTION_MIN_TURNOVER
    && sd>=1.0 && sd<=3.5
    && Number.isFinite(head) && head>=1.0
  );
  const safe=baseSafe && p24>-8.0 && p24<15.0;
  const recoverySafe=Boolean(
    baseSafe &&
    c.recoveryLane===true &&
    Number(c.turnover24h||0)>=GUARD_RECOVERY_MIN_TURNOVER &&
    p24>=GUARD_RECOVERY_MIN_24H_PCT &&
    p24<=GUARD_RECOVERY_MAX_24H_PCT
  );

  const second=Boolean(
    safe && m.lite && m.lite.secondLegTrigger
    && r1>=1.20 && r15>=1.10
    && rs1>=0.50 && rs4>=0.25
    && p1>=0.20 && p1<6.5
  );

  const fast=Boolean(
    safe && shortAccel
    && c.guardScore>=30
    && p24<8.5
    && p15>=0
    && p1>=0.20 && p1<5.0
    && p4<9.0
    && r15>=1.25 && r1>=1.35
    && rs1>=0.25 && rs4>=0.25
  );

  const recovery=Boolean(
    recoverySafe && shortAccel
    && c.guardScore>=45
    && p15>=0
    && p1>=1.0 && p1<10.0
    && p4>-12.0
    && r15>=1.30 && r1>=1.25
    && rs1>=0.75 && rs4>-5.0
  );

  const buy=second||fast||recovery;
  const reason=second
    ? "SECOND_LEG_CLOUD_CONFIRMED"
    : (fast
      ? "FAST_ACCEL_CLOUD_CONFIRMED"
      : (recovery ? "RECOVERY_ACCEL_CLOUD_CONFIRMED" : "NO_BUY"));
  const score=Math.round((
    Number(c.guardScore||0)
    +Math.max(0,rs1||0)*5
    +Math.max(0,rs4||0)*2
    +Math.max(0,(r15||0)-1)*10
    +Math.max(0,(r1||0)-1)*8
    +(second?20:0)
  )*10)/10;
  const entryMax=buy ? Math.min(live*1.004,Number(m.noChase)*0.995) : null;

  return {
    asset:c.base,venue:m.executionVenue||c.venue,venueSymbol:m.executionVenueSymbol||c.venueSymbol,
    price:live,buy,reason,score,
    pilotSizePct:20,
    entryMax,
    stop:buy ? Number(m.stop) : null,
    stopDistancePct:buy ? sd : null,
    noChase:m.noChase,
    headroomPct:head,
    change1m:c.change1m,change3m:c.change3m,change5m:c.change5m,
    change1hPct:p1,change4hPct:p4,change24hPct:p24,
    rs1hVsBtc:rs1,rs4hVsBtc:rs4,
    rvol15m:r15,rvol1h:r1,
    secondLegTrigger:Boolean(m.lite && m.lite.secondLegTrigger),
    recoveryLane:Boolean(c.recoveryLane),
    recoveryBuyEligible:recovery
  };
}

async function guardQualifyBuySignals(env,evaluated){
  const now=Date.now();
  const rawBuys=(evaluated||[])
    .filter(x=>x && x.buy)
    .sort((a,b)=>b.score-a.score)
    .slice(0,3);

  // A failed execution check resets persistence for that asset. A BUY must be
  // confirmed again on a later 5-minute execution cycle before it is actionable.
  for(const x of (evaluated||[])){
    if(!x || !x.asset || x.buy) continue;
    await guardPut(env,"trade:qualification:"+x.asset,{
      asset:x.asset,confirmations:0,requiredConfirmations:x.asset==="BTC"?1:GUARD_BUY_CONFIRMATIONS_REQUIRED_NON_BTC,
      lastRejectedAt:now,reason:x.reason||"NO_BUY"
    });
  }

  const qualified=[];
  const staged=[];
  for(const x of rawBuys){
    const key="trade:qualification:"+x.asset;
    const prev=await guardGet(env,key)||{};
    const priorAt=Number(prev.lastConfirmedAt||0);
    const continuous=priorAt>0 && (now-priorAt)<=GUARD_BUY_CONFIRMATION_MAX_GAP_MS;
    const confirmations=continuous ? Number(prev.confirmations||0)+1 : 1;
    const required=x.asset==="BTC" ? 1 : GUARD_BUY_CONFIRMATIONS_REQUIRED_NON_BTC;
    const firstConfirmedAt=continuous ? Number(prev.firstConfirmedAt||priorAt) : now;
    const q={...x,confirmations,requiredConfirmations:required};

    await guardPut(env,key,{
      asset:x.asset,confirmations,requiredConfirmations:required,
      firstConfirmedAt,lastConfirmedAt:now,
      reason:x.reason,price:x.price,score:x.score
    });

    if(confirmations>=required) qualified.push(q);
    else staged.push(q);
  }
  return {rawBuys,qualified,staged};
}

async function guardEvaluateTrades(env,candidates){
  const top=(candidates||[]).slice(0,6);
  const evaluated=await mapLimit(top,2,async x=>{
    try{
      const m=await guardExecutionMetrics(x);
      return guardPilotDecision(x,m);
    }catch(e){
      return {asset:x.base,venue:x.venue,price:x.price,buy:false,reason:"DATA_GAP",error:String(e)};
    }
  });
  const qualification=await guardQualifyBuySignals(env,evaluated);
  const buys=qualification.qualified;
  const state={
    generatedAt:new Date().toISOString(),
    mode:"CLOUDFLARE_5M_EXECUTION_GUARD",
    evaluated,
    rawBuys:qualification.rawBuys,
    stagedBuys:qualification.staged,
    buys
  };
  await guardPut(env,"trade:latest",state);
  const notify=await guardTradeNotify(env,state);
  return {...state,notify};
}

function guardTradeCard(x){
  return [
    "🚨 "+x.asset+" — CABAL PILOT BUY",
    "PLATAFORMA: "+x.venue,
    "MOTIVO: "+x.reason,
    "CONFIRMACIONES: "+Number(x.confirmations||1)+"/"+Number(x.requiredConfirmations||1),
    "PRECIO AHORA: "+guardFmt(x.price),
    "COMPRA MÁX.: "+guardFmt(x.entryMax),
    "STOP: "+guardFmt(x.stop)+" ("+guardFmt(x.stopDistancePct)+"%)",
    "RS 1H / 4H vs BTC: "+guardFmt(x.rs1hVsBtc)+"% / "+guardFmt(x.rs4hVsBtc)+"%",
    "RVOL 15M / 1H: "+guardFmt(x.rvol15m)+"x / "+guardFmt(x.rvol1h)+"x",
    "TAMAÑO PILOT: "+x.pilotSizePct+"% de la posición prevista.",
    "VENTANA: 10 min. SPOT manual. No ejecutar si el precio supera COMPRA MÁX."
  ].join("\n");
}

async function guardTradeNotify(env,state){
  const now=Date.now();
  const buys=Array.isArray(state&&state.buys)?state.buys:[];
  const active=await guardGet(env,"trade:active");

  // Once COMPRAR AHORA is delivered, ordinary momentum/RS softening does NOT
  // revoke it. Only guardRevalidateActiveTrade may close the live entry window
  // for an objective hard invalidation of the original execution limits.
  if(!buys.length){
    // A pending BUY is only useful while the current validation still confirms it.
    // If the next execution cycle has no BUY, explicitly invalidate stale pending
    // transport state so health/dashboard cannot show an obsolete order.
    const pending=await guardGet(env,"trade:pending");
    let clearedPendingAsset=null;
    if(pending && pending.buy && pending.buy.asset){
      clearedPendingAsset=pending.buy.asset;
      await guardPut(env,"trade:pending",{
        asset:null,clearedAt:now,reason:"SIGNAL_NO_LONGER_VALID",
        previousAsset:clearedPendingAsset
      });
    }
    if(active && active.asset && Number(active.validUntil||0)<=now){
      await guardPut(env,"trade:active",{asset:null,expiredAt:now});
    }
    return {ok:true,kind:"NONE",clearedPendingAsset};
  }

  const x=buys[0];
  const prior=await guardGet(env,"trade:alert:"+x.asset);
  if(prior && now-Number(prior.lastAlertAt||0)<6*60*60*1000){
    return {ok:true,kind:"COOLDOWN",asset:x.asset};
  }

  const notifyState=await guardGet(env,"trade:notify:state")||{};
  if(Number(notifyState.backoffUntil||0)>now){
    await guardPut(env,"trade:pending",{generatedAt:state.generatedAt,buy:x});
    return {ok:false,kind:"BUY",asset:x.asset,error:"NTFY_BACKOFF_ACTIVE",backoffUntil:notifyState.backoffUntil};
  }

  if(!env.NTFY_URL){
    await guardPut(env,"trade:pending",{generatedAt:state.generatedAt,buy:x});
    return {ok:false,kind:"BUY",asset:x.asset,error:"NTFY_URL_NOT_CONFIGURED"};
  }

  let r=null, responseText="";
  try{
    r=await fetch(env.NTFY_URL,{
      method:"POST",
      headers:{"Title":"🚨 CABAL — COMPRAR AHORA","Priority":"high","Tags":"chart_with_upwards_trend"},
      body:guardTradeCard(x)
    });
    if(!r.ok){ try{responseText=(await r.text()).slice(0,300);}catch(_){} }
  }catch(e){
    const state2={lastAttemptAt:now,lastStatus:null,lastError:String(e),backoffUntil:now+10*60*1000};
    await guardPut(env,"trade:notify:state",state2);
    await guardPut(env,"trade:pending",{generatedAt:state.generatedAt,buy:x});
    return {ok:false,kind:"BUY",asset:x.asset,error:String(e),backoffUntil:state2.backoffUntil};
  }

  if(!r.ok){
    const retry=guardRetryAfterMs(r);
    const backoff=retry||Math.min(60*60*1000,(r.status===429?30:10)*60*1000);
    const state2={
      lastAttemptAt:now,lastStatus:r.status,
      lastError:"HTTP_"+r.status+(responseText?":"+responseText:""),
      backoffUntil:now+backoff
    };
    await guardPut(env,"trade:notify:state",state2);
    await guardPut(env,"trade:pending",{generatedAt:state.generatedAt,buy:x});
    return {ok:false,kind:"BUY",asset:x.asset,status:r.status,error:state2.lastError,backoffUntil:state2.backoffUntil};
  }

  await guardPut(env,"trade:alert:"+x.asset,{lastAlertAt:now,price:x.price,entryMax:x.entryMax,stop:x.stop});
  await guardPut(env,"trade:active",{asset:x.asset,lastAlertAt:now,validUntil:now+10*60*1000,entryMax:x.entryMax,stop:x.stop});
  await guardPut(env,"trade:pending",{asset:null,clearedAt:now});
  await guardPut(env,"trade:notify:state",{lastAttemptAt:now,lastStatus:r.status,lastError:null,backoffUntil:0,lastSuccessAt:now});
  return {ok:true,kind:"BUY",asset:x.asset,status:r.status};
}

async function guardCancelActiveTrade(env,active,reason,price){
  const now=Date.now();
  if(!env.NTFY_URL) return {ok:false,kind:"CANCEL",asset:active.asset,error:"NTFY_URL_NOT_CONFIGURED"};

  const reasonText=reason==="ORIGINAL_STOP_BROKEN"
    ? "El precio ha roto el STOP estructural de la alerta original."
    : "El precio ha superado la COMPRA MÁX. de la alerta original; no perseguir la entrada.";

  try{
    const r=await fetch(env.NTFY_URL,{
      method:"POST",
      headers:{"Title":"🟠 CABAL — VENTANA DE ENTRADA CERRADA","Priority":"high","Tags":"warning"},
      body:[
        active.asset,
        "MOTIVO OBJETIVO: "+reason,
        reasonText,
        price!=null ? "PRECIO: "+guardFmt(price) : null,
        "SI NO ENTRASTE: NO ENTRAR.",
        "SI YA ENTRASTE: NO ES ORDEN DE VENTA; gestionar la posición con el STOP estructural comunicado en la alerta original."
      ].filter(Boolean).join("\n")
    });
    if(r.ok){
      await guardPut(env,"trade:active",{asset:null,clearedAt:now,previousAsset:active.asset,reason});
      return {ok:true,kind:"CANCEL",asset:active.asset,status:r.status,reason};
    }
    return {ok:false,kind:"CANCEL",asset:active.asset,status:r.status,error:"HTTP_"+r.status,reason};
  }catch(e){
    return {ok:false,kind:"CANCEL",asset:active.asset,error:String(e),reason};
  }
}

async function guardRevalidateActiveTrade(env,current,history){
  const now=Date.now();
  const active=await guardGet(env,"trade:active");

  if(!active || !active.asset){
    const state={
      generatedAt:new Date(now).toISOString(),
      mode:"CLOUDFLARE_1M_ACTIVE_REVALIDATION",
      checked:false,asset:null,valid:null,reason:"NO_ACTIVE_BUY",notify:null
    };
    await guardPut(env,"trade:revalidation",state);
    return state;
  }

  if(Number(active.validUntil||0)<=now){
    await guardPut(env,"trade:active",{asset:null,expiredAt:now,previousAsset:active.asset});
    const state={
      generatedAt:new Date(now).toISOString(),
      mode:"CLOUDFLARE_1M_ACTIVE_REVALIDATION",
      checked:true,asset:active.asset,valid:false,reason:"WINDOW_EXPIRED",notify:null
    };
    await guardPut(env,"trade:revalidation",state);
    return state;
  }

  const c=guardCandidateSnapshot(current,history,active.asset);
  let decision=null;
  let hardInvalidation=null;
  let reason="COMMITTED_WINDOW";
  const livePrice=c ? Number(c.price) : null;

  if(c){
    if(Number(active.stop)>0 && livePrice<=Number(active.stop)){
      hardInvalidation="ORIGINAL_STOP_BROKEN";
      reason=hardInvalidation;
    }else if(Number(active.entryMax)>0 && livePrice>Number(active.entryMax)){
      hardInvalidation="ORIGINAL_ENTRY_MAX_EXCEEDED";
      reason=hardInvalidation;
    }else{
      try{
        const m=await guardExecutionMetrics(c);
        decision=guardPilotDecision(c,m);
        reason=decision && decision.buy
          ? "STILL_CONFIRMED"
          : "COMMITTED_WINDOW_SIGNAL_SOFTENED";
      }catch(e){
        reason="COMMITTED_WINDOW_DATA_GAP";
      }
    }
  }else{
    // A missing fast-radar snapshot or a temporary data gap is not a valid reason
    // to contradict a BUY that already passed persistence. The original 10-minute
    // window remains committed unless its entry max or stop is objectively broken.
    reason="COMMITTED_WINDOW_ASSET_NOT_IN_FAST_RADAR";
  }

  let notify=null;
  let valid=true;
  if(hardInvalidation){
    valid=false;
    notify=await guardCancelActiveTrade(env,active,hardInvalidation,livePrice);
  }

  const state={
    generatedAt:new Date(now).toISOString(),
    mode:"CLOUDFLARE_1M_ACTIVE_REVALIDATION",
    checked:true,
    asset:active.asset,
    valid,
    reason,
    price:livePrice,
    originalEntryMax:Number(active.entryMax)||null,
    originalStop:Number(active.stop)||null,
    decision,
    notify
  };
  await guardPut(env,"trade:revalidation",state);
  return state;
}
async function runMarketGuard(event,env){
  const started=Date.now();
  const scheduledAt=Number(event && event.scheduledTime)||started;
  const prev=await guardGet(env,"heartbeat")||{};
  const gap=prev.lastScheduledAt ? Math.max(0,started-Number(prev.lastScheduledAt)) : 0;
  const lag=Math.max(0,started-scheduledAt);
  const recentObservationGapsMs=[
    ...(Array.isArray(prev.recentObservationGapsMs)?prev.recentObservationGapsMs:[]),
    gap
  ].slice(-10);
  let hb=Object.assign({},prev,{
    lastScheduledAt:started,
    schedulerLagMs:lag,
    lastObservationGapMs:gap,
    recentObservationGapsMs,
    maxObservationGapMs:Math.max(...recentObservationGapsMs)
  });
  await guardPut(env,"heartbeat",hb);

  try{
    const current=await guardBuildSnapshot();
    const h=await guardGet(env,"history");
    let history=Array.isArray(h && h.items) ? h.items : [];
    history=history.filter(x=>x && x.t>=started-GUARD_HISTORY_MINUTES*60_000);
    const candidates=guardCandidates(current,history);

    // WATCH data is persisted every minute. Every fifth scheduled minute the
    // autonomous execution guard performs completed 15m/1h validation and can
    // emit a strict PILOT BUY without waiting for GitHub Actions.
    const notifyResult=await guardNotify(env,candidates);
    const minuteSlot=Math.floor(scheduledAt/60_000);
    const lastExecutionAt=Number(prev.lastExecutionGuardAt||0);
    const executionDue=(minuteSlot%5)===0 || !lastExecutionAt || (started-lastExecutionAt)>=5*60_000;
    let tradeResult=null;
    let activeRevalidation=null;
    if(executionDue){
      tradeResult=await guardEvaluateTrades(env,candidates);
    }else{
      // Any BUY already delivered to the user is checked EVERY MINUTE against
      // the original hard execution limits. Soft momentum/RS decay is telemetry,
      // not a retrospective contradiction of an already committed BUY window.
      activeRevalidation=await guardRevalidateActiveTrade(env,current,history);
    }

    history.push(current);
    history=history.slice(-GUARD_HISTORY_MINUTES);
    await guardPut(env,"history",{items:history});

    const finished=Date.now();
    const cycleHealthy=Boolean(
      gap<=GUARD_HEALTH_MAX_AGE_MS &&
      lag<=GUARD_MAX_SCHEDULER_LAG_MS
    );
    const consecutiveHealthyCycles=cycleHealthy
      ? Number(prev.consecutiveHealthyCycles||0)+1
      : 0;
    const tradeNotify=tradeResult&&tradeResult.notify
      ? tradeResult.notify
      : (activeRevalidation&&activeRevalidation.notify ? activeRevalidation.notify : null);

    hb=Object.assign({},hb,{
      lastSuccessfulScan:finished,
      lastRuntimeMs:finished-started,
      lastUniverseCount:current.count,
      lastCandidateCount:candidates.length,
      lastSourceStatus:current.sourceStatus||null,
      lastAlertAssets:tradeNotify&&tradeNotify.kind==="BUY"&&tradeNotify.ok ? [tradeNotify.asset] : [],
      lastNotificationAttemptAt:tradeNotify&&tradeNotify.kind!=="NONE" ? Date.now() : prev.lastNotificationAttemptAt||null,
      lastNotificationStatus:tradeNotify ? (tradeNotify.status||null) : prev.lastNotificationStatus||null,
      lastNotificationError:tradeNotify&&tradeNotify.ok===false ? (tradeNotify.error||"TRADE_NOTIFICATION_FAILED") : null,
      notificationBackoffUntil:tradeNotify ? (tradeNotify.backoffUntil||null) : prev.notificationBackoffUntil||null,
      notificationHealthy:tradeNotify ? tradeNotify.ok!==false : (prev.notificationHealthy!==false),
      notificationMode:tradeNotify ? ("TRADE_"+tradeNotify.kind) : notifyResult.skipped||"WATCH_PERSIST_ONLY",
      lastExecutionGuardAt:executionDue ? finished : (prev.lastExecutionGuardAt||null),
      lastExecutionGuardBuyAssets:tradeResult ? tradeResult.buys.map(x=>x.asset) : (prev.lastExecutionGuardBuyAssets||[]),
      lastExecutionGuardEvaluated:tradeResult ? tradeResult.evaluated.length : (prev.lastExecutionGuardEvaluated||0),
      lastActiveRevalidationAt:activeRevalidation&&activeRevalidation.checked ? Date.now() : (prev.lastActiveRevalidationAt||null),
      lastActiveRevalidationAsset:activeRevalidation&&activeRevalidation.checked ? activeRevalidation.asset : (prev.lastActiveRevalidationAsset||null),
      lastActiveRevalidationValid:activeRevalidation&&activeRevalidation.checked ? activeRevalidation.valid : (prev.lastActiveRevalidationValid??null),
      lastActiveRevalidationReason:activeRevalidation&&activeRevalidation.checked ? activeRevalidation.reason : (prev.lastActiveRevalidationReason||null),
      lastError:null,
      consecutiveHealthyCycles
    });

    // Structural test pushes are disabled in production. NTFY quota is reserved
    // for BUY/CANCEL only; health is verified through /health and deployment CI.
    hb.verificationNotifyError="DISABLED_RESERVE_NTFY_FOR_TRADE";

    await guardPut(env,"heartbeat",hb);
  }catch(e){
    hb=Object.assign({},hb,{
      lastRuntimeMs:Date.now()-started,
      lastError:String(e),
      consecutiveHealthyCycles:0
    });
    await guardPut(env,"heartbeat",hb);
  }
}

async function guardHealth(env){
  const now=Date.now();
  const [hb,trade,pending,watch,revalidation]=await Promise.all([
    guardGet(env,"heartbeat"),
    guardGet(env,"trade:latest"),
    guardGet(env,"trade:pending"),
    guardGet(env,"watch:latest"),
    guardGet(env,"trade:revalidation")
  ]);
  if(!hb) return {
    ok:false,healthy:false,mode:"CLOUDFLARE_1M_MARKET_GUARD",
    reason:env.DB ? "NO_HEARTBEAT_YET" : "D1_NOT_BOUND",
    checkedAt:new Date(now).toISOString()
  };
  const last=Number(hb.lastSuccessfulScan||0);
  const age=last ? now-last : Number.POSITIVE_INFINITY;
  const healthy=Boolean(
    last &&
    age<=GUARD_HEALTH_MAX_AGE_MS &&
    Number(hb.schedulerLagMs||0)<=GUARD_MAX_SCHEDULER_LAG_MS &&
    Number(hb.lastObservationGapMs||0)<=GUARD_HEALTH_MAX_AGE_MS &&
    !hb.lastError
  );
  return {
    ok:true,healthy,mode:"CLOUDFLARE_1M_MARKET_GUARD",
    patchVersion:PATCH_VERSION,
    checkedAt:new Date(now).toISOString(),
    lastScheduledAt:hb.lastScheduledAt ? new Date(Number(hb.lastScheduledAt)).toISOString() : null,
    lastSuccessfulScan:last ? new Date(last).toISOString() : null,
    ageSeconds:Number.isFinite(age) ? Math.round(age/1000) : null,
    schedulerLagSeconds:Math.round(Number(hb.schedulerLagMs||0)/1000),
    lastObservationGapSeconds:Math.round(Number(hb.lastObservationGapMs||0)/1000),
    maxObservationGapSeconds:Math.round(Number(hb.maxObservationGapMs||0)/1000),
    lastRuntimeMs:Number(hb.lastRuntimeMs||0),
    lastUniverseCount:Number(hb.lastUniverseCount||0),
    lastCandidateCount:Number(hb.lastCandidateCount||0),
    sourceStatus:hb.lastSourceStatus||null,
    lastAlertAssets:Array.isArray(hb.lastAlertAssets)?hb.lastAlertAssets:[],
    consecutiveHealthyCycles:Number(hb.consecutiveHealthyCycles||0),
    notificationHealthy:hb.notificationHealthy!==false,
    notificationMode:hb.notificationMode||null,
    lastNotificationStatus:hb.lastNotificationStatus||null,
    lastNotificationError:hb.lastNotificationError||null,
    notificationBackoffUntil:hb.notificationBackoffUntil ? new Date(Number(hb.notificationBackoffUntil)).toISOString() : null,
    verificationNotifiedAt:hb.verificationNotifiedAt ? new Date(Number(hb.verificationNotifiedAt)).toISOString() : null,
    verificationNotifyError:hb.verificationNotifyError||null,
    executionGuard:{
      mode:"CLOUDFLARE_5M_EXECUTION_GUARD",
      lastRunAt:hb.lastExecutionGuardAt ? new Date(Number(hb.lastExecutionGuardAt)).toISOString() : null,
      evaluatedCount:Number(hb.lastExecutionGuardEvaluated||0),
      buyAssets:Array.isArray(hb.lastExecutionGuardBuyAssets)?hb.lastExecutionGuardBuyAssets:[],
      generatedAt:trade&&trade.generatedAt ? trade.generatedAt : null,
      evaluated:trade&&Array.isArray(trade.evaluated) ? trade.evaluated.slice(0,5) : [],
      rawBuys:trade&&Array.isArray(trade.rawBuys) ? trade.rawBuys : [],
      stagedBuys:trade&&Array.isArray(trade.stagedBuys) ? trade.stagedBuys : [],
      buys:trade&&Array.isArray(trade.buys) ? trade.buys : [],
      pendingBuy:pending&&pending.buy ? pending.buy : null
    },
    activeRevalidation:{
      mode:"CLOUDFLARE_1M_ACTIVE_REVALIDATION",
      generatedAt:revalidation&&revalidation.generatedAt ? revalidation.generatedAt : null,
      checked:revalidation ? Boolean(revalidation.checked) : false,
      asset:revalidation&&revalidation.asset ? revalidation.asset : null,
      valid:revalidation&&typeof revalidation.valid==="boolean" ? revalidation.valid : null,
      reason:revalidation&&revalidation.reason ? revalidation.reason : null,
      price:revalidation&&revalidation.price!=null ? revalidation.price : null,
      notify:revalidation&&revalidation.notify ? revalidation.notify : null
    },
    watchRadar:{
      generatedAt:watch&&watch.generatedAt ? watch.generatedAt : null,
      candidates:watch&&Array.isArray(watch.candidates) ? watch.candidates.slice(0,5) : []
    },
    lastError:hb.lastError||null
  };
}

async function handleScan(request, env){
    const started = Date.now();

    try{
      const [manualWhaleInjectedBases, whaleFeed] = await Promise.all([
        readWhaleInjections(request,env),
        fetchWhaleCandidates(env)
      ]);

      const whaleInjectedBases = new Set([
        ...manualWhaleInjectedBases,
        ...whaleFeed.bases
      ]);

      const sourceResults = await Promise.allSettled([
        bybitTickers(),
        kucoinTickers(),
        coinGeckoMarkets(env)
      ]);

      const bybit = sourceResults[0].status === "fulfilled" ? sourceResults[0].value : [];
      const kucoin = sourceResults[1].status === "fulfilled" ? sourceResults[1].value : [];
      const cg = sourceResults[2].status === "fulfilled"
        ? sourceResults[2].value
        : {status:null,rows:[],configured:!!env.COINGECKO_API_KEY};

      if(!bybit.length && !kucoin.length){
        throw new Error("NO_SPOT_TICKER_SOURCE_AVAILABLE");
      }

      const deduped = dedupeMarkets([...bybit,...kucoin]);
      const cmap = cgMap(cg.rows);

      let scanUniverse = deduped.preferred.filter(m=>(m.turnover24h || 0) >= BROAD_SCAN_MIN_TURNOVER);

      // WHALES -> CABAL injection bypasses the normal scan-floor omission if the token is tradeable on a covered venue.
      for(const base of whaleInjectedBases){
        const x = deduped.preferred.find(m=>m.base === base);
        if(x && !scanUniverse.some(y=>y.base === base)) scanUniverse.push(x);
      }

      scanUniverse.sort((a,b)=>(b.turnover24h || 0)-(a.turnover24h || 0));
      const scanUniverseTotal = scanUniverse.length;

      if(scanUniverse.length > MAX_SCAN_UNIVERSE){
        const mustKeep = new Set(whaleInjectedBases);
        const fixed = scanUniverse.filter(x=>mustKeep.has(x.base));
        const rest = scanUniverse.filter(x=>!mustKeep.has(x.base)).slice(0,Math.max(0,MAX_SCAN_UNIVERSE-fixed.length));
        scanUniverse = [...fixed,...rest];
      }

      const tv = await tvScanMarkets(scanUniverse);
      const tmap = tvMap(tv.rows);

      const stage = buildStageA(scanUniverse,tmap,cmap,whaleInjectedBases);
      const deepTargets = selectDeepTargets(stage.candidates);

      // First pass: one 1h request per target. This is the anti-STORJ second-leg layer.
      const liteResults = await mapLimit(deepTargets,4,async c=>{
        try{
          const x = await klineWithFallback(c,"60",180,deduped.byBase,null);
          const lite = deepLiteAnalysis(x.bars,c);
          return Object.assign({},c,{
            lite,
            deepValidationSource:x.market.venue,
            deepValidationVenueSymbol:x.market.venueSymbol,
            deepValidationFallback:x.fallback,
            _liteMarket:x.market,
            _liteBars:x.bars,
            deepValidation:"LITE_OK"
          });
        }catch(e){
          return Object.assign({},c,{
            lite:null,
            deepValidation:"DATA_GAP",
            deepError:String(e)
          });
        }
      });

      const fullTargets = [...liteResults]
        .filter(x=>x.lite)
        .sort((a,b)=>fullDeepPriority(b)-fullDeepPriority(a))
        .slice(0,MAX_FULL_DEEP);

      const fullResults = await mapLimit(fullTargets,3,async c=>{
        try{
