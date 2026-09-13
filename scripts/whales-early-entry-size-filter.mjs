import fs from 'node:fs/promises';

const STATE_PATH = 'data/whales-early-entry-state.json';

// Absolute sizing gates for actionable shark evidence.
// Tiny test orders are preserved as context but cannot become WHALE_DISCOVERY,
// SHARK_CONVERGENCE, EARLY_SHARK_WATCH or BUY_CANDIDATE_REVIEW.
const MICRO_SOL_MAX = 1;
const ACTIONABLE_SOL_MIN = 5;
const STRONG_SOL_MIN = 10;
const MICRO_STABLE_MAX = 100;
const ACTIONABLE_STABLE_MIN = 500;
const STRONG_STABLE_MIN = 1_000;
const MIN_RETENTION_RATIO = 0.50;

const num = (x, fallback = 0) => (x === null || x === undefined || x === '' || !Number.isFinite(Number(x))) ? fallback : Number(x);
const upper = (x) => String(x || '').trim().toUpperCase();
const round = (x, n = 6) => Number.isFinite(Number(x)) ? Number(Number(x).toFixed(n)) : null;

async function readJson(path) {
  return JSON.parse(await fs.readFile(path, 'utf8'));
}

function quoteTier(evidence = []) {
  const totals = new Map();
  for (const e of evidence) {
    const asset = upper(e.quoteAsset);
    const q = Math.abs(num(e.quoteAmount, 0));
    if (!asset || q <= 0) continue;
    totals.set(asset, (totals.get(asset) || 0) + q);
  }

  const sol = totals.get('SOL') || totals.get('WSOL') || 0;
  const stable = (totals.get('USDC') || 0) + (totals.get('USDT') || 0);
  let tier = 'MICRO_PROBE';
  if (sol >= STRONG_SOL_MIN || stable >= STRONG_STABLE_MIN) tier = 'STRONG_CONVICTION_SIZE';
  else if (sol >= ACTIONABLE_SOL_MIN || stable >= ACTIONABLE_STABLE_MIN) tier = 'MEANINGFUL_SIZE';
  else if (sol >= MICRO_SOL_MAX || stable >= MICRO_STABLE_MAX) tier = 'SCOUT_SIZE';

  return {
    tier,
    sol: round(sol, 6),
    stableUsd: round(stable, 2),
    byAsset: Object.fromEntries([...totals.entries()].map(([k,v]) => [k, round(v, 6)]))
  };
}

function walletSizing(signal) {
  const buysByWallet = new Map();
  for (const e of signal.buyEvidence || []) {
    const arr = buysByWallet.get(e.wallet) || [];
    arr.push(e);
    buysByWallet.set(e.wallet, arr);
  }

  return [...buysByWallet.entries()].map(([wallet, ev]) => {
    const size = quoteTier(ev);
    const boughtToken = ev.reduce((s,e)=>s + Math.abs(num(e.tokenAmount,0)),0);
    const retentionRatio = boughtToken > 0 ? Math.min(1, Math.max(0, num(signal.netTokenFlow,0) / boughtToken)) : 0;
    const meaningful = ['MEANINGFUL_SIZE','STRONG_CONVICTION_SIZE'].includes(size.tier) && retentionRatio >= MIN_RETENTION_RATIO;
    return {
      wallet,
      walletLabel: ev[0]?.walletLabel || null,
      walletTier: ev[0]?.walletTier || null,
      walletSource: ev[0]?.walletSource || null,
      quoteSizing: size,
      retentionRatio: round(retentionRatio, 4),
      meaningful
    };
  });
}

function downgrade(signal) {
  if (!(signal.netTokenFlow > 0) || !(signal.buyEvidence || []).length) return signal;

  const perWallet = walletSizing(signal);
  const meaningful = perWallet.filter((w) => w.meaningful);
  const priorityMeaningful = meaningful.filter((w) => w.walletSource === 'FIXED_TIER_A' || w.walletTier === 'TIER_A');
  const strongestTier = perWallet.some((w)=>w.quoteSizing.tier === 'STRONG_CONVICTION_SIZE')
    ? 'STRONG_CONVICTION_SIZE'
    : perWallet.some((w)=>w.quoteSizing.tier === 'MEANINGFUL_SIZE')
      ? 'MEANINGFUL_SIZE'
      : perWallet.some((w)=>w.quoteSizing.tier === 'SCOUT_SIZE') ? 'SCOUT_SIZE' : 'MICRO_PROBE';

  signal.positionSizing = {
    ruleVersion: 'SHARK_SIZE_FILTER_V1_2026-09-13',
    strongestTier,
    meaningfulWalletCount: meaningful.length,
    priorityMeaningfulWalletCount: priorityMeaningful.length,
    minActionable: { sol: ACTIONABLE_SOL_MIN, stableUsd: ACTIONABLE_STABLE_MIN },
    strongConviction: { sol: STRONG_SOL_MIN, stableUsd: STRONG_STABLE_MIN },
    minRetentionRatio: MIN_RETENTION_RATIO,
    perWallet
  };

  if (meaningful.length === 0) {
    signal.preSizeFilterStatus = signal.status;
    signal.preSizeFilterAction = signal.action;
    signal.status = strongestTier === 'SCOUT_SIZE' ? 'SHARK_SCOUT_POSITION' : 'MICRO_PROBE_CONTEXT_ONLY';
    signal.action = 'IGNORE_FOR_ACTIONABLE_SIGNAL';
    signal.reason = strongestTier === 'SCOUT_SIZE'
      ? `A monitored wallet is net long, but cumulative buy size is below the actionable shark threshold of ${ACTIONABLE_SOL_MIN} SOL / $${ACTIONABLE_STABLE_MIN}. Keep as context only.`
      : `Detected buy is only a micro probe. Orders below ${MICRO_SOL_MAX} SOL / $${MICRO_STABLE_MAX} are not treated as whale/shark evidence.`;
    signal.cabalValidatedForEntry = false;
    return signal;
  }

  // Recalculate independent convergence using only meaningfully-sized wallets.
  if (signal.status === 'SHARK_CONVERGENCE' && meaningful.length < 2) {
    signal.preSizeFilterStatus = signal.status;
    signal.preSizeFilterAction = signal.action;
    signal.status = priorityMeaningful.length ? 'TIER_A_MEANINGFUL_ACCUMULATION' : 'WHALE_DISCOVERY';
    signal.action = 'WATCH';
    signal.reason = 'Only one wallet meets the minimum meaningful-size gate; independent shark convergence is not confirmed.';
  }

  // Tier-A first touch is only meaningful if the Tier-A wallet itself meets sizing gate.
  if (signal.status === 'TIER_A_FIRST_TOUCH' && priorityMeaningful.length === 0) {
    signal.preSizeFilterStatus = signal.status;
    signal.preSizeFilterAction = signal.action;
    signal.status = 'SHARK_SCOUT_POSITION';
    signal.action = 'IGNORE_FOR_ACTIONABLE_SIGNAL';
    signal.reason = `Tier-A first touch exists, but the Tier-A wallet has not committed at least ${ACTIONABLE_SOL_MIN} SOL / $${ACTIONABLE_STABLE_MIN} while retaining at least ${Math.round(MIN_RETENTION_RATIO*100)}% of the token position.`;
    signal.cabalValidatedForEntry = false;
  }

  return signal;
}

