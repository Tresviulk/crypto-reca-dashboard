import fs from 'node:fs/promises';

const CONFIG_PATH = 'config/whales-multichain.json';
const STATE_PATH = 'data/whales-multichain-state.json';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function readJson(path, fallback = null) {
  try { return JSON.parse(await fs.readFile(path, 'utf8')); } catch { return fallback; }
}

function uniq(arr) { return [...new Set(arr.filter(Boolean))]; }

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
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': 'crypto-reca-whales-solana/1.0' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (!r.ok) throw new Error(`HTTP_${r.status}`);
  const j = await r.json();
  if (j?.error) throw new Error(`${method}:${JSON.stringify(j.error)}`);
  return j?.result;
}

async function rpcFailover(urls, method, params, stats) {
  let last = null;
  for (let i = 0; i < urls.length; i++) {
    const url = urls[i];
    const row = stats[url] ||= { calls: 0, successes: 0, failures: 0, recoveredFallbacks: 0, lastError: null };
    for (let attempt = 0; attempt < 2; attempt++) {
      row.calls++;
      try {
        const result = await rpcOnce(url, method, params);
        row.successes++;
        if (i > 0) row.recoveredFallbacks++;
        return { result, provider: url, usedFallback: i > 0 };
      } catch (err) {
        last = err;
        row.failures++;
        row.lastError = String(err?.message || err);
        const backoff = 180 * (attempt + 1) * (i + 1);
        await sleep(backoff);
      }
    }
  }
  throw last || new Error(`${method}: all Solana RPC providers failed`);
}

async function scanSolanaResilient(cfg, wallets, lookbackMinutes) {
  const urls = providerPool(cfg);
  const stats = {};
  const cutoff = Math.floor(Date.now() / 1000) - Number(lookbackMinutes || 180) * 60;
  const signatureLimit = Number(cfg?.signatureLimit || 25);
  const signals = [];
  const perWallet = [];
  let failedWallets = 0;
  let txFailures = 0;
  let fallbackRecoveries = 0;

  for (const wallet of wallets) {
    let walletStatus = 'PASS';
    let signatureProvider = null;
    let signaturesSeen = 0;
    let txFetched = 0;
    let walletTxFailures = 0;
    try {
      const sigRes = await rpcFailover(urls, 'getSignaturesForAddress', [wallet.address, { limit: signatureLimit, commitment: 'confirmed' }], stats);
      signatureProvider = sigRes.provider;
      if (sigRes.usedFallback) fallbackRecoveries++;
      const sigs = Array.isArray(sigRes.result) ? sigRes.result : [];
      signaturesSeen = sigs.length;
      for (const s of sigs) {
        if (!s?.blockTime || s.blockTime < cutoff || s.err) continue;
        try {
          const txRes = await rpcFailover(urls, 'getTransaction', [s.signature, { encoding: 'jsonParsed', commitment: 'confirmed', maxSupportedTransactionVersion: 0 }], stats);
          if (txRes.usedFallback) fallbackRecoveries++;
          const tx = txRes.result;
          txFetched++;
          if (!tx?.meta) continue;
          const deltas = new Map();
          for (const row of tx.meta.preTokenBalances || []) {
            if (row.owner !== wallet.address) continue;
            deltas.set(row.mint, -(Number(row.uiTokenAmount?.uiAmountString || 0)));
          }
          for (const row of tx.meta.postTokenBalances || []) {
            if (row.owner !== wallet.address) continue;
            deltas.set(row.mint, (deltas.get(row.mint) || 0) + Number(row.uiTokenAmount?.uiAmountString || 0));
          }
          const tokenFlows = [...deltas.entries()]
            .filter(([, v]) => Number.isFinite(v) && Math.abs(v) > 0)
            .map(([mint, delta]) => ({ mint, delta }));
          if (!tokenFlows.length) continue;
          signals.push({
            chain: 'solana', walletLabel: wallet.label, wallet: wallet.address,
            classification: 'TOKEN_FLOW', signature: s.signature, blockTime: s.blockTime, tokenFlows,
            rpcProvider: txRes.provider
          });
        } catch (err) {
          walletTxFailures++;
          txFailures++;
          walletStatus = 'PARTIAL';
        }
        await sleep(Number(cfg?.interTransactionDelayMs || 90));
      }
    } catch (err) {
      failedWallets++;
      walletStatus = 'ERROR';
    }
    perWallet.push({
      label: wallet.label, address: wallet.address, status: walletStatus,
      signatureProvider, signaturesSeen, txFetched, txFailures: walletTxFailures
    });
    await sleep(Number(cfg?.interWalletDelayMs || 220));
  }

  const dedup = new Map();
  for (const s of signals) dedup.set(`${s.wallet}:${s.signature}`, s);
  const outSignals = [...dedup.values()].sort((a, b) => Number(b.blockTime || 0) - Number(a.blockTime || 0));
  const status = failedWallets === wallets.length ? 'ERROR' : (failedWallets || txFailures) ? 'PARTIAL' : 'PASS';
  return {
    status,
    mode: 'RESILIENT_PUBLIC_RPC_FAILOVER',
    rpcUrl: urls[0] || null,
    rpcProviders: urls,
    providerStats: stats,
    walletCount: wallets.length,
    failed: failedWallets,
    txFailures,
    fallbackRecoveries,
    perWallet,
    signals: outSignals,
    interpretation: 'Provider-level failures are retried and failed over. A wallet is only marked failed when its signature query fails across all providers; individual transaction failures are exposed separately.'
  };
}

