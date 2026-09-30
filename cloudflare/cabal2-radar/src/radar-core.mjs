export function num(v, fallback=null) {
  const x = Number(v);
  return Number.isFinite(x) ? x : fallback;
}

export function pct(now, then) {
  const a = num(now);
  const b = num(then);
  if (a === null || b === null || b === 0) return null;
  return (a / b - 1) * 100;
}

export function priceAt(history, targetMinute, toleranceMinutes=2) {
  if (!Array.isArray(history) || !history.length) return null;
  let best = null;
  let bestGap = Infinity;
  for (const p of history) {
    const minute = num(p && p.minute);
    const price = num(p && p.price);
    if (minute === null || price === null || minute > targetMinute) continue;
    const gap = targetMinute - minute;
    if (gap <= toleranceMinutes && gap < bestGap) {
      best = price;
      bestGap = gap;
    }
  }
  return best;
}

function cap(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

export function computeRadar(asset, currentMinute, previousHistory=[]) {
  const price = num(asset.price);
  const turnover = num(asset.turnover, 0);
  const change24h = num(asset.change24h, 0);
  const venueCount = Math.max(1, Math.trunc(num(asset.venueCount, 1)));

  const p1 = pct(price, priceAt(previousHistory, currentMinute - 1, 1));
  const p3 = pct(price, priceAt(previousHistory, currentMinute - 3, 1));
  const p5 = pct(price, priceAt(previousHistory, currentMinute - 5, 1));

  const baselinePerMinute = p5 === null ? 0 : p5 / 5;
  const acceleration = p1 === null ? null : p1 - baselinePerMinute;

  const liquidEnough = turnover >= 250000;
  const move1 = p1 !== null && p1 >= 0.35;
  const move3 = p3 !== null && p3 >= 0.80;
  const move5 = p5 !== null && p5 >= 1.50;
  const freshContinuation = change24h >= 3 && change24h < 25 && p1 !== null && p1 >= 0.20;
  const detected = liquidEnough && (move1 || move3 || move5 || freshContinuation);

  let state = "QUIET";
  if (detected) {
    if (p1 !== null && p1 >= 0.60) state = "SURGE_1M";
    else if (p3 !== null && p3 >= 1.20) state = "SURGE_3M";
    else if (p5 !== null && p5 >= 2.00) state = "SURGE_5M";
    else if (acceleration !== null && acceleration >= 0.25 && p1 !== null && p1 >= 0.35) state = "ACCELERATING";
    else state = "MOVING";
  }

  let score = 0;
  if (p1 !== null) score += cap(Math.max(0, p1) * 28, 0, 30);
  if (p3 !== null) score += cap(Math.max(0, p3) * 10, 0, 25);
  if (p5 !== null) score += cap(Math.max(0, p5) * 5, 0, 20);
  if (acceleration !== null) score += cap(Math.max(0, acceleration) * 16, 0, 15);
  if (turnover > 0) score += cap((Math.log10(turnover) - 5) * 2.5, 0, 5);
  if (venueCount >= 2) score += 5;

  return {
    asset: asset.asset,
    price,
    turnover24h: turnover,
    change24hPct: Number(change24h.toFixed(4)),
    move1mPct: p1 === null ? null : Number(p1.toFixed(4)),
    move3mPct: p3 === null ? null : Number(p3.toFixed(4)),
    move5mPct: p5 === null ? null : Number(p5.toFixed(4)),
    accelerationPctPoint: acceleration === null ? null : Number(acceleration.toFixed(4)),
    venue: asset.venue,
    venueCount,
    venueSpreadPct: num(asset.venueSpreadPct),
    state,
    detected,
    extended24h: change24h >= 20,
    radarScore: Number(cap(score, 0, 100).toFixed(2))
  };
}
