import fs from 'node:fs/promises';

const REPORT = 'data/whales-report.json';
const LIVE = 'data/whales-promoted-live-state.json';
const POSITIONS = 'data/positions-state.json';
const MULTICHAIN = 'data/whales-multichain-state.json';

async function read(path, fallback = null) {
  try { return JSON.parse(await fs.readFile(path, 'utf8')); } catch { return fallback; }
}
function ageMinutes(iso) {
  const t = Date.parse(iso || '');
  return Number.isFinite(t) ? Math.max(0, (Date.now() - t) / 60000) : null;
}

async function main() {
  const report = await read(REPORT);
  if (!report) throw new Error('Base WHALES report missing');
  const live = await read(LIVE, null);
  const positions = await read(POSITIONS, null);
  const multichain = await read(MULTICHAIN, null);

  const mandatory = new Set(report?.reportContract?.mandatorySections || []);
  mandatory.add('promotedDiscoveryLive');
  report.reportContract.mandatorySections = [...mandatory];
  report.reportContract.rule = 'Always expose every section below. Empty sections must be shown as NONE or DATA_GAP; never silently omit them. Discovery wallets promoted to Tier A must also expose their live-surveillance state.';

  report.promotedDiscoveryLive = live || {
    status: 'DATA_GAP',
    reason: 'Promoted-wallet live monitor has not persisted its first state yet.',
    promotedWalletCount: report?.promotedDiscoveryWallets?.length || 0,
    flows: []
  };

  if (report?.executive?.monitoredWallets) {
    const liveCount = live?.promotedWalletCount ?? report.executive.monitoredWallets.autoPromotedDiscovery ?? 0;
    report.executive.monitoredWallets.autoPromotedDiscovery = liveCount;
    report.executive.monitoredWallets.totalSurveillanceUniverse =
      Number(report.executive.monitoredWallets.fixedEvm || 0) +
      Number(report.executive.monitoredWallets.fixedSolana || 0) +
      Number(liveCount || 0);
  }

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

  if (positions) {
    const ts = positions.updatedAt || positions.generatedAt || null;
    const row = (report.health.freshness || []).find((x) => x.module === 'positions');
    if (row) {
      row.generatedAt = ts;
      row.ageMinutes = ageMinutes(ts) == null ? null : Number(ageMinutes(ts).toFixed(1));
      row.freshness = row.ageMinutes == null ? 'MISSING' : row.ageMinutes <= Number(row.maxMinutes || 1440) ? 'FRESH' : 'STALE';
    }
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
  report.dataGaps = [...gaps];

  report.generatedAt = new Date().toISOString();
  report.enhancements = {
    promotedDiscoveryLiveIntegrated: true,
    promotedFlowsAreContextOnly: true,
    multichainStatusNormalized: true,
    rule: 'TOKEN_FLOW_CONTEXT_ONLY is never promoted to BUY/SELL without trade-level evidence.'
  };

  await fs.writeFile(REPORT, JSON.stringify(report, null, 2) + '\n');
  console.log('WHALES REPORT ENHANCED', report.generatedAt, 'multichain=', report.health.multichainOverall, 'promotedLive=', report.promotedDiscoveryLive.status);
}

main().catch((err) => { console.error(err); process.exit(1); });
