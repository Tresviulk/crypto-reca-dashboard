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

export default {
  async fetch(request, env){
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
