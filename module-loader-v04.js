// Crypto Reca v0.4.8 — modular data + single screen/action registry
(function(){
'use strict';
const urls={radar:'./data/radar-state.json',positions:'./data/positions-state.json',risk:'./data/position-risk.json',intelligence:'./data/intelligence.json',external:'./data/external-signals.json'};
const meta={},titles={},actions={};
const a=v=>Array.isArray(v)?v:[], num=v=>Number.isFinite(Number(v))?Number(v):null;
const oldLoad=loadState, oldShow=show;
const age=ts=>{const t=Date.parse(ts||'');return Number.isFinite(t)?Math.max(0,(Date.now()-t)/60000):null};
async function read(name,url){try{const d=await fetchJSON(`${url}?t=${Date.now()}`);meta[name]={ok:true,url,generatedAt:d.generatedAt||d.updatedAt||null};return d}catch(e){meta[name]={ok:false,url,error:String(e?.message||e)};return null}}
function merge(m){
 const r=m.radar;if(r){if(r.scan?.id)state.scan=r.scan;if(a(r.radar).length)state.radar=r.radar;if(a(r.history).length)state.history=r.history;if(a(r.audits).length)state.audits=r.audits;if(r.engineHealth)state.engineHealth=r.engineHealth;if(r.shadowPortfolio)state.shadowPortfolio=r.shadowPortfolio;if(r.generatedAt){state.generatedAt=r.generatedAt;state.source=r.source||state.source}if(r.validationCapital!=null)state.validationCapital=r.validationCapital}
 const p=m.positions;if(p){if(a(p.positions).length)state.positions=p.positions;if(a(p.ledger).length)state.ledger=p.ledger;if(a(p.journal).length)state.journal=p.journal}
 const k=m.risk;if(k){if(k.positionRisk)state.positionRisk=k.positionRisk;if(a(k.riskHistory).length)state.riskHistory=k.riskHistory}
 const i=m.intelligence;if(i){if(i.newsOverlay)state.newsOverlay=i.newsOverlay;if(a(i.catalysts).length)state.catalysts=i.catalysts;if(a(i.newsHistory).length)state.newsHistory=i.newsHistory}
 const x=m.external;if(x){if(x.externalSignals)state.externalSignals=x.externalSignals;if(a(x.signalSources).length)state.signalSources=x.signalSources;if(a(x.externalSignalHistory).length)state.externalSignalHistory=x.externalSignalHistory}
}
async function loadModules(){const e=await Promise.all(Object.entries(urls).map(async([k,u])=>[k,await read(k,u)]));const m=Object.fromEntries(e);merge(m);CR4.modules=m;return m}
loadState=async function(){await oldLoad();await loadModules()};
function fresh(ts,good=90,bad=180){const x=age(ts);if(x==null)return ['PARTIAL','sin timestamp'];return x<=good?['PASS',`${Math.round(x)} min`]:x<=bad?['PARTIAL',`${Math.round(x)} min`]:['FAIL',`${Math.round(x)} min`]}
function health(){
 const ers=a(state.radar).map(r=>num(r.ers)),missing=ers.filter(v=>v==null).length;let eh=missing===0&&ers.length>=6?['PASS',`${ers.length}/6`]:missing===ers.length&&ers.length?['FAIL','ERS no calculado']:['PARTIAL',`faltan ${missing}`];
 if(state?.engineHealth?.ers)eh=[state.engineHealth.ers.status||eh[0],state.engineHealth.ers.reason||eh[1]];
 return [ ['Radar',...fresh(state.generatedAt||state?.scan?.timestampEuropeMadrid)],['ERS Engine',...eh],['Position Risk',...fresh(state?.positionRisk?.generatedAt,95,190)],['Intelligence',...fresh(state?.newsOverlay?.generatedAt,100,200)],['External Signals',...fresh(state?.externalSignals?.generatedAt,100,200)],['Coinbase público',...fresh(market.updatedAt,3,10)] ];
}
function healthStatus(){const h=health();return h.some(x=>x[1]==='FAIL')?'FAIL':h.some(x=>x[1]==='PARTIAL')?'PARTIAL':'PASS'}
function badge(s){const c=s==='PASS'?'open':s==='FAIL'?'unprotected':'watch';return `<span class="badge ${c}">${esc(s)}</span>`}
function healthCard(){const h=health(),s=healthStatus();return `<div class="health-card"><div class="row"><div><div class="eyebrow">SYSTEM HEALTH</div><strong>${s}</strong></div>${badge(s)}</div><div class="health-grid">${h.map(x=>`<div><small>${esc(x[0])}</small><strong>${esc(x[1])}</strong><span>${esc(x[2])}</span></div>`).join('')}</div><button class="btn-lite" data-cr4="health">Ver diagnóstico</button></div>`}
function healthScreen(){return `<div class="section-title"><h2>System Health</h2><span>${healthStatus()}</span></div>${health().map(x=>`<div class="health-row"><div><strong>${esc(x[0])}</strong><span>${esc(x[2])}</span></div>${badge(x[1])}</div>`).join('')}<div class="card"><strong>Fuentes modulares</strong>${Object.entries(meta).map(([k,v])=>`<div class="history-row"><span>${esc(k)}</span>${badge(v.ok?'PASS':'FAIL')}</div>`).join('')}</div>`}
function registerScreen(name,titleText,renderer){screens[name]=renderer;titles[name]=titleText}
function navigate(name){oldShow(name);if(titles[name])title.textContent=titles[name]}
function on(name,fn){actions[name]=fn}
const CR4=window.CR4={modules:{},meta,registerScreen,navigate,on,health,healthStatus,loadModules,num,a};
registerScreen('health','System Health',healthScreen);titles.health='System Health';
const baseDash=screens.dashboard;screens.dashboard=()=>healthCard()+`<div class="command-card cr4-hub"><div class="eyebrow">DECISION COCKPIT</div><div class="action-grid"><button class="btn-lite" data-cr4="matrix">Decision Matrix</button><button class="btn-lite" data-cr4="protection">Protection</button><button class="btn-lite" data-cr4="external">Gurús</button><button class="btn-lite" data-cr4="shadow">Shadow</button><button class="btn-lite" data-cr4="correlation">Correlación</button></div></div>`+baseDash().replace('App 0.3.0','App 0.4.8').replace('App 0.4.5','App 0.4.8');
show=function(name){navigate(name)};
content.addEventListener('click',e=>{const el=e.target.closest('[data-cr4]');if(!el)return;const k=el.dataset.cr4;if(actions[k])actions[k](el,e);else if(screens[k])navigate(k)});
loadModules().then(()=>{updateBadge();oldShow(currentScreen)});setInterval(()=>loadModules().then(()=>{updateBadge();oldShow(currentScreen)}),60000);
})();
