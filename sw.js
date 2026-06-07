/* ══ Service Worker — مطعم الطائي v3 ══ */
const VER = 'altaei-v3';
const STATIC = ['/index.html', '/admin.html', '/manifest.json'];

/* تثبيت: كاش الملفات الثابتة فقط */
self.addEventListener('install', e=>{
  e.waitUntil(
    caches.open(VER)
      .then(c => c.addAll(STATIC).catch(()=>{}))
      .then(() => self.skipWaiting())
  );
});

/* تفعيل: احذف الكاش القديم */
self.addEventListener('activate', e=>{
  e.waitUntil(
    caches.keys()
      .then(ks => Promise.all(ks.filter(k=>k!==VER).map(k=>caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

/* طلب: منطق الاستجابة */
self.addEventListener('fetch', e=>{
  const url = new URL(e.request.url);

  /* ─ API: شبكة أولاً، وإذا فشلت أرجع فارغ ─ */
  if(url.pathname.startsWith('/api/')){
    e.respondWith(
      fetch(e.request)
        .then(res=>{
          /* كاش بيانات المطعم للاستخدام offline */
          if(res.ok && url.pathname==='/api/restaurant'){
            const clone=res.clone();
            caches.open(VER).then(c=>c.put(e.request, clone));
          }
          return res;
        })
        .catch(async ()=>{
          /* بدون نت: أرجع الكاش لو موجود */
          const cached = await caches.match(e.request);
          if(cached) return cached;
          /* وإلا أرجع استجابة offline آمنة */
          return new Response(
            JSON.stringify({ok:true, open:true, offline:true, data:{categories:[],products:[],tables:[]}}),
            {headers:{'Content-Type':'application/json'}}
          );
        })
    );
    return;
  }

  /* ─ ملفات: كاش أولاً للسرعة + تحديث خلفي ─ */
  e.respondWith(
    caches.match(e.request).then(cached=>{
      const fresh = fetch(e.request)
        .then(res=>{
          if(res && res.status===200){
            caches.open(VER).then(c=>c.put(e.request, res.clone()));
          }
          return res;
        })
        .catch(()=>null);
      return cached || fresh;
    })
  );
});
