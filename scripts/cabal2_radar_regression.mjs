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

const {num,earlyWatchCandidates}=await import('../cloudflare/cabal2-radar/src/radar-core.mjs');
assert(num(null)===null,'missing data must not become zero');
const gentle3=computeRadar({...base,price:101},now,hist([[1,100.9],[3,100],[5,100]],now));
assert(gentle3.move1mPct<0.45,'fixture: gradual acceleration');
assert(earlyWatchCandidates([gentle3]).length===1,'3m mover must not require a simultaneous 1m spike');
const second={...gentle3,asset:'SECOND'};
assert(earlyWatchCandidates([gentle3,second],{TEST:new Date().toISOString()}).length===1,'one asset cooldown must not silence another');
assert(earlyWatchCandidates([gentle3,second]).length===2,'independent assets must share a prompt batch');
assert(earlyWatchCandidates([{...gentle3,change24hPct:24}]).length===0,'extended mover cannot be pushed as early');
console.log('CABAL EARLY WATCH REGRESSION PASS');
const fs=await import('node:fs');
const vm=await import('node:vm');
let worker=fs.readFileSync('cloudflare/cabal2-radar/src/index.mjs','utf8');
worker=worker.replace(/^import .*;\n/gm,'').replace('export class Cabal2Scheduler','class Cabal2Scheduler').replace('export default {','globalThis.worker = {');
worker+='\nglobalThis.hooks={mergeVenues,nextAssetState,emitEarlyWatch};';
const metadata=new Map();let posts=[];
const sandbox={DurableObject:class{},computeRadar,num,earlyWatchCandidates,Date,URL,Response,AbortController,setTimeout,clearTimeout,console,fetch:async(url,options)=>{posts.push(options.body);return new Response('{}',{status:200});},get:async(_,key)=>metadata.get(key)||null,put:async(_,key,value)=>metadata.set(key,value)};
vm.createContext(sandbox);vm.runInContext(worker,sandbox);
vm.runInContext('getMeta=get; setMeta=put;',sandbox);
const {mergeVenues,nextAssetState,emitEarlyWatch}=sandbox.hooks;
const venues=mergeVenues([{asset:'ATH',price:100,turnover:1000000,venue:'KUCOIN',venueSymbol:'ATH-USDT'},{asset:'ATH',price:100,turnover:900000,venue:'KUCOIN',venueSymbol:'ATH-USDC'}]);
assert(venues[0].venueCount===1,'two quotes on one exchange are not two venue confirmations');
const oldState={ATH:{market:'KUCOIN:ATH-USDT',history:[{minute:999,price:100}]}};
const changed=nextAssetState([{asset:'ATH',price:110,venue:'COINBASE',venueSymbol:'ATH-USD'}],1000,oldState);
assert(changed.ATH.history.length===1,'market switch must reset incompatible price history');
await emitEarlyWatch({NTFY_URL:'https://example.invalid'},[gentle3]);
await emitEarlyWatch({NTFY_URL:'https://example.invalid'},[second]);
assert(posts.length===2,'new independent asset must not wait ten minutes after first alert');
assert(posts.every(x=>x.includes('NO ES ORDEN DE COMPRA')),'WATCH cannot masquerade as BUY');
console.log('CABAL RADAR INTEGRATION PASS: venue count/history, independent NTFY dispatch');
