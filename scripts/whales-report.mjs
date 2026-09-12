import fs from 'node:fs/promises';

const PATHS = {
  multichain: 'data/whales-multichain-state.json',
  ethereum: 'data/whales-state.json',
  fixedSolana: 'data/solana-fixed-kol-feed-state.json',
  discovery: 'data/whales-discovery-state.json',
  promoted: 'data/whales-promoted-wallets.json',
  cabal: 'data/cabal-machine.json',
  positions: 'data/positions-state.json'
};
const OUT = 'data/whales-report.json';

async function readJson(path) {
  try { return JSON.parse(await fs.readFile(path, 'utf8')); }
  catch { return null; }
}
const upper = (x) => String(x || '').trim().toUpperCase();
const uniq = (arr) => [...new Set(arr.filter(Boolean))];

function ageMinutes(iso) {
  const t = Date.parse(iso || '');
  return Number.isFinite(t) ? Math.max(0, (Date.now() - t) / 60000) : null;
}

function staleState(name, data, maxMinutes) {
  const generatedAt = data?.generatedAt || null;
  const age = ageMinutes(generatedAt);
  return { module: name, generatedAt, ageMinutes: age == null ? null : Number(age.toFixed(1)), maxMinutes, freshness: age == null ? 'MISSING' : age <= maxMinutes ? 'FRESH' : 'STALE' };
}

function currentEvmActivity(multichain, ethereum) {
  const ethSummary = multichain?.chains?.ethereum?.summary || ethereum?.summary || {};
  const buys = (ethSummary.buys || []).map((b) => ({
    chain: 'ethereum', action: 'BUY', walletLabel: b.wallet_label, wallet: b.wallet,
    asset: upper(b.received_asset), spentAsset: upper(b.spent_asset), spentValue: b.spent_value,
    receivedValue: b.received_value, contract: b.received_contract, txHash: b.tx_hash,
    time: b.received_at || b.event_created_at || null
  }));
  const sells = (ethSummary.sells || []).map((b) => ({
    chain: 'ethereum', action: 'SELL', walletLabel: b.wallet_label, wallet: b.wallet,
    asset: upper(b.spent_asset || b.received_asset), spentAsset: upper(b.spent_asset), spentValue: b.spent_value,
    receivedValue: b.received_value, contract: b.spent_contract || b.received_contract, txHash: b.tx_hash,
    time: b.received_at || b.event_created_at || null
  }));
  const other = [];
  for (const chain of ['base', 'arbitrum']) {
    for (const s of multichain?.chains?.[chain]?.signals || []) {
      other.push({ chain, action: s.classification, walletLabel: s.walletLabel, wallet: s.wallet,
        asset: upper(s.received?.asset || s.spent?.asset), spentAsset: upper(s.spent?.asset), spentValue: s.spent?.value ?? null,
        receivedValue: s.received?.value ?? null, contract: s.received?.contract || s.spent?.contract || null,
        txHash: s.txHash, blockNumber: s.blockNumber ?? null, time: null });
    }
  }
  const hl = (multichain?.chains?.hyperliquid?.fills || []).map((f) => ({
    chain: 'hyperliquid', action: f.classification, walletLabel: f.walletLabel, wallet: f.wallet,
    asset: upper(f.asset), notional: f.notional, price: f.price, size: f.size, dir: f.dir,
    txHash: f.txHash, time: f.time ? new Date(Number(f.time)).toISOString() : null
  }));
  return { buys, sells, otherEvmSignals: other, hyperliquidFills: hl };
}

function solanaActivity(fixedSolana, multichain) {
  const confirmedTrades = fixedSolana?.trades || [];
  const rawFlows = multichain?.chains?.solana?.signals || [];
  return {
    confirmedTrades,
    confirmedBuys: confirmedTrades.filter((x) => upper(x.action) === 'BUY'),
    confirmedSells: confirmedTrades.filter((x) => upper(x.action) === 'SELL'),
    confirmedConvergence: fixedSolana?.actionableConvergence || [],
    lowMarketCapBuys: fixedSolana?.lowMarketCapBuys || [],
    rawTokenFlowsContextOnly: rawFlows,
    rpcStatus: multichain?.chains?.solana?.status || 'MISSING',
    rpcFailedWallets: multichain?.chains?.solana?.failed ?? null,
    feedStatus: fixedSolana?.source?.status || 'MISSING'
  };
}

