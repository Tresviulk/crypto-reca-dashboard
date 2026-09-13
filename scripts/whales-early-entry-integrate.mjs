import fs from 'node:fs/promises';

const EARLY_PATH = 'data/whales-early-entry-state.json';
const WHALES_PATH = 'data/whales-report.json';
const MASTER_PATH = 'data/system-master-report.json';
const LEDGER_PATH = 'data/whales-net-accumulation.json';

async function readJson(path, fallback = null) {
  try { return JSON.parse(await fs.readFile(path, 'utf8')); } catch { return fallback; }
}
const num = (x) => Number.isFinite(Number(x)) ? Number(x) : null;
const tsMs = (x) => { const t = Date.parse(x || ''); return Number.isFinite(t) ? t : null; };
const uniq = (arr) => [...new Set((arr || []).filter(Boolean))];
const upper = (x) => String(x || '').trim().toUpperCase();

function ensureMandatory(obj, key) {
  obj.reportContract ||= {};
  obj.reportContract.mandatorySections ||= [];
  if (!obj.reportContract.mandatorySections.includes(key)) obj.reportContract.mandatorySections.push(key);
}

function earlySummary(early) {
  return {
    status: early?.runStatus || 'DATA_GAP',
    generatedAt: early?.generatedAt || null,
    scheduleTargetMinutes: early?.scheduleTargetMinutes ?? null,
    cohort: early?.cohort ? {
      total: early.cohort.total,
      fixedTierA: early.cohort.fixedTierA,
      discoveryTierA: early.cohort.discoveryTierA,
      dynamicTierB: early.cohort.dynamicTierB
    } : null,
    scan: early?.scan || null,
    buyCandidates: (early?.buyCandidates || []).slice(0, 10),
    earlyWatches: (early?.earlyWatches || []).slice(0, 10),
    topCandidates: (early?.topCandidates || []).slice(0, 15),
    health: early?.health || null,
    dataGaps: early?.dataGaps || []
  };
}

function earlyConfirmedEvents(early) {
  return (early?.events || []).filter((e) => ['BUY','SELL'].includes(e?.action) && Number(e?.confidence || 0) >= 0.88 && e?.wallet && e?.mint && e?.signature && e?.eventTime);
}

function ledgerEventFromEarly(e, early) {
  const meta = early?.metadataCache?.[e.mint] || {};
  const action = upper(e.action);
  const symbol = upper(e.symbolAtDetection || meta.symbol || e.mint.slice(0, 8));
  const id = ['solana', e.wallet, e.signature, action, e.mint].join(':');
  return {
    id,
    chain: 'solana',
    source: 'WHALES_EARLY_ONCHAIN_SWAP_CLASSIFIED',
    action,
    walletLabel: e.walletLabel || null,
    wallet: e.wallet,
    assetSymbol: symbol,
    assetKey: e.mint,
    tokenAmount: Math.abs(Number(e.tokenAmount || 0)),
    quoteAsset: upper(e.quoteAsset),
    quoteAmount: Math.abs(Number(e.quoteAmount || 0)),
    txRef: e.signature,
    eventTime: e.eventTime,
    marketCapUsdAtTrade: num(e.marketCapUsdAtDetection ?? meta.marketCapUsd ?? meta.fdvUsd),
    priceUsdAtTrade: num(e.priceUsdAtDetection ?? meta.priceUsd),
    confidence: Number(e.confidence || 0),
    firstTouch: Boolean(e.firstTouch),
    confirmation: 'HIGH_CONFIDENCE_ONCHAIN_SWAP_BALANCE_DELTA',
    tokenDelta: action === 'BUY' ? Math.abs(Number(e.tokenAmount || 0)) : -Math.abs(Number(e.tokenAmount || 0)),
    quoteDelta: action === 'BUY' ? -Math.abs(Number(e.quoteAmount || 0)) : Math.abs(Number(e.quoteAmount || 0))
  };
}

