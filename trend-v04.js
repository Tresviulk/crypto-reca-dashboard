// Crypto Reca v0.4 — Multi-timeframe trend overlay (display-only public market analytics)
(function(){
  const cache={};
  const inflight={};

  function ema(values,period){
    if(values.length<period)return null;
    const k=2/(period+1);let e=values.slice(0,period).reduce((a,b)=>a+b,0)/period;
    for(let i=period;i<values.length;i++)e=values[i]*k+e*(1-k);
    return e;
  }
  function num(v){const x=Number(v);return Number.isFinite(x)?x:null}
  function fmtTime(ts){
    if(!ts)return '—';
    return new Intl.DateTimeFormat('es-ES',{timeZone:'Europe/Madrid',day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date(ts*1000));
  }
  async function candles(pair,granularity){
    const pairs=[pair,pair.replace('-USDC','-USD')];
    const now=Math.floor(Date.now()/1000);
    for(const p of pairs){
      try{
        const r=await fetch(`https://api.exchange.coinbase.com/products/${p}/candles?granularity=${granularity}`,{cache:'no-store'});
        if(!r.ok)continue;
        const j=await r.json();
        if(!Array.isArray(j))continue;
        const bucket=Math.floor(now/granularity)*granularity;
        const rows=j.map(x=>({t:num(x[0]),l:num(x[1]),h:num(x[2]),o:num(x[3]),c:num(x[4]),v:num(x[5])}))
          .filter(x=>Object.values(x).every(v=>Number.isFinite(v))&&x.t<bucket)
          .sort((a,b)=>a.t-b.t);
        if(rows.length>=20)return rows.slice(-300);
      }catch{}
    }
    return [];
  }
  function aggregate4h(rows){
    const map=new Map();
    rows.forEach(x=>{
      const bucket=Math.floor(x.t/14400)*14400;
      const a=map.get(bucket);
      if(!a)map.set(bucket,{t:bucket,o:x.o,h:x.h,l:x.l,c:x.c,v:x.v,n:1});
      else{a.h=Math.max(a.h,x.h);a.l=Math.min(a.l,x.l);a.c=x.c;a.v+=x.v;a.n+=1;}
    });
    return [...map.values()].filter(x=>x.n===4).sort((a,b)=>a.t-b.t).slice(-100);
  }
  function classify(rows){
    if(!rows||rows.length<20)return {label:'SIN DATOS',tone:'neutral',reason:'Muestra insuficiente',asOf:null};
    const closes=rows.map(x=>x.c);const last=rows.at(-1);const e20=ema(closes,20);const e50=ema(closes,50);
    const recent=rows.slice(-6);const first=recent[0];const slope=(last.c-first.c)/Math.max(first.c,1);
    const highs=recent.map(x=>x.h),lows=recent.map(x=>x.l);
    const hh=highs.at(-1)>Math.max(...highs.slice(0,-1));
    const ll=lows.at(-1)<Math.min(...lows.slice(0,-1));
    let label='NEUTRAL',tone='neutral',reason='Señales mixtas';
    if(e20!=null&&e50!=null&&last.c>e20&&e20>=e50&&slope>0){label='ALCISTA';tone='bull';reason='Precio > EMA20 >= EMA50 con pendiente positiva';}
    else if(e20!=null&&e50!=null&&last.c<e20&&e20<=e50&&slope<0){label='BAJISTA';tone='bear';reason='Precio < EMA20 <= EMA50 con pendiente negativa';}
    else if(e50!=null&&last.c>=e50&&(slope>=0||hh)){label='NEUTRAL-ALCISTA';tone='bullsoft';reason='Sesgo superior positivo, pero sin alineación completa';}
    else if(e50!=null&&last.c<=e50&&(slope<=0||ll)){label='NEUTRAL-BAJISTA';tone='bearsoft';reason='Sesgo débil/bajista, sin confirmación completa';}
    return {label,tone,reason,asOf:last.t,price:last.c,ema20:e20,ema50:e50};
  }
  function summary(t){
    const a=t.m15?.label,b=t.h1?.label,c=t.h4?.label,d=t.d1?.label;
    const bear=x=>x==='BAJISTA'||x==='NEUTRAL-BAJISTA';
    const bull=x=>x==='ALCISTA'||x==='NEUTRAL-ALCISTA';
    if(bear(c)&&bear(d))return {level:'critical',text:'Deterioro multitemporal 4H/1D: revisar salida y tesis estructural.'};
    if(bear(b)&&bear(c)&&!bear(d))return {level:'high',text:'Deterioro 1H/4H: elevar vigilancia; la tendencia diaria aún no confirma ruptura estructural.'};
    if(bear(b)&&bull(c)&&bull(d))return {level:'watch',text:'Corrección bajista de corto plazo; tesis de marco superior aún intacta.'};
    if(bear(a)&&!bear(b))return {level:'watch',text:'Debilidad intradía 15m sin confirmación bajista suficiente en 1H/4H.'};
    if(bull(b)&&bull(c)&&bull(d))return {level:'good',text:'Tendencia alcista alineada en 1H/4H/1D.'};
    if(bull(c)&&bull(d))return {level:'good',text:'Marco superior constructivo; vigilar el timing de corto plazo.'};
    return {level:'neutral',text:'Lectura multitemporal mixta; evitar interpretar un único timeframe como tendencia global.'};
  }
  async function load(asset,pair,force=false){
    const key=asset;
    if(!force&&cache[key]&&Date.now()-cache[key].loadedAt<10*60*1000)return cache[key];
    if(inflight[key])return inflight[key];
    inflight[key]=(async()=>{
      try{
        const [m15,h1,d1]=await Promise.all([candles(pair,900),candles(pair,3600),candles(pair,86400)]);
        const h4=aggregate4h(h1);
        const trends={m15:classify(m15),h1:classify(h1),h4:classify(h4),d1:classify(d1)};
        const out={asset,pair,trends,summary:summary(trends),loadedAt:Date.now()};cache[key]=out;return out;
      }finally{delete inflight[key];}
    })();
    return inflight[key];
  }
  window.cryptoRecaTrend={load,get:asset=>cache[asset]||null};

  function toneClass(t){return t==='bull'?'trend-bull':t==='bear'?'trend-bear':t==='bullsoft'?'trend-bullsoft':t==='bearsoft'?'trend-bearsoft':'trend-neutral'}
  function card(data){
    if(!data)return `<div class="section-title"><h2>Tendencia multitemporal</h2><span>15m · 1H · 4H · 1D</span></div><div class="card trend-panel"><div class="empty">Calculando tendencia por temporalidad…</div></div>`;
    const order=[['m15','15m'],['h1','1H'],['h4','4H'],['d1','1D']];
    return `<div class="section-title"><h2>Tendencia multitemporal</h2><span>Coinbase público · cálculo local</span></div><div class="card trend-panel"><div class="trend-grid">${order.map(([k,l])=>{const x=data.trends[k];return `<div class="trend-cell ${toneClass(x.tone)}"><small>${l}</small><strong>${esc(x.label)}</strong><span>${esc(x.reason)}</span><em>${fmtTime(x.asOf)}</em></div>`}).join('')}</div><div class="trend-conclusion trend-${esc(data.summary.level)}"><small>Conclusión</small><strong>${esc(data.summary.text)}</strong></div><div class="tiny" style="margin-top:8px">Un timeframe bajista no equivale por sí solo a una tendencia global bajista. El motor de riesgo debe ponderar especialmente 4H/1D para posiciones CORE.</div></div>`;
  }
  function currentPair(){const a=window.__crSelectedAsset||'BTC';return (state.radar||[]).find(x=>x.asset===a)?.pair||`${a}-USDC`}
  const base=screens.assetDetail;
  screens.assetDetail=function(){
    const a=window.__crSelectedAsset||'BTC';const html=base();const data=cache[a]||null;
    const stale=!data||Date.now()-data.loadedAt>=10*60*1000;
    if(stale&&!inflight[a])setTimeout(async()=>{try{const before=cache[a]?.loadedAt||0;const out=await load(a,currentPair());if(out.loadedAt!==before&&window.__crSelectedAsset===a&&currentScreen==='assetDetail')show('assetDetail')}catch{}},0);
    return html+card(data);
  };
})();
