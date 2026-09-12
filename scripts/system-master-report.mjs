import fs from 'node:fs/promises';

const FILES = {
  whales: 'data/whales-report.json',
  cabal: 'data/cabal-machine.json',
  radar: 'data/radar-state.json',
  risk: 'data/position-risk.json',
  positions: 'data/positions-state.json',
  external: 'data/external-signals.json',
  intelligence: 'data/intelligence.json'
};
const OUT = 'data/system-master-report.json';

async function read(path) { try { return JSON.parse(await fs.readFile(path, 'utf8')); } catch { return null; } }
const upper = (x) => String(x || '').toUpperCase();
const round = (x, n = 4) => Number.isFinite(Number(x)) ? Number(Number(x).toFixed(n)) : null;

function openPositions(p) {
  return (p?.positions || []).filter((x) => x.status === 'OPEN').map((x) => ({
    id: x.id, asset: upper(x.asset), pair: x.pair, venue: x.venue || 'COINBASE', engine: x.engine,
    qty: x.qty, entry: x.effectiveEntry ?? x.entry, totalCost: x.total, protection: x.protection,
    recommendedStop: x.recommendedStop ?? null, opened: x.openedEuropeMadrid || x.openedDateEuropeMadrid || null
  }));
}

function realized(p) {
  return (p?.positions || []).filter((x) => x.status === 'CLOSED' && x.realizedPnl).map((x) => ({
    asset: upper(x.asset), pnl: x.realizedPnl.netPnl, pct: x.realizedPnl.pctOnCost ?? null, currency: x.realizedPnl.currency
  }));
}

function radarRows(r) {
  if (Array.isArray(r?.radar)) return r.radar;
  if (Array.isArray(r?.radar?.assets)) return r.radar.assets;
  if (Array.isArray(r?.assets)) return r.assets;
  return [];
}

function radarView(r) {
  return radarRows(r).map((x) => ({
    asset: upper(x.asset), pair: x.pair, price: x.price ?? x.currentPrice ?? null,
    ers: x.ers ?? x.ERS ?? null, state: x.state ?? x.phase ?? null,
    decision: x.decision ?? x.action ?? x.entryDecision ?? null, dataQuality: x.dataQuality ?? null,
    rsi: x.rsi ?? x.RSI ?? null, rvol1h: x.rvol1h ?? null,
    trend1h: x.trend1h ?? x.trends?.h1 ?? null, trend4h: x.trend4h ?? x.trends?.h4 ?? null,
    trend1d: x.trend1d ?? x.trends?.d1 ?? null
  }));
}

function riskView(risk) {
  const raw = risk?.positionRisk?.positions || risk?.positions || {};
  const entries = Array.isArray(raw)
    ? raw.map((x, i) => [x?.id || String(i), x])
    : Object.entries(raw);
  return entries.filter(([, x]) => x && typeof x === 'object').map(([id, x]) => ({
    id, asset: upper(x.asset), prs: x.prs ?? null,
    structuralState: x.structuralState ?? null, managementState: x.managementState ?? null,
    riskLevel: x.riskLevel ?? x.risk ?? null, action: x.action ?? x.advisory ?? null,
    protection: x.protection ?? null, fastDrop: x.fastDrop ?? x['FAST-DROP'] ?? null,
    modeledLoss: x.modeledLoss ?? null
  }));
}

function cabalView(c) {
  const rows = c?.candidates || [];
  return {
    generatedAt: c?.generatedAt || null, ok: c?.ok ?? null, coverage: c?.coverage || null,
    stageA: c?.candidateCountStageA ?? null, deepValidated: c?.deepValidatedCount ?? null, btcReference: c?.btcReference || null,
    leaders: rows.slice(0, 20).map((x) => ({
      asset: upper(x.asset), price: x.price, score: x.stageAScore, classification: x.classification,
      signal: x.executionSignal, urgency: x.decisionUrgency, volumeState: x.volumeState ?? null,
      effortVsResult: x.effortVsResult ?? null, rvol1h: x.rvol1h, rvol4h: x.rvol4h,
      p1: x.priceChange1hPct, p4: x.priceChange4hPct, p24: x.priceChange24hPct,
      breakout6h: x.breakout6h ?? null, reclaim6h: x.reclaim6h ?? null,
      secondLegWatch: x.secondLegWatch ?? false, secondLeg: x.secondLegTrigger ?? false
    })),
    pilotEntries: rows.filter((x) => x.executionSignal === 'PILOT_ENTRY_WINDOW').slice(0, 20).map((x) => ({
      asset: upper(x.asset), price: x.price, score: x.stageAScore, pilotEntryMax: x.pilotEntryMax,
      confirm: x.confirmationAddTrigger, stop: x.protectiveStopReference
    })),
    secondLegWatch: rows.filter((x) => x.secondLegWatch === true).slice(0, 20).map((x) => ({ asset: upper(x.asset), price: x.price, score: x.stageAScore, classification: x.classification })),
    secondLegTriggers: rows.filter((x) => x.secondLegTrigger === true).slice(0, 20).map((x) => ({ asset: upper(x.asset), price: x.price, score: x.stageAScore }))
  };
}