function aggregateLedger(events, cutoffMs) {
  const groups = new Map();
  for (const e of events) {
    if ((tsMs(e.eventTime) || 0) < cutoffMs || !['BUY','SELL'].includes(e.action)) continue;
    const key = `${e.chain}:${e.assetKey}`;
    if (!groups.has(key)) groups.set(key, {
      chain:e.chain, assetKey:e.assetKey, assetSymbol:e.assetSymbol || null,
      buyCount:0, sellCount:0, tokenBought:0, tokenSold:0, netTokenFlow:0,
      quoteSpent:0, quoteReceived:0, wallets:new Set(), latestEventAt:null
    });
    const g = groups.get(key);
    g.wallets.add(e.walletLabel || e.wallet);
    if (e.action === 'BUY') {
      g.buyCount++; g.tokenBought += Math.abs(Number(e.tokenAmount || 0)); g.quoteSpent += Math.abs(Number(e.quoteAmount || 0));
    } else {
      g.sellCount++; g.tokenSold += Math.abs(Number(e.tokenAmount || 0)); g.quoteReceived += Math.abs(Number(e.quoteAmount || 0));
    }
    g.netTokenFlow += Number(e.tokenDelta || (e.action === 'BUY' ? e.tokenAmount : -Number(e.tokenAmount || 0)) || 0);
    if (!g.latestEventAt || e.eventTime > g.latestEventAt) g.latestEventAt = e.eventTime;
  }
  return [...groups.values()].map((g) => ({
    ...g,
    tokenBought:Number(g.tokenBought.toFixed(8)), tokenSold:Number(g.tokenSold.toFixed(8)),
    netTokenFlow:Number(g.netTokenFlow.toFixed(8)), quoteSpent:Number(g.quoteSpent.toFixed(8)),
    quoteReceived:Number(g.quoteReceived.toFixed(8)), walletCount:g.wallets.size, wallets:[...g.wallets],
    direction:g.netTokenFlow > 0 ? 'NET_ACCUMULATION' : g.netTokenFlow < 0 ? 'NET_DISTRIBUTION' : 'FLAT'
  })).sort((a,b) => b.walletCount-a.walletCount || Math.abs(b.netTokenFlow)-Math.abs(a.netTokenFlow));
}

async function integrateLedger(early) {
  const ledger = await readJson(LEDGER_PATH, { schemaVersion:'1.0', module:'whalesNetAccumulationLedger', events:[] });
  const cutoff = Date.now() - 30 * 86400_000;
  const map = new Map();
  for (const e of ledger.events || []) {
    if (!e?.id || (tsMs(e.eventTime) || 0) < cutoff) continue;
    map.set(e.id, e);
  }
  for (const e of earlyConfirmedEvents(early)) {
    const row = ledgerEventFromEarly(e, early);
    if ((tsMs(row.eventTime) || 0) >= cutoff) map.set(row.id, row);
  }
  const events = [...map.values()].sort((a,b) => (tsMs(b.eventTime)||0)-(tsMs(a.eventTime)||0));
  const windows = {};
  for (const [name,h] of [['6h',6],['24h',24],['72h',72],['7d',168],['30d',720]]) windows[name] = aggregateLedger(events, Date.now()-h*3600_000);
  ledger.schemaVersion = '1.1';
  ledger.module = 'whalesNetAccumulationLedger';
  ledger.generatedAt = new Date().toISOString();
  ledger.status = 'PASS';
  ledger.retentionDays = 30;
  ledger.methodology = 'Persistent deduplicated ledger of confirmed BUY/SELL classifications. Includes provider-confirmed trades plus high-confidence wallet-first on-chain swap classifications; raw TOKEN_FLOW remains excluded.';
  ledger.sourceStatus ||= {};
  ledger.sourceStatus.earlyEntryEngine = early?.runStatus || 'MISSING';
  ledger.eventCount = events.length;
  ledger.events = events;
  ledger.windows = windows;
  ledger.top24h = windows['24h'].slice(0,25);
  ledger.top72h = windows['72h'].slice(0,25);
  ledger.top30d = windows['30d'].slice(0,50);
  await fs.writeFile(LEDGER_PATH, JSON.stringify(ledger, null, 2) + '\n');
  return ledger;
}

function dedupeDecision(rows) {
  const map = new Map();
  for (const row of rows || []) {
    const key = `${row?.source || ''}:${row?.asset || row?.mint || ''}:${row?.status || ''}`;
    map.set(key, row);
  }
  return [...map.values()];
}

