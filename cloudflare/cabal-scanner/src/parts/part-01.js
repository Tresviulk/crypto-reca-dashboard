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

const PATCH_VERSION = "CABAL_WHALES_V3_1_2026-09-12";

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
