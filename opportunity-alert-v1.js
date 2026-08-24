// Crypto Reca v0.5.2 — Early Opportunity Alert Layer
(function(){
'use strict';
const num=v=>Number.isFinite(Number(v))?Number(v):null;
const txt=v=>String(v??'').trim();
function inferredState(r){
  const explicit=txt(r?.opportunityState).toUpperCase();
  if(explicit)return explicit;
  const entry=num(r?.entryConfirmation),ers=num(r?.ers),reg=txt(r?.coreRegime).toUpperCase();
  const cur=num(r?.currentConfirmedCoreExposurePct),target=num(r?.coreTargetExposurePct);
  const under=cur!=null&&target!=null&&cur+0.25<target;
  if((reg==='R1'||reg==='R2')&&under)return 'PREPARE';
  if(entry!=null&&entry>=4)return 'ENTRY REVIEW';
  if(entry===3||(ers!=null&&ers>=75))return 'PREPARE';
  if(ers!=null&&ers>=60)return 'WATCH';
  return 'QUIET';
}
function rank(s){return s==='ENTRY REVIEW'?4:s==='PREPARE'?3:s==='WATCH'?2:s==='QUIET'?0:1}
function cls(s){return s==='ENTRY REVIEW'?'open':s==='PREPARE'?'prepare':s==='WATCH'?'watch':''}
function reason(r,s){
  const x=txt(r?.opportunityReason);if(x)return x;
  if(s==='ENTRY REVIEW')return 'Condiciones suficientes para revisar un paquete de entrada; aún no implica orden.';
  if(s==='PREPARE')return 'Setup en formación: revisar trigger, ubicación y riesgo.';
  if(s==='WATCH')return 'Movimiento/estructura merece atención aunque aún no exista entrada completa.';
  return 'Sin aceleración material detectada.';
}
function location(r){return txt(r?.locationState)||txt(r?.structure?.location)||'—'}
function trigger(r){return txt(r?.nearestTrigger)||txt(r?.structure?.nearestTrigger)||''}
function exposure(r){
  const reg=txt(r?.coreRegime),cur=num(r?.currentConfirmedCoreExposurePct),target=num(r?.coreTargetExposurePct);
  if(!reg&&!Number.isFinite(cur)&&!Number.isFinite(target))return '';
  return `<div class="tiny">Core ${esc(reg||'—')} · exposición ${cur==null?'—':money(cur)+'%'} / objetivo ${target==null?'—':money(target)+'%'}</div>`;
}
function opportunityRows(){
  return (state.radar||[]).map(r=>({r,s:inferredState(r)})).filter(x=>rank(x.s)>0).sort((a,b)=>rank(b.s)-rank(a.s)||(num(b.r.ers)||0)-(num(a.r.ers)||0));
}
function watchPanel(compact=false){
  const rows=opportunityRows();
  if(!rows.length)return compact?'':`<div class="card info-card"><strong>Opportunity Watch</strong><p>No hay una oportunidad temprana material en el último radar.</p></div>`;
  const shown=compact?rows.slice(0,3):rows;
  return `<div class="section-title"><h2>Opportunity Watch</h2><span>Alerta temprana · no es orden</span></div>${shown.map(({r,s})=>{const t=trigger(r);return `<div class="card"><div class="row"><strong>${esc(r.asset)}</strong><span class="badge ${cls(s)}">${esc(s)}</span></div><div class="tiny">${esc(reason(r,s))}</div><div class="op-metrics"><span>ERS <b>${r.ers==null?'—':money(r.ers)}/100</b></span><span>Entry <b>${r.entryConfirmation==null?'—':esc(r.entryConfirmation)+'/5'}</b></span><span>${esc(r.d||'—')} / ${esc(r.e||'—')}</span></div><div class="tiny">Ubicación: <strong>${esc(location(r))}</strong>${t?` · Trigger: ${esc(t)}`:''}</div>${exposure(r)}<div class="tiny">${s==='ENTRY REVIEW'?'REVISAR ENTRADA — NO ORDER YET':s==='PREPARE'?'PREPARAR — NO ORDER YET':'VIGILAR — NO ORDER YET'}</div></div>`}).join('')}`;
}
function install(){
  if(window.__crOpportunityV1)return;
  if(typeof screens==='undefined'||typeof screens.dashboard!=='function'||typeof screens.radar!=='function')return;
  window.__crOpportunityV1=true;
  const baseDashboard=screens.dashboard,baseRadar=screens.radar;
  screens.dashboard=()=>watchPanel(true)+baseDashboard();
  screens.radar=()=>watchPanel(false)+baseRadar();
  if(window.CR4&&typeof CR4.registerScreen==='function')CR4.registerScreen('opportunity','Oportunidades',()=>watchPanel(false));
}
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',install);else install();
setTimeout(install,0);
})();
