import fs from 'node:fs/promises';

const CONFIG_PATH = 'config/whales-discovery.json';
const STATE_PATH = 'data/whales-discovery-state.json';
const PROMOTED_PATH = 'data/whales-promoted-wallets.json';
const PUBLIC_DEMO_KEY = 'msk_demo_try_the_solana_api_2026';

const clamp = (x, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, Number(x) || 0));
const round = (x, n = 4) => Number((Number(x) || 0).toFixed(n));

async function readJson(path, fallback = null) {
  try { return JSON.parse(await fs.readFile(path, 'utf8')); } catch { return fallback; }
}

async function fetchLeaderboard(cfg, sort) {
  const url = new URL(cfg.source.endpoint);
  url.searchParams.set('period', cfg.source.period || '30d');
  url.searchParams.set('min_tokens', String(cfg.source.minTokens || 8));
  url.searchParams.set('sort', sort);
  url.searchParams.set('exclude_bots', String(cfg.source.excludeBots !== false));
  url.searchParams.set('limit', String(cfg.source.limit || 100));
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${PUBLIC_DEMO_KEY}` },
    signal: AbortSignal.timeout(20000)
  });
  if (!response.ok) throw new Error(`MadeOnSol ${sort} HTTP ${response.status}`);
  const data = await response.json();
  return { sort, rows: Array.isArray(data?.leaderboard) ? data.leaderboard : [], meta: { total: data?.total ?? null, period: data?.period ?? null } };
}

function normalizeRate(x) {
  const n = Number(x);
  if (!Number.isFinite(n)) return 0;
  return n > 1 ? n / 100 : n;
}

function daysSince(iso) {
  const t = Date.parse(iso || '');
  if (!Number.isFinite(t)) return 9999;
  return Math.max(0, (Date.now() - t) / 86400000);
}

function scoreWallet(w, cfg) {
  const s = cfg.scoring;
  const winRate = normalizeRate(w.win_rate);
  const roi = Number(w.roi || 0);
  const pnl = Number(w.net_pnl_sol || 0);
  const tokens = Number(w.tokens_traded || 0);
  const ageDays = daysSince(w.last_seen);

  const base = Number(s.alphaDatasetBase || 0);
  const win = clamp(winRate / Number(s.fullWinRate || 0.8)) * Number(s.winRateWeight || 0);
  const roiScore = clamp(roi / Number(s.fullRoi || 1)) * Number(s.roiWeight || 0);
  const pnlNorm = pnl > 0 ? clamp(Math.log10(1 + pnl) / Math.log10(1 + Number(s.fullPnlSol || 100))) : 0;
  const pnlScore = pnlNorm * Number(s.pnlWeight || 0);
  const sample = clamp(tokens / Number(s.fullSampleTokens || 30)) * Number(s.sampleWeight || 0);
  let recencyRatio = 0;
  if (ageDays <= Number(s.freshDays || 7)) recencyRatio = 1;
  else if (ageDays <= Number(s.staleDays || 30)) recencyRatio = 0.5;
  const recency = recencyRatio * Number(s.recencyWeight || 0);
  const score = clamp(base + win + roiScore + pnlScore + sample + recency, 0, 100);

  return {
    score: round(score, 2),
    breakdown: {
      alphaDataset: round(base, 2),
      winRate: round(win, 2),
      roi: round(roiScore, 2),
      pnl: round(pnlScore, 2),
      sample: round(sample, 2),
      recency: round(recency, 2)
    },
    normalized: { winRate: round(winRate, 4), roi: round(roi, 4), pnlSol: round(pnl, 4), tokensTraded: tokens, ageDays: round(ageDays, 2) }
  };
}

function tierFor(w, scored, cfg) {
  const m = scored.normalized;
  const a = cfg.tiers.tierA;
  const b = cfg.tiers.tierB;
  const q = cfg.tiers.watch;
  if (scored.score >= a.minScore && m.tokensTraded >= a.minTokens && m.winRate >= a.minWinRate && (!a.requirePositivePnl || m.pnlSol > 0) && (!a.requirePositiveRoi || m.roi > 0)) return 'TIER_A';
  if (scored.score >= b.minScore && m.tokensTraded >= b.minTokens && m.winRate >= b.minWinRate && (!b.requirePositivePnl || m.pnlSol > 0)) return 'TIER_B';
  if (scored.score >= q.minScore && m.tokensTraded >= q.minTokens) return 'WATCH';
  return 'DISCOVERED';
}

function mergeLeaderboards(resultSets) {
  const map = new Map();
  for (const set of resultSets) {
    set.rows.forEach((r, i) => {
      const wallet = r.wallet || r.wallet_address;
      if (!wallet) return;
      const prev = map.get(wallet) || { ...r, wallet, ranks: {}, appearances: 0 };
      for (const [k, v] of Object.entries(r)) if (v != null) prev[k] = v;
      prev.ranks[set.sort] = i + 1;
      prev.appearances += 1;
      map.set(wallet, prev);
    });
  }
  return [...map.values()];
}

async function main() {
  const cfg = await readJson(CONFIG_PATH);
  if (!cfg?.enabled) throw new Error('WHALES Discovery config missing or disabled');
  const previous = await readJson(STATE_PATH, null);
  const resultSets = [];
  const errors = [];

  for (const sort of cfg.source.sorts || ['win_rate']) {
    try { resultSets.push(await fetchLeaderboard(cfg, sort)); }
    catch (err) { errors.push(String(err)); }
  }

  if (!resultSets.length) {
    if (previous) {
      const stale = { ...previous, generatedAt: new Date().toISOString(), runStatus: 'STALE_SOURCE_ERROR', sourceErrors: errors, reusedPreviousState: true };
      await fs.writeFile(STATE_PATH, JSON.stringify(stale, null, 2) + '\n');
      console.log('WHALES DISCOVERY stale fallback', errors.join(' | '));
      return;
    }
    throw new Error(`All WHALES Discovery sources failed: ${errors.join(' | ')}`);
  }

  const merged = mergeLeaderboards(resultSets);
  const wallets = merged.map((w) => {
    const scored = scoreWallet(w, cfg);
    const tier = tierFor(w, scored, cfg);
    return {
      wallet: w.wallet,
      tier,
      alphaScore: scored.score,
      scoreBreakdown: scored.breakdown,
      winRate: scored.normalized.winRate,
      roi: scored.normalized.roi,
      netPnlSol: scored.normalized.pnlSol,
      tokensTraded: scored.normalized.tokensTraded,
      wins: Number(w.wins || 0),
      losses: Number(w.losses || 0),
      totalSolBought: Number(w.total_sol_bought || 0),
      totalSolSold: Number(w.total_sol_sold || 0),
      lastSeen: w.last_seen || null,
      ageDays: scored.normalized.ageDays,
      ranks: w.ranks,
      leaderboardAppearances: w.appearances,
      source: 'MADEONSOL_ALPHA_FIRST20_BUYERS_30D',
      surveillanceOnly: true
    };
  }).sort((a, b) => b.alphaScore - a.alphaScore || b.netPnlSol - a.netPnlSol);

  const tierA = wallets.filter((w) => w.tier === 'TIER_A');
  const tierB = wallets.filter((w) => w.tier === 'TIER_B');
  const watch = wallets.filter((w) => w.tier === 'WATCH');
  const promoted = (cfg.promotion.autoPromoteTierA ? tierA : []).slice(0, Number(cfg.promotion.maxPromotedWallets || 10));

  const promotedOut = {
    schemaVersion: '1.0',
    module: 'whalesPromotedWallets',
    generatedAt: new Date().toISOString(),
    policy: cfg.promotion,
    wallets: promoted.map((w, idx) => ({
      label: `SOL-DISC-${String(idx + 1).padStart(2, '0')}`,
      name: `DISCOVERY-${w.wallet.slice(0, 6)}`,
      address: w.wallet,
      tier: 'A',
      discoveryTier: w.tier,
      alphaScore: w.alphaScore,
      winRate: w.winRate,
      roi: w.roi,
      netPnlSol: w.netPnlSol,
      tokensTraded: w.tokensTraded,
      lastSeen: w.lastSeen,
      source: w.source,
      fixed: false,
      autoPromoted: true,
      doNotAutoTrade: true
    }))
  };

  const out = {
    schemaVersion: '1.0',
    module: 'whalesDiscovery',
    version: cfg.version,
    generatedAt: new Date().toISOString(),
    runStatus: errors.length ? 'PARTIAL' : 'PASS',
    source: {
      provider: cfg.source.provider,
      endpoint: '/api/v1/alpha/leaderboard',
      period: cfg.source.period,
      minTokens: cfg.source.minTokens,
      excludeBots: cfg.source.excludeBots,
      sortsRequested: cfg.source.sorts,
      sortsSucceeded: resultSets.map((x) => x.sort),
      sourceErrors: errors,
      interpretation: 'Wallets come from a first-20-buyer alpha dataset; this is an early-entry universe, not a generic rich-wallet leaderboard.'
    },
    methodology: {
      purpose: 'Find wallets with repeatable positive results as early buyers before later token expansion.',
      scoreMax: 100,
      scoring: cfg.scoring,
      tierRules: cfg.tiers,
      promotionPolicy: cfg.promotion,
      limitations: cfg.importantLimitations
    },
    universe: {
      uniqueWallets: wallets.length,
      tierA: tierA.length,
      tierB: tierB.length,
      watch: watch.length,
      discovered: wallets.filter((w) => w.tier === 'DISCOVERED').length,
      promotedForSurveillance: promoted.length
    },
    topWallets: wallets.slice(0, 50),
    tierA,
    tierB: tierB.slice(0, 30),
    watch: watch.slice(0, 30),
    promotedWallets: promotedOut.wallets,
    explicitDataGaps: [
      'No automatic EVM/Base/Arbitrum discovery in V1; current discovery engine is Solana first-20-buyer focused.',
      'No automatic insider/deployer-link graph yet beyond provider bot filtering.',
      'No guaranteed token-level live trade stream for newly discovered non-KOL wallets using the public demo tier.',
      'Historical alpha score is a surveillance ranking, not a BUY signal.'
    ]
  };

  await fs.writeFile(STATE_PATH, JSON.stringify(out, null, 2) + '\n');
  await fs.writeFile(PROMOTED_PATH, JSON.stringify(promotedOut, null, 2) + '\n');
  console.log('WHALES DISCOVERY', out.generatedAt, out.runStatus, 'wallets=', wallets.length, 'tierA=', tierA.length, 'promoted=', promoted.length);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
