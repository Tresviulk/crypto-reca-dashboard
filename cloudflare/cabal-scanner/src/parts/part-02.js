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
