    return { classification: "UNKNOWN", spent: null, received: null, flows: [] };
  }

  const flows = [];

  const nativeValue = hexToBigInt(tx.value);
  if (nativeValue > 0n) {
    if (normalize(tx.from) === wallet) {
      flows.push({ direction: "OUT", asset: "ETH", contract: null, value: Number(nativeValue) / 1e18 });
    } else if (normalize(tx.to) === wallet) {
      flows.push({ direction: "IN", asset: "ETH", contract: null, value: Number(nativeValue) / 1e18 });
    }
  }

  for (const log of receipt.logs || []) {
    if (!log.topics || log.topics.length < 3) continue;
    if (normalize(log.topics[0]) !== TRANSFER_TOPIC) continue;

    const from = topicToAddress(log.topics[1]);
    const to = topicToAddress(log.topics[2]);
    const fromWallet = normalize(from) === wallet;
    const toWallet = normalize(to) === wallet;

    if (!fromWallet && !toWallet) continue;

    const contract = normalize(log.address);
    const meta = await getTokenMetadata(env, contract);
    const value = formatUnits(hexToBigInt(log.data), meta.decimals);

    if (value === null || value <= 0) continue;

    flows.push({
      direction: fromWallet ? "OUT" : "IN",
      asset: meta.symbol,
      contract,
      value
    });
  }

  const incoming = flows.filter((f) => f.direction === "IN");
  const outgoing = flows.filter((f) => f.direction === "OUT");
  const quoteIn = incoming.filter((f) => isQuoteAsset(f.asset));
  const quoteOut = outgoing.filter((f) => isQuoteAsset(f.asset));
  const tokenIn = incoming.filter((f) => !isQuoteAsset(f.asset));
  const tokenOut = outgoing.filter((f) => !isQuoteAsset(f.asset));

  let classification = "CONTRACT_INTERACTION";
  let spent = null;
  let received = null;

  if (quoteOut.length > 0 && tokenIn.length > 0 && tokenOut.length === 0 && quoteIn.length === 0) {
    classification = "BUY";
    spent = pickLargest(quoteOut);
    received = pickLargest(tokenIn);
  } else if (tokenOut.length > 0 && quoteIn.length > 0 && tokenIn.length === 0 && quoteOut.length === 0) {
    classification = "SELL";
    spent = pickLargest(tokenOut);
    received = pickLargest(quoteIn);
  } else if (tokenOut.length === 1 && tokenIn.length === 1 && quoteOut.length === 0 && quoteIn.length === 0) {
    classification = "SWAP_TOKEN_TO_TOKEN";
    spent = tokenOut[0];
    received = tokenIn[0];
  } else if (tokenIn.length > 0 && outgoing.length === 0) {
    classification = "TRANSFER_IN";
    received = pickLargest(tokenIn);
  } else if (tokenOut.length > 0 && incoming.length === 0) {
    classification = "TRANSFER_OUT";
    spent = pickLargest(tokenOut);
  } else if (tokenIn.length === 0 && tokenOut.length === 0 && (quoteIn.length > 0 || quoteOut.length > 0)) {
    classification = "QUOTE_TRANSFER";
    spent = pickLargest(quoteOut);
    received = pickLargest(quoteIn);
  } else if (flows.length > 0) {
    classification = "COMPLEX";
    spent = pickLargest(outgoing);
    received = pickLargest(incoming);
  }

  return { classification, spent, received, flows };
}

async function saveFinalSignal(env, walletLabel, walletAddress, txHash, eventCreatedAt) {
  const result = await reconstructTransaction(env, walletAddress, txHash);
  const receivedAt = new Date().toISOString();

  await env.DB.prepare(`
    INSERT INTO whale_transactions (
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
      received_at,
      raw_group_json
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(wallet_label, tx_hash)
    DO UPDATE SET
      classification = excluded.classification,
      spent_asset = excluded.spent_asset,
      spent_value = excluded.spent_value,
      spent_contract = excluded.spent_contract,
      received_asset = excluded.received_asset,
      received_value = excluded.received_value,
      received_contract = excluded.received_contract,
      event_created_at = excluded.event_created_at,
      received_at = excluded.received_at,
      raw_group_json = excluded.raw_group_json
  `).bind(
    walletLabel,
    walletAddress,
    txHash,
    result.classification,
    result.spent?.asset || null,
    result.spent?.value ?? null,
    result.spent?.contract || null,
    result.received?.asset || null,
    result.received?.value ?? null,
    result.received?.contract || null,
    eventCreatedAt || null,
    receivedAt,
    JSON.stringify({ flows: result.flows })
  ).run();

  return result;
}

async function readLatestSignals(env, limit) {
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
    ORDER BY id DESC
    LIMIT ?
  `).bind(limit).all();

  return result.results || [];
}

function filterSignals(rows, url) {
  const minutes = Math.min(Math.max(parseInt(url.searchParams.get("minutes") || "180"), 1), 10080);
  const type = (url.searchParams.get("type") || "").toUpperCase();
  const wallet = (url.searchParams.get("wallet") || "").toUpperCase();
  const cutoff = Date.now() - minutes * 60000;

  return rows.filter((row) => {
    const time = Date.parse(row.received_at || row.event_created_at || "");
    if (!Number.isFinite(time) || time < cutoff) return false;
    if (type && row.classification !== type) return false;
    if (wallet && row.wallet_label.toUpperCase() !== wallet) return false;
    return true;
  });
}

function buildSummary(signals) {
  const buys = signals.filter((s) => s.classification === "BUY");
  const sells = signals.filter((s) => s.classification === "SELL");
  const groups = new Map();

  for (const buy of buys) {
    const key = normalize(buy.received_contract) || (buy.received_asset || "UNKNOWN").toUpperCase();
    if (!groups.has(key)) {
      groups.set(key, { contract: buy.received_contract || null, asset: buy.received_asset || null, wallets: new Set(), buys: [] });
    }
    const group = groups.get(key);
    group.wallets.add(buy.wallet_label);
    group.buys.push(buy);
  }

  const convergence = [...groups.values()]
    .map((group) => ({
      contract: group.contract,
      asset: group.asset,
      walletCount: group.wallets.size,
      wallets: [...group.wallets],
      buys: group.buys
    }))
    .filter((group) => group.walletCount >= 2)
    .sort((a, b) => b.walletCount - a.walletCount);

  return { buys, sells, convergence };
}
