      { status: 503 }
    );
  }
  if (!internalAuthorized(request, env)) {
    return Response.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ ok: false, error: "Invalid JSON" }, { status: 400 });
  }

  if (body?.action !== "WHALES_DEEP") {
    return Response.json({ ok: false, error: "Unsupported action" }, { status: 400 });
  }

  const base = upper(body?.token?.base || body?.token?.symbol || "");
  if (!base) {
    return Response.json({ ok: false, error: "Token base missing" }, { status: 400 });
  }

  const windowsHours = Array.isArray(body.windowsHours)
    ? [...new Set(body.windowsHours.map(Number).filter((x) => [6, 24, 72].includes(x)))]
    : [6, 24, 72];

  if (!windowsHours.length) windowsHours.push(6, 24, 72);
  const maxHours = Math.max(...windowsHours);

  let requestedContract = isHexAddress(body?.token?.contract)
    ? normalize(body.token.contract)
    : null;

  let rows = await readTokenSignals(env, base, requestedContract, maxHours);
  let contract = requestedContract || contractFromKnownRows(rows, base);
  let contractResolution = contract
    ? { ok: true, contract, source: requestedContract ? "CABAL_REQUEST" : "KNOWN_WALLET_HISTORY" }
    : await resolveContractViaCoinGecko(env, base);

  if (!contract && contractResolution.ok) {
    contract = contractResolution.contract;
    rows = await readTokenSignals(env, base, contract, maxHours);
  }

  const known = summarizeKnownWallets(rows, base, windowsHours);
  const knownSignal = strongestKnownSignal(known);

  let tokenCentric;
  if (!contract) {
    tokenCentric = {
      status: "DATA_GAP",
      reason: contractResolution.reason || "TOKEN_CONTRACT_UNRESOLVED",
      chain: contractResolution.chain || String(env.ALCHEMY_CHAIN || "ethereum").toLowerCase()
    };
  } else {
    const transfers = await recentTokenTransfers(env, contract, maxHours);
    tokenCentric = analyzeTokenTransfers(env, contract, transfers);
  }

  let overall = knownSignal;
  if (
    overall === "NO_KNOWN_WALLET_SIGNAL" &&
    tokenCentric.status !== "DATA_GAP" &&
    Array.isArray(tokenCentric.knownWatchedWalletsWithPositiveNetFlow) &&
    tokenCentric.knownWatchedWalletsWithPositiveNetFlow.length >= 2
  ) {
    overall = "KNOWN_WALLET_FLOW_CONVERGENCE";
  }

  if (
    overall === "NO_KNOWN_WALLET_SIGNAL" &&
    tokenCentric.status !== "DATA_GAP" &&
    Array.isArray(tokenCentric.topNetInflows) &&
    tokenCentric.topNetInflows.length
  ) {
    overall = "UNVERIFIED_TOKEN_FLOW_ACTIVITY";
  }

  return Response.json({
    ok: true,
    service: "WHALES PROJECT - Robinhood Lean Monitor",
    patchVersion: WHALES_PATCH_VERSION,
    generatedAt: new Date().toISOString(),
    requestSource: body.source || null,
    token: {
      base,
      symbol: body?.token?.symbol || null,
      venue: body?.token?.venue || null,
      marketCap: body?.token?.marketCap ?? null,
      turnover24h: body?.token?.turnover24h ?? null,
      cabalClassification: body?.token?.classification || null,
      bucketHits: body?.token?.bucketHits || [],
      contract: contract || null,
      contractResolution
    },
    windowsHours,
    knownWallets: known,
    tokenCentric,
    overallWhaleStatus: overall,
    dataQuality:
      tokenCentric.status === "DATA_GAP"
        ? (knownSignal === "NO_KNOWN_WALLET_SIGNAL" ? "PARTIAL" : "PARTIAL_KNOWN_WALLETS_ONLY")
        : tokenCentric.status,
    interpretation:
      "Known-wallet BUY/SELL signals are reconstructed from the tracked-wallet transaction set. Token-centric net transfer flows are contextual evidence only and are not automatically classified as buys or whale accumulation."
  });
}

function buildWhaleCandidates(signals) {
  const groups = new Map();

  for (const s of signals) {
    if (s.classification !== "BUY") continue;
    const base = upper(s.received_asset);
    if (!base || isQuoteAsset(base)) continue;

    if (!groups.has(base)) {
      groups.set(base, {
        base,
        buyCount: 0,
        wallets: new Set(),
        lastSeen: null,
        contracts: new Set()
      });
    }

    const g = groups.get(base);
    g.buyCount++;
    if (s.wallet_label) g.wallets.add(s.wallet_label);
    if (isHexAddress(s.received_contract)) g.contracts.add(normalize(s.received_contract));

    const t = s.received_at || s.event_created_at || null;
    if (t && (!g.lastSeen || t > g.lastSeen)) g.lastSeen = t;
  }

  return [...groups.values()]
    .map((g) => ({
      base: g.base,
      buyCount: g.buyCount,
      walletCount: g.wallets.size,
      wallets: [...g.wallets],
      convergence: g.wallets.size >= 2,
      lastSeen: g.lastSeen,
      contracts: [...g.contracts]
    }))
    .sort((a, b) => {
      if (a.convergence !== b.convergence) return a.convergence ? -1 : 1;
      if (a.walletCount !== b.walletCount) return b.walletCount - a.walletCount;
      return b.buyCount - a.buyCount;
    });
}

async function handleCandidates(request, env, url) {
  if (!env.WHALES_DEEP_TOKEN) {
    return Response.json(
      { ok: false, error: "WHALES_DEEP_TOKEN_NOT_CONFIGURED" },
      { status: 503 }
    );
  }
  if (!internalAuthorized(request, env)) {
    return Response.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  const requested = Math.min(Math.max(parseInt(url.searchParams.get("limit") || "500"), 1), 1000);
  const minutes = Math.min(Math.max(parseInt(url.searchParams.get("minutes") || "180"), 1), 10080);
  const rows = await readLatestSignals(env, requested);

  const cutoff = Date.now() - minutes * 60000;
  const signals = rows.filter((row) => {
    const t = rowTimeMs(row);
    return t !== null && t >= cutoff;
  });

  return Response.json({
    ok: true,
    patchVersion: WHALES_PATCH_VERSION,
    generatedAt: new Date().toISOString(),
    minutes,
    rowsReadRequested: requested,
    candidateCount: buildWhaleCandidates(signals).length,
    candidates: buildWhaleCandidates(signals)
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/") {
      return Response.json({
        ok: true,
        service: "WHALES PROJECT - Robinhood Lean Monitor",
        status: "ready-v3",
        patchVersion: WHALES_PATCH_VERSION,
        watchedWallets: Object.keys(WATCHED_WALLETS).length,
        alchemySignatureProtection: true,
        databaseMode: "one-final-row-per-wallet-transaction",
        hotPathD1Reads: 0,
        deepEndpoint: "/deep",