function buildCombinedConvergence(activity, solana) {
  const groups = new Map();
  const add = (assetKey, wallet, chain, source, event) => {
    if (!assetKey || !wallet) return;
    if (!groups.has(assetKey)) groups.set(assetKey, { asset: assetKey, wallets: new Set(), chains: new Set(), sources: new Set(), events: [] });
    const g = groups.get(assetKey);
    g.wallets.add(wallet); g.chains.add(chain); g.sources.add(source); g.events.push(event);
  };
  for (const b of activity.buys) add(b.asset || b.contract, b.walletLabel, b.chain, 'EVM_CONFIRMED_BUY', b);
  for (const s of activity.otherEvmSignals) if (s.action === 'BUY') add(s.asset || s.contract, s.walletLabel, s.chain, 'EVM_RECONSTRUCTED_BUY', s);
  for (const f of activity.hyperliquidFills) if (f.action === 'BUY') add(f.asset, f.walletLabel, 'hyperliquid', 'HYPERLIQUID_FILL', f);
  for (const b of solana.confirmedBuys) add(upper(b.tokenSymbol) || b.tokenMint, b.walletLabel, 'solana', 'SOLANA_KOL_CONFIRMED_BUY', b);
  return [...groups.values()].map((g) => ({
    asset: g.asset,
    walletCount: g.wallets.size,
    walletLabels: [...g.wallets],
    chainCount: g.chains.size,
    chains: [...g.chains],
    sources: [...g.sources],
    eventCount: g.events.length,
    convergence: g.wallets.size >= 2,
    events: g.events
  })).sort((a, b) => Number(b.convergence) - Number(a.convergence) || b.walletCount - a.walletCount || b.eventCount - a.eventCount);
}

function cabalSummary(cabal) {
  const candidates = cabal?.candidates || [];
  return {
    generatedAt: cabal?.generatedAt || null,
    ok: cabal?.ok ?? null,
    coverage: cabal?.coverage || null,
    stageACount: cabal?.candidateCountStageA ?? null,
    deepValidatedCount: cabal?.deepValidatedCount ?? null,
    btcReference: cabal?.btcReference || null,
    leaders: candidates.slice(0, 15).map((c) => ({ asset: upper(c.asset), price: c.price, stageAScore: c.stageAScore, classification: c.classification, executionSignal: c.executionSignal, urgency: c.decisionUrgency, rvol1h: c.rvol1h, rvol4h: c.rvol4h, priceChange1hPct: c.priceChange1hPct, priceChange4hPct: c.priceChange4hPct, priceChange24hPct: c.priceChange24hPct, secondLegWatch: c.secondLegWatch, secondLegTrigger: c.secondLegTrigger })),
    pilotEntries: candidates.filter((c) => c.executionSignal === 'PILOT_ENTRY_WINDOW').slice(0, 20).map((c) => ({ asset: upper(c.asset), price: c.price, score: c.stageAScore, pilotEntryMax: c.pilotEntryMax, confirmationAddTrigger: c.confirmationAddTrigger, protectiveStopReference: c.protectiveStopReference })),
    secondLegTriggers: candidates.filter((c) => c.secondLegTrigger === true).slice(0, 20).map((c) => ({ asset: upper(c.asset), price: c.price, score: c.stageAScore, classification: c.classification }))
  };
}

function intersections(convergence, cabal, positions) {
  const cabalMap = new Map((cabal?.candidates || []).map((c) => [upper(c.asset), c]));
  const open = (positions?.positions || []).filter((p) => p.status === 'OPEN');
  const openMap = new Map(open.map((p) => [upper(p.asset), p]));
  const whaleAssets = uniq(convergence.map((x) => upper(x.asset)));
  return {
    whalesXCabal: whaleAssets.filter((a) => cabalMap.has(a)).map((a) => ({ asset: a, whale: convergence.find((x) => upper(x.asset) === a), cabal: { score: cabalMap.get(a).stageAScore, signal: cabalMap.get(a).executionSignal, classification: cabalMap.get(a).classification, price: cabalMap.get(a).price } })),
    whalesXOpenPositions: whaleAssets.filter((a) => openMap.has(a)).map((a) => ({ asset: a, whale: convergence.find((x) => upper(x.asset) === a), position: { pair: openMap.get(a).pair, entry: openMap.get(a).effectiveEntry ?? openMap.get(a).entry, protection: openMap.get(a).protection, totalCost: openMap.get(a).total } })),
    openPositions: open.map((p) => ({ asset: upper(p.asset), pair: p.pair, entry: p.effectiveEntry ?? p.entry, qty: p.qty, totalCost: p.total, protection: p.protection, whaleSignal: whaleAssets.includes(upper(p.asset)) ? 'PRESENT' : 'NONE_IN_CURRENT_COHORT' }))
  };
}

