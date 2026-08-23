// Crypto Reca Radar timestamp visibility patch v0.4.8
(function(){
  const fmtMadrid = iso => {
    if(!iso) return '—';
    const d = new Date(iso);
    if(Number.isNaN(d.getTime())) return String(iso);
    return new Intl.DateTimeFormat('es-ES',{
      timeZone:'Europe/Madrid',day:'2-digit',month:'2-digit',year:'numeric',
      hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false
    }).format(d);
  };
  const freshness = () => {
    const raw = state?.generatedAt;
    const ms = raw ? Date.parse(raw) : NaN;
    if(!Number.isFinite(ms)) return {label:'SINCRONIZACIÓN PENDIENTE',cls:'watch',age:'sin timestamp verificable'};
    const minutes = Math.max(0,Math.round((Date.now()-ms)/60000));
    if(minutes <= 75) return {label:'ACTUAL',cls:'open',age:`hace ${minutes} min`};
    if(minutes <= 150) return {label:'RETRASADO',cls:'watch',age:`hace ${minutes} min`};
    return {label:'ANTIGUO',cls:'unprotected',age:`hace ${minutes} min`};
  };
  const metaCard = () => {
    const f=freshness();
    const exactIndicator=state?.generatedAt?fmtMadrid(state.generatedAt):'—';
    const scanReported=state?.scan?.timestampEuropeMadrid||'—';
    const scanId=state?.scan?.id||'—';
    const liveTs=market?.updatedAt?fmtMadrid(market.updatedAt):'Pendiente';
    return `<div class="radar-time-card">
      <div class="radar-time-head"><div><strong>Hora exacta del indicativo</strong><div class="tiny">Zona horaria: Europe/Madrid</div></div><span class="badge ${f.cls}">${f.label}</span></div>
      <div class="radar-time-grid">
        <div><small>Indicativo Crypto Reca</small><strong>${esc(exactIndicator)}</strong><span>${esc(scanId)}</span></div>
        <div><small>Hora reportada por el scan</small><strong>${esc(scanReported)}</strong><span>${esc(f.age)}</span></div>
        <div><small>Precio público Coinbase</small><strong>${esc(liveTs)}</strong><span>se actualiza aparte del indicativo</span></div>
      </div>
    </div>`;
  };
  const originalRadar = screens.radar;
  screens.radar = () => metaCard() + originalRadar();
})();
