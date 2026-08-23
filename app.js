const STORAGE='crypto-reca-v02';
const seed={
  validationCapital:14687.25,
  radar:[
    {asset:'BTC',price:77230.5,d:'D2',e:'E1',ers:72,decision:'WATCH / HOLD CORE',entry:'4/5'},
    {asset:'ETH',price:null,d:'D2',e:'E1',ers:67,decision:'WATCH',entry:'—'},
    {asset:'SOL',price:null,d:'D2',e:'E1',ers:59,decision:'NO ENTRY',entry:'—'},
    {asset:'XRP',price:null,d:'D1',e:'E2',ers:29,decision:'NO ENTRY',entry:'—'},
    {asset:'AVAX',price:null,d:'D1',e:'E1',ers:49,decision:'NO ENTRY',entry:'—'},
    {asset:'SUI',price:null,d:'D1',e:'E1',ers:49,decision:'NO ENTRY',entry:'—'}
  ],
  positions:[{
    id:'btc-20260822-1858',asset:'BTC',engine:'CORE',setup:'C-RECLAIM',status:'OPEN',protection:'UNPROTECTED',
    qty:0.00946259,entry:77340.93,subtotal:731.84551081,fee:1.17095282,total:733.01646363,stop:75300,
    opened:'22/08/2026 18:58',note:'Stop técnico recomendado; colocación discrecional del usuario.'
  }],
  ledger:[{
    date:'22/08/2026 18:58',asset:'BTC-USDC',side:'BUY',engine:'CORE / C-RECLAIM',qty:'0.00946259 BTC',price:'77,340.93',fee:'1.17095 USDC',status:'FILLED'
  }],
  audits:[{date:'23/08/2026',status:'PARTIAL',note:'Ventana inicial de v3.0. El histórico completo se irá acumulando con scans contemporáneos.'}]
};
let state=load();
function load(){try{return {...seed,...JSON.parse(localStorage.getItem(STORAGE)||'{}')}}catch{return structuredClone(seed)}}
function save(){localStorage.setItem(STORAGE,JSON.stringify(state))}
const eur=n=>n==null?'—':new Intl.NumberFormat('es-ES',{maximumFractionDigits:2}).format(n);
const content=document.getElementById('content');
const title=document.getElementById('screenTitle');
function currentBTC(){return state.radar.find(x=>x.asset==='BTC')?.price||state.positions[0]?.entry||0}
function unrealized(p){if(p.status!=='OPEN')return 0;const px=p.asset==='BTC'?currentBTC():p.entry;return (px-p.entry)*p.qty}
function totalExposure(){return state.positions.filter(p=>p.status==='OPEN').reduce((a,p)=>a+p.entry*p.qty,0)}
function dashboard(){
 const open=state.positions.filter(p=>p.status==='OPEN'); const pnl=open.reduce((a,p)=>a+unrealized(p),0); const exp=totalExposure();
 return `<div id="installTip" class="install-tip"><strong>Instalable en Android</strong><div class="tiny" style="margin-top:5px">Cuando esta web esté publicada por HTTPS, Android mostrará “Instalar aplicación”.</div></div>
 <div class="grid metrics">
  <div class="card"><div class="metric-label">Capital validación</div><div class="metric-value">${eur(state.validationCapital)}</div><div class="metric-sub">USDC</div></div>
  <div class="card"><div class="metric-label">Exposición abierta</div><div class="metric-value">${eur(exp)}</div><div class="metric-sub">${eur(exp/state.validationCapital*100)}%</div></div>
  <div class="card"><div class="metric-label">P/L no realizado</div><div class="metric-value ${pnl>=0?'positive':'negative'}">${pnl>=0?'+':''}${eur(pnl)}</div><div class="metric-sub">USDC aprox.</div></div>
  <div class="card"><div class="metric-label">Posiciones abiertas</div><div class="metric-value">${open.length}</div><div class="metric-sub">confirmadas</div></div>
 </div>
 <div class="section-title"><h2>Posición actual</h2><span>Ledger confirmado</span></div>
 ${open.map(positionCard).join('')||'<div class="empty card">No hay posiciones abiertas.</div>'}
 <div class="section-title"><h2>Radar rápido</h2><span>Último estado cargado</span></div>
 <div class="radar-list">${state.radar.slice(0,3).map(radarItem).join('')}</div>`
}
function positionCard(p){const pnl=unrealized(p);return `<div class="position-card"><div class="row"><div class="asset"><div class="coin">₿</div><div><h3>${p.asset}</h3><p>${p.engine} · ${p.setup}</p></div></div><div><span class="badge open">${p.status}</span> <span class="badge unprotected">${p.protection}</span></div></div><div class="kv"><div><small>Entrada</small><strong>${eur(p.entry)}</strong></div><div><small>Cantidad</small><strong>${p.qty}</strong></div><div><small>P/L bruto aprox.</small><strong class="${pnl>=0?'positive':'negative'}">${pnl>=0?'+':''}${eur(pnl)} USDC</strong></div><div><small>Stop recomendado</small><strong>${eur(p.stop)}</strong></div></div><div class="callout">Riesgo manual activo: la posición está sin stop confirmado. El stop mostrado es referencia técnica, no una orden colocada.</div></div>`}
function radarItem(r){return `<div class="radar-item"><div class="row"><div><strong>${r.asset}</strong><div class="tiny">${r.d} · ${r.e} · Entry ${r.entry}</div></div><div class="score">${r.ers}</div></div><div class="row" style="margin-top:6px"><span class="muted">${r.price==null?'Precio no cargado':eur(r.price)}</span><span class="badge ${r.ers>=75?'prepare':r.ers>=60?'watch':''}">${r.decision}</span></div><div class="bar"><span style="width:${Math.max(0,Math.min(100,r.ers))}%"></span></div></div>`}
function radar(){return `<div class="section-title"><h2>Radar</h2><span>D/E · ERS · Entry Engine</span></div><div class="radar-list">${state.radar.map(radarItem).join('')}</div><p class="tiny">Los precios no cargados quedan como “—” en lugar de inventarse. Esta app no consulta mercado por sí sola todavía.</p>`}
function positions(){return `<div class="section-title"><h2>Posiciones</h2><span>${state.positions.filter(p=>p.status==='OPEN').length} abiertas</span></div>${state.positions.map(positionCard).join('')||'<div class="empty card">Sin posiciones.</div>'}`}
function ledger(){return `<div class="section-title"><h2>Operaciones</h2><span>Solo confirmadas</span></div><div class="table-wrap"><table><thead><tr><th>Fecha</th><th>Par</th><th>Lado</th><th>Motor</th><th>Cantidad</th><th>Precio</th><th>Fee</th><th>Estado</th></tr></thead><tbody>${state.ledger.map(x=>`<tr><td>${x.date}</td><td>${x.asset}</td><td>${x.side}</td><td>${x.engine}</td><td>${x.qty}</td><td>${x.price}</td><td>${x.fee}</td><td><span class="badge open">${x.status}</span></td></tr>`).join('')}</tbody></table></div>`}
function audit(){return `<div class="section-title"><h2>Auditoría</h2><span>Histórico</span></div>${state.audits.map(a=>`<div class="card" style="margin-bottom:10px"><div class="row"><strong>${a.date}</strong><span class="badge watch">${a.status}</span></div><p class="muted" style="margin-bottom:0">${a.note}</p></div>`).join('')}<div class="card"><strong>Arquitectura preparada para crecer</strong><p class="muted">Siguiente fase: sincronización automática de scans, precios, ERS, Entry Engine y conciliación de operaciones confirmadas.</p></div>`}
const screens={dashboard,radar,positions,ledger,audit};
function show(screen){document.querySelectorAll('.nav-btn').forEach(b=>b.classList.toggle('active',b.dataset.screen===screen));title.textContent={dashboard:'Dashboard',radar:'Radar',positions:'Posiciones',ledger:'Operaciones',audit:'Auditoría'}[screen];content.innerHTML=screens[screen]();window.scrollTo({top:0,behavior:'instant'});}
document.querySelectorAll('.nav-btn').forEach(b=>b.addEventListener('click',()=>show(b.dataset.screen)));
show('dashboard');
