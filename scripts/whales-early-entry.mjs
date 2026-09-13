import fs from 'node:fs/promises';

const CONFIG_PATH = 'config/whales-multichain.json';
const DISCOVERY_PATH = 'data/whales-discovery-state.json';
const CABAL_PATH = 'data/cabal-machine.json';
const STATE_PATH = 'data/whales-early-entry-state.json';

const LOOKBACK_MINUTES = 25;
const RETENTION_HOURS = 72;
const MAX_COHORT = 30;
const MAX_TX_PER_WALLET = 8;
const SIGNATURE_LIMIT = 16;
const MAX_METADATA_LOOKUPS = 30;
const MIN_SOL_QUOTE = 0.002;
const MIN_STABLE_QUOTE = 1;
const LAMPORTS_PER_SOL = 1_000_000_000;

const WSOL = 'So11111111111111111111111111111111111111112';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const USDT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';
const QUOTE_MINTS = new Set([WSOL, USDC, USDT]);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const num = (x, fallback = 0) => (x === null || x === undefined || x === '' || !Number.isFinite(Number(x))) ? fallback : Number(x);
const round = (x, n = 8) => Number.isFinite(Number(x)) ? Number(Number(x).toFixed(n)) : null;
const upper = (x) => String(x || '').trim().toUpperCase();
const uniq = (arr) => [...new Set(arr.filter(Boolean))];

async function readJson(path, fallback = null) {
  try { return JSON.parse(await fs.readFile(path, 'utf8')); } catch { return fallback; }
}

function providerPool(cfg) {
  return uniq([
    process.env.SOLANA_RPC_URL,
    process.env.SOLANA_RPC_URL_2,
    ...(Array.isArray(cfg?.rpcUrls) ? cfg.rpcUrls : []),
    cfg?.rpcUrl,
    'https://solana-rpc.publicnode.com',
    'https://api.mainnet-beta.solana.com'
  ]);
}

async function rpcOnce(url, method, params, timeoutMs = 12000) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': 'crypto-reca-whales-early-entry/1.0' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (!response.ok) throw new Error(`HTTP_${response.status}`);
  const json = await response.json();
  if (json?.error) throw new Error(`${method}:${JSON.stringify(json.error)}`);
  return json?.result;
}

async function rpcFailover(urls, method, params, providerStats) {
  let last = null;
  for (let i = 0; i < urls.length; i++) {
    const url = urls[i];
    const stats = providerStats[url] ||= { calls: 0, successes: 0, failures: 0, recoveredFallbacks: 0, lastError: null };
    for (let attempt = 0; attempt < 2; attempt++) {
      stats.calls++;
      try {
        const result = await rpcOnce(url, method, params);
        stats.successes++;
        if (i > 0) stats.recoveredFallbacks++;
        return { result, provider: url, usedFallback: i > 0 };
      } catch (err) {
        last = err;
        stats.failures++;
        stats.lastError = String(err?.message || err);
        await sleep(160 * (attempt + 1) * (i + 1));
      }
    }
  }
  throw last || new Error(`${method}: all Solana providers failed`);
}

function walletTierWeight(wallet) {
  if (wallet.fixed) return 1.0;
  if (wallet.discoveryTier === 'TIER_A' || wallet.tier === 'TIER_A') return 0.95;
  if (wallet.discoveryTier === 'TIER_B' || wallet.tier === 'TIER_B') return 0.72;
  return 0.5;
}

