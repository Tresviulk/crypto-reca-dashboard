const WHALES_PATCH_VERSION = "WHALES_V3_2026-09-12";
const DEEP_MAX_ROWS = 1000;
const DEEP_TRANSFER_PAGE_SIZE = "0x1f4"; // 500
const DEEP_MAX_TRANSFER_PAGES = 2;

const WATCHED_WALLETS = {
  "0x7e3ba68c49561aae7c23c1d20fef0f1d7615a3ad": "RH-W1",
  "0xae0f6a971fb3e7cc671aef6e168c5c9788f72b92": "RH-W2",
  "0xd5b7c7969eabaf5f10ebe440b7e89dd16fa51ea8": "RH-W3",
  "0x82fc58011d50bfda0dd10bbecab41803a7758939": "RH-W4",
  "0x194d98d18113bdd5720a0a89fe2f98c75ece7344": "RH-W5",
  "0x43370371e0bb085d04d02a815230aaf67b35ef25": "RH-W6",
  "0xeee29d1a6fa5873065ad8789c6e15231b48318a0": "RH-W7",
  "0xde4c44e841972c2c4db1b1e27a353340fe9899de": "RH-W8",
  "0xf29f0a86420399f662577b68c48137d510084d96": "RH-W9",
  "0x4a5b304ded44a521ffece44a6386fa2014d96f7d": "RH-W10",
  "0x6f5bbfbfb82729cf356f37f88911952ca115d3f5": "RH-W11"
};

const QUOTE_ASSETS = new Set([
  "ETH", "WETH", "USDC", "USDT", "DAI", "USD1", "USDE", "PYUSD", "RLUSD"
]);

const TRANSFER_TOPIC =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

const TOKEN_META_CACHE = new Map();

function normalize(value) {
  return (value || "").toLowerCase();
}

function bufferToHex(buffer) {
  return [...new Uint8Array(buffer)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function constantTimeEqual(a, b) {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

async function verifyAlchemySignature(rawBody, signature, signingKey) {
  if (!rawBody || !signature || !signingKey) return false;
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(signingKey),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signed = await crypto.subtle.sign("HMAC", key, encoder.encode(rawBody));
  const expected = bufferToHex(signed);
  return constantTimeEqual(expected.toLowerCase(), signature.toLowerCase());
}

async function rpc(env, method, params) {
  const response = await fetch(env.ALCHEMY_RPC_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })
  });

  if (!response.ok) {
    throw new Error(`RPC HTTP ${response.status}`);
  }

  const json = await response.json();
  if (json.error) {
    throw new Error(`RPC ${method}: ${JSON.stringify(json.error)}`);
  }
  return json.result;
}

function hexToBigInt(hex) {
  try {
    return BigInt(hex || "0x0");
  } catch {
    return 0n;
  }
}

function topicToAddress(topic) {
  if (!topic || topic.length < 42) return null;
  return "0x" + topic.slice(-40).toLowerCase();
}

function formatUnits(raw, decimals) {
  try {
    const value = BigInt(raw);
    if (decimals === 0) return Number(value);
    const base = 10n ** BigInt(decimals);
    const whole = value / base;
    const fraction = value % base;
    const fractionText = fraction
      .toString()
      .padStart(decimals, "0")
      .replace(/0+$/, "");
    return Number(fractionText ? `${whole}.${fractionText}` : whole.toString());
  } catch {
    return null;
  }
}

function decodeAbiString(hex) {
  try {
    if (!hex || hex === "0x") return null;
    const clean = hex.slice(2);

    if (clean.length === 64) {
      const bytes = [];
      for (let i = 0; i < clean.length; i += 2) {
        const byte = parseInt(clean.slice(i, i + 2), 16);
        if (byte !== 0) bytes.push(byte);
      }
      return new TextDecoder().decode(new Uint8Array(bytes)).trim() || null;
    }

    if (clean.length >= 128) {
      const length = parseInt(clean.slice(64, 128), 16);
      const dataHex = clean.slice(128, 128 + length * 2);
      const bytes = [];
      for (let i = 0; i < dataHex.length; i += 2) {
        bytes.push(parseInt(dataHex.slice(i, i + 2), 16));
      }
      return new TextDecoder().decode(new Uint8Array(bytes)).trim() || null;
    }

    return null;
  } catch {
    return null;
  }
}

async function ethCall(env, to, data) {
  try {
    return await rpc(env, "eth_call", [{ to, data }, "latest"]);
  } catch {
    return null;
  }
}

async function getTokenMetadata(env, contract) {
  const key = normalize(contract);
  if (TOKEN_META_CACHE.has(key)) return TOKEN_META_CACHE.get(key);

  let symbol = null;
  let decimals = 18;

  const [symbolRaw, decimalsRaw] = await Promise.all([
    ethCall(env, contract, "0x95d89b41"),
    ethCall(env, contract, "0x313ce567")
  ]);

  if (symbolRaw) symbol = decodeAbiString(symbolRaw);

  if (decimalsRaw && decimalsRaw !== "0x") {
    const parsed = Number(hexToBigInt(decimalsRaw));
    if (Number.isFinite(parsed) && parsed >= 0 && parsed <= 36) {
      decimals = parsed;
    }
  }

  const meta = {
    symbol: symbol || key.slice(0, 10),
    decimals
  };

  TOKEN_META_CACHE.set(key, meta);
  return meta;
}

function isQuoteAsset(symbol) {
  return QUOTE_ASSETS.has((symbol || "").toUpperCase());
}

function pickLargest(flows) {
  if (!flows.length) return null;
  return flows.reduce((best, current) => {
    const a = Number(best.value || 0);
    const b = Number(current.value || 0);
    return b > a ? current : best;
  });
}

async function reconstructTransaction(env, walletAddress, txHash) {
  const wallet = normalize(walletAddress);

  const [tx, receipt] = await Promise.all([
    rpc(env, "eth_getTransactionByHash", [txHash]),
    rpc(env, "eth_getTransactionReceipt", [txHash])
  ]);

  if (!tx || !receipt) {
