const WORKER_BASE="https://senda-scanner.diondublin21.workers.dev";
const $=id=>document.getElementById(id);
const fmtPct=v=>v==null?"—":((v>=0?"+":"")+Number(v).toFixed(2)+"%");
const cls=v=>v==null?"":(v>=0?"pos":"neg");
function stateClass(s){return String(s||"").replaceAll(" ","")}
const fmtNum=v=>v==null?"—":Number(v).toLocaleString("es-ES",{maximumSignificantDigits:7});
const yesNo=v=>v==null?"—":(v?"Sí":"No");
function tech(t){
  if(!t) return '<span class="muted">Sin confirmación profunda</span>';
  return [
    'EMA20 '+fmtNum(t.ema20),
    'EMA50 '+fmtNum(t.ema50),
    'P/EMA20 '+fmtPct(t.priceVsEma20Pct),
    'P/EMA50 '+fmtPct(t.priceVsEma50Pct),
    'EMA20>50 '+yesNo(t.ema20AboveEma50),
    'RSI '+(t.rsi14??'—'),
    'ADX '+(t.adx14??'—'),
    'ST '+(t.supertrendUp?'↑':'↓'),
    'Cloud '+(t.aboveCloud?'↑':'↓')
  ].join('<br>');
}
function render(d){
  $("unique").textContent=d.coverage?.uniqueAssets??"—";
  $("eligible").textContent=d.coverage?.liquidEligibleAssets??"—";
  $("buyCount").textContent=d.statusCounts?.BUY??0;
  $("nearCount").textContent=d.statusCounts?.["NEAR BUY"]??0;
  $("watchCount").textContent=d.statusCounts?.WATCH??0;
  $("stamp").textContent="Último análisis: "+new Date(d.generatedAt).toLocaleString("es-ES")+" · "+(d.elapsedSeconds??"—")+" s";
  const rows=(d.ranking||[]).map(x=>`<tr>
    <td>${x.rank}</td>
    <td class="timestamp">${new Date(x.displayDataAt||d.generatedAt).toLocaleString("es-ES",{hour12:false})}</td>
    <td><div class="asset">${x.asset}</div><div>${x.pair}</div></td>
    <td>${x.availableVenues?.join(" · ")||x.venue}</td>
    <td><span class="state ${stateClass(x.state)}">${x.state}</span></td>
    <td><strong>${x.score}</strong></td>
    <td class="${cls(x.change1hPct)}">${fmtPct(x.change1hPct)}</td>
    <td class="${cls(x.change4hPct)}">${fmtPct(x.change4hPct)}</td>
    <td class="${cls(x.change24hPct)}">${fmtPct(x.change24hPct)}</td>
    <td class="tech">${tech(x.technical?.["4h"])}${x.technicalVenue?'<br><span class="muted">Fuente: '+x.technicalVenue+'</span>':''}</td>
    <td class="tech">${tech(x.technical?.["1d"])}${x.technicalPair?'<br><span class="muted">'+x.technicalPair+'</span>':''}</td>
    <td class="tech">Vol accel ${x.volumeAcceleration==null?"—":Number(x.volumeAcceleration).toFixed(2)+"x"}<br>24h turn ${fmtNum(x.turnover24hUsdApprox)}<br>No-chase ${x.noChase?"Sí":"No"}</td>
    <td class="reason">${[...(x.reasons||[]),...(x.penalties||[]).slice(0,2)].slice(0,5).join(" · ")}</td>
  </tr>`).join("");
  $("rows").innerHTML=rows||'<tr><td colspan="13" class="empty">No hubo suficientes activos con análisis técnico profundo.</td></tr>';
}
async function deepCandidate(c){
  const r=await fetch(WORKER_BASE+"/deep",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(c),cache:"no-store"});
  const d=await r.json();
  if(!r.ok||d.ok===false) throw new Error(d.error||("HTTP "+r.status));
  return d.result;
}
async function deepPool(candidates,limit=3){
  const out=[]; let next=0;
  async function worker(){
    while(true){
      const i=next++; if(i>=candidates.length)return;
      try{ out.push(await deepCandidate(candidates[i])); }catch{}
    }
  }
  await Promise.all(Array.from({length:Math.min(limit,candidates.length)},()=>worker()));
  return out;
}

async function scan(){
  $("scanBtn").disabled=true;$("progress").classList.remove("hidden");$("progressText").textContent="Escaneando Coinbase y KuCoin y preparando candidatos…";
  try{
    const r=await fetch(WORKER_BASE+"/scan",{cache:"no-store"}); const base=await r.json();
    if(!r.ok||base.ok===false) throw new Error(base.error||("HTTP "+r.status));
    $("progressText").textContent="Calculando EMA, RSI, ADX, Supertrend e Ichimoku candidato por candidato…";
    const deep=await deepPool(base.candidates||[],3);
    deep.sort((a,b)=>b.score-a.score);
    const ranking=deep.slice(0,20);
    ranking.forEach((x,i)=>x.rank=i+1);
    const d={
      generatedAt:new Date().toISOString(),
      elapsedSeconds:base.elapsedSeconds,
      coverage:{...base.coverage,deepCandidatesAnalyzed:deep.length,topN:ranking.length},
      statusCounts:{BUY:ranking.filter(x=>x.state==="BUY").length,"NEAR BUY":ranking.filter(x=>x.state==="NEAR BUY").length,WATCH:ranking.filter(x=>x.state==="WATCH").length},
      ranking
    };
    render(d);
  }catch(e){
    $("rows").innerHTML='<tr><td colspan="13" class="empty">Error de análisis: '+String(e.message||e)+'</td></tr>';
    $("stamp").textContent="El análisis no se completó. Vuelve a intentarlo.";
  }finally{
    $("scanBtn").disabled=false;$("progress").classList.add("hidden");
  }
}
$("scanBtn").addEventListener("click",scan);