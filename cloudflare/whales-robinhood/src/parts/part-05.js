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

  async function resolveContractViaDexScreener(baseSymbol, referenceMarketCap) {
    const chain = String(env.ALCHEMY_CHAIN || "ethereum").toLowerCase();
    const dexChainByAlchemy = {
      ethereum: "ethereum",
      base: "base",
      arbitrum: "arbitrum",
      optimism: "optimism",
      polygon: "polygon",
      bsc: "bsc",
      avalanche: "avalanche"
    };
    const dexChain = dexChainByAlchemy[chain];

    if (!dexChain) {
      return { ok: false, reason: "UNSUPPORTED_ALCHEMY_CHAIN_FOR_DEXSCREENER_RESOLUTION", chain };
    }

    try {
      const r = await fetch(
        "https://api.dexscreener.com/latest/dex/search?q=" + encodeURIComponent(baseSymbol),
        {
          headers: {
            accept: "application/json",
            "user-agent": "WHALES-DEEP/contract-resolver"
          }
        }
      );

      if (!r.ok) {
        return { ok: false, reason: "DEXSCREENER_SEARCH_HTTP_" + r.status, chain, source: "DexScreener" };
      }

      const j = await r.json();
      const pairs = Array.isArray(j?.pairs) ? j.pairs : [];
      const wanted = upper(baseSymbol);
      const exact = [];

      for (const pair of pairs) {
        const pairChain = String(pair?.chainId || "").toLowerCase();
        const candidates = [
          { side: "base", token: pair?.baseToken },
          { side: "quote", token: pair?.quoteToken }
        ];

        for (const c of candidates) {
          if (upper(c?.token?.symbol) !== wanted) continue;
          exact.push({ pair, pairChain, side: c.side, token: c.token });
        }
      }

      const observedChains = [...new Set(exact.map((x) => x.pairChain).filter(Boolean))];
      const sameChain = exact.filter(
        (x) => x.pairChain === dexChain && isHexAddress(x?.token?.address)
      );

      if (!sameChain.length) {
        return {
          ok: false,
          reason: observedChains.length ? "TOKEN_NOT_ON_CONFIGURED_ALCHEMY_CHAIN" : "DEXSCREENER_SYMBOL_NOT_RESOLVED",
          chain,
          dexChain,
          observedChains,
          source: "DexScreener"
        };
      }

      const refMcap = Number(referenceMarketCap);
      const hasRefMcap = Number.isFinite(refMcap) && refMcap > 0;
      const grouped = new Map();

      for (const row of sameChain) {
        const address = normalize(row.token.address);
        const liquidityUsd = Number(row?.pair?.liquidity?.usd) || 0;
        const marketCap = row.side === "base"
          ? (Number(row?.pair?.marketCap) || Number(row?.pair?.fdv) || null)
          : null;
        const marketCapDistance = hasRefMcap && marketCap && marketCap > 0
          ? Math.abs(Math.log(marketCap / refMcap))
          : null;

        const prev = grouped.get(address) || {
          address,
          liquidityUsd: 0,
          bestMarketCapDistance: null,
          marketCap: null,
          pairCount: 0
        };

        prev.liquidityUsd += liquidityUsd;
        prev.pairCount += 1;
        if (
          marketCapDistance !== null &&
          (prev.bestMarketCapDistance === null || marketCapDistance < prev.bestMarketCapDistance)
        ) {
          prev.bestMarketCapDistance = marketCapDistance;
          prev.marketCap = marketCap;
        }
        grouped.set(address, prev);
      }

      const ranked = [...grouped.values()].sort((a, b) => {
        if (hasRefMcap) {
          const ad = a.bestMarketCapDistance === null ? 1e9 : a.bestMarketCapDistance;
          const bd = b.bestMarketCapDistance === null ? 1e9 : b.bestMarketCapDistance;
          if (ad !== bd) return ad - bd;
        }
        if (a.liquidityUsd !== b.liquidityUsd) return b.liquidityUsd - a.liquidityUsd;
        return b.pairCount - a.pairCount;
      });

      const validationErrors = [];
      for (const candidate of ranked.slice(0, 8)) {
        const meta = await getTokenMetadata(env, candidate.address);
        if (upper(meta?.symbol) === wanted) {
          return {
            ok: true,
            contract: candidate.address,
            chain,
            dexChain,
            source: "DexScreener+OnChainSymbolValidation",
            liquidityUsd: candidate.liquidityUsd,
            pairCount: candidate.pairCount,
            marketCap: candidate.marketCap,
            referenceMarketCap: hasRefMcap ? refMcap : null
          };
        }
        validationErrors.push({ address: candidate.address, observedSymbol: meta?.symbol || null });
      }

      return {
        ok: false,
        reason: "DEXSCREENER_ONCHAIN_SYMBOL_VALIDATION_FAILED",
        chain,
        dexChain,
        observedChains,
        validationErrors,
        source: "DexScreener"
      };
    } catch (error) {
      return { ok: false, reason: "DEXSCREENER_ERROR:" + String(error), chain, source: "DexScreener" };
    }
  }

  async function resolveContractRobust(baseSymbol, referenceMarketCap) {
    const dex = await resolveContractViaDexScreener(baseSymbol, referenceMarketCap);
    if (dex.ok) return dex;

    const cg = await resolveContractViaCoinGecko(env, baseSymbol);
    if (cg.ok) {
      return {
        ...cg,
        source: "CoinGeckoFallback",
        primaryResolverFailure: dex.reason || null
      };
    }

    const preferDexReason = [
      "TOKEN_NOT_ON_CONFIGURED_ALCHEMY_CHAIN",
      "DEXSCREENER_ONCHAIN_SYMBOL_VALIDATION_FAILED",
      "DEXSCREENER_SYMBOL_NOT_RESOLVED"
    ].includes(dex.reason);

    return {
      ok: false,
      reason: preferDexReason ? dex.reason : (cg.reason || dex.reason || "TOKEN_CONTRACT_UNRESOLVED"),
      chain: dex.chain || cg.chain || String(env.ALCHEMY_CHAIN || "ethereum").toLowerCase(),
      source: "DexScreenerThenCoinGecko",
      observedChains: dex.observedChains || [],
      dexScreenerReason: dex.reason || null,
      coinGeckoReason: cg.reason || null
    };
  }

  let rows = await readTokenSignals(env, base, requestedContract, maxHours);
  let contract = requestedContract || contractFromKnownRows(rows, base);
  let contractResolution = contract
    ? { ok: true, contract, source: requestedContract ? "CABAL_REQUEST" : "KNOWN_WALLET_HISTORY" }
    : await resolveContractRobust(base, body?.token?.marketCap);

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
      chain: contractResolution.chain || String(env.ALCHEMY_CHAIN || "ethereum").toLowerCase(),
      observedChains: contractResolution.observedChains || [],
      resolver: contractResolution.source || null
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
      "Known-wallet BUY/SELL signals are reconstructed from the tracked-wallet transaction set. Contract resolution uses DexScreener first with on-chain symbol validation and only falls back to CoinGecko. Token-centric net transfer flows are contextual evidence only and are not automatically classified as buys or whale accumulation."
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