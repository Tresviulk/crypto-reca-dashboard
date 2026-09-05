import fs from 'node:fs';

const CORE = ['BTC','ETH','SOL','XRP','AVAX','HBAR','ONDO'];
const PAIRS = Object.fromEntries(CORE.map(a => [a, `${a}USDT`]));
const VALIDATION_CAPITAL = 14687.25;
const BYBIT = 'https://api.bybit.com/v5/market/kline';

const readJSON = p => JSON.parse(fs.readFileSync(p, 'utf8'));
const writeJSON = (p, v) => fs.writeFileSync(p, JSON.stringify(v, null, 2) + '\n');
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const med = arr => { const a=[...arr].sort((x,y)=>x-y); const n=a.length; return n? (n%2?a[(n-1)/2]:(a[n/2-1]+a[n/2])/2):null; };

function madridStamp(d=new Date()) {
  const f = new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Madrid',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23',timeZoneName:'longOffset'});
  const p=Object.fromEntries(f.formatToParts(d).map(x=>[x.type,x.value]));
  const off=(p.timeZoneName||'GMT+00:00').replace('GMT','');
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}${off}`;
}
function madridHuman(d=new Date()) {
  return new Intl.DateTimeFormat('sv-SE',{timeZone:'Europe/Madrid',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(d).replace('T',' ');
}
function scanId(d=new Date()) { return `CRSYNC-${new Intl.DateTimeFormat('sv-SE',{timeZone:'Europe/Madrid',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(d).replace(/[-: T]/g,'')}`; }

async function fetchJSON(url, timeoutMs=12000) {
  const c=new AbortController(); const t=setTimeout(()=>c.abort(),timeoutMs);
  try { const r=await fetch(url,{headers:{'user-agent':'crypto-reca-hourly-sync/1.0'},signal:c.signal}); if(!r.ok) throw new Error(`HTTP ${r.status}`); return await r.json(); }
  finally { clearTimeout(t); }
}

async function bybitKline(symbol, interval, limit) {
  const u=`${BYBIT}?category=spot&symbol=${symbol}&interval=${interval}&limit=${limit}`;
  const j=await fetchJSON(u);
  if (j.retCode!==0 || !Array.isArray(j?.result?.list)) throw new Error(`${symbol} ${interval}: ${j.retMsg||'bad response'}`);
  return j.result.list.map(r=>({t:Number(r[0]),o:Number(r[1]),h:Number(r[2]),l:Number(r[3]),c:Number(r[4]),v:Number(r[5])})).sort((a,b)=>a.t-b.t);
}

async function coinGeckoPrice(id) {
  const j=await fetchJSON(`https://api.coingecko.com/api/v3/simple/price?ids=${encodeURIComponent(id)}&vs_currencies=usd`);
  return Number(j?.[id]?.usd);
}

function ema(vals, n) {
  if(vals.length<n) return null; const k=2/(n+1); let e=vals.slice(0,n).reduce((a,b)=>a+b,0)/n;
  for(let i=n;i<vals.length;i++) e=vals[i]*k+e*(1-k); return e;
}
function emaSeries(vals,n) {
  if(vals.length<n) return []; const out=Array(n-1).fill(null); let e=vals.slice(0,n).reduce((a,b)=>a+b,0)/n; out.push(e); const k=2/(n+1);
  for(let i=n;i<vals.length;i++){ e=vals[i]*k+e*(1-k); out.push(e); } return out;
}
function rsi(vals,n=14) {
  if(vals.length<n+1) return null; let g=0,l=0; for(let i=vals.length-n;i<vals.length;i++){ const d=vals[i]-vals[i-1]; if(d>=0)g+=d; else l-=d; }
  if(l===0) return 100; const rs=(g/n)/(l/n); return 100-(100/(1+rs));
}
function atr(candles,n=14) {
  if(candles.length<n+1) return null; const trs=[]; for(let i=candles.length-n;i<candles.length;i++){ const p=candles[i-1].c, x=candles[i]; trs.push(Math.max(x.h-x.l,Math.abs(x.h-p),Math.abs(x.l-p))); } return trs.reduce((a,b)=>a+b,0)/trs.length;
}
function macd(vals){ const a=emaSeries(vals,12), b=emaSeries(vals,26); const line=vals.map((_,i)=>a[i]!=null&&b[i]!=null?a[i]-b[i]:null); const valid=line.filter(x=>x!=null); if(valid.length<9)return {line:null,signal:null,hist:null,prevHist:null}; const sig=emaSeries(valid,9); const s=sig[sig.length-1], ln=valid[valid.length-1], prevLn=valid[valid.length-2], prevS=sig[sig.length-2]; return {line:ln,signal:s,hist:ln-s,prevHist:prevLn-prevS}; }
function rv(candles){ if(candles.length<21)return null; const last=candles.at(-1).v, base=med(candles.slice(-21,-1).map(x=>x.v)); return base&&base>0?last/base:null; }
function slope3(series){ const v=series.filter(x=>x!=null); if(v.length<4)return 0; return v.at(-1)-v.at(-4); }
function recentSupport(candles, look=24){ const a=candles.slice(-look); return Math.min(...a.map(x=>x.l)); }
function recentResistance(candles, look=24){ const a=candles.slice(-(look+1),-1); return Math.max(...a.map(x=>x.h)); }

function classifyTF(candles){
  const c=candles.at(-1)?.c; if(!c) return 'NEUTRAL';
  const closes=candles.map(x=>x.c), e20s=emaSeries(closes,20), e20=e20s.at(-1), e50=ema(closes,50);
  const bullish=[e20!=null&&c>e20&&slope3(e20s)>0,e50!=null&&c>e50,candles.length>=10&&recentSupport(candles,5)>recentSupport(candles.slice(0,-5),5)].filter(Boolean).length;
  const bearish=[e20!=null&&c<e20&&slope3(e20s)<0,e50!=null&&c<e50,candles.length>=10&&recentSupport(candles,5)<recentSupport(candles.slice(0,-5),5)].filter(Boolean).length;
  if(bullish>=2 && bearish<2) return 'BULLISH'; if(bearish>=2) return 'BEARISH'; return 'NEUTRAL';
}
function dState(d1,h4){ if(d1==='BEARISH'&&h4==='BEARISH')return 'D0'; if(d1!=='BEARISH'&&h4!=='BEARISH'&&(d1==='BULLISH'||h4==='BULLISH'))return 'D2'; return 'D1'; }
function scoreRegime(d,d1,h4){ if(d==='D2'&&d1==='BULLISH'&&h4==='BULLISH')return 20; if(d==='D2')return 16; if(d==='D1')return 8; return 0; }
function scoreRR(rr,max=10){ if(!Number.isFinite(rr))return 0; if(max===10){ if(rr>=3)return 10;if(rr>=2.5)return 8;if(rr>=2)return 6;if(rr>=1.8)return 5;if(rr>=1.5)return 2;return 0; } if(rr>=3)return 5;if(rr>=2)return 4;if(rr>=1.8)return 3;if(rr>=1.5)return 1;return 0; }
function entryState(n){ return n<=1?'NO TIMING':n===2?'EARLY WATCH':n===3?'PREPARE':n===4?'STRONG CONFIRMATION':'FULL CONFIRMATION'; }
function actionFromPrs(prs){ if(prs==null)return 'WATCH — RISK DATA GAP'; if(prs<25)return 'HOLD'; if(prs<45)return 'WATCH'; if(prs<60)return 'REDUCE REVIEW'; if(prs<80)return 'EXIT REVIEW'; return 'EXIT SIGNAL'; }
function actionRank(a){ return {'HOLD':0,'WATCH':1,'REDUCE REVIEW':2,'EXIT REVIEW':3,'EXIT SIGNAL':4}[a] ?? 1; }

async function buildMarket(asset){
  const symbol=PAIRS[asset];
  const [m15,h1,h4,d1]=await Promise.all([bybitKline(symbol,'15',100),bybitKline(symbol,'60',240),bybitKline(symbol,'240',120),bybitKline(symbol,'D',120)]);
  return {asset,symbol,m15,h1,h4,d1,current:h1.at(-1).c};
}

function buildRadarAsset(m, breadthPositive){
  const closes=m.h1.map(x=>x.c), c=m.current, atr1=atr(m.h1), rsi1=rsi(closes), mc=macd(closes), rvol=rv(m.h1);
  const ema20=ema(closes,20), ema50=ema(closes,50), ema200=ema(closes,200);
  const d1c=classifyTF(m.d1), h4c=classifyTF(m.h4), d=dState(d1c,h4c);
  const support=recentSupport(m.h1,24), resistance=recentResistance(m.h1,24);
  const invalidation=atr1?support-0.25*atr1:support*0.997;
  const rr=(c>invalidation&&resistance>c)?(resistance-c)/(c-invalidation):null;
  const trend=ema20!=null&&ema50!=null&&c>ema50&&ema20>=ema50&&h4c!=='BEARISH';
  const distAtr=atr1?Math.abs(c-support)/atr1:null;
  const location=distAtr!=null&&distAtr<=1;
  const momentum=(mc.hist!=null&&mc.prevHist!=null&&mc.hist>mc.prevHist&&rsi1>=50);
  const volume=(rvol!=null&&rvol>=1.2);
  const priorHi=Math.max(...m.h1.slice(-21,-1).map(x=>x.h));
  const last15=m.m15.at(-1), trigger=(m.h1.at(-1).c>priorHi && last15?.c>=priorHi);
  const entry=[trend,location,momentum,volume,trigger].filter(Boolean).length;
  const regime=scoreRegime(d,d1c,h4c);
  const locScore=distAtr==null?0:distAtr<=0.5?20:distAtr<=1?15:distAtr<=1.5?5:0;
  const momScore=(classifyTF(m.h1)==='BULLISH'&&h4c==='BULLISH')?15:(classifyTF(m.h1)!=='BEARISH'&&h4c!=='BEARISH')?10:5;
  const volScore=rvol==null?0:rvol>=1.5?10:rvol>=1.2?7:rvol>=0.8?5:2;
  const align=breadthPositive>=5?10:breadthPositive>=4?7:breadthPositive>=3?5:2;
  const pullback=clamp(regime+locScore+momScore+volScore+align+0+0+scoreRR(rr,10),0,100);
  const breakoutStruct=trigger?20:(c>ema20&&c>ema50?15:10);
  const m15score=trigger?10:(last15&&last15.c>=last15.o?5:0);
  const momentumScore=clamp(regime+breakoutStruct+momScore+m15score+volScore+align+0+0+scoreRR(rr,5),0,100);
  const ers=Math.max(pullback,momentumScore), lane=pullback===momentumScore?'MIXED':pullback>momentumScore?'PULLBACK':'MOMENTUM';
  let e='E1'; if(d==='D0'||!Number.isFinite(invalidation)||invalidation>=c||(rr!=null&&rr<1.5))e='E2'; else if(entry>=4)e='E0';
  let executionStatus=e==='E2'?'BLOCKED':ers>=80&&entry>=4?'ARMED':'WATCH';
  const decision=executionStatus==='ARMED'?'ENTRY CANDIDATE — PREVIEW REQUIRED BEFORE REAL ORDER':entry===3?'PREPARE':ers>=75?'WATCH / PREPARE':'NO TRADE';
  return {asset:m.asset,pair:`${m.asset}-USDC`,price:c,d,e,pullbackScore:Math.round(pullback),momentumScore:Math.round(momentumScore),ers:Math.round(ers),ersLane:lane,entryConfirmation:entry,entryState:entryState(entry),executionStatus,decision,dataQuality:'PARTIAL',timeframes:{d1:d1c,h4:h4c,h1:classifyTF(m.h1)},indicators:{ema20_1h:ema20,ema50_1h:ema50,ema200_1h:ema200,rsi14_1h:rsi1,macdHist_1h:mc.hist,atr14_1h:atr1,rvol1h:rvol},levels:{support,invalidation,resistance,rr},wakeUp:{earlyAlert:`1H structure improves with RVOL >=1.20 and price remains within 1 ATR of support`,tradeTrigger:`completed 1H breakout/reclaim plus completed 15m hold`,volumeShock:`1H RVOL >=1.50 supportive`,invalidation,expiryHours:24},notes:'Automated deterministic public-data persistence. Event/news and derivatives components are intentionally 0 here; interactive TODO may add richer context without rewriting this scan.'};
}

function deriveManagementInvalidation(m,current){
  const a=atr(m.h1); if(!a)return null; const support=recentSupport(m.h4,18); const buffer=Math.max(0.25*a,0.0015*current); const inv=support-buffer; return inv>0&&inv<current?{support,invalidation:inv,atr:a}:null;
}

async function currentPriceForPosition(p, markets){
  if(markets[p.asset]) return markets[p.asset].current;
  const ids={PHA:'pha',TRUST:'intuition'}; if(ids[p.asset]) return await coinGeckoPrice(ids[p.asset]);
  return null;
}

function structuralFrom(m, inv){
  if(!m||!Number.isFinite(inv))return {state:'UNKNOWN',two15:false,one1h:false};
  const c15=m.m15.slice(-2).map(x=>x.c), one1h=m.h1.at(-1).c<inv, two15=c15.length===2&&c15.every(x=>x<inv);
  if(one1h||two15)return {state:'INVALIDATED',two15,one1h};
  const low=Math.min(...m.m15.slice(-4).map(x=>x.l)); if(low<inv&&m.m15.at(-1).c>=inv)return {state:'RECLAIMED',two15,one1h}; if(low<inv)return {state:'BREACH',two15,one1h}; return {state:'INTACT',two15,one1h};
}

function fastDrop(m){
  if(!m)return {triggered:false};
  const h=m.h1.at(-1), prevH=m.h1.slice(-21,-1), rvh=prevH.length===20? h.v/med(prevH.map(x=>x.v)):null, hmove=(h.c-h.o)/h.o*100;
  const q=m.m15.at(-1), prevQ=m.m15.slice(-21,-1), rvq=prevQ.length===20? q.v/med(prevQ.map(x=>x.v)):null, qmove=(q.c-q.o)/q.o*100;
  const last2=m.m15.slice(-2), draw=last2.length===2?(Math.max(...last2.map(x=>x.h))-Math.min(...last2.map(x=>x.l)))/Math.max(...last2.map(x=>x.h))*100:null;
  const triggered=(qmove<=-2&&rvq>=3)||(hmove<=-3&&rvh>=2)||(draw!=null&&draw>=3.5&&Math.max(rvq||0,rvh||0)>=2);
  return {triggered,move15mPct:qmove,rvol15m:rvq,move1hPct:hmove,rvol1h:rvh,drawdown30mPct:draw};
}

function buildRiskObject(p,m,prev,current){
  const oldInv=prev?.technicalInvalidation ?? prev?.managementThesis?.managementInvalidation ?? p.recommendedStop ?? null;
  const mgmt=oldInv==null&&m?deriveManagementInvalidation(m,current):null;
  const inv=oldInv ?? mgmt?.invalidation ?? null;
  if(!Number.isFinite(current) || !Number.isFinite(inv)) return {asset:p.asset,prs:null,action:'WATCH — RISK DATA GAP',protection:p.protection||'UNPROTECTED',entry:p.entry,qty:p.qty,currentPrice:current,technicalInvalidation:inv,invalidationStatus:inv?'CURRENT':'PARTIAL',dataQuality:'PARTIAL',reason:'No defensible current market structure/invalidation available from autonomous public-data source.'};
  const st=structuralFrom(m,inv); const A={INTACT:0,RECLAIMED:15,BREACH:25,INVALIDATED:40}[st.state] ?? 0;
  const tf1=m?classifyTF(m.h1):'NEUTRAL', tf4=m?classifyTF(m.h4):'NEUTRAL', tfd=m?classifyTF(m.d1):'NEUTRAL';
  const B=(tf4==='BEARISH'||tfd==='BEARISH')?20:(tf1==='BEARISH'?10:0);
  const rs=m?rsi(m.h1.map(x=>x.c)):null, mc=m?macd(m.h1.map(x=>x.c)):null, rvol=m?rv(m.h1):null;
  const C=(rs!=null&&rs<45&&mc?.hist<0&&rvol!=null&&rvol>=1.2)?15:0;
  const a=m?atr(m.h1):null; const adverse=p.entry>current&&a? (p.entry-current)/a : 0; const D=adverse>1.5?15:adverse>1?10:adverse>0.5?5:0;
  const E=p.protection==='PROTECTED'?0:10; let prs=A+B+C+D+E; let action=actionFromPrs(prs); if(st.state==='INVALIDATED'&&actionRank(action)<3)action='EXIT REVIEW';
  const urgency=action==='EXIT SIGNAL'?'CRITICAL':(action==='REDUCE REVIEW'||action==='EXIT REVIEW')?'ELEVATED':'NORMAL'; const fd=fastDrop(m);
  return {asset:p.asset,engine:p.engine,policyVersion:'2.2',prs,breakdown:{structural:A,regime:B,momentum:C,adverseMove:D,protection:E},thesisState:p.setup?'CURRENT_ORIGINAL':'UNKNOWN_ORIGINAL',managementThesisState:p.setup?null:(st.state==='INVALIDATED'?'INVALIDATED':'ACTIVE'),structuralState:st.state,exitUrgency:urgency,action,protection:p.protection||'UNPROTECTED',actualProtectedHeat:p.protection==='PROTECTED'?'CONFIRMED_BY_POSITIONS_STATE':'NOT ESTABLISHED',entry:p.entry,currentPrice:current,qty:p.qty,technicalInvalidation:inv,invalidationStatus:p.setup?'CURRENT':'MANAGEMENT_CURRENT',modeledLossUSDC:Number(p.qty)*Math.max(Number(p.entry)-inv,0),unrealizedPnL:(current-Number(p.entry))*Number(p.qty),trendTimeframes:{'1h':tf1,'4h':tf4,'1d':tfd},fastDropRisk:fd,managementThesis:!p.setup?{managementLane:'MANAGEMENT_ONLY',support:mgmt?.support??prev?.managementThesis?.support??null,managementInvalidation:inv,invalidationStatus:'MANAGEMENT_CURRENT',ratchetRule:'Never move lower; may only ratchet upward after a newly completed higher defended support/base.'}:undefined,reason:`Structural=${st.state}; regime ${tf1}/${tf4}/${tfd}; protection=${p.protection||'UNPROTECTED'}${fd.triggered?'; FAST-DROP RISK triggered':''}.`};
}

async function main(){
  const now=new Date(), stamp=madridStamp(now), human=madridHuman(now), id=scanId(now);
  const prevRadar=readJSON('data/radar-state.json'); const prevRisk=readJSON('data/position-risk.json'); const positionsState=readJSON('data/positions-state.json');
  const markets={}; const failures=[];
  for(const a of CORE){ try{ markets[a]=await buildMarket(a); } catch(e){ failures.push(`${a}: ${e.message}`); } }
  const positive=CORE.filter(a=>markets[a]&&classifyTF(markets[a].h4)!=='BEARISH').length;
  const radar=CORE.map(a=>markets[a]?buildRadarAsset(markets[a],positive):{asset:a,pair:`${a}-USDC`,d:null,e:null,pullbackScore:null,momentumScore:null,ers:null,ersLane:null,entryConfirmation:null,entryState:'DATA GAP',executionStatus:'BLOCKED',decision:'NO TRADE — DATA GAP',dataQuality:'FAIL'});
  const history=[...(Array.isArray(prevRadar.history)?prevRadar.history:[]),{id,timestampEuropeMadrid:human,dataQuality:failures.length?'PARTIAL':'PASS',bestCondition:radar.filter(x=>x.ers!=null).sort((a,b)=>b.ers-a.ers)[0]?.asset||'NONE',realOrderThisScan:'NO',assets:Object.fromEntries(radar.map(x=>[x.asset,{ers:x.ers,entryConfirmation:x.entryConfirmation,executionStatus:x.executionStatus}]))}].slice(-168);
  const newRadar={schemaVersion:'2.0',module:'radar',generatedAt:stamp,source:'GitHub Actions Hourly State Sync — deterministic public market data',engineVersion:'Crypto Reca v3.0',validationCapital:VALIDATION_CAPITAL,scan:{id,timestampEuropeMadrid:human,dataQuality:failures.length?'PARTIAL':'PASS',bestCondition:radar.filter(x=>x.ers!=null).sort((a,b)=>b.ers-a.ers)[0]?.asset||'NONE',realOrderThisScan:'NO',conclusion:'Autonomous persistence cycle completed. Scores are setup quality, not win probability. No auto-execution.',sourceFailures:failures},radar,history,audits:Array.isArray(prevRadar.audits)?prevRadar.audits:[],engineHealth:{ers:{status:failures.length?'PARTIAL':'PASS',spec:'docs/ENGINE_SPEC_V3_ERS.md',specRevision:'R1',reason:failures.length?`Public-data gaps: ${failures.join('; ')}`:'Required CORE OHLCV fetched and deterministic persistence completed.'},persistence:{status:'PASS',writer:'GitHub Actions',verification:'workflow validates JSON before commit'}},shadowPortfolio:prevRadar.shadowPortfolio||{generatedAt:null,candidates:[]}};
  writeJSON('data/radar-state.json',newRadar);

  const open=(positionsState.positions||[]).filter(p=>p.status==='OPEN'); const riskPositions={}; const riskHist=[...(Array.isArray(prevRisk.riskHistory)?prevRisk.riskHistory:[])]; let riskPartial=false;
  for(const p of open){ let m=markets[p.asset]||null; if(!m && (p.asset==='PHA'||p.asset==='TRUST')){ try{ const symbol=`${p.asset}USDT`; m=await buildMarket(p.asset); markets[p.asset]=m; }catch{} }
    let current=null; try{ current=await currentPriceForPosition(p,markets); }catch{}; const prev=prevRisk?.positionRisk?.positions?.[p.id]||null; const obj=buildRiskObject(p,m,prev,current); riskPositions[p.id]=obj; if(obj.prs==null)riskPartial=true; const prevAction=prev?.action; if(prevAction!==obj.action || obj.fastDropRisk?.triggered) riskHist.push({timestampEuropeMadrid:human,positionId:p.id,asset:p.asset,prs:obj.prs,action:obj.action,structuralState:obj.structuralState,protection:obj.protection,event:obj.fastDropRisk?.triggered?'FAST_DROP_RISK':'AUTONOMOUS_RISK_STATE_CHANGE'}); }
  const newRisk={schemaVersion:'2.0',module:'positionRisk',generatedAt:stamp,source:'GitHub Actions Hourly State Sync',positionRisk:{generatedAt:stamp,source:'Crypto Reca Position Risk',policyVersion:'2.2',dataQuality:riskPartial?'PARTIAL':'PASS',positions:riskPositions},riskHistory:riskHist.slice(-168)};
  writeJSON('data/position-risk.json',newRisk);

  for(const p of ['data/radar-state.json','data/position-risk.json']) JSON.parse(fs.readFileSync(p,'utf8'));
  console.log(JSON.stringify({ok:true,generatedAt:stamp,scanId:id,radarAssets:radar.length,openPositions:open.length,failures},null,2));
}

main().catch(err=>{ console.error(err); process.exit(1); });
