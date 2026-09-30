import { computeRadar, num } from "./radar-core.mjs";

const VERSION = "CABAL2_RADAR_0.1.0";
const STABLES = new Set(["USDT","USDC","DAI","FDUSD","TUSD","USDE","PYUSD","USDS","FRAX","USDD","LUSD","GHO","EURC","USD1","USDG","RLUSD"]);
const WRAPPED = new Set(["WBTC","WETH","STETH","WSTETH","CBETH","RETH","WEETH"]);
const FETCH_TIMEOUT_MS = 8000;

function eligibleBase(base) {
  const a = String(base || "").toUpperCase();
  if (!a || STABLES.has(a) || WRAPPED.has(a)) return false;
  if (/(UP|DOWN|BULL|BEAR|[235]L|[235]S)$/.test(a)) return false;
  return true;
}

async function fetchJson(url, options={}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort("timeout"), FETCH_TIMEOUT_MS);
  try {
    const r = await fetch(url, {...options, signal: controller.signal});
    if (!r.ok) throw new Error(String(r.status) + " " + url);
    return await r.json();
  } finally {
    clearTimeout(timer);
  }
}

async function kucoinRows() {
  const j = await fetchJson("https://api.kucoin.com/api/v1/market/allTickers");
  const rows = [];
  for (const x of ((j.data || {}).ticker || [])) {
    const s = String(x.symbol || "");
    if (!s.endsWith("-USDT") && !s.endsWith("-USDC")) continue;
    const p = s.split("-");
    const base = String(p[0] || "").toUpperCase();
    if (!eligibleBase(base)) continue;
    const price = num(x.last);
    const turnover = num(x.volValue, 0);
    if (price === null || price <= 0) continue;
    rows.push({
      asset: base,
      venue: "KUCOIN",
      price,
      turnover,
      change24h: num(x.changeRate, 0) * 100
    });
  }
  return rows;
}

async function coinbaseRows() {
  const url = "https://api.coinbase.com/api/v3/brokerage/market/products?limit=1000&product_type=SPOT";
  const j = await fetchJson(url, {headers: {"User-Agent": "CABAL2-Radar/0.1"}});
  const rows = [];
  for (const x of (j.products || [])) {
    const product = String(x.product_id || "");
    const parts = product.split("-");
    if (parts.length !== 2) continue;
    const base = String(x.base_currency_id || parts[0] || "").toUpperCase();
    const quote = String(x.quote_currency_id || parts[1] || "").toUpperCase();
    if (!["USD","USDC","USDT"].includes(quote) || !eligibleBase(base)) continue;
    if (x.trading_disabled === true || x.is_disabled === true) continue;
    const price = num(x.price);
    const baseVolume = num(x.volume_24h, 0);
    const turnover = price === null ? 0 : baseVolume * price;
    if (price === null || price <= 0) continue;
    rows.push({
      asset: base,
      venue: "COINBASE",
      price,
      turnover,
      change24h: num(x.price_percentage_change_24h, 0)
    });
  }
  return rows;
}

function mergeVenues(rows) {
  const map = new Map();
  for (const r of rows) {
    if (!map.has(r.asset)) map.set(r.asset, []);
    map.get(r.asset).push(r);
  }
  const out = [];
  for (const [asset, venues] of map) {
    venues.sort((a,b) => (b.turnover || 0) - (a.turnover || 0));
    const preferred = venues[0];
    const prices = venues.map(v => v.price).filter(Number.isFinite);
    const maxP = prices.length ? Math.max(...prices) : null;
    const minP = prices.length ? Math.min(...prices) : null;
    const spread = maxP !== null && minP !== null && minP > 0 ? (maxP / minP - 1) * 100 : null;
    out.push({
      asset,
      price: preferred.price,
      turnover: Math.max(...venues.map(v => v.turnover || 0)),
      change24h: preferred.change24h,
      venue: preferred.venue,
      venueCount: venues.length,
      venueSpreadPct: spread
    });
  }
  return out;
}

async function ensureDb(env) {
  await env.DB.exec(
    "CREATE TABLE IF NOT EXISTS cabal2_asset_state (" +
    "asset TEXT PRIMARY KEY, price REAL NOT NULL, turnover REAL NOT NULL, change24h REAL NOT NULL, " +
    "venue TEXT NOT NULL, venue_count INTEGER NOT NULL, venue_spread REAL, history_json TEXT NOT NULL, updated_minute INTEGER NOT NULL)"
  );
  await env.DB.exec(
    "CREATE TABLE IF NOT EXISTS cabal2_meta (" +
    "k TEXT PRIMARY KEY, v TEXT NOT NULL, updated_at TEXT NOT NULL)"
  );
}

async function readState(env) {
  const r = await env.DB.prepare("SELECT asset, history_json FROM cabal2_asset_state").all();
  const map = new Map();
  for (const row of (r.results || [])) {
    try { map.set(row.asset, JSON.parse(row.history_json || "[]")); }
    catch { map.set(row.asset, []); }
  }
  return map;
}

