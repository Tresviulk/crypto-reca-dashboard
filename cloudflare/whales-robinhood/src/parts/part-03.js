
function upper(value) {
  return String(value || "").toUpperCase();
}

function isHexAddress(value) {
  return /^0x[a-fA-F0-9]{40}$/.test(String(value || ""));
}

function internalAuthorized(request, env) {
  if (!env.WHALES_DEEP_TOKEN) return false;
  const got = request.headers.get("authorization") || "";
  const expected = "Bearer " + env.WHALES_DEEP_TOKEN;
  return constantTimeEqual(got, expected);
}

function parseIsoMs(value) {
  const t = Date.parse(value || "");
  return Number.isFinite(t) ? t : null;
}

function rowTimeMs(row) {
  return parseIsoMs(row.received_at || row.event_created_at);
}

async function readTokenSignals(env, base, contract, hours) {
  const cutoff = new Date(Date.now() - hours * 3600000).toISOString();
  const b = upper(base);
  const c = normalize(contract);

  const result = await env.DB.prepare(`
    SELECT
      id,
      wallet_label,
      wallet,
      tx_hash,
      classification,
      spent_asset,
      spent_value,
      spent_contract,
      received_asset,
      received_value,
      received_contract,
      event_created_at,
      received_at
    FROM whale_transactions
    WHERE
      (
        UPPER(COALESCE(received_asset, '')) = ?
        OR UPPER(COALESCE(spent_asset, '')) = ?
        OR (? <> '' AND LOWER(COALESCE(received_contract, '')) = ?)
        OR (? <> '' AND LOWER(COALESCE(spent_contract, '')) = ?)
      )
      AND COALESCE(received_at, event_created_at, '') >= ?
    ORDER BY id DESC
    LIMIT ?
  `).bind(
    b, b,
    c, c,
    c, c,
    cutoff,
    DEEP_MAX_ROWS
  ).all();

  return result.results || [];
}

function summarizeKnownWallets(rows, base, windowsHours) {
  const b = upper(base);
  const now = Date.now();

  const out = {};
  for (const hours of windowsHours) {
    const cutoff = now - hours * 3600000;
    const win = rows.filter((r) => {
      const t = rowTimeMs(r);
      return t !== null && t >= cutoff;
    });

    const buys = win.filter(
      (r) => r.classification === "BUY" && upper(r.received_asset) === b
    );
    const sells = win.filter(
      (r) => r.classification === "SELL" && upper(r.spent_asset) === b
    );

    const buyWallets = [...new Set(buys.map((r) => r.wallet_label).filter(Boolean))];
    const sellWallets = [...new Set(sells.map((r) => r.wallet_label).filter(Boolean))];

    const tokenBought = buys.reduce((s, r) => s + (Number(r.received_value) || 0), 0);
    const tokenSold = sells.reduce((s, r) => s + (Number(r.spent_value) || 0), 0);
    const quoteSpent = buys.reduce((s, r) => s + (Number(r.spent_value) || 0), 0);
    const quoteReceived = sells.reduce((s, r) => s + (Number(r.received_value) || 0), 0);

    out[String(hours) + "h"] = {
      signalCount: win.length,
      buyCount: buys.length,
      sellCount: sells.length,
      uniqueBuyWallets: buyWallets.length,
      uniqueSellWallets: sellWallets.length,
      buyWallets,
      sellWallets,
      tokenBought,
      tokenSold,
      netKnownWalletTokenFlow: tokenBought - tokenSold,
      quoteSpentOnBuys: quoteSpent,
      quoteReceivedOnSells: quoteReceived,
      convergence: buyWallets.length >= 2
    };
  }

  return out;
}

function contractFromKnownRows(rows, base) {
  const b = upper(base);
  for (const r of rows) {
    if (upper(r.received_asset) === b && isHexAddress(r.received_contract)) {
      return normalize(r.received_contract);
    }
    if (upper(r.spent_asset) === b && isHexAddress(r.spent_contract)) {
      return normalize(r.spent_contract);
    }
  }
  return null;
}

const CG_PLATFORM_BY_CHAIN = {
  ethereum: "ethereum",
  base: "base",
  arbitrum: "arbitrum-one",
  optimism: "optimistic-ethereum",
  polygon: "polygon-pos",
  bsc: "binance-smart-chain",
  avalanche: "avalanche"
};