function decisionTable(convergence, ix, discovery, solana, activity) {
  const rows = [];
  for (const w of convergence.slice(0, 20)) {
    let status = w.convergence ? 'WHALE_CONVERGENCE' : 'WHALE_WATCH';
    const cabalHit = ix.whalesXCabal.find((x) => x.asset === upper(w.asset));
    if (w.convergence && cabalHit && ['PILOT_ENTRY_WINDOW','WAIT_CONFIRMATION'].includes(cabalHit.cabal.signal)) status = 'HIGH_CONVICTION_REVIEW';
    rows.push({ asset: w.asset, status, walletCount: w.walletCount, chainCount: w.chainCount, cabalSignal: cabalHit?.cabal?.signal || 'NO_CABAL_CONFIRMATION', reason: w.convergence ? '2+ distinct monitored wallets buying' : 'Single monitored wallet activity only' });
  }
  for (const p of discovery?.promotedWallets || []) rows.push({ asset: p.address, status: 'DISCOVERY_TIER_A_WALLET', walletCount: null, chainCount: 1, cabalSignal: null, reason: `AlphaScore ${p.alphaScore}; surveillance promotion only` });
  if (!solana.confirmedBuys.length && !activity.hyperliquidFills.length && !activity.buys.length) rows.push({ asset: null, status: 'NO_FRESH_CONFIRMED_WHALE_BUYS', reason: 'No confirmed buy events in current persisted windows.' });
  return rows;
}

