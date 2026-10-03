import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
let source=fs.readFileSync('cloudflare/cabal-scanner/src/index.js','utf8').replace(/export default\s*\{/,'globalThis.__worker = {');
source+='\nglobalThis.test={guardFindAsset,guardQualifyBuySignals,runMarketGuard,guardTradeNotify,guardCancelActiveTrade,guardRetryAfterMs,guardTransportBackoffMs,guardVerifyTransportOnce};';
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
