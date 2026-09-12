    return {
      ok: true,
      contract: normalize(contract),
      chain,
      coinGeckoId: coin.id,
      source: "CoinGecko"
    };
  } catch (error) {
    return { ok: false, reason: String(error), chain };
  }
}

const BLOCK_SECONDS = {
  ethereum: 12,
  base: 2,
  arbitrum: 0.25,
  optimism: 2,
  polygon: 2,
  bsc: 3,
  avalanche: 2
};

function getExcludedAddresses(env, contract) {
  const set = new Set([
    "0x0000000000000000000000000000000000000000",
    "0x000000000000000000000000000000000000dead",
    normalize(contract)
  ]);

  for (const raw of String(env.WHALES_EXCLUDED_ADDRESSES || "").split(",")) {
    const a = normalize(raw.trim());
    if (isHexAddress(a)) set.add(a);
  }

  return set;
}

async function recentTokenTransfers(env, contract, hours) {
  const chain = String(env.ALCHEMY_CHAIN || "ethereum").toLowerCase();
  const sec = BLOCK_SECONDS[chain];

  if (!env.ALCHEMY_RPC_URL) {
    return { ok: false, status: "DATA_GAP", reason: "ALCHEMY_RPC_URL_NOT_CONFIGURED", chain };
  }
  if (!sec) {
    return { ok: false, status: "DATA_GAP", reason: "UNSUPPORTED_CHAIN_BLOCK_TIME", chain };
  }

  try {
    const latestHex = await rpc(env, "eth_blockNumber", []);
    const latest = hexToBigInt(latestHex);
    const estimatedBlocks = BigInt(Math.ceil((hours * 3600 / sec) * 1.25));
    const from = latest > estimatedBlocks ? latest - estimatedBlocks : 0n;

    let pageKey = null;
    const transfers = [];
    let pages = 0;
    let truncated = false;

    do {
      const params = {
        fromBlock: "0x" + from.toString(16),
        toBlock: "latest",
        contractAddresses: [contract],
        category: ["erc20"],
        excludeZeroValue: true,
        withMetadata: true,
        maxCount: DEEP_TRANSFER_PAGE_SIZE
      };
      if (pageKey) params.pageKey = pageKey;

      const result = await rpc(env, "alchemy_getAssetTransfers", [params]);
      const batch = result && Array.isArray(result.transfers) ? result.transfers : [];
      transfers.push(...batch);
      pageKey = result ? result.pageKey : null;
      pages++;

      if (pageKey && pages >= DEEP_MAX_TRANSFER_PAGES) {
        truncated = true;
        break;
      }
    } while (pageKey);

    const cutoff = Date.now() - hours * 3600000;
    const recent = transfers.filter((x) => {
      const t = parseIsoMs(x && x.metadata && x.metadata.blockTimestamp);
      return t === null || t >= cutoff;
    });

    return {
      ok: true,
      status: truncated ? "PARTIAL" : "PASS",
      chain,
      fromBlock: "0x" + from.toString(16),
      latestBlock: latestHex,
      pages,
      truncated,
      transfers: recent
    };
  } catch (error) {
    return { ok: false, status: "DATA_GAP", reason: String(error), chain };
  }
}

function analyzeTokenTransfers(env, contract, transferResult) {
  if (!transferResult.ok) {
    return {
      status: transferResult.status || "DATA_GAP",
      reason: transferResult.reason || "TOKEN_TRANSFER_QUERY_FAILED",
      chain: transferResult.chain || null
    };
  }

  const excluded = getExcludedAddresses(env, contract);
  const net = new Map();
  let observedTransferUnits = 0;
  let usableTransfers = 0;

  const add = (address, delta) => {
    const a = normalize(address);
    if (!isHexAddress(a) || excluded.has(a)) return;
    net.set(a, (net.get(a) || 0) + delta);
  };

  for (const t of transferResult.transfers) {
    const value = Number(t && t.value);
    if (!Number.isFinite(value) || value <= 0) continue;

    usableTransfers++;
    observedTransferUnits += value;
    add(t.from, -value);
    add(t.to, value);
  }

  const rows = [...net.entries()]
    .map(([address, netTokenFlow]) => ({
      address,
      walletLabel: WATCHED_WALLETS[address] || null,
      netTokenFlow
    }))
    .filter((x) => x.netTokenFlow !== 0);

  const inflows = rows
    .filter((x) => x.netTokenFlow > 0)
    .sort((a, b) => b.netTokenFlow - a.netTokenFlow)
    .slice(0, 15);

  const outflows = rows
    .filter((x) => x.netTokenFlow < 0)
    .sort((a, b) => a.netTokenFlow - b.netTokenFlow)
    .slice(0, 15);

  const topKnownPositive = inflows.filter((x) => x.walletLabel);
  const provisionalCohort = inflows.slice(0, 10).map((x) => ({
    ...x,
    status: x.walletLabel ? "KNOWN_WALLET" : "UNVERIFIED_NET_INFLOW_CANDIDATE"
  }));

  return {
    status: transferResult.status,
    chain: transferResult.chain,
    pages: transferResult.pages,
    truncated: transferResult.truncated,
    transferCount: transferResult.transfers.length,
    usableTransferCount: usableTransfers,
    observedTransferUnits,
    topNetInflows: inflows,
    topNetOutflows: outflows,
    knownWatchedWalletsWithPositiveNetFlow: topKnownPositive,
    temporary72hCohort: provisionalCohort,
    interpretationWarning:
      "Net token transfer flow is not proof of a buy. Unlabelled addresses may be exchanges, bridges, treasury, LP, custody or internal routing unless independently identified.",
    addressLabelCoverage:
      env.WHALES_EXCLUDED_ADDRESSES
        ? "WATCHED_WALLETS_PLUS_USER_EXCLUSION_LIST"
        : "WATCHED_WALLETS_ONLY_LIMITED"
  };
}

function strongestKnownSignal(known) {
  const w6 = known["6h"] || {};
  const w24 = known["24h"] || {};
  const w72 = known["72h"] || {};

  if (w6.convergence || w24.convergence || w72.convergence) {
    return "KNOWN_WALLET_CONVERGENCE";
  }
  if ((w6.buyCount || 0) > 0 || (w24.buyCount || 0) > 0 || (w72.buyCount || 0) > 0) {
    return "KNOWN_WALLET_BUY";
  }
  if ((w6.sellCount || 0) > 0 || (w24.sellCount || 0) > 0 || (w72.sellCount || 0) > 0) {
    return "KNOWN_WALLET_SELL";
  }
  return "NO_KNOWN_WALLET_SIGNAL";
}

async function handleDeep(request, env) {
  if (!env.WHALES_DEEP_TOKEN) {
    return Response.json(
      { ok: false, error: "WHALES_DEEP_TOKEN_NOT_CONFIGURED" },
