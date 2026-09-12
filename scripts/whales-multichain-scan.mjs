import fs from 'node:fs/promises';

const CONFIG_PATH = 'config/whales-multichain.json';
const OUTPUT_PATH = 'data/whales-multichain-state.json';
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const QUOTES = new Set(['ETH','WETH','USDC','USDT','DAI','USDBC','USDE','PYUSD','RLUSD']);
const metaCache = new Map();

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const norm = (x) => String(x || '').toLowerCase();
const upper = (x) => String(x || '').trim().toUpperCase();
const hexNum = (x) => Number(BigInt(x || '0x0'));

function addressTopic(address) {
  return '0x' + norm(address).replace(/^0x/, '').padStart(64, '0');
}

function topicAddress(topic) {
  if (!topic || topic.length < 42) return null;
  return '0x' + topic.slice(-40).toLowerCase();
}

function formatUnits(hexValue, decimals) {
  try {
    const raw = BigInt(hexValue || '0x0');
    const d = BigInt(decimals);
    const base = 10n ** d;
    const whole = raw / base;
    const frac = raw % base;
    if (!frac) return Number(whole);
    const f = frac.toString().padStart(decimals, '0').replace(/0+$/, '');
    return Number(`${whole}.${f}`);
  } catch {
    return null;
  }
}

async function httpJson(url, options = {}, timeoutMs = 15000) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new Error(`HTTP ${response.status} ${url}`);
  return response.json();
}

async function rpc(url, method, params = []) {
  const json = await httpJson(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })
  });
  if (json?.error) throw new Error(`${method}: ${JSON.stringify(json.error)}`);
  return json?.result;
}

function decodeAbiString(hex) {
  try {
    if (!hex || hex === '0x') return null;
    const clean = hex.slice(2);
    if (clean.length === 64) {
      const bytes = [];
      for (let i = 0; i < clean.length; i += 2) {
        const b = parseInt(clean.slice(i, i + 2), 16);
        if (b) bytes.push(b);
      }
      return new TextDecoder().decode(new Uint8Array(bytes)).trim() || null;
    }
    if (clean.length >= 128) {
      const len = parseInt(clean.slice(64, 128), 16);
      const data = clean.slice(128, 128 + len * 2);
      const bytes = [];
      for (let i = 0; i < data.length; i += 2) bytes.push(parseInt(data.slice(i, i + 2), 16));
      return new TextDecoder().decode(new Uint8Array(bytes)).trim() || null;
    }
  } catch {}
  return null;
}

async function tokenMeta(chain, rpcUrl, contract) {
  const key = `${chain}:${norm(contract)}`;
  if (metaCache.has(key)) return metaCache.get(key);
  let symbol = norm(contract).slice(0, 10);
  let decimals = 18;
  try {
    const [s, d] = await Promise.all([
      rpc(rpcUrl, 'eth_call', [{ to: contract, data: '0x95d89b41' }, 'latest']),
      rpc(rpcUrl, 'eth_call', [{ to: contract, data: '0x313ce567' }, 'latest'])
    ]);
    symbol = upper(decodeAbiString(s) || symbol);
    const parsed = d && d !== '0x' ? Number(BigInt(d)) : 18;
    if (Number.isFinite(parsed) && parsed >= 0 && parsed <= 36) decimals = parsed;
  } catch {}
  const out = { symbol, decimals };
  metaCache.set(key, out);
  return out;
}

function firstNonQuote(flows) {
  return flows.find(x => x?.asset && !QUOTES.has(upper(x.asset))) || null;
}
function firstQuote(flows) {
  return flows.find(x => x?.asset && QUOTES.has(upper(x.asset))) || null;
}