function integrateWhales(report, early, ledger) {
  if (!report) return null;
  const summary = earlySummary(early);
  ensureMandatory(report, 'earlyEntry');
  report.earlyEntry = summary;
  report.executive ||= {};
  report.executive.earlyEntry = {
    status: summary.status,
    generatedAt: summary.generatedAt,
    cohortSize: summary.cohort?.total ?? null,
    buyCandidateCount: early?.scan?.buyCandidateCount ?? 0,
    earlyWatchCount: early?.scan?.earlyWatchCount ?? 0,
    newOnchainSwapBuys: early?.scan?.newOnchainSwapBuys ?? 0,
    newOnchainSwapSells: early?.scan?.newOnchainSwapSells ?? 0
  };
  report.health ||= {};
  report.health.earlyEntry = {
    status: early?.runStatus || 'DATA_GAP',
    generatedAt: early?.generatedAt || null,
    ageMinutes: early?.generatedAt ? Number(((Date.now()-Date.parse(early.generatedAt))/60000).toFixed(1)) : null,
    cohortSize: early?.cohort?.total ?? null,
    failedWallets: early?.health?.failedWallets ?? null,
    txFailures: early?.health?.txFailures ?? null
  };
  report.coverage ||= {};
  report.coverage.earlyEntry = 'WALLET_FIRST_SOLANA_SWAP_DIRECTION_5M_POLLING_FIXED_TIER_A_PLUS_DYNAMIC_DISCOVERY';

  const buys = earlyConfirmedEvents(early).filter((e) => e.action === 'BUY').map((e) => ({
    source:'WHALES_EARLY_ENTRY', chain:'solana', walletLabel:e.walletLabel, wallet:e.wallet,
    asset: upper(e.symbolAtDetection || early?.metadataCache?.[e.mint]?.symbol || e.mint.slice(0,8)),
    mint:e.mint, tokenAmount:e.tokenAmount, quoteAsset:e.quoteAsset, quoteAmount:e.quoteAmount,
    confidence:e.confidence, firstTouch:e.firstTouch, txRef:e.signature, eventTime:e.eventTime
  }));
  const sells = earlyConfirmedEvents(early).filter((e) => e.action === 'SELL').map((e) => ({
    source:'WHALES_EARLY_ENTRY', chain:'solana', walletLabel:e.walletLabel, wallet:e.wallet,
    asset: upper(e.symbolAtDetection || early?.metadataCache?.[e.mint]?.symbol || e.mint.slice(0,8)),
    mint:e.mint, tokenAmount:e.tokenAmount, quoteAsset:e.quoteAsset, quoteAmount:e.quoteAmount,
    confidence:e.confidence, txRef:e.signature, eventTime:e.eventTime
  }));
  if (Array.isArray(report.confirmedBuys)) {
    const map = new Map(report.confirmedBuys.map((x) => [`${x.txRef || x.tx_hash || ''}:${x.wallet || ''}:${x.mint || x.asset || ''}`, x]));
    for (const x of buys) map.set(`${x.txRef}:${x.wallet}:${x.mint}`, x);
    report.confirmedBuys = [...map.values()];
  }
  if (Array.isArray(report.confirmedSells)) {
    const map = new Map(report.confirmedSells.map((x) => [`${x.txRef || x.tx_hash || ''}:${x.wallet || ''}:${x.mint || x.asset || ''}`, x]));
    for (const x of sells) map.set(`${x.txRef}:${x.wallet}:${x.mint}`, x);
    report.confirmedSells = [...map.values()];
  }

  const earlyRows = (early?.topCandidates || []).map((c) => ({
    source:'WHALES_EARLY_ENTRY', asset: upper(c.symbol || c.mint?.slice(0,8)), mint:c.mint,
    status:c.status, action:c.action, reason:c.reason, pair:c.pair, dex:c.dex,
    priceUsd:c.priceUsd, liquidityUsd:c.liquidityUsd, marketCapUsd:c.marketCapUsd,
    uniqueBuyWalletCount:c.uniqueBuyWalletCount, tierAPriorityBuyCount:c.tierAPriorityBuyCount,
    firstTouchBuyCount:c.firstTouchBuyCount, avgConfidence:c.avgConfidence,
    firstBuyAt:c.firstBuyAt, minutesSinceFirstBuy:c.minutesSinceFirstBuy, cabal:c.cabal || null
  }));
  report.decisionTable = dedupeDecision([...(report.decisionTable || []).filter((x) => x?.source !== 'WHALES_EARLY_ENTRY'), ...earlyRows]);

  const convergenceRows = earlyRows.filter((x) => x.status === 'SHARK_CONVERGENCE');
  report.convergence = Array.isArray(report.convergence) ? report.convergence.filter((x) => x?.source !== 'WHALES_EARLY_ENTRY') : [];
  report.convergence.push(...convergenceRows);
  report.actionableConvergence = Array.isArray(report.actionableConvergence) ? report.actionableConvergence.filter((x) => x?.source !== 'WHALES_EARLY_ENTRY') : [];
  report.actionableConvergence.push(...convergenceRows.filter((x) => x.action === 'BUY_CANDIDATE_REVIEW'));

  report.cabalCross ||= {};
  report.cabalCross.whalesXCabal = Array.isArray(report.cabalCross.whalesXCabal) ? report.cabalCross.whalesXCabal.filter((x) => x?.source !== 'WHALES_EARLY_ENTRY') : [];
  report.cabalCross.whalesXCabal.push(...earlyRows.filter((x) => x.cabal).map((x) => ({ ...x, source:'WHALES_EARLY_ENTRY' })));

  report.netAccumulation = ledger;
  report.dataGaps = uniq([
    ...(report.dataGaps || []).filter((x) => !String(x).includes('No guaranteed token-level live trade stream for newly discovered non-KOL wallets')),
    'EARLY_ENTRY_PUBLIC_RPC_5M_POLLING_NOT_SUBSECOND_STREAM',
    'EARLY_ENTRY_INSIDER_DEPLOYER_SYBIL_GRAPH_PARTIAL'
  ]);
  report.generatedAt = new Date().toISOString();
  return report;
}

