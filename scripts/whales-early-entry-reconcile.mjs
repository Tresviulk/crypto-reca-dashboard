import fs from 'node:fs/promises';

const STATE_PATH = 'data/whales-early-entry-state.json';
const CABAL_PATH = 'data/cabal-machine.json';
const MIN_LIQUIDITY_USD = 50_000;
const MAX_MARKET_CAP_USD = 200_000_000;
const NO_CHASE_5M = 8;
const NO_CHASE_1H = 18;

const num = (x, fallback = null) => (x === null || x === undefined || x === '' || !Number.isFinite(Number(x))) ? fallback : Number(x);
const upper = (x) => String(x || '').trim().toUpperCase();
const round = (x, n = 8) => Number.isFinite(Number(x)) ? Number(Number(x).toFixed(n)) : null;

async function readJson(path, fallback = null) {
  try { return JSON.parse(await fs.readFile(path, 'utf8')); } catch { return fallback; }
}

function cabalMap(cabal) {
  const out = new Map();
  for (const c of cabal?.candidates || []) {
    const key = upper(c.asset);
    if (!key || out.has(key)) continue;
    out.set(key, {
      asset: key,
      price: c.price ?? null,
      stageAScore: c.stageAScore ?? null,
      classification: c.classification ?? null,
      executionSignal: c.executionSignal ?? null,
      urgency: c.decisionUrgency ?? null,
      breakout6h: c.breakout6h ?? null,
      reclaim6h: c.reclaim6h ?? null,
      rvol1h: c.rvol1h ?? null,
      rvol4h: c.rvol4h ?? null,
      priceChange1hPct: c.priceChange1hPct ?? null,
      priceChange4hPct: c.priceChange4hPct ?? null,
      pilotEntryMax: c.pilotEntryMax ?? null,
      protectiveStopReference: c.protectiveStopReference ?? null
    });
  }
  return out;
}

function normalizeFirstTouch(events, history) {
  for (const e of events || []) {
    if (!e?.wallet || !e?.mint || e.action !== 'BUY') continue;
    const firstBuyAt = history?.[`${e.wallet}:${e.mint}`]?.firstBuyAt || null;
    e.firstTouch = Boolean(firstBuyAt && e.eventTime === firstBuyAt);
    e.firstBuyAtForWalletToken = firstBuyAt;
  }
}

