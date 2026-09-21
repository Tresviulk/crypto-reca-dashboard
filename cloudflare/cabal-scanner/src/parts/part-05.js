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
const GUARD_ASSET_COOLDOWN_MS = 6 * 60 * 60 * 1000;
const GUARD_GLOBAL_COOLDOWN_MS = 4 * 60 * 1000;
const GUARD_HEALTH_MAX_AGE_MS = 150 * 1000;
const GUARD_MAX_SCHEDULER_LAG_MS = 120 * 1000;

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
    String(m.venue||"")
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
  if(!bybit.length && !kucoin.length) throw new Error("GUARD_NO_SPOT_SOURCE");
  const ded=dedupeMarkets([...bybit,...kucoin]).preferred
    .filter(x=>(x.turnover24h||0)>=GUARD_MIN_TURNOVER)
    .sort((a,b)=>(b.turnover24h||0)-(a.turnover24h||0))
    .slice(0,GUARD_MAX_ASSETS);
  const a={};
  for(const m of ded) a[m.base]=guardSnapshotAsset(m);
  return {t:Date.now(),a,count:ded.length,bybit:bybit.length,kucoin:kucoin.length};
}

function guardCandidates(current,history){
  const out=[];
  const now=current.t;
  for(const [base,x] of Object.entries(current.a||{})){
    const price=Number(x[0]), turn=Number(x[1]), p24=Number(x[2]), venue=String(x[3]||"");
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

    const early24=p24<8.5;
    const accel=(
      (p1!=null && p1>=0.60 && volAccel5!=null && volAccel5>=2.0) ||
      (p3!=null && p3>=0.80 && volAccel5!=null && volAccel5>=1.5) ||
      (p5!=null && p5>=1.20 && volAccel5!=null && volAccel5>=1.2)
    );
    if(!early24 || !accel) continue;

    let score=0;
    score += Math.max(0,p1||0)*16;
    score += Math.max(0,p3||0)*10;
    score += Math.max(0,p5||0)*6;
    score += Math.min(45,Math.max(0,volAccel5||0)*10);
    if(turn>=250_000) score+=8;

    out.push({
      base,venue,price,turnover24h:turn,change24h:p24,
      change1m:p1,change3m:p3,change5m:p5,
      volumeAccel5m:volAccel5,guardScore:Math.round(score*10)/10
    });
  }
  out.sort((a,b)=>b.guardScore-a.guardScore);
  return out;
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

async function guardNotify(env,candidates){
  if(!candidates.length) return [];
  const now=Date.now();
  const global=await guardGet(env,"alert:__GLOBAL__");
  if(global && now-Number(global.lastAlertAt||0)<GUARD_GLOBAL_COOLDOWN_MS) return [];

  const chosen=[];
  for(const c of candidates){
    const prev=await guardGet(env,"alert:"+c.base);
    if(prev && now-Number(prev.lastAlertAt||0)<GUARD_ASSET_COOLDOWN_MS) continue;
    chosen.push(c);
    if(chosen.length>=2) break;
  }
  if(!chosen.length) return [];
  if(!env.NTFY_URL) throw new Error("GUARD_NTFY_URL_NOT_CONFIGURED");

  const r=await fetch(env.NTFY_URL,{
    method:"POST",
    headers:{
      "Title":"⚡ CABAL EARLY GUARD — VIGILAR AHORA",
      "Priority":"default",
      "Tags":"chart_with_upwards_trend"
    },
    body:chosen.map(guardCard).join("\n\n")
  });
  if(!r.ok) throw new Error("GUARD_NTFY_HTTP_"+r.status);

  for(const c of chosen){
    await guardPut(env,"alert:"+c.base,{lastAlertAt:now,price:c.price,guardScore:c.guardScore});
  }
  await guardPut(env,"alert:__GLOBAL__",{lastAlertAt:now,assets:chosen.map(x=>x.base)});
  return chosen.map(x=>x.base);
}

async function runMarketGuard(event,env){
  const started=Date.now();
  const scheduledAt=Number(event && event.scheduledTime)||started;
  const prev=await guardGet(env,"heartbeat")||{};
  const gap=prev.lastScheduledAt ? Math.max(0,started-Number(prev.lastScheduledAt)) : 0;
  const lag=Math.max(0,started-scheduledAt);
  let hb=Object.assign({},prev,{
    lastScheduledAt:started,
    schedulerLagMs:lag,
    lastObservationGapMs:gap,
    maxObservationGapMs:Math.max(Number(prev.maxObservationGapMs||0),gap)
  });
  await guardPut(env,"heartbeat",hb);

  try{
    const current=await guardBuildSnapshot();
    const h=await guardGet(env,"history");
    let history=Array.isArray(h && h.items) ? h.items : [];
    history=history.filter(x=>x && x.t>=started-GUARD_HISTORY_MINUTES*60_000);
    const candidates=guardCandidates(current,history);
    const alerted=await guardNotify(env,candidates);
    history.push(current);
    history=history.slice(-GUARD_HISTORY_MINUTES);
    await guardPut(env,"history",{items:history});

    const finished=Date.now();
    hb=Object.assign({},hb,{
      lastSuccessfulScan:finished,
      lastRuntimeMs:finished-started,
      lastUniverseCount:current.count,
      lastCandidateCount:candidates.length,
      lastAlertAssets:alerted,
      lastError:null
    });
    await guardPut(env,"heartbeat",hb);
  }catch(e){
    hb=Object.assign({},hb,{
      lastRuntimeMs:Date.now()-started,
      lastError:String(e)
    });
    await guardPut(env,"heartbeat",hb);
  }
}

async function guardHealth(env){
  const now=Date.now();
  const hb=await guardGet(env,"heartbeat");
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
    lastAlertAssets:Array.isArray(hb.lastAlertAssets)?hb.lastAlertAssets:[],
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
