import fs from 'node:fs/promises';

const CABAL_URL = process.env.CABAL_WORKER_URL || 'https://cabal-scanner.diondublin21.workers.dev/';
const OUT = process.env.WHALES_DEEP_OUT || 'data/whales-deep-state.json';
const EXPECTED_WINDOWS = [6, 24, 72];

async function readJson(path, fallback = null) {
  try { return JSON.parse(await fs.readFile(path, 'utf8')); } catch { return fallback; }
}

function upper(x) { return String(x || '').trim().toUpperCase(); }

function compactCandidate(c) {
  return {
    asset: upper(c?.base || c?.asset),
    venue: c?.venue || null,
    symbol: c?.venueSymbol || c?.symbol || null,
    classification: c?.classification || null,
    stageAScore: c?.stageAScore ?? c?.score ?? null,
    marketCap: c?.marketCap ?? null,
    turnover24h: c?.turnover24h ?? c?.volume24h ?? null,
    bucketHits: Array.isArray(c?.bucketHits) ? c.bucketHits : [],
    executionSignal: c?.executionSignal || null,
    decisionUrgency: c?.decisionUrgency || null
  };
}

function normalizeDeepResult(c) {
  const w = c?.whales || {};
  const d = w?.data || null;
  return {
    candidate: compactCandidate(c),
    requested: Boolean(w?.requested),
    requestStatus: w?.status || 'UNKNOWN',
    requestReason: w?.reason || null,
    queue: {
      queueRank: w?.queueRank ?? null,
      selectedThisBatch: w?.selectedThisBatch ?? (w?.status === 'OK' ? true : null),
      rotationBatchIndex: w?.rotationBatchIndex ?? null,
      rotationBatchCount: w?.rotationBatchCount ?? null,
      rotationSlotMinutes: w?.rotationSlotMinutes ?? null
    },
    resultGeneratedAt: d?.generatedAt || null,
    windowsHours: Array.isArray(d?.windowsHours) && d.windowsHours.length ? d.windowsHours : EXPECTED_WINDOWS,
    overallWhaleStatus: d?.overallWhaleStatus || null,
    dataQuality: d?.dataQuality || null,
    token: d?.token || null,
    knownWallets: d?.knownWallets || null,
    tokenCentric: d?.tokenCentric || null,
    interpretation: d?.interpretation || null
  };
}

function isMeaningfulKnownSignal(status) {
  const s = upper(status);
  if (!s) return false;
  return !['NO_KNOWN_WALLET_SIGNAL', 'UNVERIFIED_TOKEN_FLOW_ACTIVITY', 'DATA_GAP'].includes(s);
}

async function fetchCabal() {
  const r = await fetch(CABAL_URL, {
    method: 'GET',
    headers: { 'accept': 'application/json', 'user-agent': 'WHALES-DEEP-PERSIST/1.3' },
    signal: AbortSignal.timeout(180_000)
  });
  if (!r.ok) throw new Error(`CABAL_HTTP_${r.status}`);
  const j = await r.json();
  if (!j?.ok) throw new Error(`CABAL_NOT_OK:${j?.error || 'unknown'}`);
  return j;
}

