const VERSION = "SENDA_WORKER_1_4_2026-10-05";
const MIN_TURNOVER = 250000;
const TOP_DEEP = 20;
const STABLE = new Set(["USDT","USDC","DAI","FDUSD","TUSD","USDE","PYUSD","USDS","FRAX","USDD","LUSD","GHO","EURC","USD1","USDG","RLUSD"]);
const WRAP = new Set(["WBTC","WETH","STETH","WSTETH","CBETH","RETH","WEETH"]);

function n(v,d=null){ const x=Number(v); return Number.isFinite(x)?x:d; }
function clamp(v,a,b){ return Math.max(a,Math.min(b,v)); }
function pct(a,b){ return Number.isFinite(a)&&Number.isFinite(b)&&b!==0 ? (a/b-1)*100 : null; }
function upper(v){ return String(v||"").trim().toUpperCase(); }
function eligibleBase(b){
  b=upper(b);
  if(!b||STABLE.has(b)||WRAP.has(b)) return false;
  return !/(UP|DOWN|BULL|BEAR|2L|2S|3L|3S|5L|5S)$/.test(b);
}
async function fetchJson(url,options={},timeout=9000){
  const c=new AbortController(); const t=setTimeout(()=>c.abort(),timeout);
  try{
    const r=await fetch(url,{...options,signal:c.signal});
    if(!r.ok) throw new Error(`${r.status} ${url}`);
    return await r.json();
  } finally { clearTimeout(t); }
}
async function coinbaseProducts(){
  const rows=await fetchJson("https://api.exchange.coinbase.com/products");
  return (Array.isArray(rows)?rows:[]).map(x=>{
    const base=upper(x.base_currency), quote=upper(x.quote_currency), pair=String(x.id||"");
    if(!eligibleBase(base)||!["USD","USDC","USDT","EUR"].includes(quote)||x.trading_disabled||x.cancel_only||x.status!=="online") return null;
    return {base,venue:"COINBASE",pair,tv:"COINBASE:"+pair.replaceAll("-","")};
  }).filter(Boolean);
}
async function kucoinTickers(){
  const j=await fetchJson("https://api.kucoin.com/api/v1/market/allTickers");
  const rows=j?.data?.ticker||[];
  return rows.map(x=>{
    const p=String(x.symbol||"").split("-");
    if(p.length!==2||!eligibleBase(p[0])||!["USDT","USDC"].includes(p[1])) return null;
    return {base:upper(p[0]),venue:"KUCOIN",pair:x.symbol,tv:"KUCOIN:"+p.join(""),price:n(x.last),c24:(n(x.changeRate,0)||0)*100,turn:n(x.volValue,0)||0};
  }).filter(Boolean);
}
const TV_COLS=["close","change","change|60","change|240","volume","volume|60","volume|240"];
async function tvChunk(tickers){
  const j=await fetchJson("https://scanner.tradingview.com/crypto/scan",{
    method:"POST",
    headers:{"content-type":"application/json","user-agent":"Mozilla/5.0"},
    body:JSON.stringify({symbols:{tickers,query:{types:[]}},columns:TV_COLS})
  });
  const m=new Map();
  for(const row of j.data||[]){
    const d=row.d||[];
    if(!row.s||d.length<7) continue;
    m.set(row.s,{price:n(d[0]),c24:n(d[1]),c1:n(d[2]),c4:n(d[3]),vol:n(d[4]),v1:n(d[5]),v4:n(d[6])});
  }
  return m;
}
async function tvScan(markets){
  const chunks=[]; for(let i=0;i<markets.length;i+=500) chunks.push(markets.slice(i,i+500).map(x=>x.tv));
  const maps=await Promise.all(chunks.map(tvChunk));
  const out=new Map(); for(const m of maps) for(const [k,v] of m) out.set(k,v);
  return out;
}
function broadScore(m,b1,b4){
  const c1=n(m.c1,0)||0,c4=n(m.c4,0)||0,c24=n(m.c24,0)||0,va=n(m.va,1)||1,turn=n(m.turn,0)||0;
  let s=clamp(c1*7,-8,28)+clamp(c4*2.2,-8,24)+clamp((va-1)*18,-5,24)+clamp((c1-b1)*3.5,-6,12)+clamp((c4-b4)*1.2,-5,10)+clamp(Math.log10(Math.max(turn,1))-5.4,0,4)*2.5;
  if(c1>5)s-=(c1-5)*5;
  if(c4>10)s-=(c4-10)*3;
  if(c24>25)s-=(c24-25)*1.3;
  if(c1<-2||c4<-5)s-=15;
  return Math.round(s*100)/100;
}
async function universe(){
  const [cb,kc]=await Promise.all([coinbaseProducts(),kucoinTickers()]);
  const raw=[...cb,...kc]; const tv=await tvScan(raw);
  for(const m of raw){
    const t=tv.get(m.tv)||{};
    for(const k of ["price","c24","c1","c4","vol","v1","v4"]) if(t[k]!=null) m[k]=t[k];
    if(!m.turn&&m.price&&m.vol) m.turn=m.price*m.vol;
    m.va=m.v1&&m.v4>0 ? m.v1/(m.v4/4) : null;
  }
  const by=new Map();
  for(const m of raw){ if(!by.has(m.base))by.set(m.base,[]); by.get(m.base).push(m); }
  const u=[];
  for(const [base,a] of by){
    a.sort((x,y)=>(y.turn||0)-(x.turn||0));
    const z={...a[0],venues:[...new Set(a.map(x=>x.venue))].sort(),pairs:[...new Set(a.map(x=>x.venue+":"+x.pair))].sort()};
    u.push(z);
  }
  return {cbCount:cb.length,kcCount:kc.length,rawCount:raw.length,uniqueCount:u.length,rows:u};
}
async function cbBars(pair,granularity){
  const rows=await fetchJson("https://api.exchange.coinbase.com/products/"+encodeURIComponent(pair)+"/candles?granularity="+granularity);
  const now=Math.floor(Date.now()/1000); const out=[];
  for(const r of Array.isArray(rows)?rows:[]) if(Array.isArray(r)&&r.length>=6&&Number(r[0])+granularity<=now) out.push({t:+r[0],l:+r[1],h:+r[2],o:+r[3],c:+r[4],v:+r[5]});
  return out.sort((a,b)=>a.t-b.t).slice(-220);
}
async function kcBars(pair,type,seconds){
  const j=await fetchJson("https://api.kucoin.com/api/v1/market/candles?symbol="+encodeURIComponent(pair)+"&type="+type);
  const now=Math.floor(Date.now()/1000); const out=[];
  for(const r of j?.data||[]) if(Array.isArray(r)&&r.length>=6&&Number(r[0])+seconds<=now) out.push({t:+r[0],o:+r[1],c:+r[2],h:+r[3],l:+r[4],v:+r[5]});
  return out.sort((a,b)=>a.t-b.t).slice(-220);
}
function aggregate4h(hourly){
  const buckets=new Map();
  for(const x of hourly){
    const k=Math.floor(x.t/14400)*14400;
    if(!buckets.has(k)) buckets.set(k,[]);
    buckets.get(k).push(x);
  }
  const out=[];
  for(const k of [...buckets.keys()].sort((a,b)=>a-b)){
    const r=buckets.get(k).sort((a,b)=>a.t-b.t);
    if(r.length!==4) continue;
    if(r[0].t!==k||r[1].t!==k+3600||r[2].t!==k+7200||r[3].t!==k+10800) continue;
    out.push({t:k,o:r[0].o,h:Math.max(...r.map(x=>x.h)),l:Math.min(...r.map(x=>x.l)),c:r[3].c,v:r.reduce((s,x)=>s+x.v,0)});
  }
  return out.slice(-220);
}
async function barsFor(m){
  if(m.venue==="COINBASE"){
    const [h1,d1]=await Promise.all([cbBars(m.pair,3600),cbBars(m.pair,86400)]);
    return [aggregate4h(h1),d1];
  }
  return Promise.all([kcBars(m.pair,"4hour",14400),kcBars(m.pair,"1day",86400)]);
}
function mean(a){ return a.reduce((s,x)=>s+x,0)/a.length; }
function ema(v,p){
  if(v.length<p)return null; let e=mean(v.slice(0,p)),k=2/(p+1);
  for(const x of v.slice(p)) e=x*k+e*(1-k); return e;
}
function rsi(v,p=14){
  if(v.length<=p)return null; let g=0,l=0;
  for(let i=v.length-p;i<v.length;i++){ const d=v[i]-v[i-1]; if(d>0)g+=d; else l-=d; }
  g/=p;l/=p; return l===0?100:100-100/(1+g/l);
}
function atr(b,p=14){
  if(b.length<=p)return null; const tr=[];
  for(let i=1;i<b.length;i++) tr.push(Math.max(b[i].h-b[i].l,Math.abs(b[i].h-b[i-1].c),Math.abs(b[i].l-b[i-1].c)));
  return mean(tr.slice(-p));
}
function adx(b,p=14){
  if(b.length<p*2+1)return null; const tr=[],pd=[],md=[];
  for(let i=1;i<b.length;i++){
    const up=b[i].h-b[i-1].h,dn=b[i-1].l-b[i].l;
    pd.push(up>dn&&up>0?up:0);md.push(dn>up&&dn>0?dn:0);
    tr.push(Math.max(b[i].h-b[i].l,Math.abs(b[i].h-b[i-1].c),Math.abs(b[i].l-b[i-1].c)));
  }
  const dx=[];
  for(let i=p-1;i<tr.length;i++){
    const st=tr.slice(i-p+1,i+1).reduce((a,x)=>a+x,0); if(st<=0)continue;
    const pi=100*pd.slice(i-p+1,i+1).reduce((a,x)=>a+x,0)/st;
    const mi=100*md.slice(i-p+1,i+1).reduce((a,x)=>a+x,0)/st;
    if(pi+mi)dx.push(100*Math.abs(pi-mi)/(pi+mi));
  }
  return dx.length>=p?mean(dx.slice(-p)):null;
}
function ichi(b){
  if(b.length<52)return null;
  const mid=q=>{const s=b.slice(-q);return (Math.max(...s.map(x=>x.h))+Math.min(...s.map(x=>x.l)))/2};
  const t=mid(9),k=mid(26); return {t,k,a:(t+k)/2,b:mid(52)};
}
function supertrend(b,p=10,m=3){
  if(b.length<p+3)return null; let up=true,fu=null,fl=null;
  for(let i=p;i<b.length;i++){
    const a=atr(b.slice(0,i+1),p); if(a==null)continue;
    const hl=(b[i].h+b[i].l)/2,bu=hl+m*a,bl=hl-m*a;
    if(fu==null){fu=bu;fl=bl}else{const pc=b[i-1].c;fu=(bu<fu||pc>fu)?bu:fu;fl=(bl>fl||pc<fl)?bl:fl}
    const c=b[i].c;if(up&&c<fl)up=false;else if(!up&&c>fu)up=true;
  }
  return up;
}
function feats(b){
  if(b.length<52)throw new Error("insufficient bars "+b.length);
  const c=b.map(x=>x.c); return {close:c.at(-1),rsi:rsi(c),adx:adx(b),ichi:ichi(b),st:supertrend(b),ema20:ema(c,20),ema50:ema(c,50)};
}
async function analyze(m){
  const [b4,bd]=await barsFor(m); const f4=feats(b4),fd=feats(bd); const px=n(m.price)||f4.close;
  let s=25+clamp(m.broad,-20,40)*0.25; const reasons=[],penalties=[];
  for(const [lab,f,w] of [["4H",f4,1],["1D",fd,1.15]]){
    const ic=f.ichi,top=Math.max(ic.a,ic.b),bot=Math.min(ic.a,ic.b);
    if(f.close>top){s+=7*w;reasons.push(lab+" above cloud")} else if(f.close<bot){s-=7*w;penalties.push(lab+" below cloud")}
    if(f.close>ic.k&&ic.t>=ic.k){s+=3*w;reasons.push(lab+" Tenkan/Kijun bullish")}
    if(f.st){s+=6*w;reasons.push(lab+" Supertrend bullish")}else{s-=6*w;penalties.push(lab+" Supertrend bearish")}
    if(f.adx!=null&&f.adx>=18&&f.adx<=40){s+=4*w;reasons.push(lab+" ADX "+f.adx.toFixed(1))}else if(f.adx>55){s-=3*w;penalties.push(lab+" ADX overheated")}
  }
  if(f4.rsi!=null&&f4.rsi>=50&&f4.rsi<=68){s+=4;reasons.push("4H RSI constructive")}else if(f4.rsi>74){s-=8;penalties.push("4H RSI extended")}
  if(fd.rsi!=null&&fd.rsi>=48&&fd.rsi<=66){s+=3;reasons.push("1D RSI constructive")}else if(fd.rsi>74){s-=7;penalties.push("1D RSI extended")}
  const c1=n(m.c1,0)||0,c4=n(m.c4,0)||0,c24=n(m.c24,0)||0,va=n(m.va,1)||1; let noChase=false;
  if(c1>=.2&&c1<=3.5){s+=3;reasons.push("early 1H momentum")}
  if(c4>=.5&&c4<=8){s+=3;reasons.push("controlled 4H momentum")}
  if(va>=1.35){s+=Math.min(5,(va-1)*4);reasons.push("volume acceleration "+va.toFixed(2)+"x")}
  if(c1>6){s-=(c1-6)*5;noChase=true;penalties.push("1H already "+c1.toFixed(1)+"%")}
  if(c4>12){s-=(c4-12)*3;noChase=true;penalties.push("4H already "+c4.toFixed(1)+"%")}
  if(c24>25){s-=(c24-25)*1.5;noChase=true;penalties.push("24H already "+c24.toFixed(1)+"%")}
  const dk=pct(px,f4.ichi.k); if(dk!=null&&dk>10){s-=Math.min(12,(dk-10)*1.4);noChase=true;penalties.push(dk.toFixed(1)+"% above 4H Kijun")}
  if(noChase)s-=15; s=Math.round(clamp(s,0,100)*10)/10;
  const trend=f4.st&&fd.st,cloud=px>Math.max(f4.ichi.a,f4.ichi.b);
  const state=s>=78&&trend&&cloud&&!noChase?"BUY":(s>=66&&!noChase?"NEAR BUY":"WATCH");
  return {asset:m.base,venue:m.venue,pair:m.pair,availableVenues:m.venues,availablePairs:m.pairs,state,score:s,price:px,change1hPct:m.c1,change4hPct:m.c4,change24hPct:m.c24,turnover24hUsdApprox:m.turn,volumeAcceleration:m.va,noChase,
    technical:{"4h":{rsi14:f4.rsi==null?null:+f4.rsi.toFixed(2),adx14:f4.adx==null?null:+f4.adx.toFixed(2),supertrendUp:f4.st,aboveCloud:f4.close>Math.max(f4.ichi.a,f4.ichi.b)},
      "1d":{rsi14:fd.rsi==null?null:+fd.rsi.toFixed(2),adx14:fd.adx==null?null:+fd.adx.toFixed(2),supertrendUp:fd.st,aboveCloud:fd.close>Math.max(fd.ichi.a,fd.ichi.b)}},
    reasons:reasons.slice(0,6),penalties:penalties.slice(0,4),broadScore:m.broad};
}
async function mapLimit(items,limit,fn){
  const out=new Array(items.length);let next=0;
  async function worker(){while(true){const i=next++;if(i>=items.length)return;try{out[i]=await fn(items[i])}catch(e){out[i]={__error:String(e),asset:items[i].base,venue:items[i].venue}}}}
  await Promise.all(Array.from({length:Math.min(limit,items.length)},()=>worker()));return out;
}
function cors(body,status=200){
  return new Response(typeof body==="string"?body:JSON.stringify(body),{status,headers:{"content-type":"application/json; charset=utf-8","access-control-allow-origin":"*","cache-control":"no-store"}});
}
async function scan(){
  const started=Date.now(); const u=await universe(); const btc=u.rows.find(x=>x.base==="BTC")||{};
  const b1=n(btc.c1,0)||0,b4=n(btc.c4,0)||0; const eligible=[];
  for(const m of u.rows){
    if((n(m.turn,0)||0)<MIN_TURNOVER||m.price==null)continue;
    m.broad=broadScore(m,b1,b4);eligible.push(m);
  }
  eligible.sort((a,b)=>b.broad-a.broad); const deep=eligible.slice(0,TOP_DEEP);
  const analyzed=await mapLimit(deep,4,analyze);
  const errors=analyzed.filter(x=>x&&x.__error);
  const full=analyzed.filter(x=>x&&!x.__error).sort((a,b)=>b.score-a.score);
  const used=new Set(full.map(x=>x.asset));
  const ranking=[...full];
  for(const m of eligible){
    if(ranking.length>=20)break;
    if(used.has(m.base))continue;
    const failed=errors.some(e=>e.asset===m.base);
    ranking.push({
      asset:m.base,venue:m.venue,pair:m.pair,availableVenues:m.venues,availablePairs:m.pairs,
      state:"WATCH",score:Math.round(clamp(35+(m.broad||0)*0.45,0,65)*10)/10,
      price:m.price,change1hPct:m.c1,change4hPct:m.c4,change24hPct:m.c24,
      turnover24hUsdApprox:m.turn,volumeAcceleration:m.va,noChase:false,
      technical:null,reasons:["Broad-market candidate; deep confirmation pending"],
      penalties:[failed?"Deep data unavailable on this run":"Outside current deep-analysis slots"],
      broadScore:m.broad,analysisDepth:"BROAD_FALLBACK"
    });
    used.add(m.base);
  }
  ranking.splice(20);
  ranking.forEach((x,i)=>x.rank=i+1);
  return {system:"SENDA",version:VERSION,generatedAt:new Date().toISOString(),mode:"FULL_COINBASE_KUCOIN_DYNAMIC_TOP20",manualTradingOnly:true,
    coverage:{coinbasePairsDiscovered:u.cbCount,kucoinPairsDiscovered:u.kcCount,rawPairs:u.rawCount,uniqueAssets:u.uniqueCount,liquidEligibleAssets:eligible.length,deepCandidatesRequested:deep.length,deepCandidatesAnalyzed:full.length,topN:ranking.length,minTurnoverUsdApprox:MIN_TURNOVER},
    statusCounts:{BUY:ranking.filter(x=>x.state==="BUY").length,"NEAR BUY":ranking.filter(x=>x.state==="NEAR BUY").length,WATCH:ranking.filter(x=>x.state==="WATCH").length},
    ranking,errors,elapsedSeconds:Math.round((Date.now()-started)/10)/100};
}
export default {
  async fetch(request){
    const url=new URL(request.url);
    if(request.method==="OPTIONS") return new Response(null,{headers:{"access-control-allow-origin":"*","access-control-allow-methods":"GET,OPTIONS","access-control-allow-headers":"content-type"}});
    if(url.pathname==="/health") return cors({ok:true,system:"SENDA",version:VERSION});
    if(url.pathname==="/scan"){
      try{return cors(await scan())}catch(e){return cors({ok:false,error:String(e),version:VERSION},500)}
    }
    return cors({ok:true,system:"SENDA",version:VERSION,endpoints:["/health","/scan"]});
  }
};