/*
  CABAL + WHALES V3 — production patch
  Effective: 2026-09-12

  Goals:
  - Remove single-exchange / top-N discovery bottlenecks.
  - Add KuCoin spot coverage alongside Bybit (important for assets not on Bybit spot).
  - Scan a broader liquid universe with TradingView in chunks.
  - Preserve independent anomaly lanes: A/B/C/E/T/M + WHALE_INJECT.
  - Add prospective 1–7d SECOND-LEG detection from completed 1h candles.
  - Add multi-venue kline fallback (Bybit <-> KuCoin).
  - Add explicit truncation/coverage truth.
  - Add CABAL -> WHALES_DEEP hook via env.WHALES_DEEP_URL.
  - Add WHALES -> CABAL injection via POST body or ?inject=TOKEN.

  IMPORTANT:
  This worker never auto-trades.
  If WHALES_DEEP_URL is not configured, qualifying assets return WHALE DATA GAP,
  not a false "no whales" result.
*/

const PATCH_VERSION = "CABAL_WHALES_V3_1_21_2026-10-05_RADAR_BRIDGE";

const PRIMARY_MIN_TURNOVER = 2_000_000;
const BROAD_SCAN_MIN_TURNOVER = 250_000;
const MAX_SCAN_UNIVERSE = 900;
const MAX_STAGE_A = 60;

// Cloudflare-safe staged validation: 1h deep-lite on more names, then full 15m/4h on the best.
const MAX_DEEP_LITE = 16;
const MAX_FULL_DEEP = 5;
const MAX_WHALE_REQUESTS = 8;

const TV_CHUNK_SIZE = 180;
const CG_PAGES = 6;

const TV_COLUMNS = [
  "name","description","close","change","change|60","change|240",
  "volume","volume|60","volume|240"
];

const STABLES = new Set([
  "USDT","USDC","DAI","FDUSD","TUSD","USDE","PYUSD","USDS",
  "FRAX","USDD","LUSD","GHO","EURC","USD1","USDG","RLUSD"
]);

const WRAPPED = new Set([
  "WBTC","WETH","STETH","WSTETH","CBETH","RETH","WEETH"
]);

function N(v){
  const x = Number(v);
  return Number.isFinite(x) ? x : null;
}

function median(a){
  const x = a.filter(Number.isFinite).sort((p,q)=>p-q);
  if(!x.length) return null;
  const m = Math.floor(x.length/2);
  return x.length % 2 ? x[m] : (x[m-1]+x[m])/2;
}

function pct(a,b){
  return Number.isFinite(a) && Number.isFinite(b) && b !== 0
    ? (a/b - 1) * 100
    : null;
}

function clamp(v, lo, hi){
  return Math.max(lo, Math.min(hi, v));
}

function upper(v){
  return String(v || "").trim().toUpperCase();
}

const EXTERNAL_FETCH_TIMEOUT_MS = 6500;

const marketSourceBackoff=new Map();
let coinbaseNextRequestAt=0;

function marketRateBackoff(response,now=Date.now()){
  const retry=response.headers.get("retry-after");
  const seconds=retry===null ? NaN : Number(retry);
  const reset=Number(response.headers.get("gw-ratelimit-reset"));
  if(Number.isFinite(seconds) && seconds>=0) return Math.max(1000,seconds*1000);
  if(retry && Number.isFinite(Date.parse(retry))) return Math.max(1000,Date.parse(retry)-now);
  if(reset>0) return Math.max(1000,reset);
  return response.status===403 ? 5*60_000 : 60_000;
}

async function fetchTimed(url, options={}, timeoutMs=EXTERNAL_FETCH_TIMEOUT_MS){
  const host=new URL(url).hostname;
  const limited=["api.kucoin.com","api.bybit.com","api.coinbase.com"].includes(host);
  const blocked=marketSourceBackoff.get(host);
  if(limited && blocked && blocked.until>Date.now()) throw Error("SOURCE_BACKOFF "+host+" HTTP "+blocked.status);
  if(host==="api.coinbase.com"){
    const now=Date.now(), wait=Math.max(0,coinbaseNextRequestAt-now);
    coinbaseNextRequestAt=Math.max(now,coinbaseNextRequestAt)+350;
    if(wait) await new Promise(resolve=>setTimeout(resolve,wait));
  }
  const controller = new AbortController();
  const timer = setTimeout(()=>controller.abort("CABAL_FETCH_TIMEOUT"), timeoutMs);
  try{
    const response=await fetch(url,{...options,signal:controller.signal});
    if(limited && [429,403].includes(response.status)){
      marketSourceBackoff.set(host,{status:response.status,until:Date.now()+marketRateBackoff(response)});
    }
    return response;
  }finally{
    clearTimeout(timer);
  }
}