function integrateMaster(master, early, report) {
  if (!master) return null;
  const summary = earlySummary(early);
  ensureMandatory(master, 'whalesEarlyEntry');
  master.whalesEarlyEntry = summary;
  master.systemHealth ||= {};
  master.systemHealth.timestamps ||= {};
  master.systemHealth.timestamps.whalesEarlyEntry = early?.generatedAt || null;
  master.finalDecisionMatrix ||= {};
  master.finalDecisionMatrix.whaleEarlyEntries = (early?.topCandidates || []).filter((x) => ['BUY_CANDIDATE_REVIEW','EARLY_SHARK_WATCH','WATCH','DO_NOT_CHASE'].includes(x.action)).slice(0,20);
  master.finalDecisionMatrix.whaleConvergence = report?.actionableConvergence || master.finalDecisionMatrix.whaleConvergence || [];
  master.dataGaps = uniq([...(master.dataGaps || []), 'EARLY_ENTRY_PUBLIC_RPC_5M_POLLING_NOT_SUBSECOND_STREAM']);
  master.generatedAt = new Date().toISOString();
  return master;
}

async function main() {
  const early = await readJson(EARLY_PATH);
  if (!early) throw new Error('Missing data/whales-early-entry-state.json');
  const ledger = await integrateLedger(early);
  const report = integrateWhales(await readJson(WHALES_PATH), early, ledger);
  if (report) await fs.writeFile(WHALES_PATH, JSON.stringify(report, null, 2) + '\n');
  const master = integrateMaster(await readJson(MASTER_PATH), early, report);
  if (master) await fs.writeFile(MASTER_PATH, JSON.stringify(master, null, 2) + '\n');
  console.log('WHALES EARLY ENTRY INTEGRATED', early.generatedAt, 'ledgerEvents=', ledger.eventCount, 'whales=', Boolean(report), 'master=', Boolean(master), 'buyCandidates=', early?.scan?.buyCandidateCount || 0);
}

main().catch((err) => { console.error(err); process.exit(1); });
