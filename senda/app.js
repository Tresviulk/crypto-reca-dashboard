const WORKER="https://senda-scanner.diondublin21.workers.dev/scan";
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
  const displayAt=new Date().toLocaleString("es-ES",{hour12:false});
  const rows=(d.ranking||[]).map(x=>`<tr>
    <td>${x.rank}</td>
    <td class="timestamp">${displayAt}</td>
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
    <td class="reason">${x.analysisDepth==="BROAD_FALLBACK"?"Datos técnicos profundos no disponibles en esta ejecución · "+((x.penalties||[])[0]||""):([...(x.reasons||[]),...(x.penalties||[]).slice(0,2)].slice(0,5).join(" · "))}</td>
  </tr>`).join("");
  $("rows").innerHTML=rows||'<tr><td colspan="13" class="empty">No se pudo construir el ranking.</td></tr>';
}
async function scan(){
  $("scanBtn").disabled=true;$("progress").classList.remove("hidden");$("progressText").textContent="Descubriendo Coinbase y KuCoin, filtrando liquidez y analizando 4H + diario…";
  try{
    const r=await fetch(WORKER,{cache:"no-store"}); const d=await r.json();
    if(!r.ok||d.ok===false) throw new Error(d.error||("HTTP "+r.status));
    render(d);
  }catch(e){
    $("rows").innerHTML='<tr><td colspan="9" class="empty">Error de análisis: '+String(e.message||e)+'</td></tr>';
    $("stamp").textContent="El análisis no se completó. Vuelve a intentarlo.";
  }finally{
    $("scanBtn").disabled=false;$("progress").classList.add("hidden");
  }
}
$("scanBtn").addEventListener("click",scan);