function cohortFrom(config, discovery) {
  const fixed = (config?.solanaWallets || []).map((w) => ({
    ...w,
    sourceType: 'FIXED_TIER_A',
    discoveryTier: 'FIXED_TIER_A',
    alphaScore: 100,
    winRate: null,
    ageDays: null,
    fixed: true
  }));

  const tierA = (discovery?.tierA || []).map((w) => ({
    label: `EARLY-A-${w.wallet.slice(0,6)}`,
    name: `DISCOVERY-${w.wallet.slice(0,6)}`,
    address: w.wallet,
    sourceType: 'DISCOVERY_TIER_A',
    discoveryTier: 'TIER_A',
    tier: 'A',
    alphaScore: w.alphaScore,
    winRate: w.winRate,
    roi: w.roi,
    netPnlSol: w.netPnlSol,
    tokensTraded: w.tokensTraded,
    ageDays: w.ageDays,
    lastSeen: w.lastSeen,
    fixed: false
  }));

  const tierB = (discovery?.tierB || [])
    .filter((w) => num(w.alphaScore) >= 75 && num(w.winRate) >= 0.55 && num(w.netPnlSol) > 0 && num(w.tokensTraded) >= 10 && num(w.ageDays, 999) <= 14)
    .map((w) => ({
      label: `EARLY-B-${w.wallet.slice(0,6)}`,
      name: `DISCOVERY-${w.wallet.slice(0,6)}`,
      address: w.wallet,
      sourceType: 'DISCOVERY_TIER_B_DYNAMIC',
      discoveryTier: 'TIER_B',
      tier: 'B',
      alphaScore: w.alphaScore,
      winRate: w.winRate,
      roi: w.roi,
      netPnlSol: w.netPnlSol,
      tokensTraded: w.tokensTraded,
      ageDays: w.ageDays,
      lastSeen: w.lastSeen,
      fixed: false
    }))
    .sort((a, b) => num(b.alphaScore) - num(a.alphaScore) || num(a.ageDays, 999) - num(b.ageDays, 999));

  const map = new Map();
  for (const w of [...fixed, ...tierA, ...tierB]) if (w.address && !map.has(w.address)) map.set(w.address, w);
  return [...map.values()].slice(0, MAX_COHORT);
}

function accountIndex(tx, wallet) {
  const keys = tx?.transaction?.message?.accountKeys || [];
  return keys.findIndex((k) => String(k?.pubkey || k) === wallet);
}

function tokenDeltas(tx, wallet) {
  const deltas = new Map();
  for (const row of tx?.meta?.preTokenBalances || []) {
    if (row.owner !== wallet) continue;
    deltas.set(row.mint, (deltas.get(row.mint) || 0) - num(row.uiTokenAmount?.uiAmountString));
  }
  for (const row of tx?.meta?.postTokenBalances || []) {
    if (row.owner !== wallet) continue;
    deltas.set(row.mint, (deltas.get(row.mint) || 0) + num(row.uiTokenAmount?.uiAmountString));
  }
  return [...deltas.entries()]
    .filter(([, delta]) => Number.isFinite(delta) && Math.abs(delta) > 1e-12)
    .map(([mint, delta]) => ({ mint, delta }));
}

function nativeSolDelta(tx, wallet) {
  const idx = accountIndex(tx, wallet);
  if (idx < 0) return 0;
  const pre = num(tx?.meta?.preBalances?.[idx]);
  const post = num(tx?.meta?.postBalances?.[idx]);
  return (post - pre) / LAMPORTS_PER_SOL;
}

function quoteSide(deltas, solDelta) {
  const quote = [];
  if (Math.abs(solDelta) >= MIN_SOL_QUOTE) quote.push({ asset: 'SOL', mint: null, delta: solDelta, strength: 'NATIVE_SOL' });
  for (const row of deltas) {
    if (!QUOTE_MINTS.has(row.mint)) continue;
    const asset = row.mint === WSOL ? 'WSOL' : row.mint === USDC ? 'USDC' : 'USDT';
    const min = asset === 'WSOL' ? MIN_SOL_QUOTE : MIN_STABLE_QUOTE;
    if (Math.abs(row.delta) >= min) quote.push({ asset, mint: row.mint, delta: row.delta, strength: 'SPL_QUOTE' });
  }
  return quote;
}