async function main() {
  const config = await readJson(CONFIG_PATH);
  const state = await readJson(STATE_PATH);
  if (!config || !state) throw new Error('Missing multichain config/state');
  const wallets = config.solanaWallets || [];
  const sol = await scanSolanaResilient(config.chains.solana || {}, wallets, config.lookbackMinutes || 180);
  state.chains = state.chains || {};
  state.chains.solana = sol;
  state.architecture = state.architecture || {};
  state.architecture.trackedSolanaWallets = wallets.length;
  state.architecture.chains = state.architecture.chains || {};
  state.architecture.chains.solana = sol.status;
  state.architecture.importantLimitation = 'Solana uses an independent fixed cohort. RPC requests use multi-provider failover/retry; raw TOKEN_FLOW remains contextual until trade-level confirmation.';

  const corePass = ['ethereum', 'base', 'arbitrum', 'hyperliquid'].every((c) => state.architecture.chains?.[c] === 'PASS');
  if (!wallets.length) state.overallStatus = corePass ? 'PARTIAL_SOLANA_WALLETS_REQUIRED' : 'PARTIAL';
  else if (sol.status === 'PASS' && corePass) state.overallStatus = 'PASS';
  else if (sol.status === 'PARTIAL' && corePass) state.overallStatus = 'PARTIAL_SOLANA_RPC';
  else if (sol.status === 'ERROR' && corePass) state.overallStatus = 'PARTIAL_SOLANA_RPC_ERROR';
  else state.overallStatus = 'PARTIAL';

  state.generatedAt = new Date().toISOString();
  state.resilience = {
    solanaRpcFailoverEnabled: true,
    providersConfigured: sol.rpcProviders.length,
    fallbackRecoveries: sol.fallbackRecoveries,
    failedWallets: sol.failed,
    txFailures: sol.txFailures
  };
  await fs.writeFile(STATE_PATH, JSON.stringify(state, null, 2) + '\n');
  console.log('SOLANA RESILIENT RESCAN', state.generatedAt, sol.status, 'providers=', sol.rpcProviders.length, 'fallbackRecoveries=', sol.fallbackRecoveries, 'failedWallets=', sol.failed, 'txFailures=', sol.txFailures);
}

main().catch((err) => { console.error(err); process.exit(1); });