async function resolveContractViaCoinGecko(env, base) {
  const chain = String(env.ALCHEMY_CHAIN || "ethereum").toLowerCase();
  const platform = CG_PLATFORM_BY_CHAIN[chain];

  if (!platform) {
    return {
      ok: false,
      reason: "UNSUPPORTED_ALCHEMY_CHAIN_FOR_COINGECKO_RESOLUTION",
      chain
    };
  }

  // For assets listed on KuCoin, use KuCoin's own public currency registry as
  // the identity source before any symbol-only fallback. This prevents a same-
  // ticker token on Ethereum from being mistaken for a KuCoin asset whose real
  // network is Solana/Base/etc.
  try {
    const kr = await fetch(
      "https://api.kucoin.com/api/ua/v2/market/currency?currency=" + encodeURIComponent(base),
      {
        headers: {
          accept: "application/json",
          "user-agent": "WHALES-DEEP/kucoin-chain-resolver"
        },
        cf: { cacheEverything: true, cacheTtl: 300 }
      }
    );

    if (kr.ok) {
      const kj = await kr.json();
      const kd = kj?.code === "200000" ? kj?.data : null;
      if (kd && upper(kd.currency) === upper(base)) {
        const chainRows = Array.isArray(kd.list)
          ? kd.list
          : Array.isArray(kd.chains)
            ? kd.chains
            : Array.isArray(kd.items)
              ? kd.items
              : [];

        if (chainRows.length) {
          const aliases = {
            ethereum: ["eth", "erc20", "ethereum"],
            base: ["base"],
            arbitrum: ["arb", "arbitrum", "arbitrum-one", "arbitrum one"],
            optimism: ["op", "optimism", "optimistic-ethereum"],
            polygon: ["matic", "polygon", "polygon-pos"],
            bsc: ["bsc", "bep20", "bnb smart chain", "binance-smart-chain"],
            avalanche: ["avax", "avalanche", "avalanche c-chain", "avax c-chain"]
          };
          const wanted = aliases[chain] || [chain];
          const normalizedRows = chainRows.map((row) => ({
            row,
            ids: [row?.chain, row?.chainId, row?.chainName]
              .filter(Boolean)
              .map((x) => String(x).toLowerCase())
          }));
          const observedChains = [...new Set(normalizedRows.flatMap((x) => x.ids))];
          const matching = normalizedRows.filter((x) =>
            x.ids.some((id) => wanted.some((alias) => id === alias || id.includes(alias)))
          );

          for (const match of matching) {
            const address = match?.row?.contractAddress;
            if (isHexAddress(address)) {
              return {
                ok: true,
                contract: normalize(address),
                chain,
                source: "KuCoinCurrencyRegistry",
                observedChains,
                kucoinChain: match?.row?.chain || match?.row?.chainId || match?.row?.chainName || null
              };
            }
          }

          if (!matching.length) {
            return {
              ok: false,
              reason: "TOKEN_NOT_ON_CONFIGURED_ALCHEMY_CHAIN",
              chain,
              source: "KuCoinCurrencyRegistry",
              observedChains
            };
          }

          return {
            ok: false,
            reason: "CONFIGURED_CHAIN_CONTRACT_ADDRESS_UNAVAILABLE",
            chain,
            source: "KuCoinCurrencyRegistry",
            observedChains
          };
        }
      }
    }
  } catch {
    // Continue to chain token-list/API fallbacks if the venue registry is not
    // reachable. No provider failure is promoted to a false positive contract.
  }

  // Prefer CoinGecko's chain-specific static token list. A unique exact-symbol
  // match on the configured chain is accepted as the canonical contract even
  // when eth_call(symbol()) is unavailable. This avoids turning a transient
  // RPC metadata failure into a false contract-resolution DATA_GAP.
  try {
    const lr = await fetch(
      "https://tokens.coingecko.com/" + encodeURIComponent(platform) + "/all.json",
      {
        headers: {
          accept: "application/json",
          "user-agent": "WHALES-DEEP/static-contract-resolver"
        },
        cf: { cacheEverything: true, cacheTtl: 300 }
      }
    );

    if (lr.ok) {
      const lj = await lr.json();
      const tokens = Array.isArray(lj?.tokens) ? lj.tokens : [];
      const exact = tokens.filter(
        (t) => upper(t?.symbol) === upper(base) && isHexAddress(t?.address)
      );

      if (exact.length === 1) {
        return {
          ok: true,
          contract: normalize(exact[0].address),
          chain,
          source: "CoinGeckoStaticTokenListUniqueExact",
          tokenListTimestamp: lj?.timestamp || null,
          tokenListExactMatches: 1,
          onChainValidation: "OPTIONAL_NOT_REQUIRED_FOR_UNIQUE_CHAIN_MATCH"
        };
      }
    }
  } catch {
    // Continue to the API fallback below. The caller preserves diagnostics from
    // the higher-level resolver when all providers fail.
  }

  const headers = {};
  if (env.COINGECKO_API_KEY) {
    headers["x-cg-demo-api-key"] = env.COINGECKO_API_KEY;
  }

  try {
    const sr = await fetch(
      "https://api.coingecko.com/api/v3/search?query=" + encodeURIComponent(base),
      { headers }
    );
    if (!sr.ok) {
      return { ok: false, reason: "COINGECKO_SEARCH_HTTP_" + sr.status, chain };
    }

    const sj = await sr.json();
    const coins = Array.isArray(sj.coins) ? sj.coins : [];
    const exact = coins
      .filter((x) => upper(x.symbol) === upper(base))
      .sort((a, b) => {
        const ar = Number.isFinite(Number(a.market_cap_rank)) ? Number(a.market_cap_rank) : 1e9;
        const br = Number.isFinite(Number(b.market_cap_rank)) ? Number(b.market_cap_rank) : 1e9;
        return ar - br;
      });

    if (!exact.length) {
      return { ok: false, reason: "COINGECKO_SYMBOL_NOT_RESOLVED", chain };
    }

    const coin = exact[0];
    const ir = await fetch(
      "https://api.coingecko.com/api/v3/coins/" + encodeURIComponent(coin.id) +
      "?localization=false&tickers=false&market_data=false&community_data=false&developer_data=false&sparkline=false",
      { headers }
    );

    if (!ir.ok) {
      return { ok: false, reason: "COINGECKO_INFO_HTTP_" + ir.status, chain, coinGeckoId: coin.id };
    }

    const info = await ir.json();
    const contract = info && info.platforms ? info.platforms[platform] : null;

    if (!isHexAddress(contract)) {
      return {
        ok: false,
        reason: "TOKEN_NOT_ON_CONFIGURED_ALCHEMY_CHAIN",
        chain,
        coinGeckoId: coin.id
      };
    }