function classifyTransaction(tx, walletRow, signatureRow, history) {
  const wallet = walletRow.address;
  const deltas = tokenDeltas(tx, wallet);
  const solDelta = nativeSolDelta(tx, wallet);
  const quotes = quoteSide(deltas, solDelta);
  const targets = deltas.filter((d) => !QUOTE_MINTS.has(d.mint));
  const events = [];

  const spentQuotes = quotes.filter((q) => q.delta < 0);
  const receivedQuotes = quotes.filter((q) => q.delta > 0);
  const positives = targets.filter((d) => d.delta > 0);
  const negatives = targets.filter((d) => d.delta < 0);

  if (positives.length && spentQuotes.length) {
    const quote = spentQuotes.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))[0];
    for (const t of positives) {
      const key = `${wallet}:${t.mint}`;
      const prior = history[key] || null;
      const confidence = quote.strength === 'SPL_QUOTE' ? 0.96 : 0.90;
      events.push({
        chain: 'solana', action: 'BUY', classification: 'ONCHAIN_SWAP_BUY', confidence,
        walletLabel: walletRow.label, wallet, walletSource: walletRow.sourceType,
        walletTier: walletRow.discoveryTier, alphaScore: walletRow.alphaScore, winRate: walletRow.winRate,
        walletWeight: walletTierWeight(walletRow), mint: t.mint, tokenAmount: round(t.delta),
        quoteAsset: quote.asset, quoteAmount: round(Math.abs(quote.delta)),
        signature: signatureRow.signature, blockTime: signatureRow.blockTime,
        eventTime: new Date(Number(signatureRow.blockTime) * 1000).toISOString(),
        firstTouch: !prior?.firstBuyAt,
        firstBuyAtForWalletToken: prior?.firstBuyAt || null
      });
    }
  }

  if (negatives.length && receivedQuotes.length) {
    const quote = receivedQuotes.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))[0];
    for (const t of negatives) {
      events.push({
        chain: 'solana', action: 'SELL', classification: 'ONCHAIN_SWAP_SELL', confidence: quote.strength === 'SPL_QUOTE' ? 0.96 : 0.90,
        walletLabel: walletRow.label, wallet, walletSource: walletRow.sourceType,
        walletTier: walletRow.discoveryTier, alphaScore: walletRow.alphaScore, winRate: walletRow.winRate,
        walletWeight: walletTierWeight(walletRow), mint: t.mint, tokenAmount: round(Math.abs(t.delta)),
        quoteAsset: quote.asset, quoteAmount: round(Math.abs(quote.delta)),
        signature: signatureRow.signature, blockTime: signatureRow.blockTime,
        eventTime: new Date(Number(signatureRow.blockTime) * 1000).toISOString(),
        firstTouch: false
      });
    }
  }

  if (!events.length && targets.length) {
    events.push({
      chain: 'solana', action: 'CONTEXT', classification: 'TOKEN_FLOW_CONTEXT_ONLY', confidence: 0,
      walletLabel: walletRow.label, wallet, walletSource: walletRow.sourceType,
      walletTier: walletRow.discoveryTier, alphaScore: walletRow.alphaScore, winRate: walletRow.winRate,
      walletWeight: walletTierWeight(walletRow), mint: null, tokenAmount: null,
      tokenFlows: targets.map((x) => ({ mint: x.mint, delta: round(x.delta) })),
      quoteAsset: null, quoteAmount: null,
      signature: signatureRow.signature, blockTime: signatureRow.blockTime,
      eventTime: new Date(Number(signatureRow.blockTime) * 1000).toISOString(), firstTouch: false
    });
  }

  return events;
}