async function reconstructEvmTx(chain, rpcUrl, wallet, txHash) {
  const walletAddr = norm(wallet.address);
  const [tx, receipt] = await Promise.all([
    rpc(rpcUrl, 'eth_getTransactionByHash', [txHash]),
    rpc(rpcUrl, 'eth_getTransactionReceipt', [txHash])
  ]);
  if (!tx || !receipt) return null;

  const incoming = [];
  const outgoing = [];

  if (norm(tx.from) === walletAddr && BigInt(tx.value || '0x0') > 0n) {
    outgoing.push({ asset: 'ETH', value: Number(BigInt(tx.value)) / 1e18, contract: null });
  }

  for (const log of receipt.logs || []) {
    if (norm(log.topics?.[0]) !== TRANSFER_TOPIC || (log.topics || []).length < 3) continue;
    if (!log.data || log.data === '0x') continue; // skip ERC-721 style Transfer
    const from = topicAddress(log.topics[1]);
    const to = topicAddress(log.topics[2]);
    if (from !== walletAddr && to !== walletAddr) continue;
    const meta = await tokenMeta(chain, rpcUrl, log.address);
    const value = formatUnits(log.data, meta.decimals);
    if (!Number.isFinite(value)) continue;
    const flow = { asset: meta.symbol, value, contract: norm(log.address) };
    if (to === walletAddr) incoming.push(flow);
    if (from === walletAddr) outgoing.push(flow);
  }

  const receivedToken = firstNonQuote(incoming);
  const spentQuote = firstQuote(outgoing);
  const sentToken = firstNonQuote(outgoing);
  const receivedQuote = firstQuote(incoming);

  let classification = 'TRANSFER_ACTIVITY';
  let spent = null;
  let received = null;
  if (receivedToken && spentQuote) {
    classification = 'BUY';
    spent = spentQuote;
    received = receivedToken;
  } else if (sentToken && receivedQuote) {
    classification = 'SELL';
    spent = sentToken;
    received = receivedQuote;
  }

  return {
    chain,
    walletLabel: wallet.label,
    wallet: walletAddr,
    txHash,
    blockNumber: hexNum(receipt.blockNumber),
    classification,
    spent,
    received,
    incoming,
    outgoing
  };
}

async function scanEvm(chain, cfg, wallets) {
  const rpcUrl = cfg.rpcUrl;
  const latestHex = await rpc(rpcUrl, 'eth_blockNumber', []);
  const latest = hexNum(latestHex);
  const from = Math.max(0, latest - Number(cfg.lookbackBlocks || 3000));
  const fromHex = '0x' + from.toString(16);
  const toHex = 'latest';
  const pairs = [];
  const seenPairs = new Set();

  for (const wallet of wallets) {
    const wt = addressTopic(wallet.address);
    for (const topics of [[TRANSFER_TOPIC, wt], [TRANSFER_TOPIC, null, wt]]) {
      try {
        const logs = await rpc(rpcUrl, 'eth_getLogs', [{ fromBlock: fromHex, toBlock: toHex, topics }]);
        for (const log of logs || []) {
          const key = `${wallet.label}:${log.transactionHash}`;
          if (seenPairs.has(key)) continue;
          seenPairs.add(key);
          pairs.push({ wallet, txHash: log.transactionHash, block: hexNum(log.blockNumber) });
        }
      } catch (e) {
        // Public RPCs can rate-limit individual log queries. Continue and expose partial quality.
      }
      await sleep(30);
    }
  }

  pairs.sort((a, b) => b.block - a.block);
  const limited = pairs.slice(0, Number(cfg.maxTransactions || 40));
  const signals = [];
  let failed = 0;
  for (const p of limited) {
    try {
      const s = await reconstructEvmTx(chain, rpcUrl, p.wallet, p.txHash);
      if (s) signals.push(s);
    } catch {
      failed++;
    }
    await sleep(35);
  }

  return {
    status: failed && !signals.length ? 'PARTIAL' : 'PASS',
    rpcUrl,
    latestBlock: latest,
    fromBlock: from,
    candidateTransactions: pairs.length,
    reconstructed: signals.length,
    failed,
    signals
  };
}

