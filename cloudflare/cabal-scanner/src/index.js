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

const PATCH_VERSION = "CABAL_WHALES_V3_1_2_2026-09-23_EXEC_GUARD";

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
  if(!base) return false;
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
  const r = await fetch("https://api.bybit.com/v5/market/tickers?category=spot");
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
  const r = await fetch("https://api.kucoin.com/api/v1/market/allTickers");
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

  const r = await fetch(url);
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

  const r = await fetch(url);
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

async function klineOnMarket(market, interval, limit){
  if(market.venue === "BYBIT") return bybitKline(market.venueSymbol, interval, limit);
  if(market.venue === "KUCOIN") return kucoinKline(market.venueSymbol, interval, limit);
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
      base,venue,venueSymbol,price,turnover24h:turn,change24h:p24,
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

async function guardExecutionMetrics(c){
  if(!c || !c.venue || !c.venueSymbol) throw new Error("GUARD_EXECUTION_SYMBOL_MISSING");
  const market={venue:c.venue,venueSymbol:c.venueSymbol};
  const btcSymbol=c.venue==="BYBIT" ? "BTCUSDT" : "BTC-USDT";
  const btcMarket={venue:c.venue,venueSymbol:btcSymbol};

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
    p15,p1,p4,rs1,rs4,rvol15m:r15,rvol1h:r1,lite,
    noChase,headroom,
    stop:stopInfo ? stopInfo.stop : null,
    stopDistancePct:stopInfo ? stopInfo.dist : null
  };
}

function guardPilotDecision(c,m){
  const p15=Number(m.p15), p1=Number(m.p1), p4=Number(m.p4);
  const rs1=Number(m.rs1), rs4=Number(m.rs4);
  const r15=Number(m.rvol15m), r1=Number(m.rvol1h);
  const head=Number(m.headroom), sd=Number(m.stopDistancePct);
  const p24=Number(c.change24h);
  const live=Number(c.price);
  const shortAccel=(Number(c.change3m)>=0.80 || Number(c.change5m)>=1.20 || Number(c.change1m)>=0.60);
  const safe=(
    live>0 && Number(m.stop)>0 && live>Number(m.stop)
    && sd>=1.0 && sd<=3.5
    && Number.isFinite(head) && head>=1.0
    && p24<15.0
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

  const buy=second||fast;
  const reason=second ? "SECOND_LEG_CLOUD_CONFIRMED" : (fast ? "FAST_ACCEL_CLOUD_CONFIRMED" : "NO_BUY");
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
    asset:c.base,venue:c.venue,venueSymbol:c.venueSymbol,
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
    secondLegTrigger:Boolean(m.lite && m.lite.secondLegTrigger)
  };
}

async function guardEvaluateTrades(env,candidates){
  const top=(candidates||[]).slice(0,4);
  const evaluated=await mapLimit(top,2,async x=>{
    try{
      const m=await guardExecutionMetrics(x);
      return guardPilotDecision(x,m);
    }catch(e){
      return {asset:x.base,venue:x.venue,price:x.price,buy:false,reason:"DATA_GAP",error:String(e)};
    }
  });
  const buys=evaluated.filter(x=>x.buy).sort((a,b)=>b.score-a.score).slice(0,3);
  const state={
    generatedAt:new Date().toISOString(),
    mode:"CLOUDFLARE_5M_EXECUTION_GUARD",
    evaluated,
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
  const currentAssets=new Set(buys.map(x=>x.asset));

  // Revoke a still-live order if the next 5-minute validation no longer confirms it.
  if(active && active.asset && Number(active.validUntil||0)>now && !currentAssets.has(active.asset)){
    if(!env.NTFY_URL) return {ok:false,kind:"CANCEL",asset:active.asset,error:"NTFY_URL_NOT_CONFIGURED"};
    try{
      const r=await fetch(env.NTFY_URL,{
        method:"POST",
        headers:{"Title":"🔴 CABAL — CANCELAR COMPRA","Priority":"high","Tags":"warning"},
        body:[
          active.asset,
          "La validación Cloudflare de 5 minutos ya no confirma la entrada.",
          "SI NO ENTRASTE: NO COMPRAR.",
          "SI YA ENTRASTE: no añadir posición; mantener el STOP de la alerta original."
        ].join("\n")
      });
      if(r.ok){
        await guardPut(env,"trade:active",{asset:null,clearedAt:now});
        return {ok:true,kind:"CANCEL",asset:active.asset,status:r.status};
      }
      return {ok:false,kind:"CANCEL",asset:active.asset,status:r.status,error:"HTTP_"+r.status};
    }catch(e){
      return {ok:false,kind:"CANCEL",asset:active.asset,error:String(e)};
    }
  }

  if(!buys.length){
    if(active && active.asset && Number(active.validUntil||0)<=now){
      await guardPut(env,"trade:active",{asset:null,expiredAt:now});
    }
    return {ok:true,kind:"NONE"};
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
    const executionDue=(minuteSlot%5)===0;
    let tradeResult=null;
    if(executionDue){
      tradeResult=await guardEvaluateTrades(env,candidates);
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
    const tradeNotify=tradeResult&&tradeResult.notify ? tradeResult.notify : null;

    hb=Object.assign({},hb,{
      lastSuccessfulScan:finished,
      lastRuntimeMs:finished-started,
      lastUniverseCount:current.count,
      lastCandidateCount:candidates.length,
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
  const [hb,trade,pending,watch]=await Promise.all([
    guardGet(env,"heartbeat"),
    guardGet(env,"trade:latest"),
    guardGet(env,"trade:pending"),
    guardGet(env,"watch:latest")
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
      buys:trade&&Array.isArray(trade.buys) ? trade.buys : [],
      pendingBuy:pending&&pending.buy ? pending.buy : null
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