async function main() {
  const previous = await readJson(OUT, null);
  const generatedAt = new Date().toISOString();

  try {
    const cabal = await fetchCabal();
    const candidates = Array.isArray(cabal?.candidates) ? cabal.candidates : [];
    const triggered = candidates.filter((c) => c?.whales?.requested === true);
    const results = triggered.map(normalizeDeepResult);
    const okResults = results.filter((x) => x.requestStatus === 'OK' && x.resultGeneratedAt);
    const capacityQueued = results.filter((x) => x.requestStatus === 'QUEUED_LIMIT' || x.requestReason === 'MAX_WHALE_REQUESTS_REACHED' || x.requestReason === 'ROTATING_QUEUE_WAIT');
    const requestGaps = results.filter((x) => x.requestStatus !== 'OK' && x.requestStatus !== 'QUEUED_LIMIT' && x.requestReason !== 'MAX_WHALE_REQUESTS_REACHED' && x.requestReason !== 'ROTATING_QUEUE_WAIT');
    const knownSignals = okResults.filter((x) => isMeaningfulKnownSignal(x.overallWhaleStatus));
    const contextual = okResults.filter((x) => upper(x.overallWhaleStatus) === 'UNVERIFIED_TOKEN_FLOW_ACTIVITY');
    const noKnownSignal = okResults.filter((x) => upper(x.overallWhaleStatus) === 'NO_KNOWN_WALLET_SIGNAL');
    const processedCoveragePct = triggered.length ? Number((okResults.length / triggered.length * 100).toFixed(2)) : 100;
    const tr = cabal?.truncation || {};

    const out = {
      schemaVersion: '1.3',
      module: 'whalesDeepPersistence',
      version: 'WHALES_DEEP_PERSIST_V1_3_ROTATING_QUEUE_2026-09-12',
      generatedAt,
      runStatus: requestGaps.length ? 'PARTIAL' : 'PASS',
      source: {
        transport: 'CABAL_WORKER_EMBEDDED_WHALES_DEEP',
        cabalWorker: CABAL_URL,
        cabalGeneratedAt: cabal?.generatedAt || null,
        cabalPatchVersion: cabal?.patchVersion || null,
        cabalCoverage: cabal?.coverage || null,
        whaleRequestCap: tr?.whaleRequestCap ?? null,
        queueMode: tr?.whaleRotationBatchCount != null ? 'PRIORITY_RESERVE_PLUS_ROTATING_QUEUE' : 'LEGACY_TOP_N',
        reason: 'CABAL keeps the highest-priority DEEP names continuously covered and rotates the remaining capacity through the rest of the qualifying queue. QUEUED_LIMIT means waiting for a scheduled rotating batch, not a provider failure.'
      },
      windowsExpectedHours: EXPECTED_WINDOWS,
      rotation: {
        enabled: tr?.whaleRotationBatchCount != null,
        eligibleTotal: tr?.whaleEligibleTotal ?? triggered.length,
        priorityReserve: tr?.whalePriorityReserve ?? null,
        rotatingSlots: tr?.whaleRotationSlots ?? null,
        rotationPoolSize: tr?.whaleRotationPoolSize ?? null,
        batchIndex: tr?.whaleRotationBatchIndex ?? null,
        batchCount: tr?.whaleRotationBatchCount ?? null,
        slotMinutes: tr?.whaleRotationSlotMinutes ?? null,
        estimatedFullRotationMinutes: tr?.whaleRotationCoverageMinutes ?? null,
        queuedThisRun: capacityQueued.length
      },
      scan: {
        candidateCount: candidates.length,
        triggerCount: triggered.length,
        requestedCount: triggered.length,
        processedCount: okResults.length,
        okCount: okResults.length,
        capacityQueuedCount: capacityQueued.length,
        processedCoveragePct,
        requestGapCount: requestGaps.length,
        meaningfulKnownSignalCount: knownSignals.length,
        contextualFlowCount: contextual.length,
        noKnownSignalCount: noKnownSignal.length
      },
      results: okResults,
      capacityQueue: capacityQueued,
      meaningfulKnownSignals: knownSignals,
      contextualFlowActivity: contextual,
      requestGaps,
      persistence: {
        persistedResultsAvailable: okResults.length > 0,
        sourceFreshness: 'CURRENT_RUN',
        previousGeneratedAt: previous?.generatedAt || null,
        previousRotationBatchIndex: previous?.rotation?.batchIndex ?? null
      },
      interpretation: 'WHALES DEEP runs 6h/24h/72h validation. Two highest-priority qualifying names are continuously reserved; remaining DEEP slots rotate every scheduled interval through the queue. Token transfer flows remain contextual and are never automatically relabeled as buys or accumulation.'
    };

    await fs.mkdir('data', { recursive: true });
    await fs.writeFile(OUT, JSON.stringify(out, null, 2) + '\n');
    console.log('WHALES DEEP PERSIST PASS', JSON.stringify({scan: out.scan, rotation: out.rotation}));
  } catch (err) {
    const carried = Array.isArray(previous?.results) ? previous.results : [];
    const out = {
      schemaVersion: '1.3',
      module: 'whalesDeepPersistence',
      version: 'WHALES_DEEP_PERSIST_V1_3_ROTATING_QUEUE_2026-09-12',
      generatedAt,
      runStatus: 'ERROR',
      source: {
        transport: 'CABAL_WORKER_EMBEDDED_WHALES_DEEP',
        cabalWorker: CABAL_URL,
        error: String(err)
      },
      windowsExpectedHours: EXPECTED_WINDOWS,
      rotation: previous?.rotation || { enabled: null },
      scan: {
        candidateCount: null,
        triggerCount: null,
        requestedCount: null,
        processedCount: null,
        okCount: null,
        capacityQueuedCount: null,
        processedCoveragePct: null,
        requestGapCount: null,
        meaningfulKnownSignalCount: null,
        contextualFlowCount: null,
        noKnownSignalCount: null
      },
      results: carried,
      capacityQueue: [],
      meaningfulKnownSignals: [],
      contextualFlowActivity: [],
      requestGaps: [],
      persistence: {
        persistedResultsAvailable: carried.length > 0,
        sourceFreshness: carried.length ? 'STALE_CARRY_FORWARD' : 'NO_RESULTS',
        previousGeneratedAt: previous?.generatedAt || null,
        previousSourceGeneratedAt: previous?.source?.cabalGeneratedAt || null
      },
      interpretation: 'The current synchronization failed. Any carried results are retained only as stale context and must not be presented as fresh WHALES DEEP evidence.'
    };
    await fs.mkdir('data', { recursive: true });
    await fs.writeFile(OUT, JSON.stringify(out, null, 2) + '\n');
    console.error('WHALES DEEP PERSIST ERROR', String(err));
    process.exitCode = 2;
  }
}

main();