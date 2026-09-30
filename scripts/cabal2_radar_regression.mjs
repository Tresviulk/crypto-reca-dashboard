import { computeRadar } from "../cloudflare/cabal2-radar/src/radar-core.mjs";

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function hist(prices, nowMinute=1000) {
  return prices.map(([ago,price]) => ({minute:nowMinute-ago,price}));
}

const now=1000;
const base={asset:"TEST",venue:"KUCOIN",venueCount:2,venueSpreadPct:0.05,turnover:5000000,change24h:5};

const surge1=computeRadar({...base,price:101},now,hist([[1,100],[3,99.7],[5,99.5]],now));
assert(surge1.detected===true,"1m surge must be detected");
assert(surge1.state==="SURGE_1M","1m surge state");

const surge3=computeRadar({...base,price:101.25},now,hist([[1,101.0],[3,100],[5,99.9]],now));
assert(surge3.detected===true,"3m surge must be detected");

const surge5=computeRadar({...base,price:102.1},now,hist([[1,102.0],[3,101.5],[5,100]],now));
assert(surge5.detected===true,"5m surge must be detected");
assert(surge5.state==="SURGE_5M","5m surge state");

const flat=computeRadar({...base,price:100.05,change24h:0.5},now,hist([[1,100],[3,100],[5,100]],now));
assert(flat.detected===false,"flat market must not trigger");

const illiquid=computeRadar({...base,price:101,turnover:100000},now,hist([[1,100],[3,99.5],[5,99]],now));
assert(illiquid.detected===false,"low turnover noise must be blocked");

const extended=computeRadar({...base,price:101,change24h:24},now,hist([[1,100],[3,99.8],[5,99.5]],now));
assert(extended.detected===true,"extended mover must remain visible");
assert(extended.extended24h===true,"extended mover must be flagged");

console.log("CABAL 2.0 RADAR REGRESSION PASS");
