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
    headers: { 'accept': 'application/json', 'user-agent': 'WHALES-DEEP-PERSIST/1.0' },
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
    const requestGaps = results.filter((x) => x.requestStatus !== 'OK');
    const knownSignals = okResults.filter((x) => isMeaningfulKnownSignal(x.overallWhaleStatus));
    const contextual = okResults.filter((x) => upper(x.overallWhaleStatus) === 'UNVERIFIED_TOKEN_FLOW_ACTIVITY');
    const noKnownSignal = okResults.filter((x) => upper(x.overallWhaleStatus) === 'NO_KNOWN_WALLET_SIGNAL');

    const out = {
      schemaVersion: '1.0',
      module: 'whalesDeepPersistence',
      version: 'WHALES_DEEP_PERSIST_V1_2026-09-12',
      generatedAt,
      runStatus: requestGaps.length ? 'PARTIAL' : 'PASS',
      source: {
        transport: 'CABAL_WORKER_EMBEDDED_WHALES_DEEP',
        cabalWorker: CABAL_URL,
        cabalGeneratedAt: cabal?.generatedAt || null,
        cabalPatchVersion: cabal?.patchVersion || null,
        cabalCoverage: cabal?.coverage || null,
        reason: 'CABAL already holds the protected WHALES_DEEP token in Cloudflare and calls the authenticated /deep endpoint internally. This persistence layer stores those returned 6h/24h/72h results without exposing the shared token.'
      },
      windowsExpectedHours: EXPECTED_WINDOWS,
      scan: {
        candidateCount: candidates.length,
        requestedCount: triggered.length,
        okCount: okResults.length,
        requestGapCount: requestGaps.length,
        meaningfulKnownSignalCount: knownSignals.length,
        contextualFlowCount: contextual.length,
        noKnownSignalCount: noKnownSignal.length
      },
      results,
      meaningfulKnownSignals: knownSignals,
      contextualFlowActivity: contextual,
      requestGaps,
      persistence: {
        persistedResultsAvailable: true,
        sourceFreshness: 'CURRENT_RUN',
        previousGeneratedAt: previous?.generatedAt || null
      },
      interpretation: 'WHALES DEEP is token-centric Ethereum validation over 6h/24h/72h. Known-wallet signals are stronger evidence; token transfer flows remain contextual and are never automatically relabeled as buys or accumulation.'
    };

    await fs.mkdir('data', { recursive: true });
    await fs.writeFile(OUT, JSON.stringify(out, null, 2) + '\n');
    console.log('WHALES DEEP PERSIST PASS', JSON.stringify(out.scan));
  } catch (err) {
    const carried = Array.isArray(previous?.results) ? previous.results : [];
    const out = {
      schemaVersion: '1.0',
      module: 'whalesDeepPersistence',
      version: 'WHALES_DEEP_PERSIST_V1_2026-09-12',
      generatedAt,
      runStatus: 'ERROR',
      source: {
        transport: 'CABAL_WORKER_EMBEDDED_WHALES_DEEP',
        cabalWorker: CABAL_URL,
        error: String(err)
      },
      windowsExpectedHours: EXPECTED_WINDOWS,
      scan: {
        candidateCount: null,
        requestedCount: null,
        okCount: null,
        requestGapCount: null,
        meaningfulKnownSignalCount: null,
        contextualFlowCount: null,
        noKnownSignalCount: null
      },
      results: carried,
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
