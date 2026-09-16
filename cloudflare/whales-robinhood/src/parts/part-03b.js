/*
  D1 READ-OPT PATCH — 2026-09-16

  Problem fixed:
  WHALES DEEP previously used UPPER/LOWER/COALESCE over D1 columns in the
  WHERE clause. That pattern prevents efficient index use and can turn each
  token lookup into a full whale_transactions table scan. With DEEP rotating
  several candidates every 15 minutes, this can consume millions of D1 rows
  read per day.

  Strategy:
  - Create two narrow composite indexes lazily (once per Worker isolate; D1
    itself makes CREATE INDEX IF NOT EXISTS idempotent).
  - Replace the token lookup with two index-friendly SELECTs (received/spent)
    batched together.
  - Keep the same 6h/24h/72h semantics and DEEP_MAX_ROWS cap.
  - Preserve optional contract filtering without wrapping indexed columns in
    SQL functions.
*/

const WHALES_D1_READ_OPT_VERSION = "WHALES_D1_READ_OPT_V1_2026-09-16";
let WHALES_D1_INDEX_PROMISE = null;

async function ensureWhalesD1ReadIndexes(env) {
  if (!WHALES_D1_INDEX_PROMISE) {
    WHALES_D1_INDEX_PROMISE = (async () => {
      await env.DB.prepare(`
        CREATE INDEX IF NOT EXISTS idx_whale_tx_received_asset_time
        ON whale_transactions(received_asset COLLATE NOCASE, received_at DESC)
      `).run();

      await env.DB.prepare(`
        CREATE INDEX IF NOT EXISTS idx_whale_tx_spent_asset_time
        ON whale_transactions(spent_asset COLLATE NOCASE, received_at DESC)
      `).run();

      return true;
    })().catch((error) => {
      WHALES_D1_INDEX_PROMISE = null;
      throw error;
    });
  }
  return WHALES_D1_INDEX_PROMISE;
}

readTokenSignals = async function readTokenSignalsIndexed(env, base, contract, hours) {
  await ensureWhalesD1ReadIndexes(env);

  const cutoff = new Date(Date.now() - hours * 3600000).toISOString();
  const b = upper(base);
  const c = normalize(contract);

  const columns = `
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
  `;

  const receivedSql = c
    ? `SELECT ${columns}
       FROM whale_transactions
       WHERE received_asset = ? COLLATE NOCASE
         AND received_at >= ?
         AND received_contract = ?
       ORDER BY id DESC
       LIMIT ?`
    : `SELECT ${columns}
       FROM whale_transactions
       WHERE received_asset = ? COLLATE NOCASE
         AND received_at >= ?
       ORDER BY id DESC
       LIMIT ?`;

  const spentSql = c
    ? `SELECT ${columns}
       FROM whale_transactions
       WHERE spent_asset = ? COLLATE NOCASE
         AND received_at >= ?
         AND spent_contract = ?
       ORDER BY id DESC
       LIMIT ?`
    : `SELECT ${columns}
       FROM whale_transactions
       WHERE spent_asset = ? COLLATE NOCASE
         AND received_at >= ?
       ORDER BY id DESC
       LIMIT ?`;

  const receivedStmt = c
    ? env.DB.prepare(receivedSql).bind(b, cutoff, c, DEEP_MAX_ROWS)
    : env.DB.prepare(receivedSql).bind(b, cutoff, DEEP_MAX_ROWS);

  const spentStmt = c
    ? env.DB.prepare(spentSql).bind(b, cutoff, c, DEEP_MAX_ROWS)
    : env.DB.prepare(spentSql).bind(b, cutoff, DEEP_MAX_ROWS);

  const [receivedResult, spentResult] = await env.DB.batch([
    receivedStmt,
    spentStmt
  ]);

  const merged = new Map();
  for (const row of [
    ...(receivedResult?.results || []),
    ...(spentResult?.results || [])
  ]) {
    if (!merged.has(row.id)) merged.set(row.id, row);
  }

  return [...merged.values()]
    .sort((a, b2) => Number(b2.id || 0) - Number(a.id || 0))
    .slice(0, DEEP_MAX_ROWS);
};

// Deployment marker: inject a harmless diagnostic field into WHALES JSON
// responses so the live Worker can be verified without Cloudflare dashboard
// access. This does not alter signal logic.
if (!globalThis.__WHALES_D1_READ_OPT_RESPONSE_MARKER__) {
  const originalResponseJson = Response.json.bind(Response);
  Response.json = function whalesJsonWithD1Marker(body, init) {
    if (
      body &&
      typeof body === "object" &&
      !Array.isArray(body) &&
      (body.patchVersion === WHALES_PATCH_VERSION ||
        body.service === "WHALES PROJECT - Robinhood Lean Monitor")
    ) {
      body = {
        ...body,
        d1ReadOptimization: WHALES_D1_READ_OPT_VERSION
      };
    }
    return originalResponseJson(body, init);
  };
  globalThis.__WHALES_D1_READ_OPT_RESPONSE_MARKER__ = true;
}
