import fs from 'node:fs/promises';

const CONFIG_PATH = 'config/whales-multichain.json';
const OUTPUT_PATH = 'data/solana-fixed-kol-feed-state.json';
const API_BASE = 'https://madeonsol.com/api/v1/kol/feed';
// Public demo credential published in MadeOnSol's API docs. It is intentionally not a private secret.
const PUBLIC_DEMO_KEY = 'msk_demo_try_the_solana_api_2026';
const PAGES_PER_RUN = 3; // 18 calls/hour at a 10-minute cadence; public demo limit is 20/hour/IP.
const PAGE_LIMIT = 100;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function readJson(path, fallback = null) {
  try {
    return JSON.parse(await fs.readFile(path, 'utf8'));
  } catch {
    return fallback;
  }
}

async function fetchPage(before = null) {
  const url = new URL(API_BASE);
  url.searchParams.set('limit', String(PAGE_LIMIT));
  if (before) url.searchParams.set('before', before);

  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${PUBLIC_DEMO_KEY}` },
    signal: AbortSignal.timeout(15000)
  });
  if (!response.ok) throw new Error(`MadeOnSol HTTP ${response.status}`);
  return response.json();
}

function tradeTimeMs(row) {
  const t = Date.parse(row?.traded_at || row?.block_time_iso || '');
  return Number.isFinite(t) ? t : null;
}

function normalizeTrade(row, walletMeta) {
  return {
    walletLabel: walletMeta.label,
    walletName: walletMeta.name || walletMeta.label,
    wallet: row.wallet_address,
    tier: walletMeta.tier || null,
    strategy: walletMeta.strategy || row.strategy_tag || null,
    action: String(row.action || '').toUpperCase(),
    tokenMint: row.token_mint || null,
    tokenName: row.token_name || null,
    tokenSymbol: row.token_symbol || null,
    solAmount: Number(row.sol_amount ?? 0),
    tokenAmount: Number(row.token_amount ?? 0),
    marketCapUsdAtTrade: row.market_cap_usd_at_trade == null ? null : Number(row.market_cap_usd_at_trade),
    priceUsdAtTrade: row.price_usd_at_trade == null ? null : Number(row.price_usd_at_trade),
    txSignature: row.tx_signature || null,
    tradedAt: row.traded_at || row.block_time_iso || null,
    source: 'MADEONSOL_KOL_FEED'
  };
}

function uniqueKey(row) {
  return `${row.txSignature || 'no-tx'}:${row.wallet}:${row.action}:${row.tokenMint || row.tokenSymbol || 'unknown'}`;
}

function buildWalletSummary(wallets, trades) {
  return wallets.map((w) => {
    const rows = trades.filter((t) => t.wallet === w.address);
    const buys = rows.filter((t) => t.action === 'BUY');
    const sells = rows.filter((t) => t.action === 'SELL');
    return {
      label: w.label,
      name: w.name || w.label,
      address: w.address,
      tier: w.tier || null,
      strategy: w.strategy || null,
      tradeCount: rows.length,
      buyCount: buys.length,
      sellCount: sells.length,
      buySol: Number(buys.reduce((s, x) => s + (Number.isFinite(x.solAmount) ? x.solAmount : 0), 0).toFixed(6)),
      sellSol: Number(sells.reduce((s, x) => s + (Number.isFinite(x.solAmount) ? x.solAmount : 0), 0).toFixed(6)),
      latestTradeAt: rows.map((x) => x.tradedAt).filter(Boolean).sort().at(-1) || null
    };
  });
}

function buildConvergence(trades) {
  const groups = new Map();
  for (const t of trades) {
    if (t.action !== 'BUY' || !t.tokenMint) continue;
    if (!groups.has(t.tokenMint)) {
      groups.set(t.tokenMint, {
        tokenMint: t.tokenMint,
        tokenSymbol: t.tokenSymbol || null,
        tokenName: t.tokenName || null,
        wallets: new Set(),
        buySol: 0,
        buys: []
      });
    }
    const g = groups.get(t.tokenMint);
    g.wallets.add(t.walletLabel);
    g.buySol += Number.isFinite(t.solAmount) ? t.solAmount : 0;
    g.buys.push({
      walletLabel: t.walletLabel,
      walletName: t.walletName,
      solAmount: t.solAmount,
      marketCapUsdAtTrade: t.marketCapUsdAtTrade,
      tradedAt: t.tradedAt,
      txSignature: t.txSignature
    });
  }

  return [...groups.values()]
    .map((g) => ({
      tokenMint: g.tokenMint,
      tokenSymbol: g.tokenSymbol,
      tokenName: g.tokenName,
      walletCount: g.wallets.size,
      wallets: [...g.wallets],
      totalBuySol: Number(g.buySol.toFixed(6)),
      convergence: g.wallets.size >= 2,
      buys: g.buys
    }))
    .sort((a, b) => Number(b.convergence) - Number(a.convergence) || b.walletCount - a.walletCount || b.totalBuySol - a.totalBuySol);
}

async function main() {
  const config = await readJson(CONFIG_PATH);
  if (!config) throw new Error('Missing WHALES multichain config');
  const wallets = (config.solanaWallets || []).filter((w) => w.fixed !== false && w.address);
  const walletByAddress = new Map(wallets.map((w) => [w.address, w]));
  const previous = await readJson(OUTPUT_PATH, { trades: [] });
  const cutoff = Date.now() - Number(config.lookbackMinutes || 180) * 60_000;

  const fetched = [];
  const errors = [];
  let before = null;
  let pagesFetched = 0;

  for (let page = 0; page < PAGES_PER_RUN; page++) {
    try {
      const payload = await fetchPage(before);
      pagesFetched++;
      const rows = Array.isArray(payload?.trades) ? payload.trades : [];
      fetched.push(...rows);
      const next = payload?.next_before || rows.at(-1)?.traded_at || null;
      if (!next || !rows.length) break;
      before = next;
      await sleep(150);
    } catch (err) {
      errors.push(String(err));
      break;
    }
  }

  const matched = fetched
    .filter((row) => walletByAddress.has(row.wallet_address))
    .map((row) => normalizeTrade(row, walletByAddress.get(row.wallet_address)))
    .filter((row) => {
      const t = tradeTimeMs(row);
      return t !== null && t >= cutoff;
    });

  const merged = new Map();
  for (const row of [...(previous?.trades || []), ...matched]) {
    const t = tradeTimeMs(row);
    if (t === null || t < cutoff) continue;
    merged.set(uniqueKey(row), row);
  }
  const trades = [...merged.values()].sort((a, b) => (tradeTimeMs(b) || 0) - (tradeTimeMs(a) || 0));
  const convergence = buildConvergence(trades);

  const out = {
    schemaVersion: '1.0',
    module: 'solanaFixedKolFeed',
    generatedAt: new Date().toISOString(),
    lookbackMinutes: Number(config.lookbackMinutes || 180),
    source: {
      provider: 'MadeOnSol public KOL feed',
      endpoint: '/api/v1/kol/feed',
      pagesRequested: PAGES_PER_RUN,
      pagesFetched,
      rowsFetched: fetched.length,
      status: errors.length ? (pagesFetched ? 'PARTIAL' : 'ERROR') : 'PASS',
      errors
    },
    watchedWalletCount: wallets.length,
    watchedWallets: wallets.map((w) => ({ label: w.label, name: w.name || w.label, address: w.address, tier: w.tier || null, strategy: w.strategy || null })),
    matchedFreshRowsThisRun: matched.length,
    tradeCountInWindow: trades.length,
    walletSummary: buildWalletSummary(wallets, trades),
    trades,
    convergence,
    actionableConvergence: convergence.filter((x) => x.convergence),
    lowMarketCapBuys: trades.filter((t) => t.action === 'BUY' && Number.isFinite(t.marketCapUsdAtTrade) && t.marketCapUsdAtTrade > 0 && t.marketCapUsdAtTrade <= 100000),
    interpretation: 'MadeOnSol rows are confirmed KOL buy/sell classifications. Raw Solana RPC TOKEN_FLOW rows remain contextual only and must not be relabeled as buys without trade-level confirmation.'
  };

  await fs.writeFile(OUTPUT_PATH, JSON.stringify(out, null, 2) + '\n');
  console.log('SOLANA FIXED KOL FEED', out.generatedAt, out.source.status, 'wallets=', wallets.length, 'trades=', trades.length, 'convergence=', out.actionableConvergence.length);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