function buildSignals(state, cabal) {
  const cutoff6h = Date.now() - 6 * 3600_000;
  const groups = new Map();
  for (const e of state?.events || []) {
    if (!e?.mint || !['BUY','SELL'].includes(e.action) || Date.parse(e.eventTime || '') < cutoff6h) continue;
    const g = groups.get(e.mint) || { mint:e.mint, buys:[], sells:[] };
    (e.action === 'BUY' ? g.buys : g.sells).push(e);
    groups.set(e.mint, g);
  }

  const cabalBySymbol = cabalMap(cabal);
  const signals = [];

  for (const g of groups.values()) {
    const meta = state?.metadataCache?.[g.mint] || { status:'MISSING', mint:g.mint };
    const symbol = upper(meta.symbol);
    const cabalRow = symbol ? cabalBySymbol.get(symbol) || null : null;
    const cabalValidatedForEntry = Boolean(
      cabalRow &&
      cabalRow.executionSignal === 'PILOT_ENTRY_WINDOW' &&
      cabalRow.breakout6h === true &&
      cabalRow.reclaim6h === true &&
      !String(cabalRow.classification || '').toUpperCase().includes('LATE') &&
      !String(cabalRow.classification || '').toUpperCase().includes('CHURN')
    );

    const walletStats = new Map();
    for (const e of g.buys) {
      const w = walletStats.get(e.wallet) || { wallet:e.wallet, netToken:0, buys:[], sells:[], priority:false };
      w.netToken += Math.abs(num(e.tokenAmount, 0) || 0);
      w.buys.push(e);
      if (e.walletSource === 'FIXED_TIER_A' || e.walletTier === 'TIER_A') w.priority = true;
      walletStats.set(e.wallet, w);
    }
    for (const e of g.sells) {
      const w = walletStats.get(e.wallet) || { wallet:e.wallet, netToken:0, buys:[], sells:[], priority:false };
      w.netToken -= Math.abs(num(e.tokenAmount, 0) || 0);
      w.sells.push(e);
      walletStats.set(e.wallet, w);
    }

    const accumulatingWalletRows = [...walletStats.values()].filter((w) => w.netToken > 1e-12);
    const distributingWalletRows = [...walletStats.values()].filter((w) => w.netToken < -1e-12);
    const flatWalletRows = [...walletStats.values()].filter((w) => Math.abs(w.netToken) <= 1e-12);
    const activeBuys = g.buys.filter((e) => accumulatingWalletRows.some((w) => w.wallet === e.wallet));
    const priorityActiveBuys = activeBuys.filter((e) => e.walletSource === 'FIXED_TIER_A' || e.walletTier === 'TIER_A');
    const firstTouches = activeBuys.filter((e) => e.firstTouch);
    const netTokenFlow = [...walletStats.values()].reduce((s,w) => s + w.netToken, 0);
    const tokenBought = g.buys.reduce((s,e) => s + Math.abs(num(e.tokenAmount,0) || 0), 0);
    const tokenSold = g.sells.reduce((s,e) => s + Math.abs(num(e.tokenAmount,0) || 0), 0);
    const avgConfidence = activeBuys.length ? activeBuys.reduce((s,e) => s + (num(e.confidence,0) || 0),0) / activeBuys.length : 0;
    const whaleScore = accumulatingWalletRows.reduce((s,w) => s + Math.max(...w.buys.map((e) => num(e.walletWeight,0) || 0), 0), 0)
      - distributingWalletRows.reduce((s,w) => s + Math.max(...w.sells.map((e) => num(e.walletWeight,0) || 0), 0), 0);

    const liquidity = num(meta.liquidityUsd, null);
    const marketCap = num(meta.marketCapUsd ?? meta.fdvUsd, null);
    const h1 = num(meta.priceChange1hPct, null);
    const m5 = num(meta.priceChange5mPct, null);
    const noChase = (h1 != null && h1 > NO_CHASE_1H) || (m5 != null && m5 > NO_CHASE_5M);
    const liquidityHealthy = liquidity != null && liquidity >= MIN_LIQUIDITY_USD;
    const marketCapHealthy = marketCap == null || marketCap <= MAX_MARKET_CAP_USD;
    const marketHealthy = liquidityHealthy && marketCapHealthy;
    const uniqueAccumulatingWallets = accumulatingWalletRows.map((w) => w.wallet);
    const priorityAccumulatingWallets = accumulatingWalletRows.filter((w) => w.priority).map((w) => w.wallet);

    let status = 'NO_SIGNAL';
    let action = 'WATCH';
    let reason = 'No net shark accumulation condition.';

    if (netTokenFlow < -1e-12) {
      status = 'WHALE_DISTRIBUTION';
      action = 'AVOID_OR_REVIEW';
      reason = 'Current 6h classified wallet flows are net distribution after offsetting buys against sells.';
    } else if (Math.abs(netTokenFlow) <= 1e-12 && g.buys.length && g.sells.length) {
      status = 'WHALE_ROUND_TRIP_FLAT';
      action = 'NO_TRADE';
      reason = 'The monitored wallet bought and sold the same token amount in the current window; there is no remaining net accumulation.';
    } else if (noChase && activeBuys.length) {
      status = 'SHARK_BUY_LATE';
      action = 'DO_NOT_CHASE';
      reason = 'Net shark accumulation exists, but price acceleration already exceeds the early-entry no-chase threshold.';
    } else if (!liquidityHealthy && activeBuys.length) {
      status = 'WHALE_DISCOVERY_LOW_LIQUIDITY';
      action = 'WATCH_RISK_REJECT';
      reason = `Net shark accumulation exists, but verified liquidity is below the $${MIN_LIQUIDITY_USD.toLocaleString('en-US')} minimum for an actionable early-entry review.`;
    } else if (uniqueAccumulatingWallets.length >= 2 && priorityAccumulatingWallets.length >= 1 && avgConfidence >= 0.88 && marketHealthy) {
      status = 'SHARK_CONVERGENCE';
      action = cabalValidatedForEntry ? 'BUY_CANDIDATE_REVIEW' : 'EARLY_SHARK_WATCH';
      reason = cabalValidatedForEntry
        ? 'Two or more independent wallets are net accumulating, including Tier A/fixed shark coverage, and CABAL independently confirms a pilot-entry structure.'
        : 'Two or more independent wallets are net accumulating, including Tier A/fixed shark coverage; CABAL has not yet independently confirmed a pilot-entry structure.';
    } else if (priorityAccumulatingWallets.length >= 1 && firstTouches.length >= 1 && avgConfidence >= 0.88 && marketHealthy) {
      status = 'TIER_A_FIRST_TOUCH';
      action = cabalValidatedForEntry ? 'BUY_CANDIDATE_REVIEW' : 'EARLY_SHARK_WATCH';
      reason = cabalValidatedForEntry
        ? 'A Tier A/fixed shark made a high-confidence first-touch net BUY and CABAL independently confirms a pilot-entry structure.'
        : 'A Tier A/fixed shark made a high-confidence first-touch net BUY; waiting for independent CABAL entry confirmation.';
    } else if (activeBuys.length && netTokenFlow > 0) {
      status = 'WHALE_DISCOVERY';
      action = 'WATCH';
      reason = 'At least one monitored wallet remains net accumulated after buys and sells are offset, but Tier-A/convergence/CABAL entry conditions are incomplete.';
    }

    const firstBuyAt = activeBuys.map((e) => e.eventTime).sort()[0] || g.buys.map((e) => e.eventTime).sort()[0] || null;
    const latestBuyAt = activeBuys.map((e) => e.eventTime).sort().at(-1) || g.buys.map((e) => e.eventTime).sort().at(-1) || null;
    signals.push({
      status, action, reason, mint:g.mint,
      symbol:meta.symbol || null, name:meta.name || null,
      pair:meta.symbol ? `${upper(meta.symbol)}/SOL or ${upper(meta.symbol)}/USDC (DEX-dependent)` : null,
      dex:meta.dexId || null, pairAddress:meta.pairAddress || null, pairUrl:meta.pairUrl || null,
      priceUsd:meta.priceUsd ?? null, liquidityUsd:meta.liquidityUsd ?? null,
      marketCapUsd:meta.marketCapUsd ?? null, fdvUsd:meta.fdvUsd ?? null, volume24hUsd:meta.volume24hUsd ?? null,
      priceChange5mPct:meta.priceChange5mPct ?? null, priceChange1hPct:meta.priceChange1hPct ?? null,
      priceChange6hPct:meta.priceChange6hPct ?? null, priceChange24hPct:meta.priceChange24hPct ?? null,
      pairCreatedAt:meta.pairCreatedAt ?? null,
      buyCount:g.buys.length, sellCount:g.sells.length,
      tokenBought:round(tokenBought), tokenSold:round(tokenSold), netTokenFlow:round(netTokenFlow),
      uniqueBuyWalletCount:uniqueAccumulatingWallets.length,
      uniqueSellWalletCount:distributingWalletRows.length,
      uniqueBuyWallets:uniqueAccumulatingWallets,
      uniqueSellWallets:distributingWalletRows.map((w) => w.wallet),
      flatRoundTripWallets:flatWalletRows.map((w) => w.wallet),
      netAccumulatingWalletCount:uniqueAccumulatingWallets.length,
      tierAPriorityBuyCount:priorityAccumulatingWallets.length,
      firstTouchBuyCount:firstTouches.length,
      avgConfidence:round(avgConfidence,4), whaleScore:round(whaleScore,4),
      firstBuyAt, latestBuyAt,
      minutesSinceFirstBuy:firstBuyAt ? round((Date.now()-Date.parse(firstBuyAt))/60000,1) : null,
      noChase, liquidityHealthy, marketCapHealthy, marketHealthy,
      cabal:cabalRow,
      cabalValidatedForEntry,
      buyEvidence:activeBuys.slice().sort((a,b)=>Date.parse(a.eventTime)-Date.parse(b.eventTime)).map((e)=>({
        walletLabel:e.walletLabel, wallet:e.wallet, walletSource:e.walletSource, walletTier:e.walletTier,
        alphaScore:e.alphaScore, firstTouch:e.firstTouch, confidence:e.confidence,
        quoteAsset:e.quoteAsset, quoteAmount:e.quoteAmount, tokenAmount:e.tokenAmount,
        signature:e.signature, eventTime:e.eventTime
      })),
      sellEvidence:g.sells.slice().sort((a,b)=>Date.parse(a.eventTime)-Date.parse(b.eventTime)).map((e)=>({
        walletLabel:e.walletLabel, wallet:e.wallet, walletSource:e.walletSource, walletTier:e.walletTier,
        alphaScore:e.alphaScore, confidence:e.confidence, quoteAsset:e.quoteAsset,
        quoteAmount:e.quoteAmount, tokenAmount:e.tokenAmount, signature:e.signature, eventTime:e.eventTime
      })),
      dataQuality:meta.status === 'PASS' ? 'PASS' : 'PARTIAL'
    });
  }

  const rank = {
    SHARK_CONVERGENCE:8,
    TIER_A_FIRST_TOUCH:7,
    WHALE_DISCOVERY:6,
    WHALE_DISCOVERY_LOW_LIQUIDITY:5,
    SHARK_BUY_LATE:4,
    WHALE_ROUND_TRIP_FLAT:2,
    WHALE_DISTRIBUTION:1,
    NO_SIGNAL:0
  };
  return signals.sort((a,b)=>(rank[b.status]||0)-(rank[a.status]||0) || (num(b.whaleScore,0)||0)-(num(a.whaleScore,0)||0) || (num(b.liquidityUsd,0)||0)-(num(a.liquidityUsd,0)||0));
}