async function dexMetadata(mint, cache) {
  const cached = cache[mint];
  const maxAgeMs = 10 * 60_000;
  if (cached?.checkedAt && Date.now() - Date.parse(cached.checkedAt) < maxAgeMs) return cached;
  try {
    const url = `https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(mint)}`;
    const response = await fetch(url, { headers: { accept: 'application/json', 'user-agent': 'crypto-reca-whales-early-entry/1.0' }, signal: AbortSignal.timeout(12000) });
    if (!response.ok) throw new Error(`DEX_HTTP_${response.status}`);
    const json = await response.json();
    const pairs = (json?.pairs || []).filter((p) => p?.chainId === 'solana' && (p?.baseToken?.address === mint || p?.quoteToken?.address === mint));
    const ranked = pairs.sort((a, b) => num(b?.liquidity?.usd) - num(a?.liquidity?.usd) || num(b?.volume?.h24) - num(a?.volume?.h24));
    const p = ranked[0] || null;
    const out = p ? {
      status: 'PASS', checkedAt: new Date().toISOString(), mint,
      symbol: p?.baseToken?.address === mint ? p?.baseToken?.symbol : p?.quoteToken?.symbol,
      name: p?.baseToken?.address === mint ? p?.baseToken?.name : p?.quoteToken?.name,
      dexId: p.dexId || null, pairAddress: p.pairAddress || null, pairUrl: p.url || null,
      priceUsd: num(p.priceUsd, null), liquidityUsd: num(p?.liquidity?.usd, null),
      marketCapUsd: num(p.marketCap, null), fdvUsd: num(p.fdv, null), volume24hUsd: num(p?.volume?.h24, null),
      priceChange5mPct: num(p?.priceChange?.m5, null), priceChange1hPct: num(p?.priceChange?.h1, null),
      priceChange6hPct: num(p?.priceChange?.h6, null), priceChange24hPct: num(p?.priceChange?.h24, null),
      pairCreatedAt: p.pairCreatedAt ? new Date(Number(p.pairCreatedAt)).toISOString() : null
    } : { status: 'NO_PAIR', checkedAt: new Date().toISOString(), mint };
    cache[mint] = out;
    return out;
  } catch (err) {
    const out = { status: 'ERROR', checkedAt: new Date().toISOString(), mint, error: String(err?.message || err) };
    cache[mint] = out;
    return out;
  }
}

function cabalMap(cabal) {
  const map = new Map();
  for (const c of cabal?.candidates || []) {
    const key = upper(c.asset);
    if (!key || map.has(key)) continue;
    map.set(key, {
      asset: key, price: c.price ?? null, stageAScore: c.stageAScore ?? null,
      classification: c.classification ?? null, executionSignal: c.executionSignal ?? null,
      urgency: c.decisionUrgency ?? null, rvol1h: c.rvol1h ?? null, rvol4h: c.rvol4h ?? null,
      priceChange1hPct: c.priceChange1hPct ?? null, priceChange4hPct: c.priceChange4hPct ?? null,
      pilotEntryMax: c.pilotEntryMax ?? null, protectiveStopReference: c.protectiveStopReference ?? null
    });
  }
  return map;
}

function updateHistory(history, events) {
  for (const e of events) {
    if (!e.mint || !['BUY','SELL'].includes(e.action)) continue;
    const key = `${e.wallet}:${e.mint}`;
    const h = history[key] ||= { wallet: e.wallet, mint: e.mint, firstSeenAt: e.eventTime, firstBuyAt: null, lastSeenAt: e.eventTime, buyCount: 0, sellCount: 0 };
    if (e.eventTime < h.firstSeenAt) h.firstSeenAt = e.eventTime;
    if (e.action === 'BUY') {
      h.buyCount = num(h.buyCount) + 1;
      if (!h.firstBuyAt || e.eventTime < h.firstBuyAt) h.firstBuyAt = e.eventTime;
    } else h.sellCount = num(h.sellCount) + 1;
    if (!h.lastSeenAt || e.eventTime > h.lastSeenAt) h.lastSeenAt = e.eventTime;
  }
}

