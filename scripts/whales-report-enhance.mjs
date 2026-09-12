import fs from 'node:fs/promises';

const REPORT = 'data/whales-report.json';
const LIVE = 'data/whales-promoted-live-state.json';
const POSITIONS = 'data/positions-state.json';
const MULTICHAIN = 'data/whales-multichain-state.json';
const DEEP = 'data/whales-deep-state.json';

async function read(path, fallback = null) {
  try { return JSON.parse(await fs.readFile(path, 'utf8')); } catch { return fallback; }
}
function ageMinutes(iso) {
  const t = Date.parse(iso || '');
  return Number.isFinite(t) ? Math.max(0, (Date.now() - t) / 60000) : null;
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

async function main() {
  const report = await read(REPORT);
  if (!report) throw new Error('Base WHALES report missing');
  const live = await read(LIVE, null);
  const positions = await read(POSITIONS, null);
  const multichain = await read(MULTICHAIN, null);
  const deep = await read(DEEP, null);

  const mandatory = new Set(report?.reportContract?.mandatorySections || []);
  for (const section of [
    'promotedDiscoveryLive',
    'newWalletDiscovery',
    'deepValidation',
    'largeTransfers',
    'netAccumulation',
    'cexFlows',
    'smartMoneyExternal'
  ]) mandatory.add(section);
  report.reportContract.mandatorySections = [...mandatory];
  report.reportContract.rule = 'Always expose every mandatory section. Empty sections must be shown as NONE or DATA_GAP; never silently omit them. Discovery wallets promoted to Tier A must expose live-surveillance state. WHALES DEEP 6h/24h/72h must be persisted and exposed when available. Unsupported claims must remain DATA_GAP.';

  report.promotedDiscoveryLive = live || {
    status: 'DATA_GAP',
    reason: 'Promoted-wallet live monitor has not persisted its first state yet.',
    promotedWalletCount: report?.promotedDiscoveryWallets?.length || 0,
    flows: []
  };

  report.newWalletDiscovery = {
    status: report?.discovery?.runStatus || 'DATA_GAP',
    scope: report?.discovery?.source?.interpretation || 'No persisted Discovery state.',
    uniqueWallets: report?.discovery?.universe?.uniqueWallets ?? null,
    tierA: report?.discovery?.universe?.tierA ?? null,
    tierB: report?.discovery?.universe?.tierB ?? null,
    watch: report?.discovery?.universe?.watch ?? null,
    discovered: report?.discovery?.universe?.discovered ?? null,
    promotedForSurveillance: report?.discovery?.universe?.promotedForSurveillance ?? null,
    promotedWallets: report?.promotedDiscoveryWallets || []
  };

  if (deep) {
    const deepAge = ageMinutes(deep.generatedAt);
    report.deepValidation = {
      status: deep.runStatus || 'UNKNOWN',
      generatedAt: deep.generatedAt || null,
      ageMinutes: deepAge == null ? null : Number(deepAge.toFixed(1)),
      freshness: deepAge == null ? 'MISSING' : deepAge <= 35 ? 'FRESH' : 'STALE',
      source: deep?.source?.transport || 'CABAL_WORKER_EMBEDDED_WHALES_DEEP',
      sourceGeneratedAt: deep?.source?.cabalGeneratedAt || null,
      ethereumEndpointAvailable: Boolean(multichain?.chains?.ethereum?.health?.deepEndpoint),
      endpoint: multichain?.chains?.ethereum?.health?.deepEndpoint || '/deep',
      windowsExpectedHours: deep.windowsExpectedHours || [6, 24, 72],
      persistedResultsAvailable: Boolean(deep?.persistence?.persistedResultsAvailable),
      sourceFreshness: deep?.persistence?.sourceFreshness || null,
      scan: deep.scan || null,
      results: deep.results || [],
      meaningfulKnownSignals: deep.meaningfulKnownSignals || [],
      contextualFlowActivity: deep.contextualFlowActivity || [],
      requestGaps: deep.requestGaps || [],
      interpretation: deep.interpretation || null
    };
  } else {
    report.deepValidation = {
      status: 'DATA_GAP',
      ethereumEndpointAvailable: Boolean(multichain?.chains?.ethereum?.health?.deepEndpoint),
      endpoint: multichain?.chains?.ethereum?.health?.deepEndpoint || null,
      windowsExpectedHours: [6, 24, 72],
      persistedResultsAvailable: false,
      reason: 'WHALES DEEP persistence has not produced its first state yet.'
    };
  }

  const rawSolanaFlows = multichain?.chains?.solana?.signals || [];
  const promotedFlows = live?.flows || [];
  report.largeTransfers = {
    status: rawSolanaFlows.length || promotedFlows.length ? 'CONTEXT_ONLY' : 'NONE_CONFIRMED',
    confirmedLargeTransfers: [],
    contextualTokenFlows: [...rawSolanaFlows, ...promotedFlows],
    reason: 'Raw token flows can include swaps, transfers, airdrops or dust. They are not promoted to large BUY/SELL transfer signals without transaction-level classification and sizing thresholds.'
  };

  report.netAccumulation = {
    status: 'DATA_GAP',
    assets: [],
    reason: 'Canonical rolling net accumulation by wallet/token is not yet persisted across scan windows. WHALES DEEP can expose token-centric net-flow context for each current candidate, but this is not yet a durable cost-flow ledger.'
  };

  report.cexFlows = {
    status: 'DATA_GAP',
    deposits: [],
    withdrawals: [],
    reason: 'Exchange-address labeling and deposit/withdrawal attribution are not implemented in the current WHALES pipeline.'
  };

  report.smartMoneyExternal = {
    status: 'DATA_GAP',
    signals: [],
    reason: 'WHALES Discovery scores on-chain early buyers, but no independent external smart-money labeling/consensus provider is persisted in the WHALES report yet.'
  };

  if (report?.executive?.monitoredWallets) {
    const liveCount = live?.promotedWalletCount ?? report.executive.monitoredWallets.autoPromotedDiscovery ?? 0;
    report.executive.monitoredWallets.autoPromotedDiscovery = liveCount;
    report.executive.monitoredWallets.totalSurveillanceUniverse =
      Number(report.executive.monitoredWallets.fixedEvm || 0) +
      Number(report.executive.monitoredWallets.fixedSolana || 0) +
      Number(liveCount || 0);
  }
  report.executive = report.executive || {};
  report.executive.whalesDeep = deep ? {
    status: deep.runStatus || 'UNKNOWN',
    requestedCount: deep?.scan?.requestedCount ?? null,
    okCount: deep?.scan?.okCount ?? null,
    meaningfulKnownSignalCount: deep?.scan?.meaningfulKnownSignalCount ?? null,
    contextualFlowCount: deep?.scan?.contextualFlowCount ?? null
  } : { status: 'DATA_GAP' };

  report.health = report.health || {};
  if (multichain) {
    report.health.multichainOverall = multichain.overallStatus || report.health.multichainOverall;
    report.health.chainStatus = multichain?.architecture?.chains || report.health.chainStatus || {};
    report.health.solanaOperationalMeaning =
      multichain.overallStatus === 'PARTIAL_SOLANA_RPC'
        ? 'Solana wallets are configured and being monitored; some public-RPC calls failed. This is provider degradation, not a missing-wallet condition.'
        : multichain.overallStatus === 'PARTIAL_SOLANA_WALLETS_REQUIRED'
          ? 'No Solana cohort is configured.'
          : multichain.overallStatus === 'PASS'
            ? 'All enabled multichain monitors passed.'
            : 'See chainStatus and declared data gaps.';
    const row = (report.health.freshness || []).find((x) => x.module === 'multichain');
    if (row) {
      row.generatedAt = multichain.generatedAt || row.generatedAt;
      row.ageMinutes = ageMinutes(row.generatedAt) == null ? null : Number(ageMinutes(row.generatedAt).toFixed(1));
      row.freshness = row.ageMinutes == null ? 'MISSING' : row.ageMinutes <= Number(row.maxMinutes || 25) ? 'FRESH' : 'STALE';
    }
  }

  report.health.promotedDiscoveryLive = live ? {
    status: live.status,
    generatedAt: live.generatedAt,
    ageMinutes: ageMinutes(live.generatedAt) == null ? null : Number(ageMinutes(live.generatedAt).toFixed(1)),
    promotedWalletCount: live.promotedWalletCount,
    failedWallets: live.failedWallets
  } : { status: 'MISSING' };
  report.health.whalesDeep = deep ? {
    status: deep.runStatus || 'UNKNOWN',
    generatedAt: deep.generatedAt || null,
    ageMinutes: ageMinutes(deep.generatedAt) == null ? null : Number(ageMinutes(deep.generatedAt).toFixed(1)),
    freshness: ageMinutes(deep.generatedAt) == null ? 'MISSING' : ageMinutes(deep.generatedAt) <= 35 ? 'FRESH' : 'STALE',
    persistedResultsAvailable: Boolean(deep?.persistence?.persistedResultsAvailable)
  } : { status: 'MISSING', freshness: 'MISSING', persistedResultsAvailable: false };

  if (positions) {
    const ts = positions.updatedAt || positions.generatedAt || null;
    const row = (report.health.freshness || []).find((x) => x.module === 'positions');
    if (row) {
      row.generatedAt = ts;
      row.ageMinutes = ageMinutes(ts) == null ? null : Number(ageMinutes(ts).toFixed(1));
      row.freshness = row.ageMinutes == null ? 'MISSING' : row.ageMinutes <= Number(row.maxMinutes || 1440) ? 'FRESH' : 'STALE';
    }
  }

  report.coverage = report.coverage || {};
  report.coverage.whalesDeep = deep?.persistence?.persistedResultsAvailable
    ? 'PERSISTED_6H_24H_72H_VIA_CABAL_PROTECTED_BRIDGE'
    : 'DATA_GAP';

  const deepRows = deepDecisionRows(deep);
  report.decisionTable = Array.isArray(report.decisionTable) ? report.decisionTable : [];
  const existingDeepKeys = new Set(report.decisionTable.filter((x) => String(x?.status || '').startsWith('WHALES_DEEP')).map((x) => `${x.status}:${x.asset}`));
  for (const row of deepRows) {
    const key = `${row.status}:${row.asset}`;
    if (!existingDeepKeys.has(key)) report.decisionTable.push(row);
  }

  const gaps = new Set(report.dataGaps || []);
  if (!live) gaps.add('PROMOTED_DISCOVERY_LIVE_STATE_NOT_YET_PERSISTED');
  else gaps.delete('PROMOTED_DISCOVERY_LIVE_STATE_NOT_YET_PERSISTED');
  if (live?.status === 'PARTIAL') gaps.add('PROMOTED_DISCOVERY_SOLANA_RPC_PARTIAL');
  if (live?.status === 'ERROR') gaps.add('PROMOTED_DISCOVERY_SOLANA_RPC_ERROR');
  if (multichain?.overallStatus === 'PARTIAL_SOLANA_RPC') {
    gaps.delete('SOLANA_WALLETS_REQUIRED');
    gaps.add('SOLANA_RPC_PARTIAL');
  }

  if (deep?.persistence?.persistedResultsAvailable && ['PASS', 'PARTIAL'].includes(deep?.runStatus)) {
    gaps.delete('WHALES_DEEP_RESULTS_NOT_PERSISTED');
    gaps.delete('WHALES_DEEP_STATE_MISSING');
    gaps.delete('WHALES_DEEP_SYNC_ERROR');
  } else if (!deep) {
    gaps.add('WHALES_DEEP_STATE_MISSING');
  } else if (deep?.runStatus === 'ERROR') {
    gaps.add('WHALES_DEEP_SYNC_ERROR');
  }
  if (deep && ageMinutes(deep.generatedAt) > 35) gaps.add('WHALES_DEEP_STATE_STALE');
  else gaps.delete('WHALES_DEEP_STATE_STALE');

  gaps.add('NET_ACCUMULATION_LEDGER_NOT_IMPLEMENTED');
  gaps.add('CEX_LABELING_NOT_IMPLEMENTED');
  gaps.add('EXTERNAL_SMART_MONEY_LABELING_NOT_IMPLEMENTED');
  report.dataGaps = [...gaps];

  report.generatedAt = new Date().toISOString();
  report.enhancements = {
    promotedDiscoveryLiveIntegrated: true,
    promotedFlowsAreContextOnly: true,
    multichainStatusNormalized: true,
    fullReportContractEnforced: true,
    whalesDeepPersistedIntegrated: Boolean(deep?.persistence?.persistedResultsAvailable),
    whalesDeepWindowsHours: [6, 24, 72],
    whalesDeepTransport: deep?.source?.transport || null,
    rule: 'TOKEN_FLOW_CONTEXT_ONLY is never promoted to BUY/SELL without trade-level evidence. WHALES DEEP results are persisted and exposed separately from generic transfer context.'
  };

  await fs.writeFile(REPORT, JSON.stringify(report, null, 2) + '\n');
  console.log('WHALES REPORT ENHANCED', report.generatedAt, 'sections=', report.reportContract.mandatorySections.length, 'multichain=', report.health.multichainOverall, 'deep=', report.deepValidation.status, 'promotedLive=', report.promotedDiscoveryLive.status);
}

main().catch((err) => { console.error(err); process.exit(1); });
