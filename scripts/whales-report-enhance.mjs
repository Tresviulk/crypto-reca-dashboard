import fs from 'node:fs/promises';

const REPORT = 'data/whales-report.json';
const LIVE = 'data/whales-promoted-live-state.json';
const POSITIONS = 'data/positions-state.json';
const MULTICHAIN = 'data/whales-multichain-state.json';
const DEEP = 'data/whales-deep-state.json';
const CONFIG = 'config/whales-multichain.json';
const FIXED_SOLANA = 'data/solana-fixed-kol-feed-state.json';
const NET_LEDGER = 'data/whales-net-accumulation.json';
const CEX_STATE = 'data/whales-cex-flows.json';
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const CEX_TARGETS = ['coinbase', 'binance', 'kraken', 'kucoin'];
const ZERO = '0x0000000000000000000000000000000000000000';

async function read(path, fallback = null) {
  try { return JSON.parse(await fs.readFile(path, 'utf8')); } catch { return fallback; }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const upper = (x) => String(x || '').trim().toUpperCase();
const norm = (x) => String(x || '').trim().toLowerCase();
const num = (x) => Number.isFinite(Number(x)) ? Number(x) : null;
function ageMinutes(iso) {
  const t = Date.parse(iso || '');
  return Number.isFinite(t) ? Math.max(0, (Date.now() - t) / 60000) : null;
}
function tsMs(x) { const t = Date.parse(x || ''); return Number.isFinite(t) ? t : null; }
function uniq(arr) { return [...new Set(arr.filter(Boolean))]; }
function addressTopic(address) { return '0x' + norm(address).replace(/^0x/, '').padStart(64, '0'); }
function topicAddress(topic) { return topic && topic.length >= 42 ? '0x' + topic.slice(-40).toLowerCase() : null; }
function hexNum(x) { try { return Number(BigInt(x || '0x0')); } catch { return null; } }
function formatUnits(hexValue, decimals) {
  try {
    const raw = BigInt(hexValue || '0x0');
    const base = 10n ** BigInt(decimals);
    const whole = raw / base;
    const frac = raw % base;
    if (!frac) return Number(whole);
    return Number(`${whole}.${frac.toString().padStart(decimals, '0').replace(/0+$/, '')}`);
  } catch { return null; }
}
function decodeAbiString(hex) {
  try {
    if (!hex || hex === '0x') return null;
    const clean = hex.slice(2);
    if (clean.length === 64) {
      const bytes = [];
      for (let i = 0; i < clean.length; i += 2) { const b = parseInt(clean.slice(i, i + 2), 16); if (b) bytes.push(b); }
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

async function fetchJson(url, options = {}, timeoutMs = 12000) {
  const r = await fetch(url, { ...options, signal: AbortSignal.timeout(timeoutMs) });
  if (!r.ok) throw new Error(`HTTP_${r.status}:${url}`);
  return r.json();
}
async function rpcAny(urls, method, params = []) {
  let last = null;
  for (const url of uniq(urls)) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const j = await fetchJson(url, {
          method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': 'crypto-reca-whales-intel/1.0' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })
        });
        if (j?.error) throw new Error(`${method}:${JSON.stringify(j.error)}`);
        return { result: j?.result, provider: url };
      } catch (e) { last = e; await sleep(120 * (attempt + 1)); }
    }
  }
  throw last || new Error(`${method}: all providers failed`);
}
function chainRpcUrls(config, chain) {
  const cfg = config?.chains?.[chain] || {};
  return uniq([...(cfg.rpcUrls || []), cfg.rpcUrl]);
}

function deepDecisionRows(deep) {
  if (!deep || !Array.isArray(deep.results)) return [];
  const rows = [];
  for (const x of deep.results) {
    const asset = x?.candidate?.asset || x?.token?.base || null;
    const status = String(x?.overallWhaleStatus || '').toUpperCase();
    if (!asset || !status) continue;
    if (status === 'KNOWN_WALLET_FLOW_CONVERGENCE') {
      rows.push({ asset, status: 'WHALES_DEEP_CONVERGENCE', reason: '6h/24h/72h token-centric WHALES DEEP found 2+ known watched wallets with positive net flow.', deepStatus: status, dataQuality: x.dataQuality || null });
    } else if (status !== 'NO_KNOWN_WALLET_SIGNAL' && status !== 'UNVERIFIED_TOKEN_FLOW_ACTIVITY' && status !== 'DATA_GAP') {
      rows.push({ asset, status: 'WHALES_DEEP_SIGNAL', reason: 'WHALES DEEP returned a known-wallet signal in the persisted 6h/24h/72h validation.', deepStatus: status, dataQuality: x.dataQuality || null });
    } else if (status === 'UNVERIFIED_TOKEN_FLOW_ACTIVITY') {
      rows.push({ asset, status: 'WHALES_DEEP_CONTEXT', reason: 'Token-centric transfer activity exists but is not verified as a whale buy or accumulation.', deepStatus: status, dataQuality: x.dataQuality || null });
    }
  }
  return rows;
}

function normalizeLedgerEvent(e) {
  if (!e?.wallet || !e?.assetKey || !e?.txRef || !['BUY','SELL'].includes(e.action)) return null;
  const t = tsMs(e.eventTime);
  if (!t) return null;
  const tokenAmount = num(e.tokenAmount) ?? 0;
  const quoteAmount = num(e.quoteAmount) ?? 0;
  const id = [e.chain, e.wallet, e.txRef, e.action, e.assetKey].join(':');
  return { ...e, id, eventTime: new Date(t).toISOString(), tokenDelta: e.action === 'BUY' ? tokenAmount : -tokenAmount, quoteDelta: e.action === 'BUY' ? -quoteAmount : quoteAmount, confirmation: 'CONFIRMED_TRADE_CLASSIFICATION' };
}
function currentLedgerEvents(multichain, fixedSolana) {
  const out = [];
  const summary = multichain?.chains?.ethereum?.summary || {};
  for (const b of summary.buys || []) out.push({ chain:'ethereum', source:'ETHEREUM_WORKER_CONFIRMED', action:'BUY', walletLabel:b.wallet_label, wallet:b.wallet, assetSymbol:upper(b.received_asset), assetKey:norm(b.received_contract || b.received_asset), tokenAmount:num(b.received_value), quoteAsset:upper(b.spent_asset), quoteAmount:num(b.spent_value), txRef:b.tx_hash, eventTime:b.received_at || b.event_created_at || multichain.generatedAt });
  for (const s of summary.sells || []) out.push({ chain:'ethereum', source:'ETHEREUM_WORKER_CONFIRMED', action:'SELL', walletLabel:s.wallet_label, wallet:s.wallet, assetSymbol:upper(s.spent_asset || s.received_asset), assetKey:norm(s.spent_contract || s.received_contract || s.spent_asset || s.received_asset), tokenAmount:num(s.spent_value), quoteAsset:upper(s.received_asset), quoteAmount:num(s.received_value), txRef:s.tx_hash, eventTime:s.received_at || s.event_created_at || multichain.generatedAt });
  for (const chain of ['base','arbitrum']) {
    for (const s of multichain?.chains?.[chain]?.signals || []) {
      const action = upper(s.classification);
      if (!['BUY','SELL'].includes(action)) continue;
      const token = action === 'BUY' ? s.received : s.spent;
      const quote = action === 'BUY' ? s.spent : s.received;
      out.push({ chain, source:'EVM_RPC_RECONSTRUCTED', action, walletLabel:s.walletLabel, wallet:s.wallet, assetSymbol:upper(token?.asset), assetKey:norm(token?.contract || token?.asset), tokenAmount:num(token?.value), quoteAsset:upper(quote?.asset), quoteAmount:num(quote?.value), txRef:s.txHash, eventTime:s.time || multichain.generatedAt });
    }
  }
  for (const t of fixedSolana?.trades || []) {
    const action = upper(t.action);
    if (!['BUY','SELL'].includes(action)) continue;
    out.push({ chain:'solana', source:'MADEONSOL_KOL_CONFIRMED', action, walletLabel:t.walletLabel, wallet:t.wallet, assetSymbol:upper(t.tokenSymbol), assetKey:t.tokenMint || upper(t.tokenSymbol), tokenAmount:num(t.tokenAmount), quoteAsset:'SOL', quoteAmount:num(t.solAmount), txRef:t.txSignature, eventTime:t.tradedAt || fixedSolana.generatedAt, marketCapUsdAtTrade:num(t.marketCapUsdAtTrade), priceUsdAtTrade:num(t.priceUsdAtTrade) });
  }
  return out.map(normalizeLedgerEvent).filter(Boolean);
}
function aggregateLedger(events, cutoffMs) {
  const groups = new Map();
  for (const e of events) {
    if ((tsMs(e.eventTime) || 0) < cutoffMs) continue;
    const key = `${e.chain}:${e.assetKey}`;
    if (!groups.has(key)) groups.set(key, { chain:e.chain, assetKey:e.assetKey, assetSymbol:e.assetSymbol || null, buyCount:0, sellCount:0, tokenBought:0, tokenSold:0, netTokenFlow:0, quoteSpent:0, quoteReceived:0, wallets:new Set(), latestEventAt:null });
    const g = groups.get(key);
    g.wallets.add(e.walletLabel || e.wallet);
    if (e.action === 'BUY') { g.buyCount++; g.tokenBought += Math.abs(e.tokenAmount || 0); g.quoteSpent += Math.abs(e.quoteAmount || 0); }
    else { g.sellCount++; g.tokenSold += Math.abs(e.tokenAmount || 0); g.quoteReceived += Math.abs(e.quoteAmount || 0); }
    g.netTokenFlow += Number(e.tokenDelta || 0);
    if (!g.latestEventAt || e.eventTime > g.latestEventAt) g.latestEventAt = e.eventTime;
  }
  return [...groups.values()].map((g) => ({ ...g, tokenBought:Number(g.tokenBought.toFixed(8)), tokenSold:Number(g.tokenSold.toFixed(8)), netTokenFlow:Number(g.netTokenFlow.toFixed(8)), quoteSpent:Number(g.quoteSpent.toFixed(8)), quoteReceived:Number(g.quoteReceived.toFixed(8)), walletCount:g.wallets.size, wallets:[...g.wallets], direction:g.netTokenFlow > 0 ? 'NET_ACCUMULATION' : g.netTokenFlow < 0 ? 'NET_DISTRIBUTION' : 'FLAT' })).sort((a,b) => b.walletCount-a.walletCount || Math.abs(b.netTokenFlow)-Math.abs(a.netTokenFlow));
}
async function buildNetLedger(multichain, fixedSolana) {
  const prev = await read(NET_LEDGER, { events: [] });
  const cutoff = Date.now() - 30 * 86400_000;
  const merged = new Map();
  for (const e of [...(prev.events || []), ...currentLedgerEvents(multichain, fixedSolana)]) {
    const n = normalizeLedgerEvent(e) || e;
    if (!n?.id || (tsMs(n.eventTime) || 0) < cutoff) continue;
    merged.set(n.id, n);
  }
  const events = [...merged.values()].sort((a,b) => (tsMs(b.eventTime)||0)-(tsMs(a.eventTime)||0));
  const windows = {};
  for (const [name,h] of [['6h',6],['24h',24],['72h',72],['7d',168],['30d',720]]) windows[name] = aggregateLedger(events, Date.now()-h*3600_000);
  const out = { schemaVersion:'1.0', module:'whalesNetAccumulationLedger', generatedAt:new Date().toISOString(), status:'PASS', retentionDays:30, methodology:'Persistent deduplicated ledger of confirmed BUY/SELL classifications only. Raw TOKEN_FLOW is excluded from accumulation math.', sourceStatus:{ ethereum:multichain?.chains?.ethereum?.status || 'MISSING', base:multichain?.chains?.base?.status || 'MISSING', arbitrum:multichain?.chains?.arbitrum?.status || 'MISSING', solanaTradeFeed:fixedSolana?.source?.status || 'MISSING' }, eventCount:events.length, events, windows, top24h:windows['24h'].slice(0,25), top72h:windows['72h'].slice(0,25), top30d:windows['30d'].slice(0,50) };
  await fs.writeFile(NET_LEDGER, JSON.stringify(out,null,2)+'\n');
  return out;
}

async function ethLabelLookup(chainId, address, cache, counters) {
  const key = `${chainId}:${norm(address)}`;
  const cached = cache[key];
  const freshMs = 7 * 86400_000;
  if (cached && tsMs(cached.checkedAt) && Date.now()-tsMs(cached.checkedAt) < freshMs) { counters.cacheHits++; return cached; }
  if (counters.apiCalls >= 120) { counters.capped++; return cached || { address:norm(address), exchange:null, checkedAt:null, status:'LOOKUP_CAP' }; }
  counters.apiCalls++;
  try {
    const url = `https://eth-labels.com/accounts?chainId=${chainId}&address=${encodeURIComponent(address)}&limit=20`;
    const j = await fetchJson(url, { headers:{ accept:'application/json', 'user-agent':'crypto-reca-whales-cex/1.0' } }, 10000);
    const rows = Array.isArray(j) ? j : Array.isArray(j?.data) ? j.data : Array.isArray(j?.accounts) ? j.accounts : Array.isArray(j?.result) ? j.result : [];
    let exchange = null;
    let matched = null;
    for (const row of rows) {
      const text = `${row?.label || ''} ${row?.nameTag || row?.nametag || ''}`.toLowerCase();
      const hit = CEX_TARGETS.find((x) => text.includes(x));
      if (hit) { exchange = hit.toUpperCase(); matched = row; break; }
    }
    const out = { address:norm(address), exchange, label:matched?.label || null, nameTag:matched?.nameTag || matched?.nametag || null, checkedAt:new Date().toISOString(), status:'PASS' };
    cache[key] = out;
    await sleep(25);
    return out;
  } catch (e) {
    counters.apiErrors++;
    return cached || { address:norm(address), exchange:null, checkedAt:null, status:'ERROR', error:String(e?.message || e) };
  }
}
async function tokenMeta(urls, contract, cache) {
  const key = norm(contract);
  if (cache[key]) return cache[key];
  let symbol = key.slice(0,10), decimals = 18;
  try {
    const [s,d] = await Promise.all([
      rpcAny(urls,'eth_call',[{to:contract,data:'0x95d89b41'},'latest']),
      rpcAny(urls,'eth_call',[{to:contract,data:'0x313ce567'},'latest'])
    ]);
    symbol = upper(decodeAbiString(s.result) || symbol);
    const parsed = d.result && d.result !== '0x' ? Number(BigInt(d.result)) : 18;
    if (Number.isFinite(parsed) && parsed >= 0 && parsed <= 36) decimals = parsed;
  } catch {}
  return cache[key] = { symbol, decimals };
}
async function blockTime(urls, blockHex, cache) {
  if (cache[blockHex]) return cache[blockHex];
  try {
    const b = await rpcAny(urls,'eth_getBlockByNumber',[blockHex,false]);
    const t = Number(BigInt(b.result?.timestamp || '0x0')) * 1000;
    return cache[blockHex] = (t ? new Date(t).toISOString() : null);
  } catch { return null; }
}
async function buildCexState(config) {
  const prev = await read(CEX_STATE, { events:[], labelCache:{} });
  const cache = prev.labelCache || {};
  const counters = { apiCalls:0, apiErrors:0, cacheHits:0, capped:0 };
  const events = [];
  const chainHealth = {};
  const meta = {}, blocks = {};
  const chains = [
    ['ethereum',1], ['base',8453], ['arbitrum',42161]
  ];
  for (const [chain,chainId] of chains) {
    const urls = chainRpcUrls(config, chain);
    const cfg = config?.chains?.[chain] || {};
    const health = { status:'PASS', rpcProviders:urls.length, logQueries:0, queryFailures:0, transferLogs:0, cexMatches:0 };
    if (!urls.length) { health.status='ERROR'; health.reason='NO_RPC_PROVIDER'; chainHealth[chain]=health; continue; }
    let latest;
    try { latest = hexNum((await rpcAny(urls,'eth_blockNumber',[])).result); }
    catch (e) { health.status='ERROR'; health.reason=String(e?.message || e); chainHealth[chain]=health; continue; }
    const lookback = Number(cfg.cexLookbackBlocks || cfg.lookbackBlocks || 1800);
    const fromHex = '0x' + Math.max(0,latest-lookback).toString(16);
    for (const wallet of config?.evmWallets || []) {
      const wt = addressTopic(wallet.address);
      for (const direction of ['OUT','IN']) {
        const topics = direction === 'OUT' ? [TRANSFER_TOPIC,wt] : [TRANSFER_TOPIC,null,wt];
        health.logQueries++;
        let logs = [];
        try { logs = (await rpcAny(urls,'eth_getLogs',[{fromBlock:fromHex,toBlock:'latest',topics}])).result || []; }
        catch { health.queryFailures++; health.status='PARTIAL'; continue; }
        health.transferLogs += logs.length;
        for (const log of logs) {
          if (!log.data || log.data === '0x' || (log.topics || []).length < 3) continue;
          const from = topicAddress(log.topics[1]), to = topicAddress(log.topics[2]);
          const counterparty = direction === 'OUT' ? to : from;
          if (!counterparty || counterparty === ZERO || counterparty === norm(wallet.address)) continue;
          const label = await ethLabelLookup(chainId,counterparty,cache,counters);
          if (!label?.exchange) continue;
          const tm = await tokenMeta(urls,log.address,meta);
          const amount = formatUnits(log.data,tm.decimals);
          const time = await blockTime(urls,log.blockNumber,blocks) || new Date().toISOString();
          const flowType = direction === 'OUT' ? 'DEPOSIT_TO_CEX' : 'WITHDRAWAL_FROM_CEX';
          events.push({ id:[chain,wallet.label,log.transactionHash,log.logIndex,flowType].join(':'), chain, chainId, walletLabel:wallet.label, wallet:norm(wallet.address), exchange:label.exchange, exchangeAddress:counterparty, exchangeLabel:label.label, exchangeNameTag:label.nameTag, flowType, asset:tm.symbol, tokenContract:norm(log.address), amount, txHash:log.transactionHash, blockNumber:hexNum(log.blockNumber), eventTime:time, interpretation:direction === 'OUT' ? 'Possible exchange deposit / potential sell-side pressure; not proof of sale.' : 'Possible exchange withdrawal / potential self-custody accumulation; not proof of purchase.' });
          health.cexMatches++;
        }
        await sleep(35);
      }
    }
    chainHealth[chain] = health;
  }
  const cutoff = Date.now()-30*86400_000;
  const merged = new Map();
  for (const e of [...(prev.events || []),...events]) if ((tsMs(e.eventTime)||0) >= cutoff) merged.set(e.id,e);
  const kept = [...merged.values()].sort((a,b)=>(tsMs(b.eventTime)||0)-(tsMs(a.eventTime)||0));
  const anyError = Object.values(chainHealth).some((x)=>x.status !== 'PASS') || counters.apiErrors > 0 || counters.capped > 0;
  const out = { schemaVersion:'1.0', module:'whalesCexFlowLabeler', generatedAt:new Date().toISOString(), status:anyError?'PARTIAL':'PASS', provider:{ name:'eth-labels.com', provenance:'Public Etherscan-derived EVM label dataset', targetExchanges:CEX_TARGETS.map((x)=>x.toUpperCase()) }, coverage:{ ethereum:'ERC20_TRANSFER_FLOWS', base:'ERC20_TRANSFER_FLOWS', arbitrum:'ERC20_TRANSFER_FLOWS', solana:'DATA_GAP', nativeEthTransfers:'DATA_GAP' }, chainHealth, lookupStats:counters, retentionDays:30, labelCache:cache, events:kept, deposits:kept.filter((x)=>x.flowType==='DEPOSIT_TO_CEX'), withdrawals:kept.filter((x)=>x.flowType==='WITHDRAWAL_FROM_CEX'), interpretation:'Exchange labels are attribution evidence, not proof that the asset was sold or bought. Deposits/withdrawals are pressure/context signals only.' };
  await fs.writeFile(CEX_STATE, JSON.stringify(out,null,2)+'\n');
  return out;
}

async function main() {
  const report = await read(REPORT);
  if (!report) throw new Error('Base WHALES report missing');
  const [live, positions, multichain, deep, config, fixedSolana] = await Promise.all([
    read(LIVE,null), read(POSITIONS,null), read(MULTICHAIN,null), read(DEEP,null), read(CONFIG,{}), read(FIXED_SOLANA,{})
  ]);

  let netLedger = null, cexState = null;
  try { netLedger = await buildNetLedger(multichain || {}, fixedSolana || {}); }
  catch (e) { netLedger = { status:'ERROR', generatedAt:new Date().toISOString(), error:String(e?.message || e), windows:{} }; }
  try { cexState = await buildCexState(config || {}); }
  catch (e) { cexState = { status:'ERROR', generatedAt:new Date().toISOString(), error:String(e?.message || e), deposits:[], withdrawals:[], events:[] }; }

  const mandatory = new Set(report?.reportContract?.mandatorySections || []);
  for (const section of ['promotedDiscoveryLive','newWalletDiscovery','deepValidation','largeTransfers','netAccumulation','cexFlows','smartMoneyExternal']) mandatory.add(section);
  report.reportContract.mandatorySections = [...mandatory];
  report.reportContract.rule = 'Always expose every mandatory section. Empty sections must be shown as NONE or DATA_GAP; never silently omit them. Discovery wallets promoted to Tier A must expose live-surveillance state. WHALES DEEP 6h/24h/72h, net accumulation and CEX flows must be persisted and exposed when available. Unsupported claims must remain DATA_GAP.';

  report.promotedDiscoveryLive = live || { status:'DATA_GAP', reason:'Promoted-wallet live monitor has not persisted its first state yet.', promotedWalletCount:report?.promotedDiscoveryWallets?.length || 0, flows:[] };
  report.newWalletDiscovery = { status:report?.discovery?.runStatus || 'DATA_GAP', scope:report?.discovery?.source?.interpretation || 'No persisted Discovery state.', uniqueWallets:report?.discovery?.universe?.uniqueWallets ?? null, tierA:report?.discovery?.universe?.tierA ?? null, tierB:report?.discovery?.universe?.tierB ?? null, watch:report?.discovery?.universe?.watch ?? null, discovered:report?.discovery?.universe?.discovered ?? null, promotedForSurveillance:report?.discovery?.universe?.promotedForSurveillance ?? null, promotedWallets:report?.promotedDiscoveryWallets || [] };

  if (deep) {
    const deepAge = ageMinutes(deep.generatedAt);
    report.deepValidation = { status:deep.runStatus || 'UNKNOWN', generatedAt:deep.generatedAt || null, ageMinutes:deepAge == null ? null : Number(deepAge.toFixed(1)), freshness:deepAge == null ? 'MISSING' : deepAge <= 35 ? 'FRESH' : 'STALE', source:deep?.source?.transport || 'CABAL_WORKER_EMBEDDED_WHALES_DEEP', sourceGeneratedAt:deep?.source?.cabalGeneratedAt || null, ethereumEndpointAvailable:Boolean(multichain?.chains?.ethereum?.health?.deepEndpoint), endpoint:multichain?.chains?.ethereum?.health?.deepEndpoint || '/deep', windowsExpectedHours:deep.windowsExpectedHours || [6,24,72], persistedResultsAvailable:Boolean(deep?.persistence?.persistedResultsAvailable), sourceFreshness:deep?.persistence?.sourceFreshness || null, scan:deep.scan || null, rotation:deep.rotation || null, results:deep.results || [], meaningfulKnownSignals:deep.meaningfulKnownSignals || [], contextualFlowActivity:deep.contextualFlowActivity || [], requestGaps:deep.requestGaps || [], interpretation:deep.interpretation || null };
  } else report.deepValidation = { status:'DATA_GAP', ethereumEndpointAvailable:Boolean(multichain?.chains?.ethereum?.health?.deepEndpoint), endpoint:multichain?.chains?.ethereum?.health?.deepEndpoint || null, windowsExpectedHours:[6,24,72], persistedResultsAvailable:false, reason:'WHALES DEEP persistence has not produced its first state yet.' };

  const rawSolanaFlows = multichain?.chains?.solana?.signals || [];
  const promotedFlows = live?.flows || [];
  report.largeTransfers = { status:rawSolanaFlows.length || promotedFlows.length ? 'CONTEXT_ONLY' : 'NONE_CONFIRMED', confirmedLargeTransfers:[], contextualTokenFlows:[...rawSolanaFlows,...promotedFlows], reason:'Raw token flows can include swaps, transfers, airdrops or dust. They are not promoted to large BUY/SELL transfer signals without transaction-level classification and sizing thresholds.' };

  report.netAccumulation = netLedger?.status === 'PASS' ? {
    status:'PASS', generatedAt:netLedger.generatedAt, eventCount:netLedger.eventCount, retentionDays:netLedger.retentionDays,
    windows:netLedger.windows, top24h:netLedger.top24h, top72h:netLedger.top72h, top30d:netLedger.top30d,
    methodology:netLedger.methodology
  } : { status:'DATA_GAP', assets:[], reason:`Net ledger failed: ${netLedger?.error || 'unknown error'}` };

  report.cexFlows = ['PASS','PARTIAL'].includes(cexState?.status) ? {
    status:cexState.status, generatedAt:cexState.generatedAt, provider:cexState.provider, coverage:cexState.coverage,
    deposits:cexState.deposits || [], withdrawals:cexState.withdrawals || [], chainHealth:cexState.chainHealth || {}, lookupStats:cexState.lookupStats || {}, interpretation:cexState.interpretation
  } : { status:'DATA_GAP', deposits:[], withdrawals:[], reason:`CEX flow labeler failed: ${cexState?.error || 'unknown error'}` };

  report.smartMoneyExternal = { status:'DATA_GAP', signals:[], reason:'WHALES Discovery scores on-chain early buyers, but no independent external smart-money labeling/consensus provider is persisted in the WHALES report yet.' };

  if (report?.executive?.monitoredWallets) {
    const liveCount = live?.promotedWalletCount ?? report.executive.monitoredWallets.autoPromotedDiscovery ?? 0;
    report.executive.monitoredWallets.autoPromotedDiscovery = liveCount;
    report.executive.monitoredWallets.totalSurveillanceUniverse = Number(report.executive.monitoredWallets.fixedEvm || 0)+Number(report.executive.monitoredWallets.fixedSolana || 0)+Number(liveCount || 0);
  }
  report.executive = report.executive || {};
  report.executive.whalesDeep = deep ? { status:deep.runStatus || 'UNKNOWN', requestedCount:deep?.scan?.requestedCount ?? null, okCount:deep?.scan?.okCount ?? null, meaningfulKnownSignalCount:deep?.scan?.meaningfulKnownSignalCount ?? null, contextualFlowCount:deep?.scan?.contextualFlowCount ?? null, rotation:deep?.rotation || null } : { status:'DATA_GAP' };
  report.executive.netAccumulation = netLedger?.status === 'PASS' ? { status:'PASS', eventCount:netLedger.eventCount, assets24h:netLedger?.windows?.['24h']?.length || 0, assets72h:netLedger?.windows?.['72h']?.length || 0 } : { status:'DATA_GAP' };
  report.executive.cexFlows = ['PASS','PARTIAL'].includes(cexState?.status) ? { status:cexState.status, deposits:cexState.deposits?.length || 0, withdrawals:cexState.withdrawals?.length || 0 } : { status:'DATA_GAP' };

  report.health = report.health || {};
  if (multichain) {
    report.health.multichainOverall = multichain.overallStatus || report.health.multichainOverall;
    report.health.chainStatus = multichain?.architecture?.chains || report.health.chainStatus || {};
    report.health.solanaOperationalMeaning = multichain.overallStatus === 'PARTIAL_SOLANA_RPC' ? 'Solana wallets are configured and monitored with provider failover; one or more wallet/transaction calls still failed across the provider pool.' : multichain.overallStatus === 'PARTIAL_SOLANA_WALLETS_REQUIRED' ? 'No Solana cohort is configured.' : multichain.overallStatus === 'PASS' ? 'All enabled multichain monitors passed, including resilient Solana RPC.' : 'See chainStatus and declared data gaps.';
    report.health.solanaResilience = multichain?.resilience || null;
    const row = (report.health.freshness || []).find((x)=>x.module==='multichain');
    if (row) { row.generatedAt=multichain.generatedAt || row.generatedAt; row.ageMinutes=ageMinutes(row.generatedAt)==null?null:Number(ageMinutes(row.generatedAt).toFixed(1)); row.freshness=row.ageMinutes==null?'MISSING':row.ageMinutes<=Number(row.maxMinutes||25)?'FRESH':'STALE'; }
  }
  report.health.promotedDiscoveryLive = live ? { status:live.status, generatedAt:live.generatedAt, ageMinutes:ageMinutes(live.generatedAt)==null?null:Number(ageMinutes(live.generatedAt).toFixed(1)), promotedWalletCount:live.promotedWalletCount, failedWallets:live.failedWallets } : { status:'MISSING' };
  report.health.whalesDeep = deep ? { status:deep.runStatus || 'UNKNOWN', generatedAt:deep.generatedAt || null, ageMinutes:ageMinutes(deep.generatedAt)==null?null:Number(ageMinutes(deep.generatedAt).toFixed(1)), freshness:ageMinutes(deep.generatedAt)==null?'MISSING':ageMinutes(deep.generatedAt)<=35?'FRESH':'STALE', persistedResultsAvailable:Boolean(deep?.persistence?.persistedResultsAvailable) } : { status:'MISSING', freshness:'MISSING', persistedResultsAvailable:false };
  report.health.netAccumulation = { status:netLedger?.status || 'MISSING', generatedAt:netLedger?.generatedAt || null };
  report.health.cexFlowLabeler = { status:cexState?.status || 'MISSING', generatedAt:cexState?.generatedAt || null };
  if (positions) {
    const ts = positions.updatedAt || positions.generatedAt || null;
    const row=(report.health.freshness || []).find((x)=>x.module==='positions');
    if (row) { row.generatedAt=ts; row.ageMinutes=ageMinutes(ts)==null?null:Number(ageMinutes(ts).toFixed(1)); row.freshness=row.ageMinutes==null?'MISSING':row.ageMinutes<=Number(row.maxMinutes||1440)?'FRESH':'STALE'; }
  }

  report.coverage = report.coverage || {};
  report.coverage.whalesDeep = deep?.persistence?.persistedResultsAvailable ? 'PERSISTED_6H_24H_72H_VIA_CABAL_PROTECTED_BRIDGE' : 'DATA_GAP';
  report.coverage.netAccumulation = netLedger?.status === 'PASS' ? 'PERSISTENT_CONFIRMED_TRADE_LEDGER_6H_24H_72H_7D_30D' : 'DATA_GAP';
  report.coverage.cexFlows = ['PASS','PARTIAL'].includes(cexState?.status) ? 'PERSISTENT_EVM_ERC20_CEX_LABELING_ETHEREUM_BASE_ARBITRUM' : 'DATA_GAP';

  const deepRows=deepDecisionRows(deep);
  report.decisionTable=Array.isArray(report.decisionTable)?report.decisionTable:[];
  const existingDeepKeys=new Set(report.decisionTable.filter((x)=>String(x?.status||'').startsWith('WHALES_DEEP')).map((x)=>`${x.status}:${x.asset}`));
  for (const row of deepRows) { const key=`${row.status}:${row.asset}`; if (!existingDeepKeys.has(key)) report.decisionTable.push(row); }
  for (const a of netLedger?.windows?.['24h'] || []) {
    if (a.walletCount >= 2 && a.direction === 'NET_ACCUMULATION') report.decisionTable.push({ asset:a.assetSymbol || a.assetKey, status:'NET_ACCUMULATION_CONVERGENCE', walletCount:a.walletCount, chain:a.chain, reason:'Persistent 24h confirmed-trade ledger shows 2+ monitored wallets with positive net token flow.' });
  }
  for (const e of cexState?.events || []) {
    report.decisionTable.push({ asset:e.asset, status:e.flowType, walletCount:1, chain:e.chain, exchange:e.exchange, reason:e.interpretation, txHash:e.txHash });
  }

  const gaps=new Set(report.dataGaps || []);
  if (!live) gaps.add('PROMOTED_DISCOVERY_LIVE_STATE_NOT_YET_PERSISTED'); else gaps.delete('PROMOTED_DISCOVERY_LIVE_STATE_NOT_YET_PERSISTED');
  if (live?.status==='PARTIAL') gaps.add('PROMOTED_DISCOVERY_SOLANA_RPC_PARTIAL');
  if (live?.status==='ERROR') gaps.add('PROMOTED_DISCOVERY_SOLANA_RPC_ERROR');
  if (multichain?.overallStatus==='PARTIAL_SOLANA_RPC') { gaps.delete('SOLANA_WALLETS_REQUIRED'); gaps.add('SOLANA_RPC_PARTIAL'); } else if (multichain?.overallStatus==='PASS') gaps.delete('SOLANA_RPC_PARTIAL');
  if (deep?.persistence?.persistedResultsAvailable && ['PASS','PARTIAL'].includes(deep?.runStatus)) { gaps.delete('WHALES_DEEP_RESULTS_NOT_PERSISTED'); gaps.delete('WHALES_DEEP_STATE_MISSING'); gaps.delete('WHALES_DEEP_SYNC_ERROR'); }
  else if (!deep) gaps.add('WHALES_DEEP_STATE_MISSING'); else if (deep?.runStatus==='ERROR') gaps.add('WHALES_DEEP_SYNC_ERROR');
  if (deep && ageMinutes(deep.generatedAt)>35) gaps.add('WHALES_DEEP_STATE_STALE'); else gaps.delete('WHALES_DEEP_STATE_STALE');

  if (netLedger?.status==='PASS') gaps.delete('NET_ACCUMULATION_LEDGER_NOT_IMPLEMENTED'); else gaps.add('NET_ACCUMULATION_LEDGER_ERROR');
  if (['PASS','PARTIAL'].includes(cexState?.status)) {
    gaps.delete('CEX_LABELING_NOT_IMPLEMENTED');
    gaps.delete('CEX_DEPOSIT_WITHDRAWAL_LABELING_NOT_IMPLEMENTED');
    gaps.add('CEX_SOLANA_FLOW_LABELING_NOT_IMPLEMENTED');
    gaps.add('CEX_NATIVE_ETH_FLOW_LABELING_NOT_IMPLEMENTED');
    if (cexState.status==='PARTIAL') gaps.add('CEX_EVM_LABELING_PARTIAL'); else gaps.delete('CEX_EVM_LABELING_PARTIAL');
  } else gaps.add('CEX_EVM_LABELING_ERROR');
  gaps.add('EXTERNAL_SMART_MONEY_LABELING_NOT_IMPLEMENTED');
  report.dataGaps=[...gaps];

  report.generatedAt=new Date().toISOString();
  report.enhancements={ promotedDiscoveryLiveIntegrated:true, promotedFlowsAreContextOnly:true, multichainStatusNormalized:true, solanaRpcFailoverIntegrated:Boolean(multichain?.resilience?.solanaRpcFailoverEnabled), fullReportContractEnforced:true, whalesDeepPersistedIntegrated:Boolean(deep?.persistence?.persistedResultsAvailable), whalesDeepWindowsHours:[6,24,72], whalesDeepTransport:deep?.source?.transport || null, netAccumulationLedgerIntegrated:netLedger?.status==='PASS', cexEvmFlowLabelingIntegrated:['PASS','PARTIAL'].includes(cexState?.status), rule:'TOKEN_FLOW_CONTEXT_ONLY is never promoted to BUY/SELL without trade-level evidence. Net accumulation uses confirmed classifications only. CEX labels are context signals and never proof of sale/purchase.' };

  await fs.writeFile(REPORT,JSON.stringify(report,null,2)+'\n');
  console.log('WHALES REPORT ENHANCED',report.generatedAt,'sections=',report.reportContract.mandatorySections.length,'multichain=',report.health.multichainOverall,'deep=',report.deepValidation.status,'net=',report.netAccumulation.status,'cex=',report.cexFlows.status);
}

main().catch((err)=>{ console.error(err); process.exit(1); });