async function mapLimit(items, concurrency, fn){
  const out = new Array(items.length);
  let next = 0;

  async function worker(){
    while(true){
      const i = next++;
      if(i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  }

  const n = Math.min(concurrency, items.length);
  await Promise.all(Array.from({length:n},()=>worker()));
  return out;
}

function eligibleBase(base){
  if(!base || ["NEON","BLAST"].includes(String(base).trim().toUpperCase())) return false;
  if(STABLES.has(base)) return false;
  if(WRAPPED.has(base)) return false;
  if(/(UP|DOWN|BULL|BEAR|[235]L|[235]S)$/.test(base)) return false;
  return true;
}

function bybitBaseFromSymbol(symbol){
  for(const q of ["USDT","USDC"]){
    if(symbol.endsWith(q)){
      return {base:symbol.slice(0,-q.length), quote:q};
    }
  }
  return null;
}

function kucoinParts(symbol){
  const p = String(symbol || "").split("-");
  if(p.length !== 2) return null;
  if(!["USDT","USDC"].includes(p[1])) return null;
  return {base:p[0], quote:p[1]};
}

async function bybitTickers(){
  const r = await fetchTimed("https://api.bybit.com/v5/market/tickers?category=spot");
  if(!r.ok) throw new Error("Bybit tickers " + r.status);

  const j = await r.json();
  const list = j && j.result && j.result.list ? j.result.list : [];

  return list
    .map(x=>{
      const p = bybitBaseFromSymbol(x.symbol || "");
      if(!p || !eligibleBase(p.base)) return null;
      return {
        venue:"BYBIT",
        venueSymbol:x.symbol,
        canonicalSymbol:p.base + p.quote,
        tvTicker:"BYBIT:" + x.symbol,
        base:p.base,
        quote:p.quote,
        lastPrice:N(x.lastPrice),
        turnover24h:N(x.turnover24h),
        volume24hBase:N(x.volume24h),
        price24hPct:N(x.price24hPcnt) != null ? N(x.price24hPcnt) * 100 : null,
        high24h:N(x.highPrice24h),
        low24h:N(x.lowPrice24h)
      };
    })
    .filter(Boolean);
}

async function kucoinTickers(){
  const r = await fetchTimed("https://api.kucoin.com/api/v1/market/allTickers");
  if(!r.ok) throw new Error("KuCoin tickers " + r.status);

  const j = await r.json();
  const list = j && j.data && Array.isArray(j.data.ticker) ? j.data.ticker : [];

  return list
    .map(x=>{
      const p = kucoinParts(x.symbol);
      if(!p || !eligibleBase(p.base)) return null;
      return {
        venue:"KUCOIN",
        venueSymbol:x.symbol,
        canonicalSymbol:p.base + p.quote,
        tvTicker:"KUCOIN:" + p.base + p.quote,
        base:p.base,
        quote:p.quote,
        lastPrice:N(x.last),
        turnover24h:N(x.volValue),
        volume24hBase:N(x.vol),
        price24hPct:N(x.changeRate) != null ? N(x.changeRate) * 100 : null,
        high24h:N(x.high),
        low24h:N(x.low)
      };
    })
    .filter(Boolean);
}

async function coinGeckoMarkets(env){
  if(!env.COINGECKO_API_KEY){
    return {status:null, rows:[], configured:false};
  }

  const rows = [];
  let status = 200;

  // Sequential pages keep total simultaneous outbound connections comfortably below
  // Cloudflare's per-request connection ceiling while Bybit/KuCoin are also active.
  for(let page=1; page<=CG_PAGES; page++){
    const url =
      "https://api.coingecko.com/api/v3/coins/markets" +
      "?vs_currency=usd" +
      "&order=volume_desc" +
      "&per_page=250" +
      "&page=" + page +
      "&sparkline=false" +
      "&price_change_percentage=1h,24h,7d";

    const r = await fetch(url, {
      headers:{"x-cg-demo-api-key":env.COINGECKO_API_KEY}
    });

    if(!r.ok){
      status = r.status;
      continue;
    }

    const a = await r.json();
    if(Array.isArray(a)) rows.push(...a);
  }

  return {status, rows, configured:true};
}

function cgMap(rows){
  const m = new Map();
  for(const x of rows){
    const s = upper(x.symbol);
    if(!s) continue;
    const old = m.get(s);
    if(!old || (Number(x.total_volume) || 0) > (Number(old.total_volume) || 0)){
      m.set(s,x);
    }
  }
  return m;
}

function dedupeMarkets(markets){
  const byBase = new Map();

  for(const m of markets){
    if(!eligibleBase(m.base)) continue;
    const key = m.base;
    const arr = byBase.get(key) || [];
    arr.push(m);
    byBase.set(key,arr);
  }

  const preferred = [];
  for(const [base, arr] of byBase){
    arr.sort((a,b)=>(b.turnover24h || 0) - (a.turnover24h || 0));
    preferred.push(arr[0]);
  }

  preferred.sort((a,b)=>(b.turnover24h || 0) - (a.turnover24h || 0));

  return {preferred, byBase};
}

async function tvScanChunk(tickers){
  const payload = {
    symbols:{tickers, query:{types:[]}},
    columns:TV_COLUMNS
  };

  const r = await fetch("https://scanner.tradingview.com/crypto/scan", {
    method:"POST",
    headers:{
      "content-type":"application/json",
      "user-agent":"Mozilla/5.0"
    },
    body:JSON.stringify(payload)
  });

  if(!r.ok) throw new Error("TradingView " + r.status);
  const j = await r.json();
  return {status:r.status, rows:j.data || []};
}

async function tvScanMarkets(markets){
  const tickers = markets.map(x=>x.tvTicker).filter(Boolean);
  const rows = [];
  const statuses = [];
  const errors = [];

  for(let i=0; i<tickers.length; i+=TV_CHUNK_SIZE){
    const chunk = tickers.slice(i,i+TV_CHUNK_SIZE);
    try{
      const x = await tvScanChunk(chunk);
      statuses.push(x.status);
      rows.push(...x.rows);
    }catch(e){
      errors.push(String(e));
    }
  }

  return {
    status:errors.length ? "PARTIAL" : 200,
    statuses,
    errors,
    rows
  };
}

function tvMap(rows){
  const m = new Map();

  for(const row of rows){
    const s = row.s || "";
    const d = row.d || [];
    if(!s) continue;

    m.set(s, {
      tvTicker:s,
      price:N(d[2]),
      change24h:N(d[3]),
      change1h:N(d[4]),
      change4h:N(d[5]),
      volumeNow:N(d[6]),
      vol1h:N(d[7]),
      vol4h:N(d[8])
    });
  }

  return m;
}

function cgPct(g, key){
  if(!g) return null;
  return N(g[key]);
}

function laneCounts(candidates){
  const out = {A:0,B:0,C:0,E:0,T:0,M:0,WHALE_INJECT:0};
  for(const c of candidates){
    for(const x of c.bucketHits || []){
      if(out[x] == null) out[x] = 0;
      out[x]++;
    }
  }
  return out;
}

function selectWithQuotas(all){
  const sorted = [...all].sort((a,b)=>b.stageAScore-a.stageAScore);
  const chosen = [];
  const seen = new Set();

  const quotas = [
    ["WHALE_INJECT",8],
    ["E",16],
    ["T",10],
    ["B",12],
    ["A",12],
    ["C",12],
    ["M",8]
  ];

  for(const [lane, q] of quotas){
    let n = 0;
    for(const c of sorted){
      if(n >= q || chosen.length >= MAX_STAGE_A) break;
      if(seen.has(c.base)) continue;
      if(!(c.bucketHits || []).includes(lane)) continue;
      chosen.push(c);
      seen.add(c.base);
      n++;
    }
  }

  for(const c of sorted){
    if(chosen.length >= MAX_STAGE_A) break;
    if(seen.has(c.base)) continue;
    chosen.push(c);
    seen.add(c.base);
  }

  return chosen;
}

function buildStageA(markets, tv, cg, whaleInjectedBases){
  const btcRow = markets.find(x=>x.base === "BTC") || null;
  const btcTv = btcRow ? tv.get(btcRow.tvTicker) : null;

  const all = [];

  for(const m of markets){
    const injected = whaleInjectedBases.has(m.base);
    const t = tv.get(m.tvTicker) || null;
    const g = cg.get(m.base) || null;

    const mc = g && Number.isFinite(Number(g.market_cap)) ? Number(g.market_cap) : null;
    const cgVol = g && Number.isFinite(Number(g.total_volume)) ? Number(g.total_volume) : null;
    const turnover = Math.max(m.turnover24h || 0, cgVol || 0);

    if(turnover < BROAD_SCAN_MIN_TURNOVER && !injected) continue;

    const change1h = t && t.change1h != null
      ? t.change1h
      : cgPct(g,"price_change_percentage_1h_in_currency");

    const change4h = t ? t.change4h : null;

    const change24h = t && t.change24h != null
      ? t.change24h
      : (cgPct(g,"price_change_percentage_24h_in_currency") ?? m.price24hPct);

    const change7d = cgPct(g,"price_change_percentage_7d_in_currency");

    const volAccel = t && t.vol1h && t.vol4h > 0
      ? t.vol1h / (t.vol4h / 4)
      : null;

    const rs1h = btcTv && change1h != null && btcTv.change1h != null
      ? change1h - btcTv.change1h
      : null;

    const rs4h = btcTv && change4h != null && btcTv.change4h != null
      ? change4h - btcTv.change4h
      : null;

    const turnoverRatio = mc && mc > 0 ? turnover / mc : null;

    const inPrimaryBand = mc == null || (mc >= 15_000_000 && mc <= 3_000_000_000);
    const exceptionalLarge = mc != null && mc > 3_000_000_000 && (
      (change1h || 0) >= 4 ||
      (change4h || 0) >= 8 ||
      (volAccel || 0) >= 2
    );

    const microcapAnomaly = mc != null && mc < 15_000_000 && turnover >= BROAD_SCAN_MIN_TURNOVER && (
      ((turnoverRatio || 0) >= 0.08 && ((change1h || 0) >= 0.75 || (change24h || 0) >= 5 || (volAccel || 0) >= 1.35)) ||
      ((turnoverRatio || 0) >= 0.20)
    );

    if(!inPrimaryBand && !exceptionalLarge && !microcapAnomaly && !injected) continue;
    if(inPrimaryBand && turnover < PRIMARY_MIN_TURNOVER && !injected) continue;

    const A = (change1h || 0) >= 1.0 || (change4h || 0) >= 2.5;
    const B = (volAccel || 0) >= 1.4;
    const C = (
      ((change1h || 0) >= 0.5 && (volAccel || 0) >= 1.5) ||
      ((change4h || 0) >= 2.0 && (volAccel || 0) >= 1.25) ||
      ((rs1h || 0) >= 1.0 && (volAccel || 0) >= 1.25)
    );

    // E is deliberately broad at Stage A. Completed 1h candles later decide whether a real reset/base exists.
    const priorMoveMaterial = (change7d || 0) >= 15 || (change24h || 0) >= 8;
    const currentNotVertical = (change1h == null || change1h < 5) && (change4h == null || change4h < 10);
    const renewedParticipation = (volAccel || 0) >= 1.10 || (rs1h || 0) >= 0.4 || (change1h || 0) >= 0.35;
    const E = priorMoveMaterial && currentNotVertical && renewedParticipation;

    const T = (
      ((turnoverRatio || 0) >= 0.15 && ((volAccel || 0) >= 1.15 || Math.abs(change1h || 0) >= 0.5)) ||
      (turnover >= 20_000_000 && (volAccel || 0) >= 1.3)
    );

    const W = injected;
    const M = microcapAnomaly;

    if(!A && !B && !C && !E && !T && !M && !W) continue;

    let score = 0;
    score += clamp((change1h || 0) * 6, 0, 30);
    score += clamp((change4h || 0) * 2, 0, 24);
    score += clamp(((volAccel || 0)-1) * 22, 0, 30);
    score += clamp((rs1h || 0) * 4, 0, 10);
    score += turnover >= 10_000_000 ? 6 : 3;
    if(E) score += 18;
    if(T) score += 12;
    if(M) score += 10;
    if(W) score += 30;

    const churn = (volAccel || 0) >= 1.8 && Math.abs(change1h || 0) < 0.4 && Math.abs(change4h || 0) < 1.2;
    if(churn) score -= 25;

    // Keep late movers visible for process-miss/second-leg surveillance, but deprioritize pure vertical chase.
    if((change1h || 0) >= 8 && !E) score -= 12;
    if((change4h || 0) >= 15 && !E) score -= 14;
    if((change24h || 0) >= 40 && !E) score -= 12;

    if(score < 10 && !E && !T && !M && !W) continue;

    all.push({
      symbol:m.canonicalSymbol,
      base:m.base,
      quote:m.quote,
      venue:m.venue,
      venueSymbol:m.venueSymbol,
      tvTicker:m.tvTicker,
      currentPrice:m.lastPrice || (t ? t.price : null),
      turnover24h:turnover,
      marketCap:mc,
      marketCapSource:mc == null ? "UNKNOWN" : "CoinGecko",
      turnoverToMarketCap:turnoverRatio,
      change1h,
      change4h,
      change24h,
      change7d,
      vol1h:t ? t.vol1h : null,
      vol4h:t ? t.vol4h : null,
      volAccel,
      rs1h,
      rs4h,
      bucketHits:[
        A ? "A" : null,
        B ? "B" : null,
        C ? "C" : null,
        E ? "E" : null,
        T ? "T" : null,
        M ? "M" : null,
        W ? "WHALE_INJECT" : null
      ].filter(Boolean),
      stageAChurnRisk:churn,
      microcapAnomaly:M,
      whaleInjected:W,
      stageAScore:Math.round(score*10)/10
    });
  }

  all.sort((a,b)=>b.stageAScore-a.stageAScore);
  const selected = selectWithQuotas(all);

  return {
    btcReference:btcRow ? {
      symbol:btcRow.canonicalSymbol,
      venue:btcRow.venue,
      price:btcRow.lastPrice,
      change1h:btcTv ? btcTv.change1h : null,
      change4h:btcTv ? btcTv.change4h : null
    } : null,
    allCandidateCount:all.length,
    allLaneCounts:laneCounts(all),
    candidates:selected,
    stageATruncated:all.length > selected.length
  };
}

const INT_MS = {
  "15":900000,
  "60":3600000,
  "240":14400000
};

async function bybitKline(symbol, interval, limit){
  const url =
    "https://api.bybit.com/v5/market/kline?category=spot" +
    "&symbol=" + encodeURIComponent(symbol) +
    "&interval=" + interval +
    "&limit=" + limit;

  const r = await fetchTimed(url);
  if(!r.ok) throw new Error("Bybit kline " + symbol + "/" + interval + " " + r.status);

  const j = await r.json();
  const list = j && j.result && j.result.list ? j.result.list : [];
  const now = Date.now();

  return list
    .map(x=>({t:+x[0],o:+x[1],h:+x[2],l:+x[3],c:+x[4],v:+x[5]}))
    .filter(x=>x.t + INT_MS[interval] <= now)
    .sort((a,b)=>a.t-b.t);
}

function kucoinInterval(interval){
  if(interval === "15") return "15min";
  if(interval === "60") return "1hour";
  if(interval === "240") return "4hour";
  throw new Error("Unsupported KuCoin interval " + interval);
}

async function kucoinKline(symbol, interval, limit){
  const sec = Math.ceil((INT_MS[interval] * Math.max(limit + 4, 20)) / 1000);
  const endAt = Math.floor(Date.now()/1000);
  const startAt = endAt - sec;

  const url =
    "https://api.kucoin.com/api/v1/market/candles" +
    "?symbol=" + encodeURIComponent(symbol) +
    "&type=" + encodeURIComponent(kucoinInterval(interval)) +
    "&startAt=" + startAt +
    "&endAt=" + endAt;

  const r = await fetchTimed(url);
  if(!r.ok) throw new Error("KuCoin kline " + symbol + "/" + interval + " " + r.status);

  const j = await r.json();
  const list = j && Array.isArray(j.data) ? j.data : [];
  const now = Date.now();

  return list
    .map(x=>({
      t:+x[0]*1000,
      o:+x[1],
      c:+x[2],
      h:+x[3],
      l:+x[4],
      v:+x[5]
    }))
    .filter(x=>x.t + INT_MS[interval] <= now)
    .sort((a,b)=>a.t-b.t)
    .slice(-limit);
}

async function coinbaseKline(symbol,interval,limit){
  const granularity={"1":"ONE_MINUTE","5":"FIVE_MINUTE","15":"FIFTEEN_MINUTE","60":"ONE_HOUR","120":"TWO_HOUR","240":"FOUR_HOUR","360":"SIX_HOUR","D":"ONE_DAY"}[interval];
  if(!granularity || !INT_MS[interval]) throw Error("COINBASE_INTERVAL_UNSUPPORTED");
  const end=Math.floor(Date.now()/1000);
  const start=end-Math.ceil((limit+2)*INT_MS[interval]/1000);
  const url="https://api.coinbase.com/api/v3/brokerage/market/products/"+encodeURIComponent(symbol)+"/candles?granularity="+granularity+"&start="+start+"&end="+end+"&limit="+Math.min(350,limit+2);
  const r=await fetchTimed(url);
  if(!r.ok) throw Error("Coinbase candles "+symbol+" "+r.status);
  const j=await r.json();
  if(!Array.isArray(j.candles)) throw Error("COINBASE_INVALID_CANDLES");
  return j.candles.map(x=>({t:Number(x.start)*1000,l:Number(x.low),h:Number(x.high),o:Number(x.open),c:Number(x.close),v:Number(x.volume)}))
    .filter(x=>Object.values(x).every(Number.isFinite) && x.t+INT_MS[interval]<=Date.now())
    .sort((a,b)=>a.t-b.t).slice(-limit);
}

async function guardCoinbaseMarket(base){
  if(!eligibleBase(base)) throw Error("COINBASE_BASE_EXCLUDED");
  const symbol=base+"-USD";
  const root="https://api.coinbase.com/api/v3/brokerage/market/products/"+encodeURIComponent(symbol);
  const productResponse=await fetchTimed(root);
  if(!productResponse.ok) throw Error("Coinbase product "+symbol+" "+productResponse.status);
  const product=await productResponse.json();
  if(product.product_id!==symbol || product.base_currency_id!==base || product.quote_currency_id!=="USD" || product.product_type!=="SPOT" || product.is_disabled || product.view_only || product.trading_disabled || product.cancel_only || product.post_only || product.limit_only || product.auction_mode) throw Error("COINBASE_PRODUCT_NOT_EXECUTABLE");
  const tickerResponse=await fetchTimed(root+"/ticker?limit=1");
  if(!tickerResponse.ok) throw Error("Coinbase ticker "+symbol+" "+tickerResponse.status);
  const ticker=await tickerResponse.json();
  const trade=ticker.trades?.[0];
  const at=Date.parse(trade?.time), price=Number(trade?.price);
  if(trade?.product_id!==symbol || !Number.isFinite(at) || Math.abs(Date.now()-at)>120_000 || !(price>0)) throw Error("COINBASE_STALE_PRICE");
  const volume=Number(product.volume_24h), change=parseFloat(product.price_percentage_change_24h);
  if(!(volume>0) || !Number.isFinite(change)) throw Error("COINBASE_STATS_INVALID");
  return {base,quote:"USD",venue:"COINBASE",venueSymbol:symbol,lastPrice:price,
    turnover24h:volume*price,price24hPct:change};
}

async function klineOnMarket(market, interval, limit){
  if(market.venue === "BYBIT") return bybitKline(market.venueSymbol, interval, limit);
  if(market.venue === "KUCOIN") return kucoinKline(market.venueSymbol, interval, limit);
  if(market.venue === "COINBASE") return coinbaseKline(market.venueSymbol,interval,limit);
  throw new Error("Unsupported venue " + market.venue);
}

async function klineWithFallback(candidate, interval, limit, marketsByBase, preferredMarket){
  const arr = marketsByBase.get(candidate.base) || [];
  const ordered = [];

  if(preferredMarket) ordered.push(preferredMarket);

  const primary = arr.find(x=>x.venue === candidate.venue && x.venueSymbol === candidate.venueSymbol);
  if(primary && !ordered.some(x=>x.venue===primary.venue && x.venueSymbol===primary.venueSymbol)) ordered.push(primary);

  for(const x of arr){
    if(!ordered.some(y=>y.venue===x.venue && y.venueSymbol===x.venueSymbol)) ordered.push(x);
  }

  const errors = [];
  for(const m of ordered){
    try{
      const bars = await klineOnMarket(m, interval, limit);
      if(bars.length >= Math.min(12, Math.floor(limit/3))){
        return {bars, market:m, fallback:m.venue !== candidate.venue, errors};
      }
      errors.push(m.venue + ":INSUFFICIENT_BARS");
    }catch(e){
      errors.push(String(e));
    }
  }

  throw new Error("KLINE_DATA_GAP " + candidate.base + " " + interval + " | " + errors.join(" | "));
}

function deepLiteAnalysis(a60, c){
  if(!a60 || a60.length < 24) return null;

  const last = a60[a60.length-1];
  const prev20 = a60.slice(Math.max(0,a60.length-21),a60.length-1);
  const baseVol = median(prev20.map(x=>x.v)) || last.v || 1;
  const rvol1h = last.v / baseVol;

  const closeN = n => a60.length > n ? a60[a60.length-1-n].c : null;
  const move6h = pct(last.c, closeN(6));
  const move24h = pct(last.c, closeN(24));
  const move72h = pct(last.c, closeN(72));
  const move7d = pct(last.c, closeN(168));
  const move1h = pct(last.c,last.o);

  const baseWindow = a60.slice(Math.max(0,a60.length-13),a60.length-1);
  const priorWindow = a60.slice(Math.max(0,a60.length-37),Math.max(0,a60.length-13));
  const triggerWindow = a60.slice(Math.max(0,a60.length-7),a60.length-1);

  const baseHigh = Math.max(...baseWindow.map(x=>x.h));
  const baseLow = Math.min(...baseWindow.map(x=>x.l));
  const baseRangePct = baseLow > 0 ? (baseHigh/baseLow - 1) * 100 : null;

  const baseWindowVol = median(baseWindow.map(x=>x.v));
  const priorWindowVol = median(priorWindow.map(x=>x.v));
  const volumeCooled = Number.isFinite(baseWindowVol) && Number.isFinite(priorWindowVol) && priorWindowVol > 0
    ? baseWindowVol <= priorWindowVol * 1.15
    : true;

  const breakoutLevel = triggerWindow.length ? Math.max(...triggerWindow.map(x=>x.h)) : baseHigh;
  const freshParticipation = rvol1h >= 1.20;
  const positiveReaccel = (move1h || 0) >= 0.30 || last.c >= breakoutLevel * 0.995;

  const historicalMove = Math.max(
    c.change7d || -Infinity,
    c.change24h || -Infinity,
    move72h || -Infinity,
    move7d || -Infinity
  );

  const priorLegMaterial = historicalMove >= 10;
  const controlledBase = baseRangePct != null && baseRangePct <= 15;
  const notVerticallyExtended = baseHigh > 0 ? last.c <= baseHigh * 1.06 : true;
  const secondLegWatch = priorLegMaterial && controlledBase && volumeCooled && notVerticallyExtended;

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

// Keep each snapshot in its own row to avoid decoding/encoding seven full universes per cycle.
async function guardLoadHistory(env, now){
  if(!env.DB) return [];
  await env.DB.prepare("CREATE TABLE IF NOT EXISTS cabal_guard_snapshots (t INTEGER PRIMARY KEY, v TEXT NOT NULL)").run();
  const targets=[now-60_000,now-180_000,now-300_000];
  const result=await env.DB.prepare(
    "SELECT v FROM cabal_guard_snapshots WHERE (t BETWEEN ?1 AND ?2) OR (t BETWEEN ?3 AND ?4) OR (t BETWEEN ?5 AND ?6) ORDER BY t"
  ).bind(...targets.flatMap(t=>[t-20_000,t+20_000])).all();
  return (result.results||[]).map(row=>JSON.parse(row.v));
}

async function guardSaveSnapshot(env, current){
  if(!env.DB) return;
  await env.DB.batch([
    env.DB.prepare("INSERT OR REPLACE INTO cabal_guard_snapshots (t,v) VALUES (?1,?2)").bind(current.t,JSON.stringify(current)),
    env.DB.prepare("DELETE FROM cabal_guard_snapshots WHERE t < ?1").bind(current.t-GUARD_HISTORY_MINUTES*60_000)
  ]);
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
  let best=null, gap=Infinity;
  for(const snap of history||[]){
    if(!snap || !snap.t || !snap.a || !snap.a[base]) continue;
    const distance=Math.abs(snap.t-targetMs);
    if(distance<=20_000 && distance<gap){ best=snap; gap=distance; }
  }
  return best ? best.a[base] : null;
}

// Persist identities, never reuse an old price or an old BUY decision.
async function guardRunnerFollowup(env){
  const now=Date.now();
  const prior=await guardGet(env,"runner:followup")||{};
  let items=(prior.items||[]).filter(x=>x.expiresAt>now && eligibleBase(x.base));
  if(!prior.refreshedAt || now-prior.refreshedAt>=60_000){
    try{
      const r=await fetchTimed("https://raw.githubusercontent.com/Tresviulk/crypto-reca-dashboard/main/data/ntfy-alert-log.json");
      if(!r.ok) throw Error("RUNNER_SOURCE_"+r.status);
      const j=await r.json();
      for(const event of (j.events||[]).slice(-20)){
        const at=Date.parse(event.cabalGeneratedAt);
        if(event.kind!=="RUNNER" || !Number.isFinite(at) || at>now || now-at>=30*60_000) continue;
        const rows=[...String(event.message||"").matchAll(/^🚀 ([A-Z0-9]+) —/gm)].map(m=>m[1]);
        for(const base of rows){
          if(!eligibleBase(base) || items.some(y=>y.base===base && y.scanAt>=at)) continue;
          items=items.filter(y=>y.base!==base);
          items.push({base,scanAt:at,expiresAt:at+30*60_000});
        }
      }
      await guardPut(env,"runner:followup",{items,refreshedAt:now,error:null});
    }catch(e){
      await guardPut(env,"runner:followup",{items,refreshedAt:now,error:String(e)});
    }
  }
  if(env.RADAR_URL){
    try{
      const r=await fetchTimed(env.RADAR_URL);
      if(!r.ok) throw Error("RADAR_HTTP_"+r.status);
      const radar=await r.json(), last=radar.last||{};
      const at=Date.parse(last.generatedAt);
      if(!radar.healthy || !Number.isFinite(at) || at>now || now-at>90_000) throw Error("RADAR_STALE_OR_UNHEALTHY");
      const delivery=radar.earlyWatchDelivery||{};
      const alerts=Object.entries(delivery.lastByAsset||{})
        .map(([base,t])=>({base,scanAt:Date.parse(t),alerted:true}))
        .filter(x=>eligibleBase(x.base) && Number.isFinite(x.scanAt) && x.scanAt<=now && now-x.scanAt<30*60_000);
      const detected=(last.detected||[]).filter(x=>eligibleBase(x.asset)).slice(0,6)
        .map(x=>({base:x.asset,scanAt:at}));
      for(const x of [...alerts,...detected]){
        if(items.some(y=>y.base===x.base && y.scanAt>=x.scanAt)) continue;
        const alerted=x.alerted || items.find(y=>y.base===x.base)?.alerted || false;
        items=items.filter(y=>y.base!==x.base);
        items.push({...x,alerted,expiresAt:x.scanAt+30*60_000});
      }
      // Discovery carries identities only. Execution obtains a fresh native quote.
      await guardPut(env,"radar:bridge",{generatedAt:last.generatedAt,sourceStatus:last.sourceStatus,universeCount:last.universeCount,alerts:alerts.map(x=>x.base),error:null});
      items.sort((a,b)=>Number(Boolean(b.alerted))-Number(Boolean(a.alerted)) || b.scanAt-a.scanAt);
      await guardPut(env,"runner:followup",{items:items.slice(0,12),refreshedAt:now,error:null});
    }catch(e){
      await guardPut(env,"radar:bridge",{error:String(e),checkedAt:new Date(now).toISOString()});
    }
  }
  return items.slice(0,6);
}

async function guardTargetedKucoin(items){
  return (await mapLimit(items,2,async x=>{
    try{
      const symbol=x.base+"-USDT";
      const r=await fetchTimed("https://api.kucoin.com/api/v1/market/stats?symbol="+encodeURIComponent(symbol));
      if(!r.ok) return null;
      const j=await r.json(), d=j.data;
      if(j.code!=="200000" || !d || !(Number(d.last)>0)) return null;
      // Exchange timestamp is mandatory: stale data cannot become a new snapshot.
      if(!Number.isFinite(Number(d.time)) || Math.abs(Date.now()-Number(d.time))>120_000) return null;
      return {base:x.base,quote:"USDT",venue:"KUCOIN",venueSymbol:symbol,
        lastPrice:Number(d.last),turnover24h:Number(d.volValue),
        price24hPct:Number(d.changeRate)*100};
    }catch(_){return null;}
  })).filter(Boolean);
}

function guardFollowupCandidates(current,history,detected,items){
  const result=[...detected];
  for(const x of items){
    if(result.some(c=>c.base===x.base)) continue;
    const c=guardCandidateSnapshot(current,history,x.base);
    if(c && eligibleBase(c.base)) result.unshift({...c,runnerFollowup:true});
  }
  return result;
}

async function guardBuildSnapshot(followup=[],env){
  if(env && env.RADAR_URL){
    const bridge=await guardGet(env,"radar:bridge");
    if(!bridge || bridge.error || Date.now()-Date.parse(bridge.generatedAt)>90_000) throw Error("RADAR_BRIDGE_UNAVAILABLE");
    const active=await guardGet(env,"trade:active");
    const bases=[...new Set([...(active&&active.asset?[active.asset]:[]),...followup.map(x=>x.base)])].filter(eligibleBase).slice(0,6);
    const errors=[];
    const markets=await mapLimit(bases,1,async base=>{
      const kucoin=(await guardTargetedKucoin([{base}]))[0];
      if(kucoin) return kucoin;
      try{return await guardCoinbaseMarket(base);}catch(e){errors.push(base+":"+String(e));return null;}
    });
    const a={};
    for(const m of markets.filter(Boolean)) a[m.base]=guardSnapshotAsset(m);
    if(bases.length && !Object.keys(a).length) throw Error("RADAR_NATIVE_QUOTES_UNAVAILABLE "+errors.join("; "));
    return {t:Date.now(),a,count:Object.keys(a).length,discoveryUniverseCount:bridge.universeCount,
      sourceStatus:{mode:"RADAR_DISCOVERY_NATIVE_EXECUTION",radar:bridge.sourceStatus,kucoin:"TARGETED_ONLY",coinbase:"TARGETED_ONLY",quoteErrors:errors}};
  }
  const src=await Promise.allSettled([bybitTickers(),kucoinTickers()]);
  const bybit=src[0].status==="fulfilled" ? src[0].value : [];
  let kucoin=src[1].status==="fulfilled" ? src[1].value : [];
  const bybitError=src[0].status==="rejected" ? String(src[0].reason||"BYBIT_FAILED") : null;
  const kucoinError=src[1].status==="rejected" ? String(src[1].reason||"KUCOIN_FAILED") : null;
  const targeted=!kucoin.length && followup.length ? await guardTargetedKucoin(followup) : [];
  if(targeted.length) kucoin=targeted;
  let coinbase=[];
  const coinbaseErrors=[];
  if(!bybit.length && !kucoin.length){
    const watch=env ? await guardGet(env,"watch:latest") : null;
    const recent=watch && Date.now()-Date.parse(watch.generatedAt)<10*60_000 ? watch.candidates||[] : [];
    const active=env ? await guardGet(env,"trade:active") : null;
    const tracked=[...new Set([...(active&&active.asset?[active.asset]:[]),...followup.map(x=>x.base),...recent.map(x=>x.base)])].filter(eligibleBase).slice(0,7);
    // Tracked names may have no Coinbase listing. Reserve liquid reference markets
    // independently so those names cannot consume every fallback slot.
    const bases=[...new Set([...tracked,"BTC","ETH"])];
    coinbase=(await mapLimit(bases,1,async base=>{try{return await guardCoinbaseMarket(base);}catch(e){coinbaseErrors.push(base+":"+String(e));return null;}})).filter(Boolean);
  }
  if(!bybit.length && !kucoin.length && !coinbase.length) throw new Error("GUARD_NO_SPOT_SOURCE | BYBIT="+bybitError+" | KUCOIN="+kucoinError+" | COINBASE="+coinbaseErrors.join("; "));

  // The one-minute guard must not inherit a Bybit outage when KuCoin is healthy.
  // Prefer KuCoin for assets present on both venues; keep Bybit-only names as fallback.
  const eligible=[...bybit,...kucoin,...coinbase]
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
      coinbase:coinbase.length?"TARGETED_ONLY":"NOT_USED",
      bybit:bybit.length?"PASS":"FAIL",
      kucoin:targeted.length?"TARGETED_ONLY":(kucoin.length?"PASS":"FAIL"),
      bybitError,kucoinError,coinbaseErrors
    }
  };
}

function guardCandidates(current,history){
  const out=[];
  const now=current.t;
  for(const [base,x] of Object.entries(current.a||{})){
    if(["NEON","BLAST"].includes(String(base).trim().toUpperCase())) continue;
    const price=Number(x[0]), turn=Number(x[1]), p24=Number(x[2]), venue=String(x[3]||""), venueSymbol=String(x[4]||"");
    if(!(price>0) || !(turn>=GUARD_MIN_TURNOVER)) continue;

    const h1=guardFindAsset(history,base,now-60_000);
  const x1=h1 && h1[3]===venue && h1[4]===venueSymbol ? h1 : null;
    const h3=guardFindAsset(history,base,now-180_000);
  const x3=h3 && h3[3]===venue && h3[4]===venueSymbol ? h3 : null;
    const h5=guardFindAsset(history,base,now-300_000);
  const x5=h5 && h5[3]===venue && h5[4]===venueSymbol ? h5 : null;
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

  const sameMarketHistory=(history||[]).filter(s=>s.a && s.a[base] && s.a[base][3]===venue && s.a[base][4]===venueSymbol);
  const h1=guardFindAsset(sameMarketHistory,base,now-60_000);
  const x1=h1 && h1[3]===venue && h1[4]===venueSymbol ? h1 : null;
  const h3=guardFindAsset(sameMarketHistory,base,now-180_000);
  const x3=h3 && h3[3]===venue && h3[4]===venueSymbol ? h3 : null;
  const h5=guardFindAsset(sameMarketHistory,base,now-300_000);
  const x5=h5 && h5[3]===venue && h5[4]===venueSymbol ? h5 : null;
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
  if(Number.isFinite(seconds) && seconds>=0) return Math.max(5_000,seconds*1000);
  const when=Date.parse(raw);
  if(Number.isFinite(when)) return Math.max(5_000,when-Date.now());
  return null;
}

function guardTransportBackoffMs(response,body=""){
  const retry=guardRetryAfterMs(response);
  if(retry!==null) return retry;
  if(response && response.status===429 && /daily.*message|message.*daily/i.test(body)){
    const now=Date.now();
    const next=new Date(now);next.setUTCHours(24,0,0,0);
    return next.getTime()-now;
  }
  return response && response.status===429 ? 15*60_000 : 60_000;
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

// Closed candles are immutable until the next interval closes. Reuse only within
// that exact bucket; never carry stale bars across a new 15m/1h close.
async function guardClosedCandles(env,market,interval,limit){
  const bucket=Math.floor(Date.now()/INT_MS[interval]);
  const key="execution:bars:"+market.venue+":"+market.venueSymbol+":"+interval+":"+limit;
  const cached=env ? await guardGet(env,key) : null;
  if(cached && cached.bucket===bucket && Array.isArray(cached.bars)) return cached.bars;
  const bars=await klineOnMarket(market,interval,limit);
  if(env && bars.length && bars[bars.length-1].t===(bucket-1)*INT_MS[interval]){
    await guardPut(env,key,{bucket,bars});
  }
  return bars;
}

async function guardExecutionMetricsOnMarket(c,market,env){
  const btcSymbol=market.venue==="BYBIT" ? "BTCUSDT" : (market.venue==="COINBASE" ? "BTC-USD" : "BTC-USDT");
  const btcMarket={venue:market.venue,venueSymbol:btcSymbol};

  const [a15,a60,btc60]=await Promise.all([
    guardClosedCandles(env,market,"15",60),
    guardClosedCandles(env,market,"60",180),
    guardClosedCandles(env,btcMarket,"60",30)
  ]);
  if(a15.length<20 || a60.length<30 || btc60.length<6) throw new Error("GUARD_EXECUTION_INSUFFICIENT_BARS");

  if(market.venue==="COINBASE"){
    for(const [bars,interval] of [[a15,"15"],[a60,"60"],[btc60,"60"]]){
      const ms=INT_MS[interval], expected=(Math.floor(Date.now()/ms)-1)*ms;
      if(bars[bars.length-1].t!==expected || bars.slice(-24).some((x,i,a)=>i>0 && x.t-a[i-1].t!==ms)) throw Error("COINBASE_CANDLE_GAP");
    }
  }
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

async function guardExecutionMetrics(c,env){
  if(!c || !c.base || !c.venue || !c.venueSymbol) throw new Error("GUARD_EXECUTION_SYMBOL_MISSING");
  const alternatives=[{venue:c.venue,venueSymbol:c.venueSymbol}];
  if(c.venue!=="KUCOIN") alternatives.push({venue:"KUCOIN",venueSymbol:c.base+"-USDT"});
  if(c.venue!=="COINBASE") alternatives.push({venue:"COINBASE",venueSymbol:c.base+"-USD"});
  const errors=[];
  for(const market of alternatives){
    try{
      let execution=c;
      if(market.venue!==c.venue || market.venueSymbol!==c.venueSymbol){
        const row=market.venue==="COINBASE" ? await guardCoinbaseMarket(c.base) : (await guardTargetedKucoin([{base:c.base}]))[0];
        if(!row) throw Error("ALTERNATIVE_LIVE_PRICE_MISSING");
        const current={t:Date.now(),a:{[c.base]:guardSnapshotAsset(row)}};
        const history=env ? await guardLoadHistory(env,current.t) : [];
        execution=guardCandidateSnapshot(current,history,c.base);
        if(!execution) throw Error("ALTERNATIVE_MARKET_NOT_EXECUTABLE");
        if(env) await guardSaveSnapshot(env,current);
      }
      const metrics=await guardExecutionMetricsOnMarket(execution,market,env);
      return {...metrics,executionCandidate:execution};
    }catch(e){errors.push(market.venue+":"+market.venueSymbol+"="+String(e));}
  }
  throw new Error("GUARD_EXECUTION_DATA_GAP "+c.base+" | "+errors.join(" | "));
}

function guardPilotDecision(c,m){
  if(m.executionCandidate) c=m.executionCandidate;
  if(["NEON","BLAST"].includes(String(c.base || "").trim().toUpperCase())) return {asset:c.base,buy:false,reason:"PROJECT_WIND_DOWN",entryMax:null,stop:null,recoveryBuyEligible:false};
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
  // confirmed on a separate cycle at least 60 seconds later before action.
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
    const market=String(x.venue||"")+":"+String(x.venueSymbol||"");
    const continuous=prev.market===market && priorAt>0 && (now-priorAt)<=GUARD_BUY_CONFIRMATION_MAX_GAP_MS;
    const separateCycle=continuous && now-priorAt>=60_000;
    const confirmations=continuous ? Number(prev.confirmations||0)+(separateCycle?1:0) : 1;
    const required=x.asset==="BTC" ? 1 : GUARD_BUY_CONFIRMATIONS_REQUIRED_NON_BTC;
    const firstConfirmedAt=continuous ? Number(prev.firstConfirmedAt||priorAt) : now;
    const q={...x,confirmations,requiredConfirmations:required};

    await guardPut(env,key,{
      asset:x.asset,confirmations,requiredConfirmations:required,
      market,firstConfirmedAt,lastConfirmedAt:continuous&&!separateCycle?priorAt:now,
      reason:x.reason,price:x.price,score:x.score
    });

    if(confirmations>=required) qualified.push(q);
    else staged.push(q);
  }
  return {rawBuys,qualified,staged};
}

async function guardEvaluateTrades(env,candidates){
  const top=(candidates||[]).slice(0,6);
  const evaluated=await mapLimit(top,1,async x=>{
    try{
      const m=await guardExecutionMetrics(x,env);
      return guardPilotDecision(x,m);
    }catch(e){
      return {asset:x.base,venue:x.venue,price:x.price,buy:false,reason:"DATA_GAP",error:String(e)};
    }
  });
  const qualification=await guardQualifyBuySignals(env,evaluated);
  const buys=qualification.qualified;
  const state={
    generatedAt:new Date().toISOString(),
    mode:"CLOUDFLARE_1M_EXECUTION_GUARD",
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
  const buys=(Array.isArray(state&&state.buys)?state.buys:[]).filter(x=>!["NEON","BLAST"].includes(String(x.asset || "").trim().toUpperCase()));
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
    r=await fetchTimed(env.NTFY_URL,{
      method:"POST",
      headers:{"Title":"CABAL - COMPRAR AHORA","Priority":"high","Tags":"chart_with_upwards_trend"},
      body:guardTradeCard(x)
    },20000);
    if(!r.ok){ try{responseText=(await r.text()).slice(0,300);}catch(_){} }
  }catch(e){
    const state2={lastAttemptAt:now,lastStatus:null,lastError:String(e),backoffUntil:now+60*1000};
    await guardPut(env,"trade:notify:state",state2);
    await guardPut(env,"trade:pending",{generatedAt:state.generatedAt,buy:x});
    return {ok:false,kind:"BUY",asset:x.asset,error:String(e),backoffUntil:state2.backoffUntil};
  }

  if(!r.ok){
    const backoff=guardTransportBackoffMs(r,responseText);
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

  const notifyState=await guardGet(env,"trade:notify:state")||{};
  if(Number(notifyState.backoffUntil||0)>now) return {ok:false,kind:"CANCEL",asset:active.asset,error:"NTFY_BACKOFF_ACTIVE",backoffUntil:notifyState.backoffUntil};

  const reasonText=reason==="ORIGINAL_STOP_BROKEN"
    ? "El precio ha roto el STOP estructural de la alerta original."
    : "El precio ha superado la COMPRA MÁX. de la alerta original; no perseguir la entrada.";

  try{
    const r=await fetchTimed(env.NTFY_URL,{
      method:"POST",
      headers:{"Title":"CABAL - VENTANA DE ENTRADA CERRADA","Priority":"high","Tags":"warning"},
      body:[
        active.asset,
        "MOTIVO OBJETIVO: "+reason,
        reasonText,
        price!=null ? "PRECIO: "+guardFmt(price) : null,
        "SI NO ENTRASTE: NO ENTRAR.",
        "SI YA ENTRASTE: NO ES ORDEN DE VENTA; gestionar la posición con el STOP estructural comunicado en la alerta original."
      ].filter(Boolean).join("\n")
    },20000);
    if(r.ok){
      await guardPut(env,"trade:active",{asset:null,clearedAt:now,previousAsset:active.asset,reason});
      return {ok:true,kind:"CANCEL",asset:active.asset,status:r.status,reason};
    }
    const body=(await r.text()).slice(0,300);
    const backoffUntil=now+guardTransportBackoffMs(r,body);
    await guardPut(env,"trade:notify:state",{lastAttemptAt:now,lastStatus:r.status,lastError:"HTTP_"+r.status+":"+body,backoffUntil});
    return {ok:false,kind:"CANCEL",asset:active.asset,status:r.status,error:"HTTP_"+r.status,reason,backoffUntil};
  }catch(e){
    const backoffUntil=now+60_000;
    await guardPut(env,"trade:notify:state",{lastAttemptAt:now,lastStatus:null,lastError:String(e),backoffUntil});
    return {ok:false,kind:"CANCEL",asset:active.asset,error:String(e),reason,backoffUntil};
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

  const candidate=guardCandidateSnapshot(current,history,active.asset);
  let c=candidate && (!active.venue || candidate.venue===active.venue) ? candidate : null;
  if(!c && active.venue==="COINBASE"){
    try{
      const row=await guardCoinbaseMarket(active.asset);
      const snapshot={t:Date.now(),a:{[active.asset]:guardSnapshotAsset(row)}};
      c=guardCandidateSnapshot(snapshot,history,active.asset);
    }catch(_){}
  }
  let decision=null;
  let hardInvalidation=null;
  let reason="COMMITTED_WINDOW";
  const livePrice=c ? Number(c.price) : null;

  if(["NEON","BLAST"].includes(String(active.asset).trim().toUpperCase())){
    hardInvalidation="PROJECT_WIND_DOWN";
    reason=hardInvalidation;
  }else if(c){
    if(Number(active.stop)>0 && livePrice<=Number(active.stop)){
      hardInvalidation="ORIGINAL_STOP_BROKEN";
      reason=hardInvalidation;
    }else if(Number(active.entryMax)>0 && livePrice>Number(active.entryMax)){
      hardInvalidation="ORIGINAL_ENTRY_MAX_EXCEEDED";
      reason=hardInvalidation;
    }else{
      try{
        const m=await guardExecutionMetrics(c,env);
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
async function guardVerifyTransportOnce(env){
  const id=env.NTFY_VERIFICATION_ID;
  if(!id || !env.NTFY_URL) return;
  const previous=await guardGet(env,"transport:verification");
  if(previous && previous.id===id){
    if(String(previous.attemptedAt).slice(0,10)===new Date(Date.now()).toISOString().slice(0,10) && !previous.ok && previous.status===429 && /daily.*message|message.*daily/i.test(previous.error||"")){
      const transport=await guardGet(env,"trade:notify:state")||{};
      if(Number(transport.lastSuccessAt||0)<=Date.parse(previous.attemptedAt)){
        const backoffUntil=Date.now()+guardTransportBackoffMs({status:429},previous.error);
        await guardPut(env,"trade:notify:state",{...transport,lastStatus:429,lastError:previous.error,backoffUntil});
      }
    }
    return;
  }
  // Mark before sending: deployment retries must never flood the topic.
  const result={id,attemptedAt:new Date().toISOString(),ok:false,status:null,error:null};
  await guardPut(env,"transport:verification",result);
  try{
    const response=await fetchTimed(env.NTFY_URL,{
      method:"POST",headers:{"Title":"CABAL - PRUEBA DESDE MOTOR","Priority":"low"},
      body:"PRUEBA TECNICA DESDE CLOUDFLARE. NO ES WATCH NI ORDEN DE COMPRA. Verificacion del transporte NTFY."
    },20000);
    result.status=response.status;
    result.ok=response.ok;
    const body=(await response.text()).slice(0,500);
    if(response.ok){try{result.messageId=JSON.parse(body).id||null;}catch(_){}}
    else result.error=body||"HTTP_"+response.status;
  }catch(e){result.error=String(e);}
  result.completedAt=new Date().toISOString();
  await guardPut(env,"transport:verification",result);
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
    await guardVerifyTransportOnce(env);
    const followup=await guardRunnerFollowup(env);
    const current=await guardBuildSnapshot(followup,env);
    const history=await guardLoadHistory(env,current.t);
    const candidates=guardFollowupCandidates(current,history,guardCandidates(current,history),followup);

    // Validate current candidates every minute: a short-lived acceleration must
    // not disappear between five-minute decision slots. Entry/stop/volume rules
    // and separate-cycle confirmation count remain enforced.
    const notifyResult=await guardNotify(env,candidates);
    // Revalidate the original entry limits even when a new decision is due.
    const activeRevalidation=await guardRevalidateActiveTrade(env,current,history);
    const tradeResult=await guardEvaluateTrades(env,candidates);

    await guardSaveSnapshot(env,current);

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
      lastExecutionGuardAt:finished,
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
    fundamentalBlocks:["NEON","BLAST"],
    fundamentalCoverage:"MANUAL_KNOWN_BLOCKS_ONLY",
    transportState:await guardGet(env,"trade:notify:state"),
    transportVerification:await guardGet(env,"transport:verification"),
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
    radarBridge:env.RADAR_URL ? await guardGet(env,"radar:bridge") : null,
    coverageHealthy:Boolean(hb.lastSourceStatus && (hb.lastSourceStatus.mode==="RADAR_DISCOVERY_NATIVE_EXECUTION" ? hb.lastSourceStatus.radar?.kucoin==="PASS" && hb.lastSourceStatus.radar?.coinbase==="PASS" : hb.lastSourceStatus.kucoin==="PASS" && hb.lastSourceStatus.bybit==="PASS")),
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
      mode:"CLOUDFLARE_1M_EXECUTION_GUARD",
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

          const preferred = c._liteMarket || null;
          const [x15,x240] = await Promise.all([
            klineWithFallback(c,"15",50,deduped.byBase,preferred),
            klineWithFallback(c,"240",50,deduped.byBase,preferred)
          ]);

          // Reuse the already-fetched 1h lite series. This saves one subrequest per full-deep target.
          const a60 = c._liteBars || [];
          const source60 = preferred;
          if(!a60.length) throw new Error("MISSING_LITE_1H_SERIES");

          const d = deepAnalysis(x15.bars,a60,x240.bars);
          const lite = deepLiteAnalysis(a60,c) || c.lite;
          const classification = classify(c,d,lite);

          return Object.assign({},c,{
            lite,
            deep:d,
            classification,
            deepValidation:"FULL_OK",
            deepValidationSources:{
              m15:x15.market.venue,
              h1:source60 ? source60.venue : c.deepValidationSource,
              h4:x240.market.venue
            }
          });
        }catch(e){
          const classification = classify(c,null,c.lite);
          return Object.assign({},c,{
            classification,
            deepValidation:"LITE_ONLY",
            fullDeepError:String(e)
          });
        }
      });

      const liteMap = new Map(liteResults.map(x=>[x.base,x]));
      const fullMap = new Map(fullResults.map(x=>[x.base,x]));

      let final = stage.candidates.map(c=>{
        if(fullMap.has(c.base)) return fullMap.get(c.base);
        if(liteMap.has(c.base)){
          const x = liteMap.get(c.base);
          return Object.assign({},x,{classification:classify(x,null,x.lite)});
        }
        return Object.assign({},c,{
          classification:c.microcapAnomaly ? "MICROCAP ANOMALY WATCH" : ((c.bucketHits || []).includes("E") ? "SECOND-LEG WATCH — PENDING DEEP" : ((c.bucketHits || []).includes("T") ? "TURNOVER ANOMALY WATCH" : "NO SETUP")),
          deepValidation:"NOT_SELECTED"
        });
      });

      // Remove private helper fields before response.
      final = final.map(x=>{
        const y = Object.assign({},x);
        delete y._liteMarket;
        delete y._liteBars;
        return y;
      });

      // CABAL -> WHALES DEEP rotating queue.
      // Keep the two highest-priority names in every batch, then rotate the remaining
      // six slots every 15 minutes through the rest of the qualifying universe.
      // This preserves urgent coverage while preventing the same top 8 from starving
      // every lower-ranked candidate indefinitely.
      const whaleEligible = final
        .filter(isWhaleTrigger)
        .sort((a,b)=>fullDeepPriority(b)-fullDeepPriority(a));

      const whaleRotationSlotMinutes = 15;
      const whalePriorityReserve = Math.min(2,MAX_WHALE_REQUESTS,whaleEligible.length);
      const whaleRotationSlots = Math.max(0,MAX_WHALE_REQUESTS-whalePriorityReserve);
      const whalePriorityCandidates = whaleEligible.slice(0,whalePriorityReserve);
      const whaleRotationPool = whaleEligible.slice(whalePriorityReserve);
      const whaleRotationBatchCount = whaleRotationSlots > 0 && whaleRotationPool.length
        ? Math.ceil(whaleRotationPool.length/whaleRotationSlots)
        : 1;
      const whaleRotationEpoch = Math.floor(Date.now()/(whaleRotationSlotMinutes*60*1000));
      const whaleRotationBatchIndex = whaleRotationPool.length
        ? whaleRotationEpoch % whaleRotationBatchCount
        : 0;
      const whaleRotationStart = whaleRotationBatchIndex * whaleRotationSlots;

      let whaleRotatingCandidates = whaleRotationSlots > 0
        ? whaleRotationPool.slice(whaleRotationStart,whaleRotationStart+whaleRotationSlots)
        : [];

      // The final batch can be short. Wrap from the start of the rotating pool so we
      // still use the available DEEP capacity without changing priority-reserve slots.
      if(whaleRotationSlots > 0 && whaleRotatingCandidates.length < whaleRotationSlots && whaleRotationPool.length > whaleRotatingCandidates.length){
        const need = whaleRotationSlots-whaleRotatingCandidates.length;
        whaleRotatingCandidates = [
          ...whaleRotatingCandidates,
          ...whaleRotationPool.slice(0,need)
        ];
      }

      const seenWhaleBases = new Set();
      const whaleCandidates = [...whalePriorityCandidates,...whaleRotatingCandidates]
        .filter(c=>{
          if(seenWhaleBases.has(c.base)) return false;
          seenWhaleBases.add(c.base);
          return true;
        })
        .slice(0,MAX_WHALE_REQUESTS);

      const whaleSelectedBases = new Set(whaleCandidates.map(c=>c.base));
      const whaleQueueRank = new Map(whaleEligible.map((c,i)=>[c.base,i+1]));

      const whaleResults = await mapLimit(whaleCandidates,2,async c=>({
        base:c.base,
        whales:await runWhaleDeep(env,c)
      }));
      const whaleMap = new Map(whaleResults.map(x=>[x.base,x.whales]));

      final = final.map(c=>Object.assign({},c,{
        whales:whaleMap.get(c.base) || (isWhaleTrigger(c)
          ? {
              requested:true,
              status:env.WHALES_DEEP_URL ? "QUEUED_LIMIT" : "WHALE DATA GAP",
              reason:env.WHALES_DEEP_URL ? "ROTATING_QUEUE_WAIT" : "WHALES_DEEP_URL_NOT_CONFIGURED",
              queueRank:whaleQueueRank.get(c.base) || null,
              selectedThisBatch:whaleSelectedBases.has(c.base),
              rotationBatchIndex:whaleRotationBatchIndex,
              rotationBatchCount:whaleRotationBatchCount,
              rotationSlotMinutes:whaleRotationSlotMinutes
            }
          : {requested:false,status:"NOT_TRIGGERED"})
      }));

      const sourceErrors = {
        bybit:sourceResults[0].status === "rejected" ? String(sourceResults[0].reason) : null,
        kucoin:sourceResults[1].status === "rejected" ? String(sourceResults[1].reason) : null,
        coinGecko:sourceResults[2].status === "rejected" ? String(sourceResults[2].reason) : null,
        tradingView:tv.errors
      };

      const marketCorePass = (bybit.length || kucoin.length) && tv.rows.length > 0;
      const whalesConfigured = !!env.WHALES_DEEP_URL && !!env.WHALES_DEEP_TOKEN;
      const whalesBidirectional = whalesConfigured && whaleFeed.ok;
      const coverageStatus = marketCorePass && whalesBidirectional ? "PASS" : "PARTIAL";

      const response = {
        ok:true,
        patchVersion:PATCH_VERSION,
        generatedAt:new Date().toISOString(),
        coverage:{
          bucketA:marketCorePass ? "PASS" : "PARTIAL",
          bucketB:marketCorePass ? "PASS" : "PARTIAL",
          bucketC:marketCorePass ? "PASS" : "PARTIAL",
          bucketD:"EXTERNAL_STAGE0_REQUIRED",
          bucketE:"PASS_SECOND_LEG_PRECURSOR_PLUS_1H_DEEP",
          turnoverAnomaly:"PASS",
          multiVenue:"BYBIT+KUCOIN",
          whales:whalesBidirectional
            ? "BIDIRECTIONAL_CONNECTED"
            : (whalesConfigured ? "DEEP_ONLY_PARTIAL" : "WHALE DATA GAP"),
          whaleFeedStatus:whaleFeed.status,
          whaleFeedReason:whaleFeed.reason,
          coverageStatus
        },
        sources:{
          bybitSpotRows:bybit.length,
          kucoinSpotRows:kucoin.length,
          dedupedSpotBases:deduped.preferred.length,
          tradingViewStatus:tv.status,
          tradingViewRows:tv.rows.length,
          tradingViewChunks:Math.ceil(scanUniverse.length/TV_CHUNK_SIZE),
          coinGeckoConfigured:cg.configured,
          coinGeckoStatus:cg.status,
          coinGeckoRows:cg.rows.length,
          whaleFeedStatus:whaleFeed.status,
          whaleFeedCandidates:whaleFeed.candidates.length,
          errors:sourceErrors
        },
        truncation:{
          scanUniverseTotal,
          scanUniverseUsed:scanUniverse.length,
          scanUniverseTruncated:scanUniverseTotal > scanUniverse.length,
          stageAAllCandidateCount:stage.allCandidateCount,
          stageARetained:stage.candidates.length,
          stageATruncated:stage.stageATruncated,
          deepLiteRequested:deepTargets.length,
          deepLiteCap:MAX_DEEP_LITE,
          deepLiteTruncated:stage.candidates.length > deepTargets.length,
          fullDeepRequested:fullTargets.length,
          fullDeepCap:MAX_FULL_DEEP,
          fullDeepTruncated:liteResults.filter(x=>x.lite).length > fullTargets.length,
          whaleRequests:whaleCandidates.length,
          whaleRequestCap:MAX_WHALE_REQUESTS,
          whaleEligibleTotal:whaleEligible.length,
          whalePriorityReserve,
          whaleRotationSlots,
          whaleRotationPoolSize:whaleRotationPool.length,
          whaleRotationBatchIndex,
          whaleRotationBatchCount,
          whaleRotationSlotMinutes,
          whaleRotationCoverageMinutes:whaleRotationBatchCount*whaleRotationSlotMinutes
        },
        counts:{
          scannedStageAUniverse:scanUniverse.length,
          candidateCountStageA:stage.candidates.length,
          candidateCountBeforeRetention:stage.allCandidateCount,
          laneCountsBeforeRetention:stage.allLaneCounts,
          deepLiteCompleted:liteResults.filter(x=>x.lite).length,
          deepValidatedCount:fullResults.filter(x=>x.deep).length,
          whaleDeepTriggered:final.filter(x=>x.whales && x.whales.requested).length,
          whaleInjectedCount:whaleInjectedBases.size,
          whaleFeedCandidateCount:whaleFeed.candidates.length,
          manualWhaleInjectedCount:manualWhaleInjectedBases.size
        },
        btcReference:stage.btcReference,
        whaleInjection:[...whaleInjectedBases],
        whaleFeed:{
          ok:whaleFeed.ok,
          status:whaleFeed.status,
          reason:whaleFeed.reason,
          candidates:whaleFeed.candidates
        },
        candidates:final,
        runtimeMs:Date.now()-started
      };

      return new Response(JSON.stringify(response,null,2), {
        headers:{
          "content-type":"application/json; charset=utf-8",
          "cache-control":"no-store"
        }
      });
    }catch(e){
      return new Response(JSON.stringify({
        ok:false,
        patchVersion:PATCH_VERSION,
        error:String(e),
        generatedAt:new Date().toISOString()
      },null,2), {
        status:500,
        headers:{"content-type":"application/json; charset=utf-8"}
      });
    }
  }

export default {
  async fetch(request,env){
    const url=new URL(request.url);
    if(url.pathname==="/source-health"){
      const base=upper(url.searchParams.get("asset")||"AKT");
      if(!/^[A-Z0-9]{2,12}$/.test(base) || !eligibleBase(base)) return new Response('Invalid asset',{status:400});
      const key="source:probe:"+base;
      let result=await guardGet(env,key);
      if(!result || Date.now()-Date.parse(result.checkedAt)>60_000){
        try{
          const row=await guardCoinbaseMarket(base);
          const c={base,venue:row.venue,venueSymbol:row.venueSymbol,price:row.lastPrice,change24h:row.price24hPct,turnover24h:row.turnover24h};
          const metrics=await guardExecutionMetricsOnMarket(c,row,env);
          result={ok:true,asset:base,venue:row.venue,price:row.lastPrice,metrics,checkedAt:new Date().toISOString(),autoTrade:false};
        }catch(e){result={ok:false,asset:base,error:String(e),checkedAt:new Date().toISOString(),autoTrade:false};}
        await guardPut(env,key,result);
      }
      return new Response(JSON.stringify(result),{headers:{"content-type":"application/json","cache-control":"no-store"}});
    }
    if(url.pathname==="/health"){
      const h=await guardHealth(env);
      return new Response(JSON.stringify(h,null,2),{
        status:200,
        headers:{
          "content-type":"application/json; charset=utf-8",
          "cache-control":"no-store"
        }
      });
    }
    return handleScan(request,env);
  },

  async scheduled(event,env,ctx){
    ctx.waitUntil(runMarketGuard(event,env));
  }
};
