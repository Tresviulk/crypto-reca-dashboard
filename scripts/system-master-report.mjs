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

function openPositions(p) {
  return (p?.positions || []).filter((x) => x.status === 'OPEN').map((x) => ({
    id: x.id, asset: upper(x.asset), pair: x.pair, venue: x.venue || 'COINBASE', engine: x.engine,
    qty: x.qty, entry: x.effectiveEntry ?? x.entry, totalCost: x.total, protection: x.protection,
    recommendedStop: x.recommendedStop ?? null, opened: x.openedEuropeMadrid || x.openedDateEuropeMadrid || null
  }));
}

function realized(p) {
  return (p?.positions || []).filter((x) => x.status === 'CLOSED' && x.realizedPnl).map((x) => ({ asset: upper(x.asset), pnl: x.realizedPnl.netPnl, pct: x.realizedPnl.pctOnCost ?? null, currency: x.realizedPnl.currency }));
}

function radarView(r) {
  return (r?.radar || []).map((x) => ({ asset: upper(x.asset), pair: x.pair, price: x.price ?? x.currentPrice ?? null, ers: x.ers ?? x.ERS ?? null, state: x.state ?? x.phase ?? null, decision: x.decision ?? x.action ?? x.entryDecision ?? null, dataQuality: x.dataQuality ?? null, rsi: x.rsi ?? x.RSI ?? null, rvol1h: x.rvol1h ?? null, trend1h: x.trend1h ?? x.trends?.h1 ?? null, trend4h: x.trend4h ?? x.trends?.h4 ?? null, trend1d: x.trend1d ?? x.trends?.d1 ?? null }));
}

function riskView(risk) {
  const obj = risk?.positionRisk?.positions || risk?.positions || {};
  return Object.entries(obj).map(([id, x]) => ({ id, asset: upper(x.asset), prs: x.prs ?? null, structuralState: x.structuralState ?? null, managementState: x.managementState ?? null, riskLevel: x.riskLevel ?? x.risk ?? null, action: x.action ?? x.advisory ?? null, protection: x.protection ?? null, fastDrop: x.fastDrop ?? x['FAST-DROP'] ?? null, modeledLoss: x.modeledLoss ?? null }));
}

function cabalView(c) {
  const rows = c?.candidates || [];
  return {
    generatedAt: c?.generatedAt || null, ok: c?.ok ?? null, coverage: c?.coverage || null,
    stageA: c?.candidateCountStageA ?? null, deepValidated: c?.deepValidatedCount ?? null, btcReference: c?.btcReference || null,
    leaders: rows.slice(0, 20).map((x) => ({ asset: upper(x.asset), price: x.price, score: x.stageAScore, classification: x.classification, signal: x.executionSignal, urgency: x.decisionUrgency, rvol1h: x.rvol1h, rvol4h: x.rvol4h, p1: x.priceChange1hPct, p4: x.priceChange4hPct, p24: x.priceChange24hPct, secondLeg: x.secondLegTrigger })),
    pilotEntries: rows.filter((x) => x.executionSignal === 'PILOT_ENTRY_WINDOW').slice(0, 20).map((x) => ({ asset: upper(x.asset), price: x.price, score: x.stageAScore, pilotEntryMax: x.pilotEntryMax, confirm: x.confirmationAddTrigger, stop: x.protectiveStopReference })),
    secondLegTriggers: rows.filter((x) => x.secondLegTrigger === true).slice(0, 20).map((x) => ({ asset: upper(x.asset), price: x.price, score: x.stageAScore }))
  };
}

async function main() {
  const [whales, cabal, radar, risk, positions, external, intelligence] = await Promise.all(Object.values(FILES).map(read));
  const missing = Object.entries({ whales, cabal, radar, risk, positions, external, intelligence }).filter(([,v]) => !v).map(([k]) => k);
  const open = openPositions(positions);
  const rv = radarView(radar);
  const risks = riskView(risk);

  const out = {
    schemaVersion: '1.0',
    module: 'systemMasterReport',
    generatedAt: new Date().toISOString(),
    reportContract: {
      command: 'TODO',
      rule: 'TODO must expose every mandatory section. Never collapse the answer to only a few signals; empty modules must be declared NONE or DATA_GAP.',
      mandatorySections: ['systemHealth','marketRadar','cabalDiscovery','secondLegs','whales','whalesDiscovery','convergence','openPositions','positionRisk','fastDrop','externalSignals','macroIntelligence','dataGaps','finalDecisionMatrix']
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
    cabalDiscovery: cabalView(cabal),
    secondLegs: cabalView(cabal).secondLegTriggers,
    whales: whales || { status: 'DATA_GAP' },
    whalesDiscovery: whales?.discovery || { status: 'DATA_GAP' },
    convergence: { whale: whales?.actionableConvergence || [], whalesXCabal: whales?.cabalCross?.whalesXCabal || [] },
    openPositions: open,
    realizedPositions: realized(positions),
    positionRisk: risks,
    fastDrop: risks.filter((x) => x.fastDrop === true || x.fastDrop?.triggered === true),
    externalSignals: external?.externalSignals || external || { status: 'DATA_GAP' },
    macroIntelligence: intelligence?.newsOverlay || intelligence || { status: 'DATA_GAP' },
    dataGaps: [...new Set([...(whales?.dataGaps || []), ...missing.map((x) => `MODULE_MISSING_${upper(x)}`)])],
    finalDecisionMatrix: {
      whaleHighConviction: (whales?.decisionTable || []).filter((x) => x.status === 'HIGH_CONVICTION_REVIEW'),
      whaleConvergence: (whales?.decisionTable || []).filter((x) => x.status === 'WHALE_CONVERGENCE'),
      cabalPilotEntries: cabalView(cabal).pilotEntries,
      secondLegTriggers: cabalView(cabal).secondLegTriggers,
      openPositionRiskActions: risks.filter((x) => ['REDUCE REVIEW','EXIT REVIEW','EXIT SIGNAL'].includes(String(x.action || '').toUpperCase())),
      rule: 'A final BUY candidate should preferably combine early structure/CABAL with validated whale evidence and acceptable portfolio/macro risk. No module auto-executes.'
    }
  };

  await fs.writeFile(OUT, JSON.stringify(out, null, 2) + '\n');
  console.log('SYSTEM MASTER REPORT', out.generatedAt, out.systemHealth.status, 'open=', open.length, 'whaleConv=', out.convergence.whale.length, 'cabalPilot=', out.finalDecisionMatrix.cabalPilotEntries.length);
}

main().catch((err) => { console.error(err); process.exit(1); });
