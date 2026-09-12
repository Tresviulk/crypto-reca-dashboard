import fs from 'node:fs/promises';

const PROMOTED_PATH = 'data/whales-promoted-wallets.json';
const OUT_PATH = 'data/whales-promoted-live-state.json';
const RPC_URL = 'https://api.mainnet-beta.solana.com';
const LOOKBACK_MINUTES = 180;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function readJson(path, fallback = null) {
  try { return JSON.parse(await fs.readFile(path, 'utf8')); } catch { return fallback; }
}

async function rpc(method, params = []) {
  const response = await fetch(RPC_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(15000)
  });
  if (!response.ok) throw new Error(`${method} HTTP ${response.status}`);
  const json = await response.json();
  if (json?.error) throw new Error(`${method}: ${JSON.stringify(json.error)}`);
  return json?.result;
}

function tokenFlowsForWallet(tx, wallet) {
  const pre = tx?.meta?.preTokenBalances || [];
  const post = tx?.meta?.postTokenBalances || [];
  const map = new Map();
  for (const row of pre) {
    if (row.owner !== wallet) continue;
    map.set(row.mint, -(Number(row.uiTokenAmount?.uiAmountString || 0)));
  }
  for (const row of post) {
    if (row.owner !== wallet) continue;
    map.set(row.mint, (map.get(row.mint) || 0) + Number(row.uiTokenAmount?.uiAmountString || 0));
  }
  return [...map.entries()]
    .filter(([, delta]) => Number.isFinite(delta) && Math.abs(delta) > 0)
    .map(([mint, delta]) => ({ mint, delta }));
}

async function main() {
  const promoted = await readJson(PROMOTED_PATH, { wallets: [] });
  const wallets = promoted?.wallets || [];
  const cutoff = Math.floor(Date.now() / 1000) - LOOKBACK_MINUTES * 60;
  const walletSummary = [];
  const flows = [];
  let failedWallets = 0;

  for (const w of wallets) {
    let failed = false;
    let signaturesSeen = 0;
    let flowsFound = 0;
    let latestBlockTime = null;
    try {
      const sigs = await rpc('getSignaturesForAddress', [w.address, { limit: 40, commitment: 'confirmed' }]);
      const recent = (sigs || []).filter((s) => !s.err && s.blockTime && s.blockTime >= cutoff);
      signaturesSeen = recent.length;
      for (const s of recent.slice(0, 20)) {
        try {
          const tx = await rpc('getTransaction', [s.signature, { encoding: 'jsonParsed', commitment: 'confirmed', maxSupportedTransactionVersion: 0 }]);
          const tokenFlows = tokenFlowsForWallet(tx, w.address);
          if (!tokenFlows.length) continue;
          flowsFound++;
          latestBlockTime = Math.max(latestBlockTime || 0, Number(s.blockTime || 0));
          flows.push({
            walletLabel: w.label,
            wallet: w.address,
            alphaScore: w.alphaScore,
            discoveryTier: w.discoveryTier,
            classification: 'TOKEN_FLOW_CONTEXT_ONLY',
            signature: s.signature,
            blockTime: s.blockTime,
            time: new Date(Number(s.blockTime) * 1000).toISOString(),
            tokenFlows
          });
        } catch {}
        await sleep(90);
      }
    } catch (err) {
      failed = true;
      failedWallets++;
    }
    walletSummary.push({
      label: w.label,
      address: w.address,
      alphaScore: w.alphaScore,
      discoveryTier: w.discoveryTier,
      signaturesSeen,
      tokenFlowTransactions: flowsFound,
      latestFlowAt: latestBlockTime ? new Date(latestBlockTime * 1000).toISOString() : null,
      status: failed ? 'PARTIAL' : 'PASS'
    });
    await sleep(150);
  }

  flows.sort((a, b) => Number(b.blockTime || 0) - Number(a.blockTime || 0));
  const status = wallets.length === 0 ? 'PASS_NO_PROMOTED_WALLETS' : failedWallets === wallets.length ? 'ERROR' : failedWallets ? 'PARTIAL' : 'PASS';
  const out = {
    schemaVersion: '1.0',
    module: 'whalesPromotedSolanaMonitor',
    generatedAt: new Date().toISOString(),
    status,
    rpcUrl: RPC_URL,
    lookbackMinutes: LOOKBACK_MINUTES,
    promotedWalletCount: wallets.length,
    failedWallets,
    walletSummary,
    flows,
    interpretation: 'Live RPC surveillance of auto-promoted Discovery wallets. TOKEN_FLOW_CONTEXT_ONLY is not a confirmed BUY/SELL and must never be relabeled without trade-level evidence.'
  };
  await fs.writeFile(OUT_PATH, JSON.stringify(out, null, 2) + '\n');
  console.log('PROMOTED SOLANA LIVE', out.generatedAt, status, 'wallets=', wallets.length, 'flows=', flows.length);
}

main().catch((err) => { console.error(err); process.exit(1); });
