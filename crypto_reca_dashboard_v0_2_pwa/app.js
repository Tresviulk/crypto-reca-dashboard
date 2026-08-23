const KEY = 'cryptoRecaDashboardV02';
const defaultData = {
  settings: { capital: 14687.25, systemName: 'Crypto Reca' },
  radar: {
    'BTC/USDC':'watch','ETH/USDC':'watch','SOL/USDC':'watch','XRP/USDC':'watch','AVAX/USDC':'watch','ADA/USDC':'watch'
  },
  trades: []
};
let data = loadData();
let deferredPrompt = null;

function loadData(){
  try { return JSON.parse(localStorage.getItem(KEY)) || structuredClone(defaultData); }
  catch { return structuredClone(defaultData); }
}
function saveData(){ localStorage.setItem(KEY, JSON.stringify(data)); render(); }
function fmt(n, d=2){ return new Intl.NumberFormat('es-ES',{minimumFractionDigits:d,maximumFractionDigits:d}).format(Number(n||0)); }
function pct(n){ return `${fmt(n,1)}%`; }
function tradePnl(t){
  if(!t.exitPrice || !t.entryPrice || !t.notional) return 0;
  return (Number(t.exitPrice)/Number(t.entryPrice)-1)*Number(t.notional);
}
function nowLocalInput(){ const d=new Date(); d.setMinutes(d.getMinutes()-d.getTimezoneOffset()); return d.toISOString().slice(0,16); }
function labelState(s){ return ({bull:'BULL',neutral:'NEUTRAL',defensive:'DEFENSIVE',watch:'WATCH'})[s] || s.toUpperCase(); }

function render(){
  document.getElementById('baseCapital').textContent = `${fmt(data.settings.capital)} USDC`;
  const open = data.trades.filter(t=>t.status==='open');
  const closed = data.trades.filter(t=>t.status==='closed');
  const exposure = open.reduce((a,t)=>a+Number(t.notional||0),0);
  const realized = closed.reduce((a,t)=>a+tradePnl(t),0);
  const wins = closed.filter(t=>tradePnl(t)>0).length;
  document.getElementById('openExposure').textContent = `${fmt(exposure)} USDC`;
  document.getElementById('openExposurePct').textContent = pct(data.settings.capital ? exposure/data.settings.capital*100 : 0);
  const pnlEl = document.getElementById('realizedPnl'); pnlEl.textContent = `${realized>=0?'+':''}${fmt(realized)} USDC`; pnlEl.className = realized>0?'pnl pos':realized<0?'pnl neg':'';
  document.getElementById('tradeCount').textContent = data.trades.length;
  document.getElementById('winRate').textContent = closed.length ? `Win rate ${pct(wins/closed.length*100)}` : 'Win rate —';
  document.getElementById('statusTitle').textContent = open.length ? `${open.length} posición${open.length>1?'es':''} abierta${open.length>1?'s':''}` : 'Sin posiciones abiertas';
  document.getElementById('statusText').textContent = open.length ? `Exposición actual: ${fmt(exposure)} USDC. Revisa invalidación y riesgo antes de cualquier nueva entrada.` : 'Añade operaciones reales o en seguimiento. Los datos se guardan en este dispositivo.';
  document.getElementById('heroBadge').textContent = open.length ? 'ACTIVE' : 'READY';

  const rg = document.getElementById('radarGrid'); rg.innerHTML='';
  Object.entries(data.radar).forEach(([pair,state])=>{
    rg.insertAdjacentHTML('beforeend',`<div class="radar-card"><div class="pair">${pair.replace('/USDC','')}</div><div class="state ${state}">${labelState(state)}</div></div>`)
  });
  renderTrades('openTrades', data.trades.filter(t=>t.status!=='closed'), false);
  renderTrades('closedTrades', closed.slice().sort((a,b)=>(b.exitDate||'').localeCompare(a.exitDate||'')), true);
}