async function scanHyperliquid(cfg, wallets, lookbackMinutes) {
  const cutoff = Date.now() - lookbackMinutes * 60_000;
  const fills = [];
  let failedWallets = 0;
  for (const wallet of wallets) {
    try {
      const rows = await httpJson(cfg.infoUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'userFills', user: wallet.address, aggregateByTime: true })
      });
      for (const f of Array.isArray(rows) ? rows : []) {
        const time = Number(f.time || 0);
        if (!time || time < cutoff) continue;
        const dir = String(f.dir || '');
        let classification = 'POSITION_ADJUSTMENT';
        if (/open long/i.test(dir) || /spot.*buy/i.test(dir)) classification = 'BUY';
        else if (/open short/i.test(dir) || /spot.*sell/i.test(dir)) classification = 'SELL';
        fills.push({
          chain: 'hyperliquid',
          walletLabel: wallet.label,
          wallet: norm(wallet.address),
          classification,
          asset: upper(f.coin),
          dir,
          side: f.side || null,
          price: Number(f.px),
          size: Number(f.sz),
          notional: Number(f.px) * Number(f.sz),
          time,
          txHash: f.hash || null,
          tid: f.tid ?? null
        });
      }
    } catch {
      failedWallets++;
    }
    await sleep(40);
  }
  fills.sort((a, b) => b.time - a.time);
  return {
    status: failedWallets === wallets.length ? 'ERROR' : failedWallets ? 'PARTIAL' : 'PASS',
    infoUrl: cfg.infoUrl,
    failedWallets,
    fills
  };
}

async function scanSolana(cfg, wallets, lookbackMinutes) {
  if (!wallets.length) {
    return {
      status: cfg.statusUntilWalletsConfigured || 'NEEDS_WALLET_COHORT',
      rpcUrl: cfg.rpcUrl,
      walletCount: 0,
      signals: [],
      reason: 'No Solana wallet addresses are configured. EVM 0x addresses cannot be converted into Solana public keys.'
    };
  }
  const cutoff = Math.floor(Date.now() / 1000) - lookbackMinutes * 60;
  const signals = [];
  let failed = 0;
  for (const wallet of wallets) {
    try {
      const sigs = await rpc(cfg.rpcUrl, 'getSignaturesForAddress', [wallet.address, { limit: 25, commitment: 'confirmed' }]);
      for (const s of sigs || []) {
        if (!s.blockTime || s.blockTime < cutoff || s.err) continue;
        const tx = await rpc(cfg.rpcUrl, 'getTransaction', [s.signature, { encoding: 'jsonParsed', commitment: 'confirmed', maxSupportedTransactionVersion: 0 }]);
        if (!tx?.meta) continue;
        const pre = tx.meta.preTokenBalances || [];
        const post = tx.meta.postTokenBalances || [];
        const deltas = new Map();
        for (const row of pre) {
          if (row.owner !== wallet.address) continue;
          deltas.set(row.mint, -(Number(row.uiTokenAmount?.uiAmountString || 0)));
        }
        for (const row of post) {
          if (row.owner !== wallet.address) continue;
          deltas.set(row.mint, (deltas.get(row.mint) || 0) + Number(row.uiTokenAmount?.uiAmountString || 0));
        }
        const tokenFlows = [...deltas.entries()].filter(([,v]) => Math.abs(v) > 0).map(([mint,delta]) => ({ mint, delta }));
        if (!tokenFlows.length) continue;
        signals.push({
          chain: 'solana',
          walletLabel: wallet.label,
          wallet: wallet.address,
          classification: 'TOKEN_FLOW',
          signature: s.signature,
          blockTime: s.blockTime,
          tokenFlows
        });
      }
    } catch {
      failed++;
    }
  }
  return { status: failed === wallets.length ? 'ERROR' : failed ? 'PARTIAL' : 'PASS', rpcUrl: cfg.rpcUrl, walletCount: wallets.length, failed, signals };
}

