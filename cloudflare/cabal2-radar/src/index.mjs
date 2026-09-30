import { DurableObject } from "cloudflare:workers";
import { computeRadar, num } from "./radar-core.mjs";

const VERSION = "CABAL2_RADAR_0.1.3";
const STABLES = new Set(["USDT","USDC","DAI","FDUSD","TUSD","USDE","PYUSD","USDS","FRAX","USDD","LUSD","GHO","EURC","USD1","USDG","RLUSD"]);
const WRAPPED = new Set(["WBTC","WETH","STETH","WSTETH","CBETH","RETH","WEETH"]);
const FETCH_TIMEOUT_MS = 8000;
const ALARM_INTERVAL_MS = 60_000;

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
    rows.push({asset:base,venue:"KUCOIN",price,turnover,change24h:num(x.changeRate,0)*100});
  }
  return rows;
}

async function coinbaseRows() {
  const url = "https://api.coinbase.com/api/v3/brokerage/market/products?limit=1000&product_type=SPOT";
  const j = await fetchJson(url, {headers:{"User-Agent":"CABAL2-Radar/0.1"}});
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
    rows.push({asset:base,venue:"COINBASE",price,turnover,change24h:num(x.price_percentage_change_24h,0)});
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
    "CREATE TABLE IF NOT EXISTS cabal2_meta (" +
    "k TEXT PRIMARY KEY, v TEXT NOT NULL, updated_at TEXT NOT NULL)"
  );
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

