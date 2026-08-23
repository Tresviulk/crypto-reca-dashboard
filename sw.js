const CACHE='crypto-reca-app-v0.4.5';
const STATIC=['./','./index.html','./styles.css','./features-v04.css','./news-v04.css','./trend-v04.css','./architecture-v04.css','./app.js','./radar-time.js','./features-v04.js','./live-indicators-v04.js','./trend-v04.js','./position-risk-v04.js','./news-v04.js','./module-loader-v04.js','./decision-v04.js','./risk-tools-v04.js','./research-v04.js','./manifest.webmanifest','./icons/icon-192.png','./icons/icon-512.png'];
self.addEventListener('install',event=>{event.waitUntil(caches.open(CACHE).then(c=>c.addAll(STATIC)).then(()=>self.skipWaiting()));});
self.addEventListener('activate',event=>{event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim()));});
self.addEventListener('fetch',event=>{
  const req=event.request;if(req.method!=='GET')return;const url=new URL(req.url);if(url.origin!==self.location.origin)return;
  if(url.pathname.includes('/data/')&&url.pathname.endsWith('.json')){
    event.respondWith(fetch(req,{cache:'no-store'}).then(resp=>{if(resp&&resp.ok){const copy=resp.clone();caches.open(CACHE).then(c=>c.put(req,copy));}return resp;}).catch(()=>caches.match(req)));
    return;
  }
  if(req.mode==='navigate'){
    event.respondWith(fetch(req).then(resp=>{const copy=resp.clone();caches.open(CACHE).then(c=>c.put('./index.html',copy));return resp;}).catch(()=>caches.match('./index.html')));return;
  }
  event.respondWith(caches.match(req).then(cached=>{const network=fetch(req).then(resp=>{if(resp&&resp.ok){const copy=resp.clone();caches.open(CACHE).then(c=>c.put(req,copy));}return resp;}).catch(()=>cached);return cached||network;}));
});