function volumeTurnover(cabal) {
  const rows = cabal?.candidates || [];
  return rows
    .filter((x) => Number(x.rvol1h || 0) >= 2 || Number(x.rvol4h || 0) >= 2 || x.volumeState === 'VOLUME ACCELERATING')
    .sort((a, b) => Math.max(Number(b.rvol1h || 0), Number(b.rvol4h || 0)) - Math.max(Number(a.rvol1h || 0), Number(a.rvol4h || 0)))
    .slice(0, 30)
    .map((x) => ({
      asset: upper(x.asset), price: x.price, volumeState: x.volumeState ?? null,
      rvol1h: x.rvol1h ?? null, rvol4h: x.rvol4h ?? null,
      p1: x.priceChange1hPct ?? null, p4: x.priceChange4hPct ?? null, p24: x.priceChange24hPct ?? null,
      effortVsResult: x.effortVsResult ?? null, score: x.stageAScore ?? null, signal: x.executionSignal ?? null
    }));
}

function portfolioPnlView(positions, radar) {
  const open = openPositions(positions);
  const priceMap = new Map(radarView(radar).filter((x) => Number.isFinite(Number(x.price))).map((x) => [x.asset, Number(x.price)]));
  const openMtm = open.map((p) => {
    const mark = priceMap.get(p.asset);
    if (!Number.isFinite(mark)) return { ...p, mark: null, marketValue: null, unrealizedPnl: null, unrealizedPct: null, status: 'DATA_GAP_NO_CURRENT_MARK' };
    const marketValue = Number(p.qty) * mark;
    const pnl = marketValue - Number(p.totalCost || 0);
    return { ...p, mark, marketValue: round(marketValue), unrealizedPnl: round(pnl), unrealizedPct: p.totalCost ? round((pnl / Number(p.totalCost)) * 100) : null, status: 'MTM_AVAILABLE' };
  });
  const realizedRows = realized(positions);
  const realizedByCurrency = {};
  for (const r of realizedRows) realizedByCurrency[r.currency] = round((realizedByCurrency[r.currency] || 0) + Number(r.pnl || 0));
  const knownOpen = openMtm.filter((x) => x.status === 'MTM_AVAILABLE');
  return {
    open: openMtm,
    openMtmCoverage: `${knownOpen.length}/${openMtm.length}`,
    knownOpenUnrealizedPnlNominal: round(knownOpen.reduce((s, x) => s + Number(x.unrealizedPnl || 0), 0)),
    warning: knownOpen.length === openMtm.length ? null : 'Open-position aggregate P/L is incomplete because one or more assets have no current mark in the persisted radar. Do not treat knownOpenUnrealizedPnlNominal as total portfolio P/L.',
    realized: realizedRows,
    realizedByCurrency
  };
}

function catalystsView(external, intelligence) {
  const explicit = [];
  const sources = [external, intelligence].filter(Boolean);
  for (const src of sources) {
    const rows = src?.catalysts || src?.listings || src?.upcomingCatalysts || [];
    if (Array.isArray(rows)) explicit.push(...rows);
  }
  return explicit.length
    ? { status: 'AVAILABLE', items: explicit }
    : { status: 'DATA_GAP', items: [], reason: 'No normalized catalysts/listings array is persisted in the current external/intelligence artifacts. Macro/news context remains available separately.' };
}

function processMissesView(cabal, radar, whales, missing) {
  const misses = [];
  if (cabal?.coverage?.bucketD === 'EXTERNAL_STAGE0_REQUIRED') misses.push({ module: 'CABAL', code: 'BUCKET_D_EXTERNAL_STAGE0_REQUIRED', severity: 'KNOWN_GAP' });
  for (const f of radar?.scan?.sourceFailures || []) misses.push({ module: 'RADAR', code: 'SOURCE_FAILURE', detail: f, severity: 'DATA_QUALITY' });
  for (const g of whales?.dataGaps || []) misses.push({ module: 'WHALES', code: g, severity: 'KNOWN_GAP' });
  for (const m of missing) misses.push({ module: upper(m), code: 'MODULE_MISSING', severity: 'ERROR' });
  return { status: misses.length ? 'ISSUES_DECLARED' : 'NONE', count: misses.length, items: misses };
}

