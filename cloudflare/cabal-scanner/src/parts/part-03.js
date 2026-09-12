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