async function writeAssets(env, assets, minute, prior) {
  const statements = [];
  for (const a of assets) {
    const history = Array.isArray(prior.get(a.asset)) ? prior.get(a.asset).slice() : [];
    history.push({minute, price:a.price});
    const dedup = [];
    const seen = new Set();
    for (let i=history.length-1; i>=0; i--) {
      const h = history[i];
      if (!h || seen.has(h.minute)) continue;
      seen.add(h.minute);
      dedup.push(h);
      if (dedup.length >= 12) break;
    }
    dedup.reverse();
    statements.push(
      env.DB.prepare(
        "INSERT INTO cabal2_asset_state(asset,price,turnover,change24h,venue,venue_count,venue_spread,history_json,updated_minute) " +
        "VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(asset) DO UPDATE SET price=excluded.price,turnover=excluded.turnover," +
        "change24h=excluded.change24h,venue=excluded.venue,venue_count=excluded.venue_count,venue_spread=excluded.venue_spread," +
        "history_json=excluded.history_json,updated_minute=excluded.updated_minute"
      ).bind(a.asset,a.price,a.turnover,a.change24h,a.venue,a.venueCount,a.venueSpreadPct,JSON.stringify(dedup),minute)
    );
  }
  for (let i=0; i<statements.length; i+=80) {
    await env.DB.batch(statements.slice(i,i+80));
  }
}

async function setMeta(env, key, value) {
  const now = new Date().toISOString();
  await env.DB.prepare(
    "INSERT INTO cabal2_meta(k,v,updated_at) VALUES(?,?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v,updated_at=excluded.updated_at"
  ).bind(key, JSON.stringify(value), now).run();
}

async function getMeta(env, key) {
  const r = await env.DB.prepare("SELECT v,updated_at FROM cabal2_meta WHERE k=?").bind(key).first();
  if (!r) return null;
  try { return {...JSON.parse(r.v), storedAt:r.updated_at}; }
  catch { return null; }
}

async function runScan(env) {
  const started = Date.now();
  await ensureDb(env);
  const sourceStatus = {coinbase:"PENDING",kucoin:"PENDING"};
  let cb=[], ku=[];
  try { cb = await coinbaseRows(); sourceStatus.coinbase = cb.length ? "PASS" : "EMPTY"; }
  catch (e) { sourceStatus.coinbase = "FAIL:" + String(e && e.message || e); }
  try { ku = await kucoinRows(); sourceStatus.kucoin = ku.length ? "PASS" : "EMPTY"; }
  catch (e) { sourceStatus.kucoin = "FAIL:" + String(e && e.message || e); }

  const merged = mergeVenues([...cb,...ku]).filter(x => x.turnover >= 75000);
  const prior = await readState(env);
  const minute = Math.floor(Date.now()/60000);

  const radar = merged.map(a => computeRadar(a, minute, prior.get(a.asset) || []));
  radar.sort((a,b) => (b.detected-a.detected) || (b.radarScore-a.radarScore) || (b.turnover24h-a.turnover24h));
  const detected = radar.filter(x => x.detected);

  await writeAssets(env, merged, minute, prior);

  const result = {
    version: VERSION,
    generatedAt: new Date().toISOString(),
    mode: "MARKET_RADAR_ONLY",
    autoTrade: false,
    sourceStatus,
    universeCount: merged.length,
    sourceCounts: {coinbase:cb.length, kucoin:ku.length},
    detectionCount: detected.length,
    scanDurationMs: Date.now()-started,
    detected: detected.slice(0,100),
    note: "Detection is intentionally independent of BUY quality. Extended movers remain visible and are flagged, not suppressed."
  };
  await setMeta(env, "last_radar", result);
  return result;
}

function json(data, status=200) {
  return new Response(JSON.stringify(data,null,2), {
    status,
    headers: {"content-type":"application/json; charset=utf-8","cache-control":"no-store"}
  });
}

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runScan(env));
  },
  async fetch(request, env) {
    const u = new URL(request.url);
    if (u.pathname === "/health") {
      await ensureDb(env);
      const last = await getMeta(env, "last_radar");
      const ageSeconds = last && last.generatedAt ? Math.round((Date.now()-Date.parse(last.generatedAt))/1000) : null;
      return json({
        healthy: !!last && ageSeconds !== null && ageSeconds <= 150,
        version: VERSION,
        mode: "CABAL2_1M_MARKET_RADAR",
        ageSeconds,
        last
      });
    }
    if (u.pathname === "/radar") {
      await ensureDb(env);
      return json((await getMeta(env, "last_radar")) || {version:VERSION,status:"NO_SCAN_YET"});
    }
    return json({
      service:"CABAL 2.0 Market Radar",
      version:VERSION,
      endpoints:["/health","/radar"],
      autoTrade:false
    });
  }
};