async function main() {
  const [state, cabal] = await Promise.all([readJson(STATE_PATH), readJson(CABAL_PATH,{})]);
  if (!state) throw new Error('Missing early-entry state');

  normalizeFirstTouch(state.events, state.walletMintHistory || {});
  normalizeFirstTouch(state.newEvents, state.walletMintHistory || {});
  const signals = buildSignals(state, cabal);
  state.signals = signals;
  state.topCandidates = signals.filter((s)=>['SHARK_CONVERGENCE','TIER_A_FIRST_TOUCH','WHALE_DISCOVERY','WHALE_DISCOVERY_LOW_LIQUIDITY','SHARK_BUY_LATE'].includes(s.status)).slice(0,20);
  state.buyCandidates = signals.filter((s)=>s.action === 'BUY_CANDIDATE_REVIEW');
  state.earlyWatches = signals.filter((s)=>s.action === 'EARLY_SHARK_WATCH');
  state.scan ||= {};
  state.scan.signalCount = signals.length;
  state.scan.buyCandidateCount = state.buyCandidates.length;
  state.scan.earlyWatchCount = state.earlyWatches.length;
  state.scan.netAccumulationSignalCount = signals.filter((s)=>s.netTokenFlow > 0).length;
  state.scan.netDistributionSignalCount = signals.filter((s)=>s.netTokenFlow < 0).length;
  state.scan.roundTripFlatCount = signals.filter((s)=>s.status === 'WHALE_ROUND_TRIP_FLAT').length;
  state.reconciliation = {
    applied:true,
    generatedAt:new Date().toISOString(),
    version:'EARLY_ENTRY_RECONCILE_V1_2026-09-13',
    rules:[
      'BUY signals require positive net token accumulation after offsetting classified sells.',
      'Independent convergence counts only wallets with positive net token position in the observed window.',
      'BUY_CANDIDATE_REVIEW requires CABAL PILOT_ENTRY_WINDOW plus breakout6h and reclaim6h; otherwise shark activity remains WATCH.',
      `Verified liquidity below $${MIN_LIQUIDITY_USD} is not actionable.`,
      'Round trips and net distribution are never promoted to BUY candidates.'
    ]
  };
  await fs.writeFile(STATE_PATH, JSON.stringify(state,null,2)+'\n');
  console.log('WHALES EARLY ENTRY RECONCILED', state.reconciliation.generatedAt, 'signals=',signals.length,'netAccum=',state.scan.netAccumulationSignalCount,'dist=',state.scan.netDistributionSignalCount,'flat=',state.scan.roundTripFlatCount,'buyCandidates=',state.buyCandidates.length,'earlyWatches=',state.earlyWatches.length);
}

main().catch((err)=>{ console.error(err); process.exit(1); });