function buildSignals(events, metadataCache, cabal) {
  const cutoff6h = Date.now() - 6 * 3600_000;
  const groups = new Map();
  for (const e of events) {
    if (!e.mint || !['BUY','SELL'].includes(e.action) || Date.parse(e.eventTime) < cutoff6h) continue;
    const g = groups.get(e.mint) || { mint: e.mint, buys: [], sells: [] };
    if (e.action === 'BUY') g.buys.push(e); else g.sells.push(e);
    groups.set(e.mint, g);
  }

  const cabalBySymbol = cabalMap(cabal);
  const out = [];
  for (const g of groups.values()) {
    const meta = metadataCache[g.mint] || { status: 'MISSING', mint: g.mint };
    const uniqueBuyWallets = [...new Set(g.buys.map((e) => e.wallet))];
    const uniqueSellWallets = [...new Set(g.sells.map((e) => e.wallet))];
    const priorityBuys = g.buys.filter((e) => e.walletSource === 'FIXED_TIER_A' || e.walletTier === 'TIER_A');
    const firstTouches = g.buys.filter((e) => e.firstTouch);
    const avgConfidence = g.buys.length ? g.buys.reduce((s, e) => s + num(e.confidence), 0) / g.buys.length : 0;
    const score = g.buys.reduce((s, e) => s + num(e.walletWeight), 0) - g.sells.reduce((s, e) => s + num(e.walletWeight) * 0.8, 0);
    const liquidity = num(meta.liquidityUsd, null);
    const marketCap = num(meta.marketCapUsd ?? meta.fdvUsd, null);
    const h1 = num(meta.priceChange1hPct, null);
    const m5 = num(meta.priceChange5mPct, null);
    const noChase = (h1 != null && h1 > 18) || (m5 != null && m5 > 8);
    const marketHealthy = (liquidity == null || liquidity >= 50_000) && (marketCap == null || marketCap <= 200_000_000);
    const cabalRow = meta.symbol ? cabalBySymbol.get(upper(meta.symbol)) || null : null;

    let status = 'NO_SIGNAL';
    let action = 'WATCH';
    let reason = 'No strong early-entry condition.';
    if (uniqueBuyWallets.length >= 2 && priorityBuys.length >= 1 && avgConfidence >= 0.88 && marketHealthy && !noChase) {
      status = 'SHARK_CONVERGENCE';
      action = 'BUY_CANDIDATE_REVIEW';
      reason = 'Two or more independent monitored wallets show high-confidence on-chain swap BUYs, including at least one Tier A/fixed shark, before chase conditions are reached.';
    } else if (priorityBuys.length >= 1 && firstTouches.length >= 1 && avgConfidence >= 0.88 && marketHealthy && !noChase) {
      status = 'TIER_A_FIRST_TOUCH';
      action = 'EARLY_SHARK_WATCH';
      reason = 'A Tier A/fixed wallet made a high-confidence first-touch BUY while liquidity/market-cap filters remain acceptable.';
    } else if (g.buys.length && !noChase) {
      status = 'WHALE_DISCOVERY';
      action = 'WATCH';
      reason = 'At least one monitored wallet has a classified on-chain BUY, but convergence/Tier-A conditions are incomplete.';
    } else if (g.buys.length && noChase) {
      status = 'SHARK_BUY_LATE';
      action = 'DO_NOT_CHASE';
      reason = 'Wallet BUY activity exists, but price acceleration already exceeds the early-entry no-chase threshold.';
    } else if (g.sells.length) {
      status = 'WHALE_DISTRIBUTION';
      action = 'AVOID_OR_REVIEW';
      reason = 'Monitored wallet SELL activity dominates the current window.';
    }

    const firstBuyAt = g.buys.map((e) => e.eventTime).sort()[0] || null;
    const latestBuyAt = g.buys.map((e) => e.eventTime).sort().at(-1) || null;
    out.push({
      status, action, reason, mint: g.mint,
      symbol: meta.symbol || null, name: meta.name || null,
      pair: meta.symbol ? `${upper(meta.symbol)}/SOL or ${upper(meta.symbol)}/USDC (DEX-dependent)` : null,
      dex: meta.dexId || null, pairAddress: meta.pairAddress || null, pairUrl: meta.pairUrl || null,
      priceUsd: meta.priceUsd ?? null, liquidityUsd: meta.liquidityUsd ?? null,
      marketCapUsd: meta.marketCapUsd ?? null, fdvUsd: meta.fdvUsd ?? null, volume24hUsd: meta.volume24hUsd ?? null,
      priceChange5mPct: meta.priceChange5mPct ?? null, priceChange1hPct: meta.priceChange1hPct ?? null,
      priceChange6hPct: meta.priceChange6hPct ?? null, priceChange24hPct: meta.priceChange24hPct ?? null,
      pairCreatedAt: meta.pairCreatedAt ?? null,
      buyCount: g.buys.length, sellCount: g.sells.length,
      uniqueBuyWalletCount: uniqueBuyWallets.length, uniqueSellWalletCount: uniqueSellWallets.length,
      uniqueBuyWallets, uniqueSellWallets,
      tierAPriorityBuyCount: priorityBuys.length, firstTouchBuyCount: firstTouches.length,
      avgConfidence: round(avgConfidence, 4), whaleScore: round(score, 4),
      firstBuyAt, latestBuyAt,
      minutesSinceFirstBuy: firstBuyAt ? round((Date.now() - Date.parse(firstBuyAt)) / 60000, 1) : null,
      cabal: cabalRow,
      buyEvidence: g.buys.slice().sort((a,b) => Date.parse(a.eventTime)-Date.parse(b.eventTime)).map((e) => ({
        walletLabel: e.walletLabel, wallet: e.wallet, walletSource: e.walletSource, walletTier: e.walletTier,
        alphaScore: e.alphaScore, firstTouch: e.firstTouch, confidence: e.confidence,
        quoteAsset: e.quoteAsset, quoteAmount: e.quoteAmount, tokenAmount: e.tokenAmount,
        signature: e.signature, eventTime: e.eventTime
      })),
      sellEvidence: g.sells.slice().sort((a,b) => Date.parse(a.eventTime)-Date.parse(b.eventTime)).map((e) => ({
        walletLabel: e.walletLabel, wallet: e.wallet, walletSource: e.walletSource, walletTier: e.walletTier,
        alphaScore: e.alphaScore, confidence: e.confidence, quoteAsset: e.quoteAsset,
        quoteAmount: e.quoteAmount, tokenAmount: e.tokenAmount, signature: e.signature, eventTime: e.eventTime
      })),
      dataQuality: meta.status === 'PASS' ? 'PASS' : 'PARTIAL'
    });
  }

  const rank = { SHARK_CONVERGENCE: 5, TIER_A_FIRST_TOUCH: 4, WHALE_DISCOVERY: 3, SHARK_BUY_LATE: 2, WHALE_DISTRIBUTION: 1, NO_SIGNAL: 0 };
  return out.sort((a,b) => (rank[b.status]||0)-(rank[a.status]||0) || num(b.whaleScore)-num(a.whaleScore) || num(b.liquidityUsd)-num(a.liquidityUsd));
}

