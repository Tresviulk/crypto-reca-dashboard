import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
let source=fs.readFileSync('cloudflare/cabal-scanner/src/index.js','utf8').replace(/export default\s*\{/,'globalThis.__worker = {');
source+='\nglobalThis.test={guardLoadHistory,guardSaveSnapshot,guardFindAsset,guardQualifyBuySignals,runMarketGuard,guardTradeNotify,guardCancelActiveTrade,guardRetryAfterMs,guardTransportBackoffMs,guardVerifyTransportOnce};';
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