function renderTrades(id, trades, closed){
  const el=document.getElementById(id);
  if(!trades.length){el.className='trade-list empty-state';el.textContent=closed?'Todavía no hay operaciones cerradas.':'No hay posiciones abiertas.';return;}
  el.className='trade-list'; el.innerHTML='';
  trades.forEach(t=>{
    const pnl=tradePnl(t);
    const risk = t.stopPrice && t.entryPrice && t.notional ? Math.abs((Number(t.stopPrice)/Number(t.entryPrice)-1)*Number(t.notional)) : null;
    el.insertAdjacentHTML('beforeend',`<div class="trade-row">
      <div><div class="pair">${t.pair}</div><small>${t.notes||'Sin notas'}</small></div>
      <div><span class="pill ${t.status}">${t.status==='open'?'ABIERTA':t.status==='closed'?'CERRADA':'SEGUIMIENTO'}</span><small>${t.entryDate?new Date(t.entryDate).toLocaleString('es-ES'):'—'}</small></div>
      <div><strong>${fmt(t.entryPrice, t.entryPrice<10?4:2)}</strong><small>Entrada</small></div>
      <div><strong>${fmt(t.notional)} USDC</strong><small>Notional</small></div>
      <div>${closed?`<strong class="pnl ${pnl>=0?'pos':'neg'}">${pnl>=0?'+':''}${fmt(pnl)} USDC</strong><small>Resultado</small>`:`<strong>${risk!==null?fmt(risk)+' USDC':'—'}</strong><small>Riesgo a stop</small>`}</div>
      <div class="trade-action"><button class="btn ghost" data-edit="${t.id}">Editar</button></div>
    </div>`);
  });
  el.querySelectorAll('[data-edit]').forEach(b=>b.addEventListener('click',()=>openTradeDialog(b.dataset.edit)));
}

function openTradeDialog(id=null){
  const dlg=document.getElementById('tradeDialog');
  const t=id?data.trades.find(x=>x.id===id):null;
  document.getElementById('dialogTitle').textContent=t?'Editar operación':'Añadir posición';
  document.getElementById('tradeId').value=t?.id||'';
  document.getElementById('pair').value=t?.pair||'BTC/USDC';
  document.getElementById('tradeStatus').value=t?.status||'open';
  document.getElementById('entryPrice').value=t?.entryPrice||'';
  document.getElementById('notional').value=t?.notional||'';
  document.getElementById('stopPrice').value=t?.stopPrice||'';
  document.getElementById('exitPrice').value=t?.exitPrice||'';
  document.getElementById('entryDate').value=t?.entryDate||nowLocalInput();
  document.getElementById('exitDate').value=t?.exitDate||'';
  document.getElementById('notes').value=t?.notes||'';
  document.getElementById('deleteTradeBtn').hidden=!t;
  dlg.showModal();
}

function getTradeForm(){
  return {
    id: document.getElementById('tradeId').value || crypto.randomUUID(),
    pair: document.getElementById('pair').value,
    status: document.getElementById('tradeStatus').value,
    entryPrice: Number(document.getElementById('entryPrice').value),
    notional: Number(document.getElementById('notional').value),
    stopPrice: Number(document.getElementById('stopPrice').value)||null,
    exitPrice: Number(document.getElementById('exitPrice').value)||null,
    entryDate: document.getElementById('entryDate').value||null,
    exitDate: document.getElementById('exitDate').value||null,
    notes: document.getElementById('notes').value.trim()
  };
}

