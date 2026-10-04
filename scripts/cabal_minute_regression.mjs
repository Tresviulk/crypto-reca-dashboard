import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
let source=fs.readFileSync('cloudflare/cabal-scanner/src/index.js','utf8').replace(/export default\s*\{/,'globalThis.__worker = {');
source+='\nglobalThis.test={guardCandidateSnapshot,marketRateBackoff,guardCoinbaseMarket,coinbaseKline,guardPilotDecision,fetchTimed,guardClosedCandles,guardRunnerFollowup,guardTargetedKucoin,guardFollowupCandidates,guardBuildSnapshot,guardLoadHistory,guardSaveSnapshot,guardFindAsset,guardQualifyBuySignals,runMarketGuard,guardTradeNotify,guardCancelActiveTrade,guardRetryAfterMs,guardTransportBackoffMs,guardVerifyTransportOnce};';
let clock=1800000000000;
class Clock extends Date {static now(){return clock;}}
const store=new Map();
const context={console,URL,Date:Clock,Math,JSON,Number,String,Boolean,Array,Object,Set,Map,Promise,RegExp,Error,TypeError,parseInt,parseFloat,isFinite,setTimeout,clearTimeout,AbortController,fetch:async()=>{throw Error('network disabled');}};
vm.createContext(context);vm.runInContext(source,context);
context.getStore=async(_,key)=>store.get(key)||null;
context.putStore=async(_,key,value)=>{store.set(key,value);};
vm.runInContext('guardGet=getStore; guardPut=putStore;',context);
const {guardFindAsset,guardQualifyBuySignals,runMarketGuard}=context.test;
assert.equal(guardFindAsset([{t:clock-180000,a:{ATH:[100]}}],'ATH',clock-60000),null,'stale return must not masquerade as 1m');
assert.equal(guardFindAsset([{t:clock-59000,a:{ATH:[100]}}],'ATH',clock-60000)[0],100,'scheduler jitter must not skip the matching snapshot');
const buy={asset:'ATH',buy:true,score:80};
let q=await guardQualifyBuySignals({},[buy]);assert.equal(q.qualified.length,0);
q=await guardQualifyBuySignals({},[buy]);assert.equal(q.qualified.length,0,'same-cycle replay must not qualify');
clock+=59000;q=await guardQualifyBuySignals({},[buy]);assert.equal(q.qualified.length,0,'59 seconds is not a separate confirmation');
// A same-cycle retry must not move the last-confirmed timestamp.
clock+=1000;q=await guardQualifyBuySignals({},[buy]);assert.equal(q.qualified.length,1,'fresh independent minute must qualify');
await guardQualifyBuySignals({},[{asset:'ATH',buy:false,reason:'DATA_GAP'}]);
clock+=60000;q=await guardQualifyBuySignals({},[buy]);assert.equal(q.qualified.length,0,'data gap resets confirmations');
let runs=0,revalidations=0;
context.snapshot=async()=>({t:clock,a:{},count:100,sourceStatus:{kucoin:'PASS',bybit:'PASS'}});
context.execute=async()=>{runs++;return {buys:[],evaluated:[],notify:{ok:true,kind:'NONE'}};};
context.revalidate=async()=>{revalidations++;return {checked:false};};
vm.runInContext('guardBuildSnapshot=snapshot; guardEvaluateTrades=execute; guardRevalidateActiveTrade=revalidate;',context);
await runMarketGuard({scheduledTime:clock},{});
clock+=60000;await runMarketGuard({scheduledTime:clock},{});
assert.equal(runs,2,'decision cannot wait for fifth minute');
assert.equal(revalidations,2,'active entry must still be checked on decision minutes');
console.log('CABAL MINUTE REGRESSION PASS: stale/jitter, independent confirmations, data-gap reset, minute decisions and active revalidation');

const notifications=[];
context.fetch=async(url,options)=>{
  new Headers(options.headers); // Enforce real HTTP header validation, not a permissive mock.
  notifications.push(options);
  return new Response('{}',{status:200});
};
const delivered=await context.test.guardTradeNotify({NTFY_URL:'https://example.invalid'},{generatedAt:new Date(clock).toISOString(),buys:[{asset:'TEST',price:100,entryMax:100.4,stop:98,stopDistancePct:2,confirmations:2,requiredConfirmations:2}]});
assert.equal(delivered.ok,true,'BUY must pass actual HTTP header validation');
assert.equal(delivered.kind,'BUY');
const closed=await context.test.guardCancelActiveTrade({NTFY_URL:'https://example.invalid'},{asset:'TEST'},'ORIGINAL_STOP_BROKEN',97);
assert.equal(closed.ok,true,'entry-window closure must pass actual header validation');
assert.equal(notifications.length,2);
assert(notifications[0].body.includes('SPOT manual'),'BUY remains manual');
console.log('CABAL NOTIFICATION HEADER REGRESSION PASS: BUY and closure HTTP headers');

assert.equal(context.test.guardRetryAfterMs(new Response('',{status:429,headers:{'Retry-After':'7200'}})),7200000,'server backoff must not be capped below Retry-After');
clock+=7*60*60*1000;
context.fetch=async()=>{throw Error('transient timeout');};
const failed=await context.test.guardTradeNotify({NTFY_URL:'https://example.invalid'},{generatedAt:new Date(clock).toISOString(),buys:[{asset:'RETRYTEST',price:100,entryMax:100.4,stop:98}]});
assert.equal(failed.backoffUntil-clock,60000,'transient outage must retry on the next minute');
console.log('NTFY RETRY REGRESSION PASS');

const throttledCancel=await context.test.guardCancelActiveTrade({NTFY_URL:'https://example.invalid'},{asset:'TEST'},'ORIGINAL_STOP_BROKEN',97);
assert.equal(throttledCancel.error,'NTFY_BACKOFF_ACTIVE','CANCEL cannot hammer the server during backoff');
assert(context.test.guardTransportBackoffMs(new Response('',{status:429}),'daily message limit reached')>60000,'daily quota must wait for UTC reset');
let probes=0;
context.fetch=async()=>{probes++;return new Response('{"id":"probe-id"}',{status:200});};
await context.test.guardVerifyTransportOnce({NTFY_URL:'https://example.invalid',NTFY_VERIFICATION_ID:'test-one'});
await context.test.guardVerifyTransportOnce({NTFY_URL:'https://example.invalid',NTFY_VERIFICATION_ID:'test-one'});
assert.equal(probes,1,'transport verification must only send once');
console.log('NTFY QUOTA AND ONE-TIME VERIFICATION PASS');

// SQL history uses the original observation time and 20s jitter window.
const snapshots=new Map();
const db={prepare(sql){return {args:[],bind(...args){this.args=args;return this;},async run(){
  if(sql.startsWith('INSERT')) snapshots.set(this.args[0],this.args[1]);
  if(sql.startsWith('DELETE')) for(const t of snapshots.keys()) if(t<this.args[0]) snapshots.delete(t);
},async all(){return {results:[...snapshots].filter(([t])=>this.args.some((v,i)=>i%2===0&&t>=v&&t<=this.args[i+1])).sort((a,b)=>a[0]-b[0]).map(([,v])=>({v}))};}};},async batch(statements){for(const q of statements) await q.run();}};
await context.test.guardLoadHistory({DB:db},clock);
for(const offset of [480000,360000,301000,181000,61000,0]) await context.test.guardSaveSnapshot({DB:db},{t:clock-offset,a:{TEST:[100,1e6,0,'KUCOIN','TEST-USDT']}});
const selected=await context.test.guardLoadHistory({DB:db},clock);
assert.equal(selected.length,3,'only 1m/3m/5m snapshots are decoded');
assert.equal(context.test.guardFindAsset(selected,'TEST',clock-60000)[0],100,'jitter preserved');
assert(!snapshots.has(clock-480000),'expired snapshot removed');
assert(!source.includes('guardGet(env,"history")'),'legacy full-history JSON cannot be decoded');
console.log('CABAL CPU HISTORY REGRESSION PASS: selective reads, jitter, expiry, no legacy blob');

// RUNNER identities survive a quiet minute; prices must always be live.
store.clear();
context.fetch=async()=>new Response(JSON.stringify({events:[{kind:'RUNNER',cabalGeneratedAt:new Date(clock).toISOString(),message:'🚀 AKT — RUNNER TEMPRANO\n🚀 NEON — RUNNER TEMPRANO'}]}),{status:200});
const followed=await context.test.guardRunnerFollowup({});
assert.equal(followed.length,1);assert.equal(followed[0].base,'AKT');
assert.equal(followed[0].price,undefined,'old machine price must not be retained');
const quiet={t:clock,a:{AKT:[0.7079,4330669,7.2997,'KUCOIN','AKT-USDT']}};
const tracking=context.test.guardFollowupCandidates(quiet,[],[],followed);
assert.equal(tracking[0].price,0.7079);assert.equal(tracking[0].runnerFollowup,true);
assert.equal(context.test.guardFollowupCandidates({t:clock,a:{}},[],[],followed).length,0,'missing live price cannot be evaluated');
context.fetch=async()=>new Response(JSON.stringify({code:'200000',data:{last:'0.71',volValue:'4330669',changeRate:'0.07',time:clock}}),{status:200});
assert.equal((await context.test.guardTargetedKucoin(followed))[0].lastPrice,0.71);
context.fetch=async()=>new Response(JSON.stringify({code:'200000',data:{last:'0.71',time:clock-180000}}),{status:200});
assert.equal((await context.test.guardTargetedKucoin(followed)).length,0,'stale exchange tick rejected');
clock+=31*60000;
context.fetch=async()=>{throw Error('source unavailable');};
assert.equal((await context.test.guardRunnerFollowup({})).length,0,'expired runner cannot be revived by source failure');
console.log('RUNNER FOLLOWUP PASS: live prices, quiet minutes, targeted fallback, expiry and fundamental exclusions');

store.clear();
let candleReads=0;
context.readBars=async()=>{candleReads++;return [{t:(Math.floor(clock/900000)-1)*900000,c:1}];};
vm.runInContext('klineOnMarket=readBars;',context);
const market={venue:'KUCOIN',venueSymbol:'AKT-USDT'};
await context.test.guardClosedCandles({},market,'15',60);
await context.test.guardClosedCandles({},market,'15',60);
assert.equal(candleReads,1,'unchanged completed bars must be reused');
clock+=900000;
await context.test.guardClosedCandles({},market,'15',60);
assert.equal(candleReads,2,'new close must force a fresh exchange read');
console.log('CLOSED CANDLE CACHE PASS: reuse immutable bars; refresh on each close');

store.clear();
const originalFetch=context.fetch;
context.fetch=async url=>{
  if(url.endsWith('/ticker')) return new Response(JSON.stringify({price:'0.75',time:new Date(clock).toISOString()}),{status:200});
  if(url.endsWith('/stats')) return new Response(JSON.stringify({open:'0.70',volume:'2000000'}),{status:200});
  return new Response(JSON.stringify({base_currency:'AKT',quote_currency:'USD',status:'online',trading_disabled:false}),{status:200});
};
const cb=await context.test.guardCoinbaseMarket('AKT');
assert.equal(cb.lastPrice,0.75);assert.equal(cb.turnover24h,1500000);assert.equal(cb.venue,'COINBASE');
context.fetch=async url=>url.endsWith('/ticker') ? new Response(JSON.stringify({price:'0.75',time:new Date(clock-180000).toISOString()}),{status:200}) : new Response(JSON.stringify({base_currency:'AKT',quote_currency:'USD',status:'online'}),{status:200});
await assert.rejects(()=>context.test.guardCoinbaseMarket('AKT'),/STALE_PRICE/);
context.fetch=async()=>new Response(JSON.stringify([[Math.floor(clock/900000)*900,1,2,1.1,1.5,99],[Math.floor(clock/900000)*900-900,1,2,1.1,1.5,99]]),{status:200});
const candles=await context.test.coinbaseKline('AKT-USD','15',60);
assert.equal(candles.length,1,'live candle excluded');assert.equal(candles[0].c,1.5);assert.equal(candles[0].v,99);
store.clear();
let v=await context.test.guardQualifyBuySignals({},[{asset:'AKT',venue:'KUCOIN',venueSymbol:'AKT-USDT',buy:true,score:60}]);
clock+=60000;
v=await context.test.guardQualifyBuySignals({},[{asset:'AKT',venue:'COINBASE',venueSymbol:'AKT-USD',buy:true,score:60}]);
assert.equal(v.qualified.length,0,'switching venues resets confirmation');
clock+=60000;
v=await context.test.guardQualifyBuySignals({},[{asset:'AKT',venue:'COINBASE',venueSymbol:'AKT-USD',buy:true,score:60}]);
assert.equal(v.qualified.length,1,'two same-market confirmations qualify');
const m={executionCandidate:{base:'AKT',venue:'COINBASE',venueSymbol:'AKT-USD',price:0.75,turnover24h:1500000,change24h:7,guardScore:40,change1m:1},executionVenue:'COINBASE',executionVenueSymbol:'AKT-USD',p15:1,p1:2,p4:3,rs1:1,rs4:1,rvol15m:3,rvol1h:3,headroom:2,stopDistancePct:2,stop:0.735,noChase:0.78};
const decision=context.test.guardPilotDecision({base:'AKT',price:0.7079},m);
assert.equal(decision.price,0.75,'entry uses target exchange price');assert.equal(decision.venue,'COINBASE');assert.equal(decision.buy,true);
let requests=0;context.fetch=async()=>{requests++;return new Response('',{status:429,headers:{'retry-after':'30'}});};
await context.test.fetchTimed('https://api.kucoin.com/test');
await assert.rejects(()=>context.test.fetchTimed('https://api.kucoin.com/test2'),/SOURCE_BACKOFF/);
assert.equal(requests,1,'rate-limited source cannot be hammered');
assert.equal(context.test.marketRateBackoff(new Response('',{status:429,headers:{'gw-ratelimit-reset':'2500'}})),2500);
console.log('SOURCE FAILOVER PASS: Coinbase price/volume/bars, stale rejection, same-market confirmations and quota backoff');

const altNow={t:clock,a:{AKT:[0.75,1500000,7,'COINBASE','AKT-USD']}};
const altHistory=[{t:clock-60000,a:{AKT:[0.7079,4000000,7,'KUCOIN','AKT-USDT']}},{t:clock-60010,a:{AKT:[0.74,1500000,7,'COINBASE','AKT-USD']}}];
const altCandidate=context.test.guardCandidateSnapshot(altNow,altHistory,'AKT');
assert(Math.abs(altCandidate.change1m-(0.75/0.74-1)*100)<1e-8,'short momentum uses same exchange history');
console.log('SAME EXCHANGE HISTORY PASS');