async function main() {
  const state = await readJson(STATE_PATH);
  state.signals = (state.signals || []).map(downgrade);

  const actionableStatuses = new Set(['SHARK_CONVERGENCE','TIER_A_FIRST_TOUCH','TIER_A_MEANINGFUL_ACCUMULATION','WHALE_DISCOVERY','WHALE_DISCOVERY_LOW_LIQUIDITY','SHARK_BUY_LATE']);
  state.topCandidates = state.signals.filter((s) => actionableStatuses.has(s.status) && s.action !== 'IGNORE_FOR_ACTIONABLE_SIGNAL').slice(0,20);
  state.buyCandidates = state.signals.filter((s) => s.action === 'BUY_CANDIDATE_REVIEW' && (s.positionSizing?.meaningfulWalletCount || 0) > 0);
  state.earlyWatches = state.signals.filter((s) => s.action === 'EARLY_SHARK_WATCH' && (s.positionSizing?.meaningfulWalletCount || 0) > 0);

  state.scan ||= {};
  state.scan.rawNetAccumulationSignalCount = state.signals.filter((s)=>num(s.netTokenFlow,0) > 0).length;
  state.scan.netAccumulationSignalCount = state.signals.filter((s)=>num(s.netTokenFlow,0) > 0 && (s.positionSizing?.meaningfulWalletCount || 0) > 0).length;
  state.scan.microProbeCount = state.signals.filter((s)=>s.status === 'MICRO_PROBE_CONTEXT_ONLY').length;
  state.scan.scoutPositionCount = state.signals.filter((s)=>s.status === 'SHARK_SCOUT_POSITION').length;
  state.scan.buyCandidateCount = state.buyCandidates.length;
  state.scan.earlyWatchCount = state.earlyWatches.length;

  state.sizeFilter = {
    applied: true,
    generatedAt: new Date().toISOString(),
    version: 'SHARK_SIZE_FILTER_V1_2026-09-13',
    thresholds: {
      microProbeBelow: { sol: MICRO_SOL_MAX, stableUsd: MICRO_STABLE_MAX },
      actionableMin: { sol: ACTIONABLE_SOL_MIN, stableUsd: ACTIONABLE_STABLE_MIN },
      strongConvictionMin: { sol: STRONG_SOL_MIN, stableUsd: STRONG_STABLE_MIN },
      minTokenRetentionRatio: MIN_RETENTION_RATIO
    },
    policy: [
      'Sub-1 SOL / sub-$100 buys are micro probes and never count as whale/shark signals.',
      '1-5 SOL / $100-$500 positions are scout context only and never produce actionable alerts.',
      'Actionable whale evidence requires at least 5 SOL or $500 cumulative buy notional per wallet/token plus >=50% token retention.',
      'Strong conviction sizing begins at 10 SOL or $1,000.',
      'Convergence only counts independently meaningful-sized wallets; two dust/scout buys can never create convergence.',
      'All micro/scout transactions remain persisted for behavioral history but are excluded from BUY CANDIDATE and EARLY SHARK WATCH.'
    ]
  };

  await fs.writeFile(STATE_PATH, JSON.stringify(state,null,2)+'\n');
  console.log('WHALES SIZE FILTER APPLIED', state.sizeFilter.generatedAt, 'rawAccum=',state.scan.rawNetAccumulationSignalCount,'meaningfulAccum=',state.scan.netAccumulationSignalCount,'micro=',state.scan.microProbeCount,'scout=',state.scan.scoutPositionCount,'buyCandidates=',state.scan.buyCandidateCount);
}

main().catch((err)=>{ console.error(err); process.exit(1); });