document.getElementById('addTradeBtn').addEventListener('click',()=>openTradeDialog());
document.getElementById('saveTradeBtn').addEventListener('click',()=>{
  const t=getTradeForm();
  if(!t.entryPrice || !t.notional){alert('Entrada y notional son obligatorios.');return;}
  const i=data.trades.findIndex(x=>x.id===t.id); if(i>=0)data.trades[i]=t; else data.trades.push(t);
  saveData(); document.getElementById('tradeDialog').close();
});
document.getElementById('deleteTradeBtn').addEventListener('click',()=>{
  const id=document.getElementById('tradeId').value; if(!id)return;
  if(confirm('¿Eliminar esta operación?')){data.trades=data.trades.filter(t=>t.id!==id);saveData();document.getElementById('tradeDialog').close();}
});
document.getElementById('clearClosedBtn').addEventListener('click',()=>{
  if(!data.trades.some(t=>t.status==='closed')) return;
  if(confirm('¿Eliminar todas las operaciones cerradas?')){data.trades=data.trades.filter(t=>t.status!=='closed');saveData();}
});

document.getElementById('settingsBtn').addEventListener('click',()=>{
  document.getElementById('settingsCapital').value=data.settings.capital;
  document.getElementById('settingsSystem').value=data.settings.systemName;
  document.getElementById('settingsDialog').showModal();
});
document.getElementById('saveSettingsBtn').addEventListener('click',()=>{
  data.settings.capital=Number(document.getElementById('settingsCapital').value)||0;
  data.settings.systemName=document.getElementById('settingsSystem').value.trim()||'Crypto Reca';
  saveData();document.getElementById('settingsDialog').close();
});

document.getElementById('editRadarBtn').addEventListener('click',()=>{
  const ed=document.getElementById('radarEditor');ed.innerHTML='';
  Object.entries(data.radar).forEach(([pair,state])=>ed.insertAdjacentHTML('beforeend',`<div class="radar-edit-row"><strong>${pair}</strong><select data-radar="${pair}"><option value="bull" ${state==='bull'?'selected':''}>Bull</option><option value="watch" ${state==='watch'?'selected':''}>Watch</option><option value="neutral" ${state==='neutral'?'selected':''}>Neutral</option><option value="defensive" ${state==='defensive'?'selected':''}>Defensive</option></select></div>`));
  document.getElementById('radarDialog').showModal();
});
document.getElementById('saveRadarBtn').addEventListener('click',()=>{
  document.querySelectorAll('[data-radar]').forEach(s=>data.radar[s.dataset.radar]=s.value); saveData(); document.getElementById('radarDialog').close();
});

document.getElementById('exportBtn').addEventListener('click',()=>{
  const blob=new Blob([JSON.stringify(data,null,2)],{type:'application/json'});const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=`crypto-reca-backup-${new Date().toISOString().slice(0,10)}.json`;a.click();URL.revokeObjectURL(a.href);
});
document.getElementById('importInput').addEventListener('change',async(e)=>{
  const f=e.target.files[0]; if(!f)return;
  try{const parsed=JSON.parse(await f.text());if(!parsed.settings||!Array.isArray(parsed.trades))throw new Error();data=parsed;saveData();alert('Datos importados correctamente.');}catch{alert('El archivo no es un backup válido de Crypto Reca.');}
  e.target.value='';
});

document.getElementById('themeBtn').addEventListener('click',()=>{document.documentElement.classList.toggle('light');localStorage.setItem('cryptoRecaTheme',document.documentElement.classList.contains('light')?'light':'dark');});
if(localStorage.getItem('cryptoRecaTheme')==='light')document.documentElement.classList.add('light');

window.addEventListener('beforeinstallprompt',(e)=>{e.preventDefault();deferredPrompt=e;document.getElementById('installBtn').hidden=false;});
document.getElementById('installBtn').addEventListener('click',async()=>{if(!deferredPrompt)return;deferredPrompt.prompt();await deferredPrompt.userChoice;deferredPrompt=null;document.getElementById('installBtn').hidden=true;});
window.addEventListener('appinstalled',()=>{document.getElementById('installBtn').hidden=true;});

function setOnline(){document.getElementById('offlineState').textContent=navigator.onLine?'Online':'Offline';}
window.addEventListener('online',setOnline);window.addEventListener('offline',setOnline);setOnline();
if('serviceWorker' in navigator)window.addEventListener('load',()=>navigator.serviceWorker.register('./sw.js').catch(console.error));

render();
