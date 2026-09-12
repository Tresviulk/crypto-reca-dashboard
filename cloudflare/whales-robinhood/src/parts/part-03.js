
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

