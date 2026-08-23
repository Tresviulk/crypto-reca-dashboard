// Crypto Reca v0.4.8 — exact indicator time, entry marker and unified live P/L presentation
(function(){'use strict';
  const fmtMadridExact=iso=>{if(!iso)return '—';const d=new Date(iso);if(Number.isNaN(d.getTime()))return String(iso);return new Intl.DateTimeFormat('es-ES',{timeZone:'Europe/Madrid',day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false}).format(d)};
  const fmtMadridShort=iso=>{if(!iso)return '—';const d=new Date(iso);if(Number.isNaN(d.getTime()))return String(iso);return new Intl.DateTimeFormat('es-ES',{timeZone:'Europe/Madrid',day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}).format(d)};
  const parseOpened=v=>{if(!v)return NaN;if(/Z$|[+-]\d\d:\d\d$/.test(v))return Date.parse(v);const s=String(v).replace(' ','T');return Date.parse(`${s}${s.length===16?':00':''}+02:00`)};
  const openPosition=asset=>(state.positions||[]).find(p=>p.status==='OPEN'&&p.asset===asset)||null;

  spark=function(asset){
    const s=market.series[asset]||[];if(s.length<3)return '<div class="spark-empty">Sin gráfico en vivo</div>';
    const p=openPosition(asset),entry=p?Number(p.entry):null,entryTs=p?parseOpened(p.openedEuropeMadrid||p.openedAt||p.opened):NaN;
    const vals=s.map(x=>x.c).filter(Number.isFinite);if(entry!=null&&Number.isFinite(entry))vals.push(entry);
    const min=Math.min(...vals),max=Math.max(...vals),range=max-min||1;
    const first=s[0].t,last=s[s.length-1].t,span=(last-first)||1;
    const pts=s.map((x,i)=>`${(i/(s.length-1))*100},${34-((x.c-min)/range)*30}`).join(' ');
    let marker='';
    if(p&&Number.isFinite(entry)&&Number.isFinite(entryTs)){
      const entrySec=entryTs/1000;
      if(entrySec>=first&&entrySec<=last){const x=Math.max(0,Math.min(100,((entrySec-first)/span)*100)),y=34-((entry-min)/range)*30;marker=`<line class="entry-level" x1="0" y1="${y.toFixed(2)}" x2="100" y2="${y.toFixed(2)}"/><circle class="entry-dot" cx="${x.toFixed(2)}" cy="${y.toFixed(2)}" r="2.4"/>`;}
    }
    const legend=p?`<div class="entry-legend"><span class="entry-dot-text">●</span> Tu entrada: <strong>${money(entry)} USDC</strong> · ${esc(p.openedEuropeMadrid||fmtMadridShort(p.openedAt||p.opened))}</div>`:'';
    return `<svg class="spark" viewBox="0 0 100 36" preserveAspectRatio="none" aria-label="Evolución 1H"><polyline points="${pts}" fill="none" stroke="currentColor" stroke-width="2" vector-effect="non-scaling-stroke"/>${marker}</svg>${legend}`;
  };

  const prevRadarItem=radarItem;
  radarItem=function(r){
    const html=prevRadarItem(r),exact=fmtMadridExact(state.generatedAt);
    return html.replace(/<\/div>$/,`<div class="indicator-exact-time"><span>Indicativo Crypto Reca</span><strong>${esc(exact)}</strong></div></div>`);
  };

  window.CR4_UI={fmtMadridExact};
})();
