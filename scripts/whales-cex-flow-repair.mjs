import fs from 'node:fs/promises';

const CONFIG='config/whales-multichain.json';
const STATE='data/whales-cex-flows.json';
const REPORT='data/whales-report.json';
const TRANSFER_TOPIC='0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const TARGETS=['coinbase','binance','kraken','kucoin'];
const ZERO='0x0000000000000000000000000000000000000000';
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));

async function read(path,fallback=null){try{return JSON.parse(await fs.readFile(path,'utf8'))}catch{return fallback}}
const norm=(x)=>String(x||'').trim().toLowerCase();
const upper=(x)=>String(x||'').trim().toUpperCase();
const uniq=(a)=>[...new Set(a.filter(Boolean))];
const hex=(n)=>'0x'+Math.max(0,Number(n)||0).toString(16);
const hexNum=(x)=>{try{return Number(BigInt(x||'0x0'))}catch{return null}};
const tsMs=(x)=>{const t=Date.parse(x||'');return Number.isFinite(t)?t:null};
const topicAddress=(x)=>x&&x.length>=42?'0x'+x.slice(-40).toLowerCase():null;
const addressTopic=(x)=>'0x'+norm(x).replace(/^0x/,'').padStart(64,'0');

function providerPool(config,chain){
  const c=config?.chains?.[chain]||{};
  const fallback={
    ethereum:['https://ethereum-rpc.publicnode.com','https://eth.llamarpc.com','https://cloudflare-eth.com','https://1rpc.io/eth'],
    base:['https://mainnet.base.org','https://base-rpc.publicnode.com','https://base.llamarpc.com','https://1rpc.io/base'],
    arbitrum:['https://arb1.arbitrum.io/rpc','https://arbitrum-one-rpc.publicnode.com','https://arbitrum.llamarpc.com','https://1rpc.io/arb']
  };
  return uniq([...(c.rpcUrls||[]),c.rpcUrl,...(fallback[chain]||[])]);
}
async function fetchJson(url,opts={},timeout=9000){
  const r=await fetch(url,{...opts,signal:AbortSignal.timeout(timeout)});
  if(!r.ok)throw new Error(`HTTP_${r.status}`);
  return r.json();
}
async function rpc(url,method,params){
  const j=await fetchJson(url,{method:'POST',headers:{'content-type':'application/json','user-agent':'crypto-reca-cex-flow/2.0'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})});
  if(j?.error)throw new Error(`${j.error.code}:${j.error.message}`);
  return j?.result;
}
async function rpcAny(urls,method,params,stats){
  let last=null;
  for(const url of urls){
    const s=stats[url] ||= {calls:0,successes:0,failures:0,lastError:null};
    for(let a=0;a<2;a++){
      s.calls++;
      try{const result=await rpc(url,method,params);s.successes++;return {result,provider:url}}
      catch(e){last=e;s.failures++;s.lastError=String(e?.message||e);await sleep(100*(a+1))}
    }
  }
  throw last||new Error(`${method}:all_providers_failed`);
}
async function chunkedLogs(urls,baseFilter,fromBlock,toBlock,chunkSize,stats,health){
  const out=[];
  for(let start=fromBlock;start<=toBlock;start+=chunkSize){
    const end=Math.min(toBlock,start+chunkSize-1);
    health.chunkQueries++;
    try{
      const r=await rpcAny(urls,'eth_getLogs',[{...baseFilter,fromBlock:hex(start),toBlock:hex(end)}],stats);
      health.successfulChunks++;
      health.providersUsed[r.provider]=(health.providersUsed[r.provider]||0)+1;
      if(Array.isArray(r.result))out.push(...r.result);
    }catch(e){
      health.failedChunks++;
      health.lastErrors.push(`${start}-${end}:${String(e?.message||e)}`);
    }
    await sleep(20);
  }
  return out;
}
function formatUnits(value,decimals){
  try{const raw=BigInt(value||'0x0'),base=10n**BigInt(decimals),w=raw/base,f=raw%base;if(!f)return Number(w);return Number(`${w}.${f.toString().padStart(decimals,'0').replace(/0+$/,'')}`)}catch{return null}
}
function decodeString(v){
  try{if(!v||v==='0x')return null;const h=v.slice(2);if(h.length===64){const b=[];for(let i=0;i<h.length;i+=2){const x=parseInt(h.slice(i,i+2),16);if(x)b.push(x)}return new TextDecoder().decode(new Uint8Array(b)).trim()||null}if(h.length>=128){const n=parseInt(h.slice(64,128),16),d=h.slice(128,128+n*2),b=[];for(let i=0;i<d.length;i+=2)b.push(parseInt(d.slice(i,i+2),16));return new TextDecoder().decode(new Uint8Array(b)).trim()||null}}catch{}return null
}
async function tokenMeta(urls,contract,cache,stats){
  const k=norm(contract);if(cache[k])return cache[k];let symbol=k.slice(0,10),decimals=18;
  try{const s=await rpcAny(urls,'eth_call',[{to:contract,data:'0x95d89b41'},'latest'],stats);symbol=upper(decodeString(s.result)||symbol)}catch{}
  try{const d=await rpcAny(urls,'eth_call',[{to:contract,data:'0x313ce567'},'latest'],stats);const n=Number(BigInt(d.result||'0x12'));if(Number.isFinite(n)&&n>=0&&n<=36)decimals=n}catch{}
  return cache[k]={symbol,decimals};
}
async function blockTime(urls,b,cache,stats){
  if(cache[b])return cache[b];try{const r=await rpcAny(urls,'eth_getBlockByNumber',[b,false],stats);const ms=Number(BigInt(r.result?.timestamp||'0x0'))*1000;return cache[b]=ms?new Date(ms).toISOString():null}catch{return null}
}
async function label(chainId,address,cache,stats){
  const k=`${chainId}:${norm(address)}`,old=cache[k];
  if(old&&tsMs(old.checkedAt)&&Date.now()-tsMs(old.checkedAt)<7*86400_000){stats.cacheHits++;return old}
  if(stats.calls>=150){stats.capped++;return old||{address:norm(address),exchange:null,status:'LOOKUP_CAP'}}
  stats.calls++;
  try{
    const j=await fetchJson(`https://eth-labels.com/accounts?chainId=${chainId}&address=${encodeURIComponent(address)}&limit=20`,{headers:{accept:'application/json','user-agent':'crypto-reca-cex-flow/2.0'}},6500);
    const rows=Array.isArray(j)?j:Array.isArray(j?.data)?j.data:Array.isArray(j?.accounts)?j.accounts:Array.isArray(j?.result)?j.result:[];
    let hit=null,row=null;
    for(const x of rows){const text=`${x?.label||''} ${x?.nameTag||x?.nametag||''}`.toLowerCase();hit=TARGETS.find(t=>text.includes(t));if(hit){row=x;break}}
    const o={address:norm(address),exchange:hit?hit.toUpperCase():null,label:row?.label||null,nameTag:row?.nameTag||row?.nametag||null,checkedAt:new Date().toISOString(),status:'PASS'};cache[k]=o;return o;
  }catch(e){stats.errors++;return old||{address:norm(address),exchange:null,status:'ERROR',error:String(e?.message||e)}}
}