async function getAssetState(env) {
  const r = await env.DB.prepare("SELECT v FROM cabal2_meta WHERE k='asset_state'").first();
  if (!r) return {};
  try {
    const parsed = JSON.parse(r.v);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function nextAssetState(assets, minute, prior) {
  const out = {};
  for (const a of assets) {
    const old = prior[a.asset] && Array.isArray(prior[a.asset].history) ? prior[a.asset].history : [];
    const history = old.filter(h => h && Number.isFinite(Number(h.minute)) && Number.isFinite(Number(h.price)));
    history.push({minute,price:a.price});
    const dedup = [];
    const seen = new Set();
    for (let i=history.length-1; i>=0; i--) {
      const h=history[i];
      if (seen.has(h.minute)) continue;
      seen.add(h.minute);
      dedup.push(h);
      if (dedup.length>=12) break;
    }
    dedup.reverse();
    out[a.asset]={history:dedup};
  }
  return out;
}

async function runScan(env) {
  const started = Date.now();
  await ensureDb(env);
  const sourceStatus = {coinbase:"PENDING",kucoin:"PENDING"};
  let cb=[],ku=[];
  try { cb=await coinbaseRows(); sourceStatus.coinbase=cb.length?"PASS":"EMPTY"; }
  catch(e) { sourceStatus.coinbase="FAIL:"+String(e&&e.message||e); }
  try { ku=await kucoinRows(); sourceStatus.kucoin=ku.length?"PASS":"EMPTY"; }
  catch(e) { sourceStatus.kucoin="FAIL:"+String(e&&e.message||e); }

  if (!cb.length && !ku.length) throw new Error("ALL_MARKET_SOURCES_FAILED");

  const merged=mergeVenues([...cb,...ku]).filter(x=>x.turnover>=75000);
  const prior=await getAssetState(env);
  const minute=Math.floor(Date.now()/60000);

  const radar=merged.map(a=>computeRadar(a,minute,(prior[a.asset]||{}).history||[]));
  radar.sort((a,b)=>(Number(b.detected)-Number(a.detected))||(b.radarScore-a.radarScore)||(b.turnover24h-a.turnover24h));
  const detected=radar.filter(x=>x.detected);

  await setMeta(env,"asset_state",nextAssetState(merged,minute,prior));

  const result={
    version:VERSION,
    generatedAt:new Date().toISOString(),
    mode:"MARKET_RADAR_ONLY",
    autoTrade:false,
    sourceStatus,
    universeCount:merged.length,
    sourceCounts:{coinbase:cb.length,kucoin:ku.length},
    detectionCount:detected.length,
    scanDurationMs:Date.now()-started,
    detected:detected.slice(0,100),
    note:"Detection is intentionally independent of BUY quality. Extended movers remain visible and are flagged, not suppressed."
  };
  await setMeta(env,"last_radar",result);
  await setMeta(env,"last_error",{error:null,at:new Date().toISOString()});
  return result;
}

async function recordError(env, error) {
  try {
    await ensureDb(env);
    await setMeta(env,"last_error",{error:String(error&&error.stack||error&&error.message||error),at:new Date().toISOString()});
  } catch {}
}

function json(data,status=200) {
  return new Response(JSON.stringify(data,null,2),{
    status,
    headers:{"content-type":"application/json; charset=utf-8","cache-control":"no-store"}
  });
}

export class Cabal2Scheduler extends DurableObject {
  constructor(ctx,env) {
    super(ctx,env);
    this.ctx=ctx;
    this.env=env;
  }

  async fetch() {
    const current=await this.ctx.storage.getAlarm();
    const now=Date.now();
    if (current===null || current<=now+15_000) {
      await this.ctx.storage.setAlarm(now+ALARM_INTERVAL_MS);
    }
    const armedFor=await this.ctx.storage.getAlarm();
    return json({
      scheduler:"DURABLE_OBJECT_ALARM",
      armed:true,
      armedFor:armedFor?new Date(armedFor).toISOString():null,
      intervalMs:ALARM_INTERVAL_MS
    });
  }

  async alarm(alarmInfo) {
    const scheduledAt=new Date().toISOString();
    await ensureDb(this.env);
    await setMeta(this.env,"scheduler_state",{
      source:"DURABLE_OBJECT_ALARM",
      status:"RUNNING",
      scheduledAt,
      lastScheduledAt:scheduledAt,
      retryCount:Number(alarmInfo&&alarmInfo.retryCount||0)
    });
    try {
      const result=await runScan(this.env);
      await setMeta(this.env,"scheduler_state",{
        source:"DURABLE_OBJECT_ALARM",
        status:"PASS",
        scheduledAt,
        lastScheduledAt:scheduledAt,
        lastCompletedAt:new Date().toISOString(),
        radarGeneratedAt:result.generatedAt,
        retryCount:Number(alarmInfo&&alarmInfo.retryCount||0)
      });
      await this.ctx.storage.setAlarm(Date.now()+ALARM_INTERVAL_MS);
    } catch (e) {
      const error=String(e&&e.stack||e&&e.message||e);
      await recordError(this.env,e);
      await setMeta(this.env,"scheduler_state",{
        source:"DURABLE_OBJECT_ALARM",
        status:"FAIL",
        scheduledAt,
        lastScheduledAt:scheduledAt,
        lastCompletedAt:new Date().toISOString(),
        retryCount:Number(alarmInfo&&alarmInfo.retryCount||0),
        error
      });
      if (Number(alarmInfo&&alarmInfo.retryCount||0)>=5) {
        await this.ctx.storage.setAlarm(Date.now()+ALARM_INTERVAL_MS);
        return;
      }
      throw e;
    }
  }
}

export default {
  async scheduled(event,env) {
    const scheduledAt=new Date().toISOString();
    const scheduledTime=Number.isFinite(Number(event && event.scheduledTime))
      ? new Date(Number(event.scheduledTime)).toISOString()
      : null;
    const cron=String((event && event.cron) || "");
    await ensureDb(env);
    await setMeta(env,"scheduler_state",{
      source:"CRON_TRIGGER",
      status:"RUNNING",
      cron,
      scheduledAt,
      scheduledTime,
      lastScheduledAt:scheduledAt
    });
    try {
      const result=await runScan(env);
      await setMeta(env,"scheduler_state",{
        source:"CRON_TRIGGER",
        status:"PASS",
        cron,
        scheduledAt,
        scheduledTime,
        lastScheduledAt:scheduledAt,
        lastCompletedAt:new Date().toISOString(),
        radarGeneratedAt:result.generatedAt
      });
    } catch (e) {
      const error=String(e&&e.stack||e&&e.message||e);
      await recordError(env,e);
      await setMeta(env,"scheduler_state",{
        source:"CRON_TRIGGER",
        status:"FAIL",
        cron,
        scheduledAt,
        scheduledTime,
        lastScheduledAt:scheduledAt,
        lastCompletedAt:new Date().toISOString(),
        error
      });
      throw e;
    }
  },
  async fetch(request,env) {
    const u=new URL(request.url);
    if (u.pathname==="/scheduler/start") {
      const id=env.CABAL2_SCHEDULER.idFromName("primary");
      const stub=env.CABAL2_SCHEDULER.get(id);
      return await stub.fetch(new Request("https://cabal2-scheduler.internal/start"));
    }
    if (u.pathname==="/health") {
      await ensureDb(env);
      let last=await getMeta(env,"last_radar");
      if (u.searchParams.get("bootstrap")==="1" && (!last || last.version!==VERSION)) {
        try { await runScan(env); }
        catch (e) { await recordError(env,e); }
        last=await getMeta(env,"last_radar");
      }
      const lastError=await getMeta(env,"last_error");
      const scheduler=await getMeta(env,"scheduler_state");
      const ageSeconds=last&&last.generatedAt?Math.round((Date.now()-Date.parse(last.generatedAt))/1000):null;
      const schedulerAgeSeconds=scheduler&&scheduler.lastScheduledAt
        ? Math.round((Date.now()-Date.parse(scheduler.lastScheduledAt))/1000)
        : null;
      return json({
        healthy:!!last&&last.version===VERSION&&ageSeconds!==null&&ageSeconds<=150&&!(lastError&&lastError.error),
        schedulerHealthy:!!scheduler&&scheduler.status==="PASS"&&schedulerAgeSeconds!==null&&schedulerAgeSeconds<=150,
        version:VERSION,
        mode:"CABAL2_1M_MARKET_RADAR",
        ageSeconds,
        schedulerAgeSeconds,
        scheduler,
        lastError,
        last
      });
    }
    if (u.pathname==="/radar") {
      await ensureDb(env);
      return json((await getMeta(env,"last_radar"))||{version:VERSION,status:"NO_SCAN_YET"});
    }
    return json({service:"CABAL 2.0 Market Radar",version:VERSION,endpoints:["/health","/radar","/scheduler/start"],autoTrade:false});
  }
};

// Verification workflow deploy trigger