function summarizeConvergence(chainResults, ethState) {
  const byAsset = new Map();
  const add = (asset, walletLabel, chain, classification, ref) => {
    asset = upper(asset);
    if (!asset || classification !== 'BUY') return;
    if (!byAsset.has(asset)) byAsset.set(asset, { asset, wallets: new Set(), chains: new Set(), events: [] });
    const g = byAsset.get(asset);
    g.wallets.add(walletLabel);
    g.chains.add(chain);
    g.events.push(ref);
  };

  for (const b of ethState?.summary?.buys || []) add(b.received_asset, b.wallet_label, 'ethereum', 'BUY', { txHash: b.tx_hash, time: b.received_at || b.event_created_at });
  for (const chain of ['base','arbitrum']) {
    for (const s of chainResults[chain]?.signals || []) add(s.received?.asset, s.walletLabel, chain, s.classification, { txHash: s.txHash, blockNumber: s.blockNumber });
  }
  for (const f of chainResults.hyperliquid?.fills || []) add(f.asset, f.walletLabel, 'hyperliquid', f.classification, { txHash: f.txHash, time: f.time, dir: f.dir });

  return [...byAsset.values()].map(g => ({
    asset: g.asset,
    walletCount: g.wallets.size,
    wallets: [...g.wallets],
    chainCount: g.chains.size,
    chains: [...g.chains],
    convergence: g.wallets.size >= 2,
    events: g.events
  })).sort((a,b) => Number(b.convergence)-Number(a.convergence) || b.walletCount-a.walletCount || b.events.length-a.events.length);
}

async function main() {
  const config = JSON.parse(await fs.readFile(CONFIG_PATH, 'utf8'));
  let ethState = null;
  try { ethState = JSON.parse(await fs.readFile(config.chains.ethereum.sourceFile, 'utf8')); } catch {}

  const results = {};
  results.ethereum = {
    status: ethState?.health?.ok ? 'PASS' : 'DATA_GAP',
    source: config.chains.ethereum.sourceFile,
    health: ethState?.health || null,
    summary: ethState?.summary || null
  };

  for (const chain of ['base','arbitrum']) {
    try {
      results[chain] = await scanEvm(chain, config.chains[chain], config.evmWallets);
    } catch (e) {
      results[chain] = { status: 'ERROR', error: String(e), signals: [] };
    }
  }

  try {
    results.hyperliquid = await scanHyperliquid(config.chains.hyperliquid, config.evmWallets, config.lookbackMinutes);
  } catch (e) {
    results.hyperliquid = { status: 'ERROR', error: String(e), fills: [] };
  }

  try {
    results.solana = await scanSolana(config.chains.solana, config.solanaWallets || [], config.lookbackMinutes);
  } catch (e) {
    results.solana = { status: 'ERROR', error: String(e), signals: [] };
  }

  const convergence = summarizeConvergence(results, ethState);
  const statuses = Object.fromEntries(Object.entries(results).map(([k,v]) => [k, v.status]));
  const fullPass = ['ethereum','base','arbitrum','hyperliquid'].every(c => statuses[c] === 'PASS');

  const out = {
    schemaVersion: '1.0',
    module: 'whalesMultichain',
    version: config.version,
    generatedAt: new Date().toISOString(),
    overallStatus: fullPass ? (statuses.solana === 'PASS' ? 'PASS' : 'PARTIAL_SOLANA_WALLETS_REQUIRED') : 'PARTIAL',
    architecture: {
      trackedEvmWallets: config.evmWallets.length,
      trackedSolanaWallets: (config.solanaWallets || []).length,
      chains: statuses,
      importantLimitation: 'The same 11 EVM wallet addresses are monitored on Ethereum, Base, Arbitrum and Hyperliquid. Solana uses a different address format and requires an independently identified Solana whale cohort.'
    },
    chains: results,
    convergence,
    actionableConvergence: convergence.filter(x => x.convergence)
  };

  await fs.writeFile(OUTPUT_PATH, JSON.stringify(out, null, 2) + '\n');
  console.log('WHALES MULTICHAIN', out.generatedAt, out.overallStatus, statuses, 'convergence=', out.actionableConvergence.length);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
