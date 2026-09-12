        candidatesEndpoint: "/candidates",
        deepAuthConfigured: !!env.WHALES_DEEP_TOKEN,
        alchemyChain: String(env.ALCHEMY_CHAIN || "ethereum").toLowerCase(),
        timestamp: new Date().toISOString()
      });
    }

    if (request.method === "GET" && url.pathname === "/candidates") {
      return handleCandidates(request, env, url);
    }

    if (request.method === "GET" && (url.pathname === "/signals" || url.pathname === "/summary")) {
      const requested = Math.min(Math.max(parseInt(url.searchParams.get("limit") || "500"), 1), 1000);
      const rows = await readLatestSignals(env, requested);
      const signals = filterSignals(rows, url);

      if (url.pathname === "/summary") {
        const summary = buildSummary(signals);
        return Response.json({
          ok: true,
          patchVersion: WHALES_PATCH_VERSION,
          rowsReadRequested: requested,
          signalCount: signals.length,
          buys: summary.buys,
          sells: summary.sells,
          convergence: summary.convergence
        });
      }

      return Response.json({
        ok: true,
        patchVersion: WHALES_PATCH_VERSION,
        rowsReadRequested: requested,
        count: signals.length,
        signals
      });
    }

    if (request.method === "POST" && url.pathname === "/deep") {
      return handleDeep(request, env);
    }

    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405 });
    }

    // Existing Alchemy webhook hot path remains unchanged in principle:
    // raw body + HMAC verification + one final D1 row per watched-wallet transaction.
    let rawBody;
    try {
      rawBody = await request.text();
    } catch {
      return Response.json({ ok: false, error: "Invalid body" }, { status: 400 });
    }

    const signature = request.headers.get("x-alchemy-signature");
    const validSignature = await verifyAlchemySignature(rawBody, signature, env.ALCHEMY_SIGNING_KEY);

    if (!validSignature) {
      return Response.json({ ok: false, error: "Unauthorized" }, { status: 401 });
    }

    let payload;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      return Response.json({ ok: false, error: "Invalid JSON" }, { status: 400 });
    }

    const activity = payload?.event?.activity || [];
    const uniqueTransactions = new Map();

    for (const item of activity) {
      const from = normalize(item.fromAddress);
      const to = normalize(item.toAddress);
      const fromLabel = WATCHED_WALLETS[from];
      const toLabel = WATCHED_WALLETS[to];

      if (!item.hash || (!fromLabel && !toLabel)) continue;

      if (fromLabel) {
        uniqueTransactions.set(`${fromLabel}|${item.hash}`, {
          walletLabel: fromLabel,
          walletAddress: from,
          txHash: item.hash
        });
      }

      if (toLabel) {
        uniqueTransactions.set(`${toLabel}|${item.hash}`, {
          walletLabel: toLabel,
          walletAddress: to,
          txHash: item.hash
        });
      }
    }

    let saved = 0;
    let failed = 0;
    const newBuyCandidates = [];

    for (const txInfo of uniqueTransactions.values()) {
      try {
        const result = await saveFinalSignal(
          env,
          txInfo.walletLabel,
          txInfo.walletAddress,
          txInfo.txHash,
          payload.createdAt || null
        );
        saved++;

        if (
          result.classification === "BUY" &&
          result.received &&
          !isQuoteAsset(result.received.asset)
        ) {
          newBuyCandidates.push({
            base: upper(result.received.asset),
            walletLabel: txInfo.walletLabel,
            txHash: txInfo.txHash,
            contract: result.received.contract || null
          });
        }
      } catch (error) {
        failed++;
        console.error("WHALES tx processing failed", txInfo.txHash, String(error));
      }
    }

    // Valid Alchemy webhook always receives 200 even if RPC/D1 had a transient failure.
    return Response.json({
      ok: true,
      authenticated: true,
      patchVersion: WHALES_PATCH_VERSION,
      uniqueTransactions: uniqueTransactions.size,
      saved,
      failed,
      newBuyCandidates
    });
  }
};
