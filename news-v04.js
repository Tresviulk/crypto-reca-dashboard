// Crypto Reca v0.4 — News & Catalysts Overlay UI
(function(){
  function actionClass(a){
    if(a==='EXIT REVIEW'||a==='REDUCE REVIEW'||a==='AVOID NEW ENTRY')return 'unprotected';
    if(a==='PREPARE VOLATILITY'||a==='WATCH'||a==='DO NOT CHASE')return 'watch';
    return 'open';
  }
  function impactClass(i){
    if(i==='CRITICAL'||i==='HIGH')return 'unprotected';
    if(i==='MEDIUM')return 'watch';
    return 'prepare';
  }
  function newsItems(){return state?.newsOverlay?.items||[]}
  function catalysts(){return state?.catalysts||[]}
  function fmtAssets(a){return Array.isArray(a)?a.join(', '):(a||'MARKET')}
  function latestRelevant(){return newsItems().find(x=>['HIGH','CRITICAL'].includes(x.impactLevel))||newsItems()[0]||null}
  function newsSummaryCard(){
    const n=latestRelevant();const c=catalysts()[0];
    return `<div class="news-summary-card"><div class="row"><div><div class="eyebrow">NEWS & CATALYSTS</div><strong>${n?esc(n.headline):'Sin noticias materiales nuevas'}</strong><div class="tiny">${n?`${esc(fmtAssets(n.assets))} · ${esc(n.impactLevel||'—')} · ${esc(n.horizon||'—')}`:'Solo se muestran eventos realmente relevantes.'}</div></div>${n?`<span class="badge ${impactClass(n.impactLevel)}">${esc(n.impactLevel||'—')}</span>`:''}</div>${n?`<div class="news-action-line"><span>Acción</span><strong>${esc(n.action||'NO ACTION')}</strong><small>${esc(n.actionReason||'')}</small></div>`:''}${c?`<div class="next-catalyst"><small>Próximo catalizador</small><strong>${esc(c.headline||c.event||'—')}</strong><span>${esc(c.timestampEuropeMadrid||c.scheduledEuropeMadrid||c.publishedAt||'—')}</span></div>`:''}<button class="btn-primary" data-news-action="open-news">Ver noticias y próximos eventos</button></div>`;
  }
  function itemCard(n){
    return `<div class="news-item ${['HIGH','CRITICAL'].includes(n.impactLevel)?'news-major':''}"><div class="row"><div><div class="source-row"><span class="source-tag ${n.sourceQuality==='A'?'confirmed':'scan'}">FUENTE ${esc(n.sourceQuality||'—')}</span><span class="source-tag">${esc(n.status||'—')}</span><span class="source-tag">${esc(n.horizon||'—')}</span></div><h3>${esc(n.headline||'')}</h3></div><span class="badge ${impactClass(n.impactLevel)}">${esc(n.impactLevel||'—')}</span></div><div class="tiny">${esc(n.timestampEuropeMadrid||n.publishedAt||'—')} · ${esc(fmtAssets(n.assets))} · ${esc(n.sourceName||'—')}</div>${n.summary?`<p>${esc(n.summary)}</p>`:''}<div class="news-grid"><div><small>Dirección</small><strong>${esc(n.impactDirection||'UNKNOWN')}</strong></div><div><small>Confianza</small><strong>${esc(n.confidence||'—')}</strong></div><div><small>Por qué importa</small><strong>${esc(n.whyItMatters||'—')}</strong></div><div><small>Acción Crypto Reca</small><strong>${esc(n.action||'NO ACTION')}</strong></div></div>${n.actionReason?`<div class="risk-reason"><strong>Consejo de actuación</strong><p>${esc(n.actionReason)}</p></div>`:''}${n.sourceUrl?`<a class="news-link" href="${esc(n.sourceUrl)}" target="_blank" rel="noopener noreferrer">Abrir fuente</a>`:''}</div>`;
  }
  function catalystCard(c){
    return `<div class="catalyst-card"><div class="row"><div><strong>${esc(c.headline||c.event||'Catalizador')}</strong><div class="tiny">${esc(c.timestampEuropeMadrid||c.scheduledEuropeMadrid||c.publishedAt||'Hora no confirmada')}</div></div><span class="badge ${impactClass(c.impactLevel)}">${esc(c.impactLevel||'—')}</span></div><div class="tiny" style="margin-top:6px">${esc(fmtAssets(c.assets))}</div><p>${esc(c.preparationNote||c.note||c.whyItMatters||'')}</p></div>`;
  }
  function newsScreen(){
    const items=newsItems(),cats=catalysts();
    return `<div class="screen-actions"><button class="btn-lite" data-news-action="back-dashboard">← Inicio</button><button class="btn-primary" data-action="refresh-now">Actualizar</button></div><div class="news-status"><div><div class="eyebrow">NEWS OVERLAY</div><strong>${esc(state?.newsOverlay?.marketBias||'NEUTRAL / NO DATA')}</strong><div class="tiny">${esc(state?.newsOverlay?.generatedAt||'Esperando primera sincronización')}</div></div><span class="badge ${state?.newsOverlay?.dataQuality==='PASS'?'open':'watch'}">${esc(state?.newsOverlay?.dataQuality||'PENDIENTE')}</span></div><div class="section-title"><h2>Noticias relevantes</h2><span>${items.length} activas</span></div>${items.length?items.map(itemCard).join(''):'<div class="empty card">Aún no hay noticias de alta señal sincronizadas.</div>'}<div class="section-title"><h2>Próximos 7 días</h2><span>catalizadores</span></div>${cats.length?cats.map(catalystCard).join(''):'<div class="empty card">No hay catalizadores materiales confirmados ahora.</div>'}<div class="card info-card"><strong>Regla de uso</strong><p>Una noticia positiva nunca crea una compra por sí sola. Noticias negativas de alta severidad pueden aconsejar evitar nuevas entradas, revisar reducción o revisar salida, pero ninguna recomendación se registra como venta ejecutada hasta que el usuario confirme la operación real en Coinbase.</p></div>`;
  }
  screens.news=newsScreen;
  const baseDashboard=screens.dashboard;
  screens.dashboard=()=>newsSummaryCard()+baseDashboard();
  const oldShow=show;
  show=function(screen){
    oldShow(screen);
    if(screen==='news')title.textContent='Noticias';
  };
  content.addEventListener('click',e=>{
    const el=e.target.closest('[data-news-action]');if(!el)return;
    if(el.dataset.newsAction==='open-news')show('news');
    if(el.dataset.newsAction==='back-dashboard')show('dashboard');
  });
})();
