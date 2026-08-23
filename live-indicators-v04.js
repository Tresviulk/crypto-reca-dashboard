// Crypto Reca v0.4 — public live technical analytics (display-only)
(function(){
  window.__crSelectedAsset=window.__crSelectedAsset||'BTC';
  const HOUR=3600000;

  coinbaseSeries=async function(pair){
    const pairs=[pair,pair.replace('-USDC','-USD')];
    for(const p of pairs){
      try{
        const j=await fetchJSON(`https://api.exchange.coinbase.com/products/${p}/candles?granularity=3600`);
        if(Array.isArray(j)&&j.length>20){
          const startHour=Math.floor(Date.now()/HOUR)*HOUR;
          return j.map(x=>({t:Number(x[0]),l:Number(x[1]),h:Number(x[2]),o:Number(x[3]),c:Number(x[4]),v:Number(x[5])}))
            .filter(x=>[x.t,x.l,x.h,x.o,x.c,x.v].every(Number.isFinite)&&x.t*1000<startHour)
            .sort((a,b)=>a.t-b.t).slice(-220);
        }
      }catch{}
    }
    return [];
  };

  function ema(values,period){
    if(values.length<period)return null;
    const k=2/(period+1);let e=values.slice(0,period).reduce((a,b)=>a+b,0)/period;
    for(let i=period;i<values.length;i++)e=values[i]*k+e*(1-k);
    return e;
  }
  function rsi(values,period=14){
    if(values.length<period+1)return null;
    let gain=0,loss=0;
    for(let i=1;i<=period;i++){const d=values[i]-values[i-1];if(d>=0)gain+=d;else loss-=d;}
    let ag=gain/period,al=loss/period;
    for(let i=period+1;i<values.length;i++){const d=values[i]-values[i-1];const g=d>0?d:0,l=d<0?-d:0;ag=(ag*(period-1)+g)/period;al=(al*(period-1)+l)/period;}
    if(al===0)return 100;const rs=ag/al;return 100-(100/(1+rs));
  }
  function atr(rows,period=14){
    if(rows.length<period+1)return null;const tr=[];
    for(let i=1;i<rows.length;i++){const x=rows[i],pc=rows[i-1].c;tr.push(Math.max(x.h-x.l,Math.abs(x.h-pc),Math.abs(x.l-pc)));}
    let a=tr.slice(0,period).reduce((s,x)=>s+x,0)/period;
    for(let i=period;i<tr.length;i++)a=(a*(period-1)+tr[i])/period;return a;
  }
  function vwap(rows,count=24){
    const r=rows.slice(-count);let pv=0,vol=0;r.forEach(x=>{const tp=(x.h+x.l+x.c)/3;pv+=tp*x.v;vol+=x.v});return vol?pv/vol:null;
  }
  function rvol(rows){
    if(rows.length<22)return null;const latest=rows[rows.length-1].v;const prev=rows.slice(-21,-1).map(x=>x.v);const avg=prev.reduce((a,b)=>a+b,0)/prev.length;return avg?latest/avg:null;
  }
  function calc(asset){
    const rows=market.series?.[asset]||[];const closes=rows.map(x=>x.c).filter(Number.isFinite);if(closes.length<20)return null;
    const e12=ema(closes,12),e26=ema(closes,26);const m=e12!=null&&e26!=null?e12-e26:null;
    return {bars:rows.length,ema20:ema(closes,20),ema50:ema(closes,50),ema200:ema(closes,200),rsi14:rsi(closes,14),macd:m,atr14:atr(rows,14),vwap:vwap(rows,24),rvol:rvol(rows),asOf:rows.at(-1)?.t||null};
  }
  window.cryptoRecaLiveIndicators=calc;

  function panel(asset){
    const x=calc(asset);if(!x)return `<div class="section-title"><h2>Indicadores técnicos en vivo</h2><span>Coinbase público</span></div><div class="empty card">Aún no hay suficientes velas públicas para calcular los indicadores.</div>`;
    const f=v=>v==null?'—':money(v);const time=x.asOf?new Intl.DateTimeFormat('es-ES',{timeZone:'Europe/Madrid',day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date(x.asOf*1000)):'—';
    return `<div class="section-title"><h2>Indicadores técnicos en vivo</h2><span>${x.bars} velas 1H</span></div><div class="source-row">${sourceTagLocal('LIVE CALCULATED','live')}<span class="tiny">última vela completada: ${esc(time)} Europe/Madrid</span></div><div class="grid indicator-grid" style="margin-top:10px"><div><small>EMA20 1H</small><strong>${f(x.ema20)}</strong><span class="mini-source">COINBASE PUBLIC</span></div><div><small>EMA50 1H</small><strong>${f(x.ema50)}</strong><span class="mini-source">COINBASE PUBLIC</span></div><div><small>EMA200 1H</small><strong>${f(x.ema200)}</strong><span class="mini-source">COINBASE PUBLIC</span></div><div><small>RSI14 1H</small><strong>${f(x.rsi14)}</strong><span class="mini-source">CALCULADO</span></div><div><small>MACD 12/26</small><strong>${f(x.macd)}</strong><span class="mini-source">CALCULADO</span></div><div><small>ATR14 1H</small><strong>${f(x.atr14)}</strong><span class="mini-source">CALCULADO</span></div><div><small>VWAP 24H</small><strong>${f(x.vwap)}</strong><span class="mini-source">STANDARD VWAP</span></div><div><small>RVOL 1H</small><strong>${x.rvol==null?'—':`${money(x.rvol)}x`}</strong><span class="mini-source">vs 20 velas previas</span></div></div><div class="card info-card"><strong>Uso</strong><p>Estos indicadores son analítica visual calculada desde velas públicas completadas. No sustituyen los valores contemporáneos usados por el motor Crypto Reca para decidir una entrada.</p></div>`;
  }
  function sourceTagLocal(txt,cls=''){return `<span class="source-tag ${cls}">${esc(txt)}</span>`}

  const baseDetail=screens.assetDetail;
  screens.assetDetail=function(){return baseDetail()+panel(window.__crSelectedAsset)};
  content.addEventListener('click',e=>{const el=e.target.closest('[data-action="open-asset"]');if(el?.dataset?.asset)window.__crSelectedAsset=el.dataset.asset;},true);
})();