async function main(){
  const [config,prev,report]=await Promise.all([read(CONFIG,{}),read(STATE,{events:[],labelCache:{}}),read(REPORT,{})]);
  const retained=new Map();
  const cutoff=Date.now()-30*86400_000;
  for(const e of prev.events||[])if((tsMs(e.eventTime)||0)>=cutoff)retained.set(e.id,e);
  const labelCache=prev.labelCache||{},tokenCache={},blockCache={};
  const lookup={calls:0,errors:0,cacheHits:0,capped:0};
  const chainHealth={},rpcStats={};
  const chains=[
    {name:'ethereum',chainId:1,chunk:450,lookback:Number(config?.chains?.ethereum?.cexLookbackBlocks||1800)},
    {name:'base',chainId:8453,chunk:1000,lookback:Number(config?.chains?.base?.cexLookbackBlocks||5000)},
    {name:'arbitrum',chainId:42161,chunk:1500,lookback:Number(config?.chains?.arbitrum?.cexLookbackBlocks||5000)}
  ];
  for(const c of chains){
    const urls=providerPool(config,c.name),health={status:'PASS',rpcProviders:urls.length,chunkSize:c.chunk,lookbackBlocks:c.lookback,walletDirections:0,chunkQueries:0,successfulChunks:0,failedChunks:0,transferLogs:0,cexMatches:0,providersUsed:{},lastErrors:[]};
    if(!urls.length){health.status='ERROR';health.lastErrors.push('NO_RPC_PROVIDER');chainHealth[c.name]=health;continue}
    let latest;
    try{latest=hexNum((await rpcAny(urls,'eth_blockNumber',[],rpcStats)).result)}catch(e){health.status='ERROR';health.lastErrors.push(String(e?.message||e));chainHealth[c.name]=health;continue}
    const from=Math.max(0,latest-c.lookback);
    for(const w of config.evmWallets||[]){
      const wt=addressTopic(w.address);
      for(const direction of ['OUT','IN']){
        health.walletDirections++;
        const topics=direction==='OUT'?[TRANSFER_TOPIC,wt]:[TRANSFER_TOPIC,null,wt];
        const logs=await chunkedLogs(urls,{topics},from,latest,c.chunk,rpcStats,health);
        health.transferLogs+=logs.length;
        for(const log of logs){
          if(!log?.data||log.data==='0x'||(log.topics||[]).length<3)continue;
          const fromA=topicAddress(log.topics[1]),toA=topicAddress(log.topics[2]);
          const counter=direction==='OUT'?toA:fromA;
          if(!counter||counter===ZERO||counter===norm(w.address))continue;
          const lab=await label(c.chainId,counter,labelCache,lookup);
          if(!lab.exchange)continue;
          const m=await tokenMeta(urls,log.address,tokenCache,rpcStats),time=await blockTime(urls,log.blockNumber,blockCache,rpcStats)||new Date().toISOString();
          const flowType=direction==='OUT'?'DEPOSIT_TO_CEX':'WITHDRAWAL_FROM_CEX';
          const id=[c.name,w.label,log.transactionHash,log.logIndex,flowType].join(':');
          retained.set(id,{id,chain:c.name,chainId:c.chainId,walletLabel:w.label,wallet:norm(w.address),exchange:lab.exchange,exchangeAddress:counter,exchangeLabel:lab.label,exchangeNameTag:lab.nameTag,flowType,asset:m.symbol,tokenContract:norm(log.address),amount:formatUnits(log.data,m.decimals),txHash:log.transactionHash,blockNumber:hexNum(log.blockNumber),eventTime:time,interpretation:direction==='OUT'?'Possible exchange deposit / potential sell-side pressure; not proof of sale.':'Possible exchange withdrawal / potential self-custody accumulation; not proof of purchase.'});
          health.cexMatches++;
        }
      }
    }
    if(health.failedChunks>0)health.status=health.successfulChunks>0?'PARTIAL':'ERROR';
    health.lastErrors=health.lastErrors.slice(-8);
    chainHealth[c.name]=health;
  }
  const events=[...retained.values()].filter(e=>(tsMs(e.eventTime)||0)>=cutoff).sort((a,b)=>(tsMs(b.eventTime)||0)-(tsMs(a.eventTime)||0));
  const degraded=Object.values(chainHealth).some(x=>x.status!=='PASS')||lookup.errors>0||lookup.capped>0;
  const out={schemaVersion:'1.1',module:'whalesCexFlowLabeler',generatedAt:new Date().toISOString(),status:degraded?'PARTIAL':'PASS',provider:{name:'eth-labels.com',provenance:'Public Etherscan-derived EVM label dataset',targetExchanges:TARGETS.map(upper)},coverage:{ethereum:'ERC20_TRANSFER_FLOWS_CHUNKED_RPC',base:'ERC20_TRANSFER_FLOWS_CHUNKED_RPC',arbitrum:'ERC20_TRANSFER_FLOWS_CHUNKED_RPC',solana:'DATA_GAP',nativeEthTransfers:'DATA_GAP'},chainHealth,rpcStats,lookupStats:lookup,retentionDays:30,labelCache,events,deposits:events.filter(e=>e.flowType==='DEPOSIT_TO_CEX'),withdrawals:events.filter(e=>e.flowType==='WITHDRAWAL_FROM_CEX'),interpretation:'Exchange labels are attribution evidence, not proof that the asset was sold or bought. Chunked multi-provider RPC prevents a single range/provider rejection from disabling an entire chain.'};
  await fs.writeFile(STATE,JSON.stringify(out,null,2)+'\n');
  report.cexFlows={status:out.status,generatedAt:out.generatedAt,provider:out.provider,coverage:out.coverage,deposits:out.deposits,withdrawals:out.withdrawals,chainHealth:out.chainHealth,lookupStats:out.lookupStats,interpretation:out.interpretation};
  report.health=report.health||{};report.health.cexFlowLabeler={status:out.status,generatedAt:out.generatedAt,chainHealth:out.chainHealth};
  report.coverage=report.coverage||{};report.coverage.cexFlows='PERSISTENT_EVM_ERC20_CEX_LABELING_CHUNKED_FAILOVER_ETHEREUM_BASE_ARBITRUM';
  const gaps=new Set(report.dataGaps||[]);gaps.delete('CEX_LABELING_NOT_IMPLEMENTED');gaps.delete('CEX_DEPOSIT_WITHDRAWAL_LABELING_NOT_IMPLEMENTED');gaps.delete('CEX_EVM_LABELING_ERROR');
  if(out.status==='PASS')gaps.delete('CEX_EVM_LABELING_PARTIAL');else gaps.add('CEX_EVM_LABELING_PARTIAL');
  gaps.add('CEX_SOLANA_FLOW_LABELING_NOT_IMPLEMENTED');gaps.add('CEX_NATIVE_ETH_FLOW_LABELING_NOT_IMPLEMENTED');report.dataGaps=[...gaps];
  report.executive=report.executive||{};report.executive.cexFlows={status:out.status,deposits:out.deposits.length,withdrawals:out.withdrawals.length,chains:Object.fromEntries(Object.entries(chainHealth).map(([k,v])=>[k,v.status]))};
  report.generatedAt=new Date().toISOString();
  await fs.writeFile(REPORT,JSON.stringify(report,null,2)+'\n');
  console.log('WHALES CEX FLOW REPAIR',out.generatedAt,out.status,'chains=',Object.fromEntries(Object.entries(chainHealth).map(([k,v])=>[k,v.status])),'deposits=',out.deposits.length,'withdrawals=',out.withdrawals.length,'lookup=',lookup);
}

main().catch(e=>{console.error(e);process.exit(1)});