async function main() {
  const [whales, cabal, radar, risk, positions, external, intelligence] = await Promise.all(Object.values(FILES).map(read));
  const missing = Object.entries({ whales, cabal, radar, risk, positions, external, intelligence }).filter(([,v]) => !v).map(([k]) => k);
  const open = openPositions(positions);
  const rv = radarView(radar);
  const risks = riskView(risk);
  const cabalData = cabalView(cabal);
  const pnl = portfolioPnlView(positions, radar);
  const processMisses = processMissesView(cabal, radar, whales, missing);

  const out = {
    schemaVersion: '2.0',
    module: 'systemMasterReport',
    generatedAt: new Date().toISOString(),
    reportContract: {
      command: 'TODO',
      rule: 'TODO must expose every mandatory section. Never collapse the answer to only a few signals; empty modules must be declared NONE or DATA_GAP. No unsupported module may be silently omitted.',
      mandatorySections: [
        'systemHealth','marketRadar','cabalDiscovery','secondLegs','volumeTurnoverAnomalies','deepValidation',
        'whales','whalesDiscovery','whalesDeep','convergence','openPositions','portfolioPnl','positionRisk','fastDrop',
        'externalSignals','macroIntelligence','catalystsListings','processMisses','dataGaps','finalDecisionMatrix'
      ]
    },
    systemHealth: {
      status: missing.length ? 'PARTIAL' : 'PASS_WITH_DECLARED_GAPS',
      missingModules: missing,
      timestamps: {
        whales: whales?.generatedAt || null, cabal: cabal?.generatedAt || null, radar: radar?.generatedAt || null,
        risk: risk?.generatedAt || null, positions: positions?.updatedAt || null, external: external?.generatedAt || null, intelligence: intelligence?.generatedAt || null
      }
    },
    marketRadar: { scan: radar?.scan || null, assets: rv },
    cabalDiscovery: cabalData,
    secondLegs: { watch: cabalData.secondLegWatch, triggers: cabalData.secondLegTriggers },
    volumeTurnoverAnomalies: volumeTurnover(cabal),
    deepValidation: {
      cabal: { status: cabal ? 'AVAILABLE' : 'DATA_GAP', deepValidatedCount: cabal?.deepValidatedCount ?? null },
      whales: whales?.deepValidation || { status: 'DATA_GAP' }
    },
    whales: whales || { status: 'DATA_GAP' },
    whalesDiscovery: whales?.newWalletDiscovery || whales?.discovery || { status: 'DATA_GAP' },
    whalesDeep: whales?.deepValidation || { status: 'DATA_GAP' },
    convergence: { whale: whales?.actionableConvergence || [], whalesXCabal: whales?.cabalCross?.whalesXCabal || [] },
    openPositions: open,
    portfolioPnl: pnl,
    realizedPositions: realized(positions),
    positionRisk: risks,
    fastDrop: risks.filter((x) => x.fastDrop === true || x.fastDrop?.triggered === true),
    externalSignals: external?.externalSignals || external || { status: 'DATA_GAP' },
    macroIntelligence: intelligence?.newsOverlay || intelligence || { status: 'DATA_GAP' },
    catalystsListings: catalystsView(external, intelligence),
    processMisses,
    dataGaps: [...new Set([...(whales?.dataGaps || []), ...missing.map((x) => `MODULE_MISSING_${upper(x)}`), ...(pnl.warning ? ['PORTFOLIO_OPEN_MTM_INCOMPLETE'] : []), ...(catalystsView(external, intelligence).status === 'DATA_GAP' ? ['CATALYSTS_LISTINGS_NORMALIZED_FEED_MISSING'] : [])])],
    finalDecisionMatrix: {
      whaleHighConviction: (whales?.decisionTable || []).filter((x) => x.status === 'HIGH_CONVICTION_REVIEW'),
      whaleConvergence: (whales?.decisionTable || []).filter((x) => x.status === 'WHALE_CONVERGENCE'),
      cabalPilotEntries: cabalData.pilotEntries,
      secondLegTriggers: cabalData.secondLegTriggers,
      openPositionRiskActions: risks.filter((x) => ['REDUCE REVIEW','EXIT REVIEW','EXIT SIGNAL'].includes(String(x.action || '').toUpperCase())),
      rule: 'Final BUY candidates should preferably combine early CABAL structure, validated whale evidence, acceptable risk and no contradictory macro/data-quality flags. No module auto-executes.'
    }
  };

  await fs.writeFile(OUT, JSON.stringify(out, null, 2) + '\n');
  console.log('SYSTEM MASTER REPORT', out.generatedAt, out.systemHealth.status, 'sections=', out.reportContract.mandatorySections.length, 'open=', open.length, 'whaleConv=', out.convergence.whale.length, 'cabalPilot=', out.finalDecisionMatrix.cabalPilotEntries.length);
}

main().catch((err) => { console.error(err); process.exit(1); });
