const WORKER="https://senda-scanner.diondublin21.workers.dev/scan";
const $=id=>document.getElementById(id);
const fmtPct=v=>v==null?"—":((v>=0?"+":"")+Number(v).toFixed(2)+"%");
const cls=v=>v==null?"":(v>=0?"pos":"neg");
function stateClass(s){return String(s||"").replaceAll(" ","")}
function render(d){
  $("unique").textContent=d.coverage?.uniqueAssets??"—";
  $("eligible").textContent=d.coverage?.liquidEligibleAssets??"—";
  $("buyCount").textContent=d.statusCounts?.BUY??0;
  $("nearCount").textContent=d.statusCounts?.["NEAR BUY"]??0;
  $("watchCount").textContent=d.statusCounts?.WATCH??0;
  $("stamp").textContent="Último análisis: "+new Date(d.generatedAt).toLocaleString("es-ES")+" · "+(d.elapsedSeconds??"—")+" s";
  const rows=(d.ranking||[]).map(x=>`<tr>
    <td>${x.rank}</td>
    <td><div class="asset">${x.asset}</div><div>${x.pair}</div></td>
    <td>${x.availableVenues?.join(" · ")||x.venue}</td>
    <td><span class="state ${stateClass(x.state)}">${x.state}</span></td>
    <td><strong>${x.score}</strong></td>
    <td class="${cls(x.change1hPct)}">${fmtPct(x.change1hPct)}</td>
    <td class="${cls(x.change4hPct)}">${fmtPct(x.change4hPct)}</td>
    <td class="${cls(x.change24hPct)}">${fmtPct(x.change24hPct)}</td>
    <td class="reason">${[...(x.reasons||[]),...(x.penalties||[]).slice(0,1)].slice(0,3).join(" · ")}</td>
  </tr>`).join("");
  $("rows").innerHTML=rows||'<tr><td colspan="9" class="empty">No se pudo construir el ranking.</td></tr>';
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