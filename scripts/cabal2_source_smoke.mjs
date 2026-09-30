const results={};

async function probeCoinbase(){
  const r=await fetch("https://api.coinbase.com/api/v3/brokerage/market/products?limit=1000&product_type=SPOT",{headers:{"User-Agent":"CABAL2-SourceSmoke/0.1"}});
  if(!r.ok) throw new Error("HTTP "+r.status);
  const j=await r.json();
  const rows=(j.products||[]).filter(x=>{
    const id=String(x.product_id||"");
    const p=id.split("-");
    return p.length===2 && ["USD","USDC","USDT"].includes(String(x.quote_currency_id||p[1]).toUpperCase()) && x.trading_disabled!==true && x.is_disabled!==true;
  });
  if(rows.length<20) throw new Error("unexpectedly small product universe: "+rows.length);
  return rows.length;
}

async function probeKuCoin(){
  const r=await fetch("https://api.kucoin.com/api/v1/market/allTickers");
  if(!r.ok) throw new Error("HTTP "+r.status);
  const j=await r.json();
  const rows=(((j.data||{}).ticker)||[]).filter(x=>String(x.symbol||"").endsWith("-USDT")||String(x.symbol||"").endsWith("-USDC"));
  if(rows.length<50) throw new Error("unexpectedly small ticker universe: "+rows.length);
  return rows.length;
}

for (const [name,fn] of [["coinbase",probeCoinbase],["kucoin",probeKuCoin]]) {
  try { results[name]={status:"PASS",count:await fn()}; }
  catch(e) { results[name]={status:"FAIL",error:String(e&&e.message||e)}; }
}

console.log("CABAL 2.0 SOURCE SMOKE",JSON.stringify(results));
if(results.coinbase.status!=="PASS" || results.kucoin.status!=="PASS") process.exit(1);
