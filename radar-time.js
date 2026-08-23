// Crypto Reca Radar timestamp visibility patch v0.3.1
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
    const scanTs=state?.scan?.timestampEuropeMadrid||'—';
    const scanId=state?.scan?.id||'—';
    const liveTs=market?.updatedAt?fmtMadrid(market.updatedAt):'Pendiente';
    return `<div class="radar-time-card">
      <div class="radar-time-head"><div><strong>Fecha y hora de la información</strong><div class="tiny">Zona horaria: Europe/Madrid</div></div><span class="badge ${f.cls}">${f.label}</span></div>
      <div class="radar-time-grid">
        <div><small>Último scan Crypto Reca</small><strong>${esc(scanTs)}</strong><span>${esc(scanId)}</span></div>
        <div><small>Sincronizado en la app</small><strong>${esc(fmtMadrid(state?.generatedAt))}</strong><span>${esc(f.age)}</span></div>
        <div><small>Precios públicos Coinbase</small><strong>${esc(liveTs)}</strong><span>se actualizan aparte del scan</span></div>
      </div>
    </div>`;
  };
  const originalRadar = screens.radar;
  screens.radar = () => metaCard() + originalRadar();
})();