async function main() {
  const [config, discovery, cabal, previous] = await Promise.all([
    readJson(CONFIG_PATH, {}), readJson(DISCOVERY_PATH, {}), readJson(CABAL_PATH, {}), readJson(STATE_PATH, {})
  ]);
  const solCfg = config?.chains?.solana || {};
  const rpcUrls = providerPool(solCfg);
  const cohort = cohortFrom(config, discovery);
  const providerStats = {};
  const processed = new Set(previous?.processedSignatures || []);
  const history = previous?.walletMintHistory && typeof previous.walletMintHistory === 'object' ? previous.walletMintHistory : {};
  const metadataCache = previous?.metadataCache && typeof previous.metadataCache === 'object' ? previous.metadataCache : {};
  const retainedPrevious = Array.isArray(previous?.events) ? previous.events : [];
  const newEvents = [];
  const perWallet = [];
  const cutoff = Math.floor(Date.now() / 1000) - LOOKBACK_MINUTES * 60;
  let failedWallets = 0;
  let txFailures = 0;
  let fallbackRecoveries = 0;

  for (const w of cohort) {
    let status = 'PASS';
    let signaturesSeen = 0;
    let newSignatures = 0;
    let classifiedEvents = 0;
    let provider = null;
    try {
      const sigResult = await rpcFailover(rpcUrls, 'getSignaturesForAddress', [w.address, { limit: SIGNATURE_LIMIT, commitment: 'confirmed' }], providerStats);
      provider = sigResult.provider;
      if (sigResult.usedFallback) fallbackRecoveries++;
      const recent = (Array.isArray(sigResult.result) ? sigResult.result : []).filter((s) => !s?.err && s?.blockTime && s.blockTime >= cutoff);
      signaturesSeen = recent.length;
      const unseen = recent.filter((s) => !processed.has(s.signature)).slice(0, MAX_TX_PER_WALLET);
      newSignatures = unseen.length;
      for (const s of unseen) {
        try {
          const txResult = await rpcFailover(rpcUrls, 'getTransaction', [s.signature, { encoding: 'jsonParsed', commitment: 'confirmed', maxSupportedTransactionVersion: 0 }], providerStats);
          if (txResult.usedFallback) fallbackRecoveries++;
          const events = classifyTransaction(txResult.result, w, s, history).map((e) => ({ ...e, rpcProvider: txResult.provider }));
          newEvents.push(...events);
          classifiedEvents += events.length;
          processed.add(s.signature);
        } catch (err) {
          txFailures++;
          status = 'PARTIAL';
        }
        await sleep(num(solCfg.interTransactionDelayMs, 70));
      }
    } catch (err) {
      failedWallets++;
      status = 'ERROR';
    }
    perWallet.push({
      label: w.label, address: w.address, sourceType: w.sourceType, discoveryTier: w.discoveryTier,
      alphaScore: w.alphaScore, winRate: w.winRate, ageDays: w.ageDays,
      status, rpcProvider: provider, signaturesSeen, newSignatures, classifiedEvents
    });
    await sleep(num(solCfg.interWalletDelayMs, 140));
  }

  updateHistory(history, newEvents);
  const retentionCutoff = Date.now() - RETENTION_HOURS * 3600_000;
  const merged = new Map();
  for (const e of [...retainedPrevious, ...newEvents]) {
    if (!e?.signature || Date.parse(e.eventTime || '') < retentionCutoff) continue;
    const key = `${e.wallet}:${e.signature}:${e.action}:${e.mint || 'context'}`;
    merged.set(key, e);
  }
  const events = [...merged.values()].sort((a,b) => Date.parse(b.eventTime)-Date.parse(a.eventTime));

  const activeMints = uniq(events.filter((e) => e.mint && ['BUY','SELL'].includes(e.action) && Date.parse(e.eventTime) >= Date.now()-6*3600_000).map((e) => e.mint)).slice(0, MAX_METADATA_LOOKUPS);
  for (const mint of activeMints) {
    const meta = await dexMetadata(mint, metadataCache);
    for (const e of events) {
      if (e.mint !== mint || e.priceUsdAtDetection != null || meta.status !== 'PASS') continue;
      e.priceUsdAtDetection = meta.priceUsd ?? null;
      e.symbolAtDetection = meta.symbol ?? null;
      e.liquidityUsdAtDetection = meta.liquidityUsd ?? null;
      e.marketCapUsdAtDetection = meta.marketCapUsd ?? meta.fdvUsd ?? null;
    }
    await sleep(80);
  }

  const signals = buildSignals(events, metadataCache, cabal);
  const topCandidates = signals.filter((s) => ['SHARK_CONVERGENCE','TIER_A_FIRST_TOUCH','WHALE_DISCOVERY','SHARK_BUY_LATE'].includes(s.status)).slice(0, 20);
  const buyCandidates = signals.filter((s) => s.action === 'BUY_CANDIDATE_REVIEW');
  const earlyWatches = signals.filter((s) => s.action === 'EARLY_SHARK_WATCH');
  const contextOnly = newEvents.filter((e) => e.action === 'CONTEXT').length;
  const onchainBuys = newEvents.filter((e) => e.action === 'BUY').length;
  const onchainSells = newEvents.filter((e) => e.action === 'SELL').length;

  const runStatus = failedWallets === cohort.length ? 'ERROR' : (failedWallets || txFailures) ? 'PARTIAL' : 'PASS';
  const out = {
    schemaVersion: '1.0',
    module: 'whalesEarlyEntryEngine',
    version: 'WHALES_EARLY_ENTRY_V1_2026-09-13',
    generatedAt: new Date().toISOString(),
    runStatus,
    purpose: 'Wallet-first early-entry detection. Start from shark wallets, classify real on-chain swap direction, resolve the token/pair and only then use CABAL as secondary confirmation.',
    executionPolicy: 'SURVEILLANCE_ONLY_NO_AUTO_TRADE',
    scheduleTargetMinutes: 5,
    lookbackMinutes: LOOKBACK_MINUTES,
    retentionHours: RETENTION_HOURS,
    cohort: {
      total: cohort.length,
      fixedTierA: cohort.filter((w) => w.sourceType === 'FIXED_TIER_A').length,
      discoveryTierA: cohort.filter((w) => w.sourceType === 'DISCOVERY_TIER_A').length,
      dynamicTierB: cohort.filter((w) => w.sourceType === 'DISCOVERY_TIER_B_DYNAMIC').length,
      maxCohort: MAX_COHORT,
      wallets: cohort.map((w) => ({ label:w.label, address:w.address, sourceType:w.sourceType, tier:w.discoveryTier, alphaScore:w.alphaScore, winRate:w.winRate, ageDays:w.ageDays }))
    },
    health: {
      rpcMode: 'RESILIENT_PUBLIC_RPC_FAILOVER', rpcProviders: rpcUrls, providerStats,
      failedWallets, txFailures, fallbackRecoveries, walletsPass: perWallet.filter((w) => w.status === 'PASS').length,
      walletsPartial: perWallet.filter((w) => w.status === 'PARTIAL').length,
      walletsError: perWallet.filter((w) => w.status === 'ERROR').length
    },
    scan: {
      newEventCount: newEvents.length, newOnchainSwapBuys: onchainBuys, newOnchainSwapSells: onchainSells,
      newContextOnly: contextOnly, retainedEventCount: events.length,
      activeMintCount6h: activeMints.length, signalCount: signals.length,
      buyCandidateCount: buyCandidates.length, earlyWatchCount: earlyWatches.length
    },
    thresholds: {
      highConfidenceBuyMin: 0.88,
      convergenceIndependentWallets: 2,
      minLiquidityUsdForEarlyWatch: 50000,
      maxMarketCapUsdForEarlyWatch: 200000000,
      noChase5mPct: 8,
      noChase1hPct: 18,
      interpretation: 'Thresholds are designed to favor early detection and reject already-extended moves. They are review gates, not automatic execution rules.'
    },
    perWallet,
    newEvents,
    events,
    signals,
    topCandidates,
    buyCandidates,
    earlyWatches,
    processedSignatures: [...processed].slice(-2500),
    walletMintHistory: history,
    metadataCache,
    dataGaps: [
      'GitHub Actions/public RPC is near-real-time polling, not a sub-second WebSocket/gRPC stream; detection latency can be several minutes.',
      'Swap classification is high-confidence balance-delta inference using SOL/WSOL/USDC/USDT quote legs; ambiguous transfers remain CONTEXT and never become BUY.',
      'Insider/deployer/sybil graph is not yet a complete independent attribution layer.',
      'DexScreener metadata can be missing or lag during the first minutes of a new token.'
    ]
  };

  await fs.writeFile(STATE_PATH, JSON.stringify(out, null, 2) + '\n');
  console.log('WHALES EARLY ENTRY', out.generatedAt, runStatus, 'cohort=', cohort.length, 'newBuys=', onchainBuys, 'newSells=', onchainSells, 'candidates=', buyCandidates.length, 'watches=', earlyWatches.length);
}

main().catch((err) => { console.error(err); process.exit(1); });
