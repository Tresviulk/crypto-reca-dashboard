import fs from 'node:fs/promises';

const STATE = 'data/whales-multichain-state.json';
const CONFIG = 'config/whales-multichain.json';

async function main() {
  const [state, config] = await Promise.all([
    fs.readFile(STATE, 'utf8').then(JSON.parse),
    fs.readFile(CONFIG, 'utf8').then(JSON.parse)
  ]);

  const statuses = state?.architecture?.chains || Object.fromEntries(
    Object.entries(state?.chains || {}).map(([k, v]) => [k, v?.status || 'MISSING'])
  );
  const solanaWalletCount = Number(config?.solanaWallets?.length || 0);
  const coreChains = ['ethereum', 'base', 'arbitrum', 'hyperliquid'];
  const corePass = coreChains.every((c) => statuses[c] === 'PASS');
  const sol = statuses.solana || 'MISSING';

  let overallStatus = 'PARTIAL';
  if (corePass) {
    if (solanaWalletCount === 0 || sol === 'NEEDS_WALLET_COHORT') overallStatus = 'PARTIAL_SOLANA_WALLETS_REQUIRED';
    else if (sol === 'PASS') overallStatus = 'PASS';
    else if (sol === 'PARTIAL') overallStatus = 'PARTIAL_SOLANA_RPC';
    else if (sol === 'ERROR') overallStatus = 'PARTIAL_SOLANA_RPC_ERROR';
    else overallStatus = `PARTIAL_SOLANA_${String(sol).toUpperCase()}`;
  }

  state.overallStatus = overallStatus;
  state.architecture = state.architecture || {};
  state.architecture.trackedSolanaWallets = solanaWalletCount;
  state.architecture.importantLimitation = solanaWalletCount
    ? 'Solana has a configured independent whale cohort. A PARTIAL Solana status means public-RPC/provider degradation, not missing wallets. Raw TOKEN_FLOW remains contextual until trade-level confirmation.'
    : 'Solana uses a different address format and still requires an independently identified Solana whale cohort.';
  state.statusSemantics = {
    normalized: true,
    solanaWalletCount,
    meaning: {
      PASS: 'All enabled chain monitors passed.',
      PARTIAL_SOLANA_WALLETS_REQUIRED: 'No Solana cohort is configured.',
      PARTIAL_SOLANA_RPC: 'Solana cohort exists but some public RPC calls failed; other core chains passed.',
      PARTIAL_SOLANA_RPC_ERROR: 'Solana cohort exists but the Solana RPC monitor failed; other core chains passed.',
      PARTIAL: 'One or more non-Solana core chain monitors are not PASS.'
    }
  };

  await fs.writeFile(STATE, JSON.stringify(state, null, 2) + '\n');
  console.log('WHALES MULTICHAIN STATUS NORMALIZED', overallStatus, 'solanaWallets=', solanaWalletCount);
}

main().catch((err) => { console.error(err); process.exit(1); });
