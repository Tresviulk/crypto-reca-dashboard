// Crypto Reca v0.4 — Position Risk / Exit Advisory UI
(function(){
  function prFor(p){return state?.positionRisk?.positions?.[p.id]||null}
  function actionClass(a){return a==='EXIT SIGNAL'?'unprotected':a==='EXIT REVIEW'||a==='REDUCE REVIEW'?'watch':a==='HOLD'?'open':'prepare'}
  function riskActionText(a){
    if(a==='EXIT SIGNAL')return 'Salida aconsejada por regla del sistema';
    if(a==='EXIT REVIEW')return 'Revisar salida ahora';
    if(a==='REDUCE REVIEW')return 'Revisar reducción de exposición';
    if(a==='WATCH')return 'Mantener bajo vigilancia';
    if(a==='HOLD')return 'Mantener mientras la tesis siga intacta';
    return 'Esperando evaluación';
  }
  function trendTone(v){const x=String(v||'');return x.includes('BAJISTA')?'unprotected':x.includes('ALCISTA')?'open':'watch'}
  function trendStrip(r){
    const t=r?.trendTimeframes||r?.trends||null;if(!t)return '';
    const get=k=>{const v=t[k]??t[k.toUpperCase()]??null;return typeof v==='object'?(v.label||v.state||'—'):(v||'—')};
    const vals=[['15m',get('15m')],['1H',get('1h')],['4H',get('4h')],['1D',get('1d')]];
    return `<div class="section-title"><h2>Tendencia multitemporal</h2><span>Exit Engine</span></div><div class="trend-risk-grid">${vals.map(([k,v])=>`<div><small>${k}</small><span class="badge ${trendTone(v)}">${esc(v)}</span></div>`).join('')}</div>${r.trendConclusion?`<div class="risk-reason"><strong>Lectura conjunta</strong><p>${esc(r.trendConclusion)}</p></div>`:''}`;
  }
  function riskCard(p,compact=false){
    const r=prFor(p);
    if(!r)return `<div class="card risk-engine-card"><div class="row"><strong>Position Risk · ${esc(p.asset)}</strong><span class="badge watch">PENDIENTE</span></div><p class="muted">Esperando el primer cálculo automático de riesgo/salida para esta posición.</p></div>`;
    const b=r.breakdown||{};const prs=Number.isFinite(Number(r.prs))?Number(r.prs):null;
    const cls=actionClass(r.action);
    const head=`<div class="row"><div><strong>Position Risk · ${esc(p.asset)}</strong><div class="tiny">${esc(state.positionRisk?.generatedAt||'—')} · ${esc(state.positionRisk?.dataQuality||'—')}</div></div><span class="badge ${cls}">${esc(r.action||'—')}</span></div>`;
    if(compact)return `<div class="card risk-engine-card ${r.action==='EXIT SIGNAL'?'risk-critical':''}">${head}<div class="risk-score-row"><div><small>PRS</small><strong>${prs==null?'—':prs}<span>/100</span></strong></div><div><small>Tesis</small><strong>${esc(r.thesisState||'—')}</strong></div><div><small>Riesgo modelado</small><strong>${r.modeledLossUSDC==null?'—':`${money(r.modeledLossUSDC)} USDC`}</strong></div></div>${r.trendConclusion?`<div class="tiny">${esc(r.trendConclusion)}</div>`:''}<p>${esc(riskActionText(r.action))}</p>${r.reason?`<div class="tiny">${esc(r.reason)}</div>`:''}</div>`;
    return `<div class="card risk-engine-card ${r.action==='EXIT SIGNAL'?'risk-critical':''}">${head}<div class="risk-hero"><div><span>PRS</span><strong>${prs==null?'—':prs}</strong><small>/100 · no es probabilidad de pérdida</small></div><div><span>Acción</span><strong>${esc(r.action||'—')}</strong><small>${esc(riskActionText(r.action))}</small></div></div>${trendStrip(r)}<div class="grid detail-grid"><div><small>Tesis</small><strong>${esc(r.thesisState||'—')}</strong></div><div><small>Protección real</small><strong>${esc(r.protection||p.protection||'—')}</strong></div><div><small>Invalidación técnica</small><strong>${r.technicalInvalidation==null?'—':money(r.technicalInvalidation)}</strong></div><div><small>Estado invalidación</small><strong>${esc(r.invalidationStatus||'—')}</strong></div><div><small>Pérdida modelada</small><strong>${r.modeledLossUSDC==null?'—':`${money(r.modeledLossUSDC)} USDC`}</strong></div><div><small>% capital validación</small><strong>${r.modeledLossPctCapital==null?'—':`${money(r.modeledLossPctCapital)}%`}</strong></div><div><small>Distancia a invalidación</small><strong>${r.distanceToInvalidationPct==null?'—':`${money(r.distanceToInvalidationPct)}%`}</strong></div><div><small>Distancia ATR</small><strong>${r.distanceToInvalidationATR==null?'—':`${money(r.distanceToInvalidationATR)} ATR`}</strong></div><div><small>P/L no realizado</small><strong>${r.unrealizedPnLUSDC==null?'—':`${money(r.unrealizedPnLUSDC)} USDC`}</strong></div><div><small>P/L %</small><strong>${r.unrealizedPnLPct==null?'—':`${money(r.unrealizedPnLPct)}%`}</strong></div></div><div class="section-title"><h2>Componentes PRS</h2><span>A/B/C/D/E</span></div><div class="dimension-grid"><div class="dimension"><span>Estructura</span><strong>${b.structural??b.A??'—'}/40</strong></div><div class="dimension"><span>Régimen</span><strong>${b.regime??b.B??'—'}/20</strong></div><div class="dimension"><span>Momentum</span><strong>${b.momentum??b.C??'—'}/15</strong></div><div class="dimension"><span>Adverse Move</span><strong>${b.adverseMove??b.D??'—'}/15</strong></div><div class="dimension"><span>Sin protección</span><strong>${b.protection??b.E??'—'}/10</strong></div></div>${r.reason?`<div class="risk-reason"><strong>Por qué</strong><p>${esc(r.reason)}</p></div>`:''}${r.upgradeCondition?`<div class="risk-condition"><small>Empeora si</small><strong>${esc(r.upgradeCondition)}</strong></div>`:''}${r.downgradeCondition?`<div class="risk-condition"><small>Mejora si</small><strong>${esc(r.downgradeCondition)}</strong></div>`:''}<div class="tiny risk-disclaimer">Señal de gestión de riesgo. No es una venta ejecutada. Cualquier venta real debe confirmarse posteriormente desde Coinbase.</div></div>`;
  }

  function openPositions(){return (state.positions||[]).filter(p=>p.status==='OPEN')}
  function riskSummaryBlock(){const p=openPositions();if(!p.length)return '';return `<div class="section-title"><h2>Riesgo de posiciones abiertas</h2><span>Motor de salida</span></div>${p.map(x=>riskCard(x,true)).join('')}`}

  const baseDashboard=screens.dashboard;
  const basePositions=screens.positions;
  const baseAsset=screens.assetDetail;
  const baseRisk=screens.risk;

  screens.dashboard=()=>riskSummaryBlock()+baseDashboard();
  screens.positions=()=>`${openPositions().map(p=>riskCard(p,false)).join('')}${basePositions()}`;
  screens.assetDetail=()=>{const html=baseAsset();const p=openPositions().find(p=>p.asset===window.__crSelectedAsset);return html+(p?`<div class="section-title"><h2>Riesgo de la posición abierta</h2><span>Exit Engine</span></div>${riskCard(p,false)}`:'')};
  screens.risk=()=>`${baseRisk()}<div class="section-title"><h2>Exit Advisory</h2><span>Reglas automáticas</span></div>${openPositions().map(p=>riskCard(p,false)).join('')||'<div class="empty card">Sin posiciones abiertas.</div>'}`;
})();