async function main() {
  const [multichain, ethereum, fixedSolana, discovery, promoted, cabal, positions] = await Promise.all(Object.values(PATHS).map(readJson));
  const freshness = [
    staleState('multichain', multichain, 25), staleState('ethereumWorker', ethereum, 25), staleState('solanaFixedFeed', fixedSolana, 35),
    staleState('discovery', discovery, 75), staleState('cabal', cabal, 30), staleState('positions', positions, 1440)
  ];
  const evm = currentEvmActivity(multichain, ethereum);
  const solana = solanaActivity(fixedSolana, multichain);
  const convergence = buildCombinedConvergence(evm, solana);
  const cabalView = cabalSummary(cabal);
  const ix = intersections(convergence, cabal, positions);
  const fixedEvmCount = multichain?.architecture?.trackedEvmWallets ?? 0;
  const fixedSolanaCount = fixedSolana?.watchedWalletCount ?? multichain?.architecture?.trackedSolanaWallets ?? 0;
  const promotedCount = promoted?.wallets?.length ?? discovery?.promotedWallets?.length ?? 0;

  const gaps = [];
  if (!multichain) gaps.push('MULTICHAIN_STATE_MISSING');
  if (!fixedSolana) gaps.push('SOLANA_FIXED_FEED_MISSING');
  if (!discovery) gaps.push('WHALES_DISCOVERY_NOT_YET_RUN');
  if (!cabal) gaps.push('CABAL_STATE_MISSING');
  if (multichain?.chains?.solana?.status !== 'PASS') gaps.push(`SOLANA_RPC_${multichain?.chains?.solana?.status || 'MISSING'}`);
  gaps.push('BITCOIN_ONCHAIN_WHALE_TRACKING_NOT_IMPLEMENTED');
  gaps.push('EVM_AUTOMATIC_NEW_WALLET_DISCOVERY_NOT_IMPLEMENTED_V1');
  gaps.push('CEX_DEPOSIT_WITHDRAWAL_LABELING_NOT_IMPLEMENTED');
  gaps.push('INSIDER_DEPLOYER_LINK_GRAPH_NOT_IMPLEMENTED');

  const report = {
    schemaVersion: '2.0',
    module: 'whalesCanonicalReport',
    generatedAt: new Date().toISOString(),
    reportContract: {
      command: 'WHALES',
      rule: 'Always expose every section below. Empty sections must be shown as NONE or DATA_GAP; never silently omit them.',
      mandatorySections: ['executive','health','coverage','fixedCohort','discovery','confirmedBuys','confirmedSells','solana','hyperliquid','convergence','cabalCross','portfolioCross','decisionTable','dataGaps']
    },
    executive: {
      status: gaps.some((g) => g.includes('MISSING')) ? 'PARTIAL' : 'RUNNING_WITH_DECLARED_GAPS',
      monitoredWallets: { fixedEvm: fixedEvmCount, fixedSolana: fixedSolanaCount, autoPromotedDiscovery: promotedCount, totalSurveillanceUniverse: fixedEvmCount + fixedSolanaCount + promotedCount },
      freshConfirmedBuys: evm.buys.length + solana.confirmedBuys.length + evm.otherEvmSignals.filter((x) => x.action === 'BUY').length + evm.hyperliquidFills.filter((x) => x.action === 'BUY').length,
      freshConfirmedSells: evm.sells.length + solana.confirmedSells.length + evm.otherEvmSignals.filter((x) => x.action === 'SELL').length + evm.hyperliquidFills.filter((x) => x.action === 'SELL').length,
      actionableConvergenceCount: convergence.filter((x) => x.convergence).length,
      whalesXCabalCount: ix.whalesXCabal.length,
      discoveryTierACount: discovery?.universe?.tierA ?? null
    },
    health: { freshness, multichainOverall: multichain?.overallStatus || 'MISSING', chainStatus: multichain?.architecture?.chains || {}, fixedSolanaFeed: fixedSolana?.source || null, discoveryStatus: discovery?.runStatus || 'NOT_RUN' },
    coverage: {
      ethereum: 'FIXED_COHORT_WORKER', base: 'FIXED_EVM_COHORT_RPC', arbitrum: 'FIXED_EVM_COHORT_RPC', hyperliquid: 'FIXED_EVM_COHORT_USER_FILLS',
      solana: 'FIXED_TIER_A_KOL_FEED + RPC_CONTEXT + ALPHA_WALLET_DISCOVERY', bitcoin: 'DATA_GAP',
      discoveryScopeV1: 'SOLANA_FIRST20_BUYER_ALPHA_DATASET'
    },
    fixedCohort: { evmCount: fixedEvmCount, solanaCount: fixedSolanaCount, solanaWallets: fixedSolana?.watchedWallets || [] },
    discovery: discovery || { status: 'DATA_GAP', reason: 'Discovery workflow has not persisted a state yet.' },
    promotedDiscoveryWallets: promoted?.wallets || discovery?.promotedWallets || [],
    confirmedBuys: { ethereum: evm.buys, baseArbitrum: evm.otherEvmSignals.filter((x) => x.action === 'BUY'), hyperliquid: evm.hyperliquidFills.filter((x) => x.action === 'BUY'), solana: solana.confirmedBuys },
    confirmedSells: { ethereum: evm.sells, baseArbitrum: evm.otherEvmSignals.filter((x) => x.action === 'SELL'), hyperliquid: evm.hyperliquidFills.filter((x) => x.action === 'SELL'), solana: solana.confirmedSells },
    solana,
    hyperliquid: { status: multichain?.chains?.hyperliquid?.status || 'MISSING', failedWallets: multichain?.chains?.hyperliquid?.failedWallets ?? null, fills: evm.hyperliquidFills },
    convergence,
    actionableConvergence: convergence.filter((x) => x.convergence),
    cabalCross: { cabal: cabalView, whalesXCabal: ix.whalesXCabal },
    portfolioCross: { openPositions: ix.openPositions, whaleMatches: ix.whalesXOpenPositions },
    decisionTable: decisionTable(convergence, ix, discovery, solana, evm),
    dataGaps: uniq([...(discovery?.explicitDataGaps || []), ...gaps]),
    sourceTimestamps: { multichain: multichain?.generatedAt || null, ethereum: ethereum?.generatedAt || null, solanaFixed: fixedSolana?.generatedAt || null, discovery: discovery?.generatedAt || null, cabal: cabal?.generatedAt || null, positions: positions?.updatedAt || positions?.generatedAt || null }
  };

  await fs.writeFile(OUT, JSON.stringify(report, null, 2) + '\n');
  console.log('WHALES CANONICAL REPORT', report.generatedAt, report.executive);
}

main().catch((err) => { console.error(err); process.exit(1); });
