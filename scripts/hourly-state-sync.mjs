import fs from 'node:fs';

const CORE = ['BTC','ETH','SOL','XRP','AVAX','HBAR','ONDO'];
const VALIDATION_CAPITAL = 14687.25;
const CB = 'https://api.exchange.coinbase.com';
const CG = 'https://api.coingecko.com/api/v3';

const readJSON = p => JSON.parse(fs.readFileSync(p,'utf8'));
const writeJSON = (p,v) => fs.writeFileSync(p,JSON.stringify(v,null,2)+'\n');
const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
const median=a=>{const x=[...a].sort((p,q)=>p-q),n=x.length;return n?(n%2?x[(n-1)/2]:(x[n/2-1]+x[n/2])/2):null};

function madridISO(d=new Date()){
  const f=new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Madrid',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23',timeZoneName:'longOffset'});
  const p=Object.fromEntries(f.formatToParts(d).map(x=>[x.type,x.value]));
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}${(p.timeZoneName||'GMT+00:00').replace('GMT','')}`;
}
function madridHuman(d=new Date()){
  return new Intl.DateTimeFormat('sv-SE',{timeZone:'Europe/Madrid',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(d).replace('T',' ');
}
function scanId(d=new Date()){
  return `CRSYNC-${new Intl.DateTimeFormat('sv-SE',{timeZone:'Europe/Madrid',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(d).replace(/[-: T]/g,'')}`;
}
async function fetchJSON(url,timeout=12000){const c=new AbortController(),t=setTimeout(()=>c.abort(),timeout);try{const r=await fetch(url,{headers:{accept:'application/json','user-agent':'crypto-reca-state-sync/2.0'},signal:c.signal});if(!r.ok)throw new Error(`HTTP ${r.status}`);return await r.json()}finally{clearTimeout(t)}}

async function cbCandles(asset,granularity){
  const candidates=[`${asset}-USD`,`${asset}-USDC`];
  let lastErr='';
  for(const product of candidates){
    try{
      const raw=await fetchJSON(`${CB}/products/${product}/candles?granularity=${granularity}`);
      if(!Array.isArray(raw)||raw.length<20)throw new Error('insufficient candles');
      const now=Date.now();
      const out=raw.map(r=>({t:Number(r[0])*1000,l:Number(r[1]),h:Number(r[2]),o:Number(r[3]),c:Number(r[4]),v:Number(r[5])}))
        .filter(x=>Number.isFinite(x.c)&&x.t+granularity*1000<=now)
        .sort((a,b)=>a.t-b.t);
      if(out.length<20)throw new Error('insufficient completed candles');
      return {product,candles:out};
    }catch(e){lastErr=`${product}: ${e.message}`}
  }
  throw new Error(lastErr||'Coinbase candles unavailable');
}
function synth4h(h1){
  const groups=new Map();
  for(const x of h1){const d=new Date(x.t),hour=d.getUTCHours(),start=Date.UTC(d.getUTCFullYear(),d.getUTCMonth(),d.getUTCDate(),Math.floor(hour/4)*4);if(!groups.has(start))groups.set(start,[]);groups.get(start).push(x)}
  return [...groups.entries()].sort((a,b)=>a[0]-b[0]).filter(([,g])=>g.length===4).map(([t,g])=>({t,o:g[0].o,h:Math.max(...g.map(x=>x.h)),l:Math.min(...g.map(x=>x.l)),c:g.at(-1).c,v:g.reduce((s,x)=>s+x.v,0)}));
}
async function market(asset){
  const [m15,h1,d1]=await Promise.all([cbCandles(asset,900),cbCandles(asset,3600),cbCandles(asset,86400)]);
  const h4=synth4h(h1.candles);
  if(h4.length<20)throw new Error('insufficient synthetic 4H candles');
  return {asset,product:h1.product,m15:m15.candles,h1:h1.candles,h4,d1:d1.candles,current:h1.candles.at(-1).c};
}
async function cgPrice(id){const j=await fetchJSON(`${CG}/simple/price?ids=${encodeURIComponent(id)}&vs_currencies=usd`);return Number(j?.[id]?.usd)}

function ema(vals,n){if(vals.length<n)return null;let e=vals.slice(0,n).reduce((a,b)=>a+b,0)/n,k=2/(n+1);for(let i=n;i<vals.length;i++)e=vals[i]*k+e*(1-k);return e}
function emaSeries(vals,n){if(vals.length<n)return [];const out=Array(n-1).fill(null);let e=vals.slice(0,n).reduce((a,b)=>a+b,0)/n,k=2/(n+1);out.push(e);for(let i=n;i<vals.length;i++){e=vals[i]*k+e*(1-k);out.push(e)}return out}
function rsi(vals,n=14){if(vals.length<n+1)return null;let g=0,l=0;for(let i=vals.length-n;i<vals.length;i++){const d=vals[i]-vals[i-1];d>=0?g+=d:l-=d}return l===0?100:100-100/(1+(g/n)/(l/n))}
function atr(c,n=14){if(c.length<n+1)return null;let t=[];for(let i=c.length-n;i<c.length;i++){const p=c[i-1].c,x=c[i];t.push(Math.max(x.h-x.l,Math.abs(x.h-p),Math.abs(x.l-p)))}return t.reduce((a,b)=>a+b,0)/t.length}
function macd(vals){const a=emaSeries(vals,12),b=emaSeries(vals,26),line=vals.map((_,i)=>a[i]!=null&&b[i]!=null?a[i]-b[i]:null).filter(x=>x!=null);if(line.length<10)return {hist:null,prevHist:null};const s=emaSeries(line,9);return {hist:line.at(-1)-s.at(-1),prevHist:line.at(-2)-s.at(-2)}}
function rvol(c){if(c.length<21)return null;const base=median(c.slice(-21,-1).map(x=>x.v));return base?c.at(-1).v/base:null}
function support(c,n=24){return Math.min(...c.slice(-n).map(x=>x.l))}
function resistance(c,n=24){return Math.max(...c.slice(-(n+1),-1).map(x=>x.h))}
function slope3(s){const v=s.filter(x=>x!=null);return v.length>=4?v.at(-1)-v.at(-4):0}
function tf(c){const cls=c.map(x=>x.c),last=cls.at(-1),e20s=emaSeries(cls,20),e20=e20s.at(-1),e50=ema(cls,50);if(e20==null||e50==null)return 'NEUTRAL';const b=[last>e20&&slope3(e20s)>0,last>e50,support(c,5)>support(c.slice(0,-5),5)].filter(Boolean).length;const s=[last<e20&&slope3(e20s)<0,last<e50,support(c,5)<support(c.slice(0,-5),5)].filter(Boolean).length;return b>=2&&s<2?'BULLISH':s>=2?'BEARISH':'NEUTRAL'}
function dstate(d1,h4){return d1==='BEARISH'&&h4==='BEARISH'?'D0':d1!=='BEARISH'&&h4!=='BEARISH'&&(d1==='BULLISH'||h4==='BULLISH')?'D2':'D1'}
function rrScore(rr,max){if(!Number.isFinite(rr))return 0;if(max===10){if(rr>=3)return 10;if(rr>=2.5)return 8;if(rr>=2)return 6;if(rr>=1.8)return 5;if(rr>=1.5)return 2;return 0}if(rr>=3)return 5;if(rr>=2)return 4;if(rr>=1.8)return 3;if(rr>=1.5)return 1;return 0}
function entryName(n){return n<=1?'NO TIMING':n===2?'EARLY WATCH':n===3?'PREPARE':n===4?'STRONG CONFIRMATION':'FULL CONFIRMATION'}

function radarAsset(m,breadth){
  const cls=m.h1.map(x=>x.c),c=m.current,a=atr(m.h1),r=rsi(cls),mc=macd(cls),rv=rvol(m.h1),e20=ema(cls,20),e50=ema(cls,50),e200=ema(cls,200);
  const t1=tf(m.h1),t4=tf(m.h4),td=tf(m.d1),d=dstate(td,t4),sup=support(m.h1),res=resistance(m.h1),inv=a?sup-.25*a:sup*.997,rr=(c>inv&&res>c)?(res-c)/(c-inv):null;
  const trend=e20!=null&&e50!=null&&c>e50&&e20>=e50&&t4!=='BEARISH';const dist=a?Math.abs(c-sup)/a:null;const location=dist!=null&&dist<=1;const momentum=mc.hist!=null&&mc.prevHist!=null&&mc.hist>mc.prevHist&&r>=50;const volume=rv!=null&&rv>=1.2;
  const priorHi=Math.max(...m.h1.slice(-21,-1).map(x=>x.h)),last15=m.m15.at(-1),trigger=m.h1.at(-1).c>priorHi&&last15.c>=priorHi;
  const entry=[trend,location,momentum,volume,trigger].filter(Boolean).length;
  const regime=d==='D2'&&td==='BULLISH'&&t4==='BULLISH'?20:d==='D2'?16:d==='D1'?8:0;
  const loc=dist==null?0:dist<=.5?20:dist<=1?15:dist<=1.5?5:0;const conf=t1==='BULLISH'&&t4==='BULLISH'?15:t1!=='BEARISH'&&t4!=='BEARISH'?10:5;const vs=rv==null?0:rv>=1.5?10:rv>=1.2?7:rv>=.8?5:2;const align=breadth>=5?10:breadth>=4?7:breadth>=3?5:2;
  const P=clamp(regime+loc+conf+vs+align+rrScore(rr,10),0,100),bs=trigger?20:(c>e20&&c>e50?15:10),m15=trigger?10:(last15.c>=last15.o?5:0),M=clamp(regime+bs+conf+m15+vs+align+rrScore(rr,5),0,100),ers=Math.max(P,M),lane=P===M?'MIXED':P>M?'PULLBACK':'MOMENTUM';
  let e='E1';if(d==='D0'||!Number.isFinite(inv)||inv>=c||(rr!=null&&rr<1.5))e='E2';else if(entry>=4)e='E0';const executionStatus=e==='E2'?'BLOCKED':ers>=80&&entry>=4?'ARMED':'WATCH';
  return {asset:m.asset,pair:`${m.asset}-USDC`,price:c,d,e,pullbackScore:Math.round(P),momentumScore:Math.round(M),ers:Math.round(ers),ersLane:lane,entryConfirmation:entry,entryState:entryName(entry),executionStatus,decision:executionStatus==='ARMED'?'ENTRY CANDIDATE — PREVIEW REQUIRED BEFORE REAL ORDER':entry===3?'PREPARE':ers>=75?'WATCH / PREPARE':'NO TRADE',dataQuality:'PARTIAL',timeframes:{d1:td,h4:t4,h1:t1},indicators:{ema20_1h:e20,ema50_1h:e50,ema200_1h:e200,rsi14_1h:r,macdHist_1h:mc.hist,atr14_1h:a,rvol1h:rv},levels:{support:sup,invalidation:inv,resistance:res,rr},wakeUp:{earlyAlert:'1H structure improves with RVOL >=1.20 and price remains within 1 ATR of support',tradeTrigger:'completed 1H breakout/reclaim plus completed 15m hold',volumeShock:'1H RVOL >=1.50 supportive',invalidation:inv,expiryHours:24},source:m.product,notes:'Autonomous persistence uses completed Coinbase public candles. Derivatives/news components remain zero in this lightweight persistence cycle.'};
}
function fastDrop(m){if(!m)return {triggered:false};const h=m.h1.at(-1),ph=m.h1.slice(-21,-1),rh=ph.length===20?h.v/median(ph.map(x=>x.v)):null,hm=(h.c-h.o)/h.o*100,q=m.m15.at(-1),pq=m.m15.slice(-21,-1),rq=pq.length===20?q.v/median(pq.map(x=>x.v)):null,qm=(q.c-q.o)/q.o*100,last2=m.m15.slice(-2),draw=last2.length===2?(Math.max(...last2.map(x=>x.h))-Math.min(...last2.map(x=>x.l)))/Math.max(...last2.map(x=>x.h))*100:null;return {triggered:(qm<=-2&&rq>=3)||(hm<=-3&&rh>=2)||(draw>=3.5&&Math.max(rq||0,rh||0)>=2),move15mPct:qm,rvol15m:rq,move1hPct:hm,rvol1h:rh,drawdown30mPct:draw}}
function action(prs){return prs==null?'WATCH — RISK DATA GAP':prs<25?'HOLD':prs<45?'WATCH':prs<60?'REDUCE REVIEW':prs<80?'EXIT REVIEW':'EXIT SIGNAL'}
function rank(a){return {'HOLD':0,'WATCH':1,'REDUCE REVIEW':2,'EXIT REVIEW':3,'EXIT SIGNAL':4}[a]??1}
function riskObj(p,m,prev,current){
  let inv=prev?.technicalInvalidation??prev?.managementThesis?.managementInvalidation??p.recommendedStop??null;let mgmt=null;if(inv==null&&m){const a=atr(m.h1),sup=support(m.h4,18);if(a){mgmt={support:sup,invalidation:sup-Math.max(.25*a,.0015*current)};if(mgmt.invalidation>0&&mgmt.invalidation<current)inv=mgmt.invalidation}}
  if(!Number.isFinite(current)||!Number.isFinite(inv))return {asset:p.asset,prs:null,action:'WATCH — RISK DATA GAP',protection:p.protection||'UNPROTECTED',entry:p.entry,qty:p.qty,currentPrice:current,technicalInvalidation:inv,invalidationStatus:'PARTIAL',dataQuality:'PARTIAL',reason:'Fresh price obtained but autonomous structural OHLCV/invalidation is incomplete.'};
  let st='INTACT';if(m){const two=m.m15.slice(-2).every(x=>x.c<inv),one=m.h1.at(-1).c<inv,low=Math.min(...m.m15.slice(-4).map(x=>x.l));st=one||two?'INVALIDATED':low<inv&&m.m15.at(-1).c>=inv?'RECLAIMED':low<inv?'BREACH':'INTACT'}
  const A={INTACT:0,RECLAIMED:15,BREACH:25,INVALIDATED:40}[st]??0,t1=m?tf(m.h1):'NEUTRAL',t4=m?tf(m.h4):'NEUTRAL',td=m?tf(m.d1):'NEUTRAL',B=t4==='BEARISH'||td==='BEARISH'?20:t1==='BEARISH'?10:0,rs=m?rsi(m.h1.map(x=>x.c)):null,mc=m?macd(m.h1.map(x=>x.c)):null,rv=m?rvol(m.h1):null,C=rs!=null&&rs<45&&mc.hist<0&&rv>=1.2?15:0,a=m?atr(m.h1):null,adv=p.entry>current&&a?(p.entry-current)/a:0,D=adv>1.5?15:adv>1?10:adv>.5?5:0,E=p.protection==='PROTECTED'?0:10,prs=A+B+C+D+E;let ac=action(prs);if(st==='INVALIDATED'&&rank(ac)<3)ac='EXIT REVIEW';const fd=fastDrop(m);
  return {asset:p.asset,engine:p.engine,policyVersion:'2.2',prs,breakdown:{structural:A,regime:B,momentum:C,adverseMove:D,protection:E},thesisState:p.setup?'CURRENT_ORIGINAL':'UNKNOWN_ORIGINAL',managementThesisState:p.setup?null:(st==='INVALIDATED'?'INVALIDATED':'ACTIVE'),structuralState:st,exitUrgency:ac==='EXIT SIGNAL'?'CRITICAL':['REDUCE REVIEW','EXIT REVIEW'].includes(ac)?'ELEVATED':'NORMAL',action:ac,protection:p.protection||'UNPROTECTED',actualProtectedHeat:p.protection==='PROTECTED'?'CONFIRMED_BY_POSITIONS_STATE':'NOT ESTABLISHED',entry:p.entry,currentPrice:current,qty:p.qty,technicalInvalidation:inv,invalidationStatus:p.setup?'CURRENT':'MANAGEMENT_CURRENT',modeledLossUSDC:Number(p.qty)*Math.max(Number(p.entry)-inv,0),unrealizedPnL:(current-Number(p.entry))*Number(p.qty),trendTimeframes:{'1h':t1,'4h':t4,'1d':td},fastDropRisk:fd,managementThesis:!p.setup?{managementLane:'MANAGEMENT_ONLY',support:mgmt?.support??prev?.managementThesis?.support??null,managementInvalidation:inv,invalidationStatus:'MANAGEMENT_CURRENT',ratchetRule:'Never move lower; only ratchet upward after a new defended higher base.'}:undefined,reason:`Structural=${st}; trend ${t1}/${t4}/${td}; protection=${p.protection||'UNPROTECTED'}${fd.triggered?'; FAST-DROP RISK':''}.`};
}

async function main(){
  const now=new Date(),stamp=madridISO(now),human=madridHuman(now),id=scanId(now),oldRadar=readJSON('data/radar-state.json'),oldRisk=readJSON('data/position-risk.json'),posState=readJSON('data/positions-state.json'),markets={},fail=[];
  for(const a of CORE){try{markets[a]=await market(a)}catch(e){fail.push(`${a}: ${e.message}`)}}
  const breadth=CORE.filter(a=>markets[a]&&tf(markets[a].h4)!=='BEARISH').length;
  const radar=CORE.map(a=>markets[a]?radarAsset(markets[a],breadth):{asset:a,pair:`${a}-USDC`,d:null,e:null,pullbackScore:null,momentumScore:null,ers:null,ersLane:null,entryConfirmation:null,entryState:'DATA GAP',executionStatus:'BLOCKED',decision:'NO TRADE — DATA GAP',dataQuality:'FAIL'});
  const hist=[...(Array.isArray(oldRadar.history)?oldRadar.history:[]),{id,timestampEuropeMadrid:human,dataQuality:fail.length?'PARTIAL':'PASS',bestCondition:radar.filter(x=>x.ers!=null).sort((a,b)=>b.ers-a.ers)[0]?.asset||'NONE',realOrderThisScan:'NO',assets:Object.fromEntries(radar.map(x=>[x.asset,{ers:x.ers,entryConfirmation:x.entryConfirmation,executionStatus:x.executionStatus}]))}].slice(-168);
  writeJSON('data/radar-state.json',{schemaVersion:'2.0',module:'radar',generatedAt:stamp,source:'GitHub Actions Hourly State Sync — Coinbase public OHLCV',engineVersion:'Crypto Reca v3.0',validationCapital:VALIDATION_CAPITAL,scan:{id,timestampEuropeMadrid:human,dataQuality:fail.length?'PARTIAL':'PASS',bestCondition:radar.filter(x=>x.ers!=null).sort((a,b)=>b.ers-a.ers)[0]?.asset||'NONE',realOrderThisScan:'NO',conclusion:'Autonomous lightweight persistence completed. No auto-execution.',sourceFailures:fail},radar,history:hist,audits:Array.isArray(oldRadar.audits)?oldRadar.audits:[],engineHealth:{ers:{status:fail.length?'PARTIAL':'PASS',spec:'docs/ENGINE_SPEC_V3_ERS.md',specRevision:'R1',reason:fail.length?fail.join('; '):'Seven CORE assets refreshed from completed public OHLCV.'},persistence:{status:'PASS',writer:'GitHub Actions',verification:'JSON validated and re-read from origin/main'}},shadowPortfolio:oldRadar.shadowPortfolio||{generatedAt:null,candidates:[]}});

  const open=(posState.positions||[]).filter(p=>p.status==='OPEN'),rp={},rh=[...(Array.isArray(oldRisk.riskHistory)?oldRisk.riskHistory:[])];let partial=false;
  for(const p of open){let m=markets[p.asset]||null;if(!m&&p.asset==='TRUST'){try{m=await market('TRUST')}catch{}}let current=m?.current??null;if(current==null){try{current=await cgPrice({TRUST:'intuition',PHA:'pha'}[p.asset])}catch{}}const prev=oldRisk?.positionRisk?.positions?.[p.id]||null,o=riskObj(p,m,prev,current);rp[p.id]=o;if(o.prs==null)partial=true;if(prev?.action!==o.action||o.fastDropRisk?.triggered)rh.push({timestampEuropeMadrid:human,positionId:p.id,asset:p.asset,prs:o.prs,action:o.action,structuralState:o.structuralState,protection:o.protection,event:o.fastDropRisk?.triggered?'FAST_DROP_RISK':'AUTONOMOUS_RISK_STATE_CHANGE'})}
  writeJSON('data/position-risk.json',{schemaVersion:'2.0',module:'positionRisk',generatedAt:stamp,source:'GitHub Actions Hourly State Sync',positionRisk:{generatedAt:stamp,source:'Crypto Reca Position Risk',policyVersion:'2.2',dataQuality:partial?'PARTIAL':'PASS',positions:rp},riskHistory:rh.slice(-168)});
  JSON.parse(fs.readFileSync('data/radar-state.json','utf8'));JSON.parse(fs.readFileSync('data/position-risk.json','utf8'));console.log(JSON.stringify({ok:true,generatedAt:stamp,scanId:id,coreFresh:radar.filter(x=>x.ers!=null).length,openPositions:open.length,failures:fail},null,2));
}
main().catch(e=>{console.error(e);process.exit(1)});
