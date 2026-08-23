// Crypto Reca Dashboard v0.4 — operational intelligence layer
(function(){
  const V='0.4.0';
  let selectedAsset='BTC';
  let selectedPosition=null;
  const baseScreens={dashboard:screens.dashboard,radar:screens.radar,positions:screens.positions,ledger:screens.ledger,audit:screens.audit};
  const baseRadarItem=radarItem;
  const basePositionCard=positionCard;

  const n=v=>{const x=Number(v);return Number.isFinite(x)?x:null};
  const val=(obj,...keys)=>{for(const k of keys){const parts=k.split('.');let cur=obj;for(const p of parts)cur=cur?.[p];if(cur!==undefined&&cur!==null)return cur;}return null};
  const boolText=v=>v===true?'Sí':v===false?'No':'—';
  const badge=(txt,cls='prepare')=>`<span class="badge ${cls}">${esc(txt)}</span>`;
  const sourceTag=(txt,cls='')=>`<span class="source-tag ${cls}">${esc(txt)}</span>`;

  function historyPoint(h,asset){
    const a=h?.assets?.[asset] || h?.assetStates?.[asset] || (Array.isArray(h?.radar)?h.radar.find(x=>x.asset===asset):null) || h?.[asset] || null;
    const ers=n(a?.ers ?? h?.ers?.[asset]);
    const entry=n(a?.entryConfirmation ?? a?.entry ?? h?.entryConfirmation?.[asset]);
    return {id:h?.id||h?.scanId||'—',ts:h?.timestampEuropeMadrid||h?.timestamp||'—',ers,entry};
  }
  function assetHistory(asset){return (state.history||[]).map(h=>historyPoint(h,asset)).filter(x=>x.ers!=null||x.entry!=null)}

  function svgLine(points,key,maxValue,label){
    const data=points.filter(x=>n(x[key])!=null);
    if(data.length<2)return `<div class="empty mini-empty">Sin muestra suficiente para ${esc(label)}.</div>`;
    const w=100,h=38,pad=3,max=maxValue,min=0;
    const coords=data.map((d,i)=>{const yv=Math.max(min,Math.min(max,n(d[key])));const x=pad+(i/(data.length-1))*(w-pad*2);const y=h-pad-((yv-min)/(max-min))*(h-pad*2);return `${x.toFixed(1)},${y.toFixed(1)}`}).join(' ');
    const last=data[data.length-1];
    return `<svg class="history-chart" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-label="${esc(label)}"><polyline points="${coords}" fill="none" stroke="currentColor" stroke-width="2" vector-effect="non-scaling-stroke"/></svg><div class="chart-foot"><span>${data.length} scans</span><strong>${esc(label)}: ${money(last[key])}${maxValue===5?'/5':'/100'}</strong></div>`;
  }

  function opportunityState(r){
    const e=String(r?.e||'');const ers=n(r?.ers)||0;const entry=n(r?.entryConfirmation);
    if(e==='E2')return {label:'BLOQUEADO',cls:'unprotected',rank:0,why:'Estado E2 / gate no apto'};
    if(entry!=null&&entry>=4&&ers>=75)return {label:'CONFIRMACIÓN FUERTE',cls:'open',rank:5,why:'Entry Engine fuerte + ERS elevado'};
    if(entry===3)return {label:'PREPARAR',cls:'prepare',rank:4,why:'Entry Engine en PREPARE'};
    if(ers>=75)return {label:'CERCA',cls:'prepare',rank:3,why:'ERS elevado; faltan confirmaciones'};
    if(ers>=60)return {label:'WATCH',cls:'watch',rank:2,why:'Condición intermedia'};
    return {label:'NO SETUP',cls:'',rank:1,why:'Sin calidad suficiente ahora'};
  }
  function rankedRadar(){return [...(state.radar||[])].sort((a,b)=>{const A=opportunityState(a),B=opportunityState(b);return B.rank-A.rank || (n(b.entryConfirmation)||-1)-(n(a.entryConfirmation)||-1) || (n(b.ers)||0)-(n(a.ers)||0)})}

  function modeledRisk(p){
    const q=n(p.qty),entry=n(p.entry),stop=n(p.recommendedStop??p.stop);if(q==null||entry==null||stop==null)return null;
    return Math.abs(entry-stop)*q;
  }
  function riskSummary(){
    const open=(state.positions||[]).filter(p=>p.status==='OPEN');
    const exposure=open.reduce((s,p)=>s+(n(p.entry)||0)*(n(p.qty)||0),0);
    const modeled=open.map(modeledRisk).filter(x=>x!=null).reduce((a,b)=>a+b,0);
    const protectedRisk=open.filter(p=>p.protection==='PROTECTED').map(p=>{const q=n(p.qty),entry=n(p.entry),s=n(p.actualStop??p.stopPlaced??p.recommendedStop);return q!=null&&entry!=null&&s!=null?Math.abs(entry-s)*q:0}).reduce((a,b)=>a+b,0);
    const capital=n(state.validationCapital)||0;
    return {open,exposure,modeled,protectedRisk,capital,exposurePct:capital?exposure/capital*100:0};
  }

  function derivedAlerts(){
    const arr=[];
    const g=state.generatedAt?Date.parse(state.generatedAt):NaN;
    if(Number.isFinite(g)){
      const mins=Math.round((Date.now()-g)/60000);
      if(mins>75)arr.push({level:mins>150?'high':'med',title:'Radar retrasado',text:`Última sincronización hace ${mins} min.`});
    }else arr.push({level:'med',title:'Sincronización pendiente',text:'Aún no hay un scan automático confirmado en la fuente estructurada.'});
    (state.positions||[]).filter(p=>p.status==='OPEN'&&p.protection==='UNPROTECTED').forEach(p=>arr.push({level:'high',title:`${p.asset} sin protección confirmada`,text:'La posición real figura OPEN + UNPROTECTED.'}));
    (state.radar||[]).forEach(r=>{
      const e=n(r.entryConfirmation),ers=n(r.ers)||0;
      if(e!=null&&e>=4)arr.push({level:'high',title:`${r.asset}: Entry ${e}/5`,text:`${r.decision||'Confirmación fuerte'} · ERS ${ers}/100.`});
      else if(e===3)arr.push({level:'med',title:`${r.asset}: PREPARE`,text:`Entry Engine 3/5 · ERS ${ers}/100.`});
    });
    (state.alerts||[]).forEach(a=>arr.push(a));
    const seen=new Set();return arr.filter(a=>{const k=`${a.title}|${a.text}`;if(seen.has(k))return false;seen.add(k);return true});
  }

  function actionButton(label,action,extra='',cls='btn-lite'){return `<button class="${cls}" data-action="${action}" ${extra}>${esc(label)}</button>`}

  function quickHub(){
    const best=rankedRadar()[0],s=best?opportunityState(best):null;
    return `<div class="command-card"><div class="command-head"><div><div class="eyebrow">CENTRO OPERATIVO</div><strong>${best?`${esc(best.asset)} · ${esc(s.label)}`:'Esperando datos'}</strong><div class="tiny">${best?`${esc(s.why)} · ERS ${money(best.ers)}/100 · Entry ${best.entryConfirmation==null?'—':`${best.entryConfirmation}/5`}`:'Sin radar disponible'}</div></div>${best?badge(s.label,s.cls):''}</div><div class="action-grid">${actionButton('Oportunidades','open-opportunities')}${actionButton('Riesgo','open-risk')}${actionButton('Alertas','open-alerts')}${actionButton('Actualizar ahora','refresh-now')}</div></div>`;
  }

  radarItem=function(r){
    return baseRadarItem(r).replace('<div class="radar-item">',`<div class="radar-item radar-click" data-action="open-asset" data-asset="${esc(r.asset)}" role="button" tabindex="0" title="Abrir ficha completa de ${esc(r.asset)}">`);
  };
  positionCard=function(p){
    const html=basePositionCard(p);
    const controls=`<div class="card-actions">${actionButton('Ver timeline','open-timeline',`data-position="${esc(p.id||'')}"`)}${actionButton('Risk Dashboard','open-risk')}</div>`;
    return html.replace(/<\/div>$/,`${controls}</div>`);
  };

  function opportunitiesScreen(){
    const rows=rankedRadar();
    return `<div class="screen-actions">${actionButton('Actualizar ahora','refresh-now','','btn-primary')}</div><div class="section-title"><h2>Centro de oportunidades</h2><span>No es probabilidad de éxito</span></div><div class="opportunity-list">${rows.map((r,i)=>{const s=opportunityState(r);return `<div class="opportunity-card" data-action="open-asset" data-asset="${esc(r.asset)}"><div class="rank">${i+1}</div><div class="op-main"><div class="row"><strong>${esc(r.asset)}</strong>${badge(s.label,s.cls)}</div><div class="tiny">${esc(s.why)}</div><div class="op-metrics"><span>ERS <b>${money(r.ers)}/100</b></span><span>Entry <b>${r.entryConfirmation==null?'—':`${r.entryConfirmation}/5`}</b></span><span>${esc(r.d||'—')} / ${esc(r.e||'—')}</span></div></div></div>`}).join('')||'<div class="empty card">Sin datos de radar.</div>'}</div><div class="card info-card"><strong>Cómo leer esta pantalla</strong><p>Ordena el radar por estado operativo, Entry Engine y ERS. No convierte una señal en orden real ni sustituye los hard gates de Crypto Reca.</p></div>`;
  }

  function riskScreen(){
    const r=riskSummary();
    return `<div class="section-title"><h2>Risk Dashboard</h2><span>Capital y exposición</span></div><div class="grid metrics"><div class="card"><div class="metric-label">Exposición abierta</div><div class="metric-value">${money(r.exposure)}</div><div class="metric-sub">${money(r.exposurePct)}% del capital</div></div><div class="card"><div class="metric-label">Riesgo modelado</div><div class="metric-value">${money(r.modeled)}</div><div class="metric-sub">USDC hasta stops técnicos</div></div><div class="card"><div class="metric-label">Riesgo protegido</div><div class="metric-value">${money(r.protectedRisk)}</div><div class="metric-sub">solo protección confirmada</div></div><div class="card"><div class="metric-label">Posiciones abiertas</div><div class="metric-value">${r.open.length}</div><div class="metric-sub">confirmadas</div></div></div><div class="section-title"><h2>Detalle</h2><span>Por posición</span></div>${r.open.map(p=>{const mr=modeledRisk(p);const exp=(n(p.entry)||0)*(n(p.qty)||0);return `<div class="card risk-row"><div class="row"><strong>${esc(p.asset)}</strong>${badge(p.protection,p.protection==='PROTECTED'?'open':'unprotected')}</div><div class="kv"><div><small>Exposición</small><strong>${money(exp)} USDC</strong></div><div><small>Riesgo modelado</small><strong>${mr==null?'—':`${money(mr)} USDC`}</strong></div><div><small>Stop técnico</small><strong>${money(p.recommendedStop??p.stop)}</strong></div><div><small>Stop real confirmado</small><strong>${money(p.actualStop??p.stopPlaced)}</strong></div></div></div>`}).join('')||'<div class="empty card">Sin posiciones abiertas.</div>'}<div class="card info-card"><strong>Distinción crítica</strong><p>“Riesgo modelado” usa el stop técnico recomendado. “Riesgo protegido” solo cuenta un stop realmente confirmado en Coinbase.</p></div>`;
  }

  function alertsScreen(){
    const alerts=derivedAlerts();
    return `<div class="screen-actions">${actionButton('Actualizar','refresh-now','','btn-primary')}</div><div class="section-title"><h2>Alertas inteligentes</h2><span>${alerts.length} activas</span></div>${alerts.map(a=>`<div class="alert-card ${a.level==='high'?'alert-high':a.level==='med'?'alert-med':''}"><strong>${esc(a.title||'Alerta')}</strong><p>${esc(a.text||a.note||'')}</p></div>`).join('')||'<div class="empty card">No hay alertas materiales ahora.</div>'}<div class="card info-card"><strong>Alcance actual</strong><p>Estas alertas se calculan dentro de la aplicación y al abrirla. Las notificaciones push externas requieren una capa separada y no se simulan aquí.</p></div>`;
  }

  function journalScreen(){
    const hist=(state.history||[]).slice(-30).reverse();
    const journal=state.journal||[];
    return `<div class="section-title"><h2>Journal automático</h2><span>Decisiones + hechos</span></div><div class="subtabs"><span class="source-tag confirmed">CONFIRMADO COINBASE</span><span class="source-tag scan">ÚLTIMO SCAN</span></div><div class="section-title"><h2>Acciones confirmadas</h2><span>${(state.ledger||[]).length}</span></div>${(state.ledger||[]).slice().reverse().map(x=>`<div class="journal-row"><div><strong>${esc(x.side)} · ${esc(x.asset)}</strong><div class="tiny">${esc(x.dateEuropeMadrid||x.date||'—')}</div></div><div class="tiny">${esc(x.qty||'')} @ ${esc(x.price||'—')} · ${esc(x.status||'')}</div></div>`).join('')||'<div class="empty card">Sin operaciones confirmadas.</div>'}${journal.length?`<div class="section-title"><h2>Notas estructuradas</h2><span>${journal.length}</span></div>${journal.slice().reverse().map(j=>`<div class="journal-row"><div><strong>${esc(j.title||j.type||'Journal')}</strong><div class="tiny">${esc(j.timestampEuropeMadrid||j.date||'—')}</div></div><div class="tiny">${esc(j.note||j.text||'')}</div></div>`).join('')}`:''}<div class="section-title"><h2>Scans contemporáneos</h2><span>${hist.length}</span></div>${hist.map(h=>`<div class="journal-row"><div><strong>${esc(h.id||h.scanId||'—')}</strong><div class="tiny">${esc(h.timestampEuropeMadrid||h.timestamp||'—')}</div></div><div class="tiny">${esc(h.bestCondition||'—')} · ${esc(h.realOrderThisScan||h.realOrder||'NO')} · ${esc(h.dataQuality||'—')}</div></div>`).join('')||'<div class="empty card">El journal de scans se llenará automáticamente con el histórico.</div>'}`;
  }

  function analyticsScreen(){
    const history=state.history||[];const assets=state.radar||[];
    return `<div class="section-title"><h2>Analítica del sistema</h2><span>${history.length} scans guardados</span></div>${assets.map(r=>{const h=assetHistory(r.asset);const e=h.filter(x=>x.ers!=null);const avg=e.length?e.reduce((s,x)=>s+x.ers,0)/e.length:null;const prep=h.filter(x=>x.entry!=null&&x.entry>=3).length;const strong=h.filter(x=>x.entry!=null&&x.entry>=4).length;return `<div class="card analytics-row"><div class="row"><strong>${esc(r.asset)}</strong>${h.length<5?badge('MUESTRA INSUFICIENTE','watch'):badge('MUESTRA EN CURSO','prepare')}</div><div class="kv"><div><small>Scans medibles</small><strong>${h.length}</strong></div><div><small>ERS medio</small><strong>${avg==null?'—':money(avg)}</strong></div><div><small>PREPARE+</small><strong>${prep}</strong></div><div><small>STRONG+</small><strong>${strong}</strong></div></div></div>`}).join('')}<div class="card info-card"><strong>Sin falsas estadísticas</strong><p>No se calcula win rate ni eficacia por banda hasta disponer de operaciones/resoluciones suficientes y contemporáneas. La app mostrará “muestra insuficiente” antes que producir una conclusión falsa.</p></div>`;
  }

  function indicatorBox(label,value,source='SCAN'){return `<div><small>${esc(label)}</small><strong>${value==null?'—':esc(value)}</strong><span class="mini-source">${esc(source)}</span></div>`}
  function assetDetailScreen(){
    const r=(state.radar||[]).find(x=>x.asset===selectedAsset);if(!r)return '<div class="empty card">Activo no disponible.</div>';
    const h=assetHistory(r.asset);const px=livePrice(r.asset);
    const ind=r.indicators||{};const st=r.structure||{};const dim=r.entryDimensions||{};
    const entries=[
      ['EMA20 1H',val(r,'indicators.ema20_1h','ema20_1h')],['EMA50 1H',val(r,'indicators.ema50_1h','ema50_1h')],['EMA200 1H',val(r,'indicators.ema200_1h','ema200_1h')],['VWAP',val(r,'indicators.vwap_1h','vwap_1h','vwap')],['RSI14 1H',val(r,'indicators.rsi14_1h','rsi14_1h','rsi14')],['ATR14 1H',val(r,'indicators.atr14_1h','atr14_1h','atr14')],['MACD 1H',val(r,'indicators.macd_1h','macd_1h','macd')],['RVOL 1H',val(r,'indicators.rvol_1h','rvol_1h','rvol')]
    ];
    return `<div class="screen-actions">${actionButton('← Volver al Radar','back-radar')}${actionButton('Actualizar','refresh-now','','btn-primary')}</div><div class="asset-hero"><div><div class="eyebrow">${esc(r.pair||`${r.asset}-USDC`)}</div><h2>${esc(r.asset)}</h2><div class="asset-price">${money(px)} <small>USDC</small></div><div class="source-row">${sourceTag('LIVE COINBASE','live')}${sourceTag(`SCAN ${state.scan?.id||'—'}`,'scan')}</div></div><div class="asset-score"><span>ERS</span><strong>${money(r.ers)}</strong><small>/100</small></div></div><div class="grid detail-grid">${indicatorBox('D / E',`${r.d||'—'} / ${r.e||'—'}`)}${indicatorBox('Entry Engine',r.entryConfirmation==null?'—':`${r.entryConfirmation}/5`)}${indicatorBox('Estado Entry',r.entryState||'—')}${indicatorBox('Decisión',r.decision||'—')}</div><div class="section-title"><h2>Indicadores</h2><span>solo si el scan los aportó</span></div><div class="grid indicator-grid">${entries.map(x=>indicatorBox(x[0],x[1])).join('')}</div><div class="section-title"><h2>Estructura y ejecución</h2><span>último scan</span></div><div class="grid detail-grid">${indicatorBox('Ubicación',val(r,'structure.location','location'))}${indicatorBox('Soporte',val(r,'structure.support','support'))}${indicatorBox('Resistencia',val(r,'structure.resistance','resistance'))}${indicatorBox('Trigger',val(r,'structure.trigger','trigger'))}${indicatorBox('Invalidación',val(r,'structure.invalidation','invalidation'))}${indicatorBox('Setup',val(r,'structure.setup','setup'))}</div><div class="section-title"><h2>5 dimensiones Entry Engine</h2><span>confirmaciones</span></div><div class="dimension-grid">${['trend','location','momentum','volume','trigger'].map(k=>`<div class="dimension ${dim[k]===true?'yes':dim[k]===false?'no':''}"><span>${esc(k.toUpperCase())}</span><strong>${boolText(dim[k])}</strong></div>`).join('')}</div><div class="section-title"><h2>Evolución ERS</h2><span>histórico</span></div><div class="card chart-card">${svgLine(h,'ers',100,'ERS')}</div><div class="section-title"><h2>Evolución Entry Engine</h2><span>histórico</span></div><div class="card chart-card">${svgLine(h,'entry',5,'Entry Engine')}</div><div class="card info-card"><strong>Origen de datos</strong><p>${sourceTag('LIVE','live')} precio público Coinbase. ${sourceTag('SCAN','scan')} ERS, D/E, Entry Engine, indicadores y estructura solo cuando fueron calculados contemporáneamente por Crypto Reca.</p></div>`;
  }

  function timelineScreen(){
    const p=(state.positions||[]).find(x=>x.id===selectedPosition) || (state.positions||[])[0];if(!p)return '<div class="empty card">Posición no disponible.</div>';
    const scans=(state.history||[]).slice(-50);
    const ledger=(state.ledger||[]).filter(x=>String(x.asset||'').startsWith(p.asset));
    const events=[...ledger.map(x=>({kind:'COINBASE',ts:x.dateEuropeMadrid||x.date,title:`${x.side} ${x.asset}`,text:`${x.qty||''} @ ${x.price||'—'} · ${x.status||''}`})),...scans.map(h=>{const hp=historyPoint(h,p.asset);return {kind:'SCAN',ts:hp.ts,title:hp.id,text:`ERS ${hp.ers==null?'—':hp.ers}/100 · Entry ${hp.entry==null?'—':`${hp.entry}/5`} · ${h.bestCondition||'—'}`}})];
    return `<div class="screen-actions">${actionButton('← Posiciones','back-positions')}</div><div class="section-title"><h2>Timeline ${esc(p.asset)}</h2><span>${esc(p.status)}</span></div><div class="card"><div class="kv"><div><small>Entrada confirmada</small><strong>${money(p.entry)}</strong></div><div><small>Apertura</small><strong>${esc(p.openedEuropeMadrid||'—')}</strong></div><div><small>Cantidad</small><strong>${esc(p.qty)}</strong></div><div><small>Protección</small><strong>${esc(p.protection)}</strong></div></div></div><div class="timeline">${events.map(e=>`<div class="timeline-event"><div class="timeline-dot ${e.kind==='COINBASE'?'confirmed':'scan'}"></div><div><div class="row"><strong>${esc(e.title)}</strong>${sourceTag(e.kind,e.kind==='COINBASE'?'confirmed':'scan')}</div><div class="tiny">${esc(e.ts||'—')}</div><p>${esc(e.text||'')}</p></div></div>`).join('')||'<div class="empty card">Aún no hay eventos suficientes.</div>'}</div>`;
  }

  screens.opportunities=opportunitiesScreen;
  screens.risk=riskScreen;
  screens.alerts=alertsScreen;
  screens.journal=journalScreen;
  screens.analytics=analyticsScreen;
  screens.assetDetail=assetDetailScreen;
  screens.timeline=timelineScreen;

  screens.dashboard=()=>quickHub()+baseScreens.dashboard();
  screens.positions=()=>`<div class="screen-actions">${actionButton('Risk Dashboard','open-risk')}${actionButton('Journal','open-journal')}</div>`+baseScreens.positions();
  screens.ledger=()=>`<div class="screen-actions">${actionButton('Journal completo','open-journal')}${actionButton('Analítica','open-analytics')}</div>`+baseScreens.ledger();
  screens.audit=()=>`<div class="action-grid audit-hub">${actionButton('Analítica','open-analytics')}${actionButton('Journal','open-journal')}${actionButton('Alertas','open-alerts')}${actionButton('Riesgo','open-risk')}</div>`+baseScreens.audit();

  const titles={dashboard:'Dashboard',radar:'Radar',positions:'Posiciones',ledger:'Operaciones',audit:'Auditoría',opportunities:'Oportunidades',risk:'Riesgo',alerts:'Alertas',journal:'Journal',analytics:'Analítica',assetDetail:'Ficha de activo',timeline:'Timeline'};
  show=function(screen){
    currentScreen=screen;
    document.querySelectorAll('.nav-btn').forEach(b=>b.classList.toggle('active',b.dataset.screen===screen));
    title.textContent=titles[screen]||'Crypto Reca';
    const fn=screens[screen]||screens.dashboard;
    content.innerHTML=fn();
    window.scrollTo({top:0,behavior:'instant'});
  };

  async function refreshAll(){
    const btn=content.querySelector('[data-action="refresh-now"]');if(btn){btn.disabled=true;btn.textContent='Actualizando…';}
    await loadState();await refreshMarket();updateBadge();show(currentScreen);
  }
  content.addEventListener('click',e=>{
    const el=e.target.closest('[data-action]');if(!el)return;
    const a=el.dataset.action;
    if(a==='open-asset'){selectedAsset=el.dataset.asset||'BTC';show('assetDetail');}
    else if(a==='open-opportunities')show('opportunities');
    else if(a==='open-risk')show('risk');
    else if(a==='open-alerts')show('alerts');
    else if(a==='open-journal')show('journal');
    else if(a==='open-analytics')show('analytics');
    else if(a==='open-timeline'){selectedPosition=el.dataset.position||null;show('timeline');}
    else if(a==='back-radar')show('radar');
    else if(a==='back-positions')show('positions');
    else if(a==='refresh-now')refreshAll();
  });
  content.addEventListener('keydown',e=>{if((e.key==='Enter'||e.key===' ')&&e.target?.matches?.('[data-action="open-asset"]')){e.preventDefault();e.target.click();}});

  // Version marker for the UI; keeps app.js core untouched.
  document.querySelector('.eyebrow')?.replaceChildren(document.createTextNode(`CRYPTO RECA v3.0 · APP ${V}`));
})();
