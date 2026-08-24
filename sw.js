const CACHE='crypto-reca-app-v0.5.2';
const STATIC=['./','./index.html','./styles.css','./features-v04.css','./news-v04.css','./trend-v04.css','./architecture-v04.css','./ui-consistency-v04.css','./app.js','./radar-time.js','./features-v04.js','./live-indicators-v04.js','./trend-v04.js','./position-risk-v04.js','./news-v04.js','./ers-display-v04.js','./module-loader-v04.js','./risk-dashboard-fix-v04.js','./decision-v04.js','./risk-tools-v04.js','./research-v04.js','./ui-consistency-v04.js','./opportunity-alert-v1.js?v=0.5.2','./manifest.webmanifest','./icons/icon-192.png','./icons/icon-512.png'];
self.addEventListener('install',event=>{event.waitUntil(caches.open(CACHE).then(c=>c.addAll(STATIC)).then(()=>self.skipWaiting()));});
self.addEventListener('activate',event=>{event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim()));});
async function networkFirst(req,cacheKey=req){
  try{
    const resp=await fetch(req,{cache:'no-store'});
    if(resp&&resp.ok){const copy=resp.clone();const c=await caches.open(CACHE);await c.put(cacheKey,copy);}
    return resp;
  }catch(err){
    const cached=await caches.match(cacheKey);
    if(cached)return cached;
    throw err;
  }
}
self.addEventListener('fetch',event=>{
  const req=event.request;if(req.method!=='GET')return;const url=new URL(req.url);if(url.origin!==self.location.origin)return;
  if(url.pathname.includes('/data/')&&url.pathname.endsWith('.json')){
    const canonical=url.origin+url.pathname;
    event.respondWith(networkFirst(req,canonical));
    return;
  }
  if(req.mode==='navigate'){
    event.respondWith((async()=>{
      try{
        const resp=await fetch(req,{cache:'no-store'});
        if(resp&&resp.ok){const copy=resp.clone();const c=await caches.open(CACHE);await c.put('./index.html',copy);}
        return resp;
      }catch(err){
        const cached=await caches.match('./index.html');
        if(cached)return cached;
        throw err;
      }
    })());
    return;
  }
  if(/\.(?:js|css)$/.test(url.pathname)||url.pathname.endsWith('/manifest.webmanifest')){
    event.respondWith(networkFirst(req));
    return;
  }
  event.respondWith(caches.match(req).then(cached=>cached||fetch(req).then(resp=>{if(resp&&resp.ok){const copy=resp.clone();caches.open(CACHE).then(c=>c.put(req,copy));}return resp;})));
});
