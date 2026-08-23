const APP_VERSION='0.3.0';
const DATA_URL='./data/crypto-reca-state.json';
const FALLBACK_STATE={schemaVersion:'1.0',appVersion:APP_VERSION,engineVersion:'Crypto Reca v3.0',generatedAt:null,source:'FALLBACK',scan:{id:null,timestampEuropeMadrid:null,dataQuality:'OFFLINE',conclusion:'Sin datos sincronizados.'},validationCapital:14687.25,radar:[],positions:[],ledger:[],audits:[],history:[]};
let state=FALLBACK_STATE;
let market={prices:{},series:{},updatedAt:null,provider:'Coinbase public'};
let currentScreen='dashboard';
const content=document.getElementById('content');
const title=document.getElementById('screenTitle');
const syncBadge=document.getElementById('syncBadge');
const money=n=>n==null||Number.isNaN(Number(n))?'—':new Intl.NumberFormat('es-ES',{maximumFractionDigits:2}).format(Number(n));
const pct=n=>n==null||Number.isNaN(Number(n))?'—':`${money(n)}%`;
const esc=s=>String(s??'').replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));

async function fetchJSON(url,opts={}){const r=await fetch(url,{cache:'no-store',...opts});if(!r.ok)throw new Error(`HTTP ${r.status}`);return r.json()}
async function loadState(){
  try{state=await fetchJSON(`${DATA_URL}?t=${Date.now()}`);if(!Array.isArray(state.radar))state.radar=[];if(!Array.isArray(state.positions))state.positions=[];if(!Array.isArray(state.ledger))state.ledger=[];if(!Array.isArray(state.audits))state.audits=[];if(!Array.isArray(state.history))state.history=[];}
  catch{state=FALLBACK_STATE;}
}
async function coinbasePrice(pair){
  const pairs=[pair,pair.replace('-USDC','-USD')];
  for(const p of pairs){
    try{const j=await fetchJSON(`https://api.exchange.coinbase.com/products/${p}/ticker`);const v=Number(j.price);if(Number.isFinite(v))return {price:v,pair:p};}catch{}
    try{const j=await fetchJSON(`https://api.coinbase.com/v2/prices/${p}/spot`);const v=Number(j?.data?.amount);if(Number.isFinite(v))return {price:v,pair:p};}catch{}
  }
  return null;
}
async function coinbaseSeries(pair){
  const pairs=[pair,pair.replace('-USDC','-USD')];
  for(const p of pairs){
    try{const j=await fetchJSON(`https://api.exchange.coinbase.com/products/${p}/candles?granularity=3600`);if(Array.isArray(j)&&j.length>3){return j.slice(0,48).map(x=>({t:x[0],c:Number(x[4])})).filter(x=>Number.isFinite(x.c)).sort((a,b)=>a.t-b.t);}}catch{}
  }
  return [];
}
async function refreshMarket(){
  const assets=(state.radar||[]).map(r=>({asset:r.asset,pair:r.pair||`${r.asset}-USDC`}));
  await Promise.all(assets.map(async a=>{const q=await coinbasePrice(a.pair);if(q)market.prices[a.asset]=q.price;}));
  await Promise.all(assets.map(async a=>{market.series[a.asset]=await coinbaseSeries(a.pair);}));
  market.updatedAt=new Date().toISOString();
}
function livePrice(asset){return market.prices[asset]??null}
function unrealized(p){if(p.status!=='OPEN')return 0;const px=livePrice(p.asset);if(px==null)return null;return (px-Number(p.entry))*Number(p.qty)}
function totalExposure(){return (state.positions||[]).filter(p=>p.status==='OPEN').reduce((a,p)=>a+Number(p.entry||0)*Number(p.qty||0),0)}
function freshLabel(){
  const ts=state?.scan?.timestampEuropeMadrid||state.generatedAt;
  if(!ts)return 'Esperando primer sync';
  return `Scan ${esc(state.scan?.id||'—')} · ${esc(ts)}`;
}
function updateBadge(){
  if(!syncBadge)return;
  const online=navigator.onLine;
  const hasScan=!!(state?.scan?.id||state?.generatedAt);
  syncBadge.className=`live-dot ${online&&hasScan?'ok':online?'warn':'bad'}`;
  syncBadge.innerHTML=`<span></span>${online?(hasScan?'SYNC':'PENDIENTE'):'OFFLINE'}`;
  syncBadge.title=freshLabel();
}
function spark(asset){
  const s=market.series[asset]||[];if(s.length<3)return '<div class="spark-empty">Sin gráfico en vivo</div>';
  const vals=s.map(x=>x.c),min=Math.min(...vals),max=Math.max(...vals),range=max-min||1;
  const pts=vals.map((v,i)=>`${(i/(vals.length-1))*100},${34-((v-min)/range)*30}`).join(' ');
  return `<svg class="spark" viewBox="0 0 100 36" preserveAspectRatio="none" aria-label="Evolución 1H"><polyline points="${pts}" fill="none" stroke="currentColor" stroke-width="2" vector-effect="non-scaling-stroke"/></svg>`;
}
function positionCard(p){
  const pnl=unrealized(p);const px=livePrice(p.asset);
  return `<div class="position-card"><div class="row"><div class="asset"><div class="coin">${p.asset==='BTC'?'₿':esc(p.asset[0])}</div><div><h3>${esc(p.asset)}</h3><p>${esc(p.engine)} · ${esc(p.setup)}</p></div></div><div><span class="badge open">${esc(p.status)}</span> <span class="badge ${p.protection==='UNPROTECTED'?'unprotected':'open'}">${esc(p.protection)}</span></div></div><div class="kv"><div><small>Entrada</small><strong>${money(p.entry)}</strong></div><div><small>Precio vivo</small><strong>${money(px)}</strong></div><div><small>Cantidad</small><strong>${esc(p.qty)}</strong></div><div><small>P/L bruto aprox.</small><strong class="${pnl==null?'muted':pnl>=0?'positive':'negative'}">${pnl==null?'—':`${pnl>=0?'+':''}${money(pnl)} USDC`}</strong></div><div><small>Stop recomendado</small><strong>${money(p.recommendedStop??p.stop)}</strong></div><div><small>Apertura</small><strong>${esc(p.openedEuropeMadrid||p.opened||'—')}</strong></div></div>${p.protection==='UNPROTECTED'?'<div class="callout">Posición real sin protección confirmada. El stop mostrado es referencia técnica, no una orden ejecutada.</div>':''}</div>`
}
function radarItem(r){
  const px=livePrice(r.asset),entry=r.entryConfirmation==null?'—':`${r.entryConfirmation}/5`;
  return `<div class="radar-item"><div class="row"><div><strong>${esc(r.asset)}</strong><div class="tiny">${esc(r.d||'—')} · ${esc(r.e||'—')} · Entry ${entry}</div></div><div class="price-block"><strong>${money(px)}</strong><span>USDC</span></div></div>${spark(r.asset)}<div class="row"><span class="muted">ERS ${money(r.ers)}/100</span><span class="badge ${Number(r.ers)>=75?'prepare':Number(r.ers)>=60?'watch':''}">${esc(r.decision||'—')}</span></div><div class="bar"><span style="width:${Math.max(0,Math.min(100,Number(r.ers)||0))}%"></span></div><div class="tiny" style="margin-top:7px">Entry Engine: ${entry} · ${esc(r.entryState||'—')}</div></div>`
}
function dashboard(){
 const open=(state.positions||[]).filter(p=>p.status==='OPEN');const exp=totalExposure();const pnls=open.map(unrealized).filter(v=>v!=null);const pnl=pnls.length?pnls.reduce((a,b)=>a+b,0):null;
 return `<div class="status-card"><div><strong>${esc(state.engineVersion||'Crypto Reca')}</strong><div class="tiny">App ${APP_VERSION} · ${freshLabel()}</div></div><div class="badge ${state.scan?.dataQuality==='PASS'?'open':'watch'}">${esc(state.scan?.dataQuality||'PENDING')}</div></div><div class="grid metrics"><div class="card"><div class="metric-label">Capital validación</div><div class="metric-value">${money(state.validationCapital)}</div><div class="metric-sub">USDC</div></div><div class="card"><div class="metric-label">Exposición abierta</div><div class="metric-value">${money(exp)}</div><div class="metric-sub">${pct(exp/Number(state.validationCapital||1)*100)}</div></div><div class="card"><div class="metric-label">P/L no realizado</div><div class="metric-value ${pnl==null?'muted':pnl>=0?'positive':'negative'}">${pnl==null?'—':`${pnl>=0?'+':''}${money(pnl)}`}</div><div class="metric-sub">USDC aprox.</div></div><div class="card"><div class="metric-label">Posiciones abiertas</div><div class="metric-value">${open.length}</div><div class="metric-sub">confirmadas</div></div></div><div class="section-title"><h2>Posición actual</h2><span>Ledger confirmado</span></div>${open.map(positionCard).join('')||'<div class="empty card">No hay posiciones abiertas.</div>'}<div class="section-title"><h2>Radar rápido</h2><span>Precio vivo + último scan</span></div><div class="radar-list">${(state.radar||[]).slice(0,3).map(radarItem).join('')}</div>${state.scan?.conclusion?`<div class="card conclusion"><strong>Conclusión del último scan</strong><p>${esc(state.scan.conclusion)}</p></div>`:''}`
}
function radar(){return `<div class="section-title"><h2>Radar</h2><span>${freshLabel()}</span></div><div class="radar-list">${(state.radar||[]).map(radarItem).join('')}</div><p class="tiny">Precios y gráficos: APIs públicas de Coinbase cuando están disponibles. ERS, D/E, Entry Engine y decisiones: último scan sincronizado de Crypto Reca. Ningún dato privado de Coinbase se almacena aquí.</p>`}
function positions(){return `<div class="section-title"><h2>Posiciones</h2><span>${(state.positions||[]).filter(p=>p.status==='OPEN').length} abiertas</span></div>${(state.positions||[]).map(positionCard).join('')||'<div class="empty card">Sin posiciones.</div>'}`}
function ledger(){return `<div class="section-title"><h2>Operaciones</h2><span>Solo confirmadas</span></div><div class="table-wrap"><table><thead><tr><th>Fecha</th><th>Par</th><th>Lado</th><th>Motor</th><th>Cantidad</th><th>Precio</th><th>Fee</th><th>Estado</th></tr></thead><tbody>${(state.ledger||[]).map(x=>`<tr><td>${esc(x.dateEuropeMadrid||x.date)}</td><td>${esc(x.asset)}</td><td>${esc(x.side)}</td><td>${esc(x.engine)}</td><td>${esc(x.qty)}</td><td>${esc(x.price)}</td><td>${esc(x.fee)}</td><td><span class="badge open">${esc(x.status)}</span></td></tr>`).join('')}</tbody></table></div>`}
function audit(){
 const h=(state.history||[]).slice(-24).reverse();
 return `<div class="section-title"><h2>Auditoría</h2><span>Sin hindsight</span></div>${(state.audits||[]).slice().reverse().map(a=>`<div class="card audit-card"><div class="row"><strong>${esc(a.date)}</strong><span class="badge watch">${esc(a.status)}</span></div><p class="muted">${esc(a.note)}</p></div>`).join('')}<div class="section-title"><h2>Últimos scans</h2><span>${h.length} guardados</span></div>${h.length?h.map(x=>`<div class="history-row"><div><strong>${esc(x.id||'—')}</strong><div class="tiny">${esc(x.timestampEuropeMadrid||'—')}</div></div><div class="tiny">${esc(x.bestCondition||'—')} · ${esc(x.dataQuality||'—')}</div></div>`).join(''):'<div class="empty card">El histórico empezará a llenarse con los próximos scans automáticos.</div>'}<div class="card system-card"><strong>Estado del sistema</strong><div class="kv"><div><small>Motor</small><strong>${esc(state.engineVersion)}</strong></div><div><small>App</small><strong>${APP_VERSION}</strong></div><div><small>Fuente de scan</small><strong>${esc(state.source||'—')}</strong></div><div><small>Mercado</small><strong>${esc(market.provider)}</strong></div></div><p class="tiny">Arquitectura read-only. La app no contiene claves privadas, no puede enviar órdenes a Coinbase y no debe usarse como confirmación de ejecución.</p></div>`
}
const screens={dashboard,radar,positions,ledger,audit};
function show(screen){currentScreen=screen;document.querySelectorAll('.nav-btn').forEach(b=>b.classList.toggle('active',b.dataset.screen===screen));title.textContent={dashboard:'Dashboard',radar:'Radar',positions:'Posiciones',ledger:'Operaciones',audit:'Auditoría'}[screen];content.innerHTML=screens[screen]();window.scrollTo({top:0,behavior:'instant'});}
async function boot(){
  updateBadge();await loadState();updateBadge();show(currentScreen);
  refreshMarket().then(()=>{updateBadge();show(currentScreen)});
}
document.querySelectorAll('.nav-btn').forEach(b=>b.addEventListener('click',()=>show(b.dataset.screen)));
window.addEventListener('online',updateBadge);window.addEventListener('offline',updateBadge);
setInterval(()=>refreshMarket().then(()=>show(currentScreen)),60000);
setInterval(()=>loadState().then(()=>{updateBadge();show(currentScreen)}),120000);
boot();
