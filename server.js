/**
 * ══════════════════════════════════════════════
 *  سيرفر نظام إدارة المطاعم v2.1
 *  يدعم: PostgreSQL (Railway) + JSON Files (محلي)
 * ══════════════════════════════════════════════
 */
const http   = require('http');
const fs     = require('fs');
const path   = require('path');
const url    = require('url');
const crypto = require('crypto');

const PORT     = process.env.PORT     || 5000;
const DEV_PASS = process.env.DEV_PASS || 'dev@muqtada2025';
const DB_URL   = process.env.DATABASE_URL; // يُعطى تلقائياً من Railway PostgreSQL

/* ══ مجلد ملفات محلي (fallback) ══ */
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DB_FILE   = path.join(DATA_DIR, 'licenses.json');
const ORD_FILE  = path.join(DATA_DIR, 'orders.json');
const REST_FILE = path.join(DATA_DIR, 'restaurants.json');
if(!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR,{recursive:true});
[[DB_FILE,'[]'],[ORD_FILE,'[]'],[REST_FILE,'{}']].forEach(([f,def])=>{
  if(!fs.existsSync(f)) fs.writeFileSync(f,def,'utf8');
});

/* ══ قاعدة البيانات (PostgreSQL أو JSON) ══ */
let pg = null;
let pool = null;

async function initDB(){
  if(!DB_URL){ console.log('📁 وضع JSON Files'); return; }
  try{
    pg = require('pg');
    pool = new pg.Pool({
      connectionString: DB_URL,
      ssl: { rejectUnauthorized: false }
    });
    // إنشاء جدول KV بسيط
    await pool.query(`
      CREATE TABLE IF NOT EXISTS kv_store (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    // إدخال قيم افتراضية
    await pool.query(`
      INSERT INTO kv_store(key,value) VALUES
        ('licenses','[]'),('orders','[]'),('restaurants','{}')
      ON CONFLICT(key) DO NOTHING
    `);
    console.log('🐘 PostgreSQL متصل');
  }catch(e){
    console.error('PostgreSQL خطأ:', e.message);
    pool = null;
  }
}

async function kvGet(key){
  if(pool){
    const r = await pool.query('SELECT value FROM kv_store WHERE key=$1',[key]);
    return r.rows[0] ? JSON.parse(r.rows[0].value) : (key==='restaurants'?{}:[]);
  }
  const f = key==='licenses'?DB_FILE:key==='orders'?ORD_FILE:REST_FILE;
  try{ return JSON.parse(fs.readFileSync(f,'utf8')); }catch{ return key==='restaurants'?{}:[]; }
}

async function kvSet(key, val){
  if(pool){
    await pool.query(
      'INSERT INTO kv_store(key,value,updated_at) VALUES($1,$2,NOW()) ON CONFLICT(key) DO UPDATE SET value=$2,updated_at=NOW()',
      [key, JSON.stringify(val)]
    );
    return;
  }
  const f = key==='licenses'?DB_FILE:key==='orders'?ORD_FILE:REST_FILE;
  fs.writeFileSync(f, JSON.stringify(val,null,2), 'utf8');
}

/* shortcuts */
const readDB    = ()       => kvGet('licenses');
const writeDB   = d        => kvSet('licenses', d);
const readOrds  = ()       => kvGet('orders');
const writeOrds = d        => kvSet('orders', d);
const readRests = ()       => kvGet('restaurants');
const writeRests= d        => kvSet('restaurants', d);

/* ══ مساعدات ══ */
function genKey(){
  const c='ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const s=()=>Array.from({length:4},()=>c[Math.floor(Math.random()*c.length)]).join('');
  return `${s()}-${s()}-${s()}-${s()}`;
}
function genId(){ return Date.now().toString(36)+Math.random().toString(36).slice(2,6).toUpperCase(); }
function calcExpiry(type,from){
  const map={daily:1,monthly:30,'2months':60,'3months':90,'6months':180,yearly:365};
  const d=from?new Date(from):new Date();
  d.setDate(d.getDate()+(map[type]||30));
  return d.toISOString();
}
function hashPw(pw){ return crypto.createHash('sha256').update(pw+'altaei_salt').digest('hex'); }

/* ══ جلسات الأدمن ══ */
const sessions={};
function newSession(rid,username){
  const token=crypto.randomBytes(32).toString('hex');
  sessions[token]={rid,username,exp:Date.now()+8*3600*1000};
  return token;
}
function checkSession(req){
  const token=req.headers['x-admin-token'];
  if(!token) return null;
  const s=sessions[token];
  if(!s||Date.now()>s.exp) return null;
  s.exp=Date.now()+8*3600*1000;
  return s;
}

function ensureRestData(data){
  return {
    name:         data.name         || '',
    logo:         data.logo         || null,
    colors:       data.colors       || {primary:'#8B0000',secondary:'#c9953a',bg:'#0d0101'},
    address:      data.address      || '',
    mapsUrl:      data.mapsUrl      || '',
    whatsapp:     data.whatsapp     || '',
    acceptOrders: data.acceptOrders !== false,
    categories:   Array.isArray(data.categories)?data.categories:[],
    products:     Array.isArray(data.products)?data.products:[],
    tables:       Array.isArray(data.tables)?data.tables:[]
  };
}

/* ══ CORS + JSON ══ */
function cors(res){
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Methods','GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type,X-Dev-Pass,X-Admin-Token');
  res.setHeader('Cache-Control','no-store,no-cache,must-revalidate');
  res.setHeader('Pragma','no-cache');
}
function json(res,code,data){ cors(res); res.writeHead(code,{'Content-Type':'application/json;charset=utf-8'}); res.end(JSON.stringify(data)); }
function body(req){ return new Promise(r=>{ let d=''; req.on('data',c=>{d+=c;if(d.length>15e6)d='{}'}); req.on('end',()=>{try{r(JSON.parse(d))}catch{r({})}}); }); }

/* ══════════════ ROUTES ══════════════ */
const routes = {

  /* ─ عام: حالة المطعم ─ */
  'GET /api/status': async(req,res,q)=>{
    const rid=(q.rid||'').toLowerCase().trim();
    if(!rid) return json(res,400,{ok:false,msg:'rid مطلوب'});
    const db=await readDB(), now=new Date();
    const rec=db.find(r=>r.rid===rid&&!r.disabled&&new Date(r.expiry)>now);
    if(rec) return json(res,200,{ok:true,open:true,daysLeft:Math.ceil((new Date(rec.expiry)-now)/864e5),client:rec.client});
    const ex=db.find(r=>r.rid===rid);
    if(ex?.disabled) return json(res,200,{ok:true,open:false,msg:'الموقع موقوف'});
    if(ex) return json(res,200,{ok:true,open:false,msg:'انتهى الاشتراك'});
    return json(res,200,{ok:true,open:false,msg:'غير مسجّل'});
  },

  /* ─ عام: بيانات المنيو ─ */
  'GET /api/restaurant': async(req,res,q)=>{
    const rid=(q.rid||'').toLowerCase().trim();
    if(!rid) return json(res,400,{ok:false,msg:'rid مطلوب'});
    const rests=await readRests();
    const data=rests[rid]||{};
    json(res,200,{ok:true,data:ensureRestData(data)});
  },

  /* ─ عام: إرسال طلب ─ */
  'POST /api/order': async(req,res)=>{
    const b=await body(req);
    if(!b.rid||!b.items?.length) return json(res,400,{ok:false,msg:'بيانات ناقصة'});
    const rests=await readRests();
    if(rests[b.rid]?.acceptOrders===false) return json(res,200,{ok:false,msg:'لا يستقبل طلبات حالياً'});
    const order={id:'ORD-'+genId(),rid:b.rid,table:b.table||'',phone:b.phone||'',name:b.name||'',
      items:b.items,total:b.total||0,status:'pending',notes:b.notes||'',
      date:new Date().toISOString(),dateLocal:new Date().toLocaleString('ar-IQ')};
    const ords=await readOrds(); ords.push(order); await writeOrds(ords);
    json(res,200,{ok:true,orderId:order.id});
  },

  /* ─ عام: تتبع طلب ─ */
  'GET /api/order/track': async(req,res,q)=>{
    if(!q.id) return json(res,400,{ok:false,msg:'id مطلوب'});
    const order=(await readOrds()).find(o=>o.id===q.id);
    if(!order) return json(res,404,{ok:false,msg:'غير موجود'});
    json(res,200,{ok:true,id:order.id,status:order.status,date:order.date,total:order.total,items:order.items,table:order.table,rid:order.rid});
  },

  /* ─ أدمن: دخول ─ */
  'POST /api/admin/login': async(req,res)=>{
    const b=await body(req);
    const db=await readDB();
    const rec=db.find(r=>r.username===b.username?.toLowerCase()?.trim());
    if(!rec) return json(res,401,{ok:false,msg:'اسم المستخدم غير موجود'});
    if(rec.disabled) return json(res,403,{ok:false,msg:'الحساب موقوف'});
    if(new Date(rec.expiry)<new Date()) return json(res,403,{ok:false,msg:'انتهى الاشتراك'});
    if(rec.passwordHash!==hashPw(b.password)) return json(res,401,{ok:false,msg:'كلمة المرور غير صحيحة'});
    const rests=await readRests();
    if(!rests[rec.rid]){ rests[rec.rid]={name:rec.client,logo:null,colors:{primary:'#8B0000',secondary:'#c9953a',bg:'#0d0101'},whatsapp:'',address:'',mapsUrl:'',acceptOrders:true,categories:[],products:[],tables:[]}; await writeRests(rests); }
    const token=newSession(rec.rid,rec.username);
    json(res,200,{ok:true,token,rid:rec.rid,username:rec.username,client:rec.client,daysLeft:Math.ceil((new Date(rec.expiry)-new Date())/864e5)});
  },

  /* ─ أدمن: تغيير كلمة المرور ─ */
  'POST /api/admin/change-password': async(req,res)=>{
    const sess=checkSession(req); if(!sess) return json(res,401,{ok:false,msg:'غير مصرّح'});
    const b=await body(req);
    if(!b.newPassword||b.newPassword.length<6) return json(res,400,{ok:false,msg:'كلمة المرور قصيرة'});
    const db=await readDB(); const idx=db.findIndex(r=>r.username===sess.username);
    if(idx<0) return json(res,404,{ok:false,msg:'غير موجود'});
    db[idx].passwordHash=hashPw(b.newPassword); await writeDB(db);
    json(res,200,{ok:true});
  },

  /* ─ أدمن: تحديث المطعم ─ */
  'POST /api/admin/restaurant': async(req,res)=>{
    const sess=checkSession(req); if(!sess) return json(res,401,{ok:false,msg:'غير مصرّح'});
    const b=await body(req);
    const rests=await readRests();
    const rest=rests[sess.rid]||{categories:[],products:[],tables:[]};
    ['name','logo','whatsapp','address','mapsUrl','acceptOrders'].forEach(k=>{ if(b[k]!==undefined) rest[k]=b[k]; });
    if(b.colors) rest.colors={...rest.colors,...b.colors};
    rests[sess.rid]=rest; await writeRests(rests);
    json(res,200,{ok:true});
  },

  /* ─ أدمن: الفئات ─ */
  'POST /api/admin/categories/add': async(req,res)=>{
    const sess=checkSession(req); if(!sess) return json(res,401,{ok:false,msg:'غير مصرّح'});
    const b=await body(req); if(!b.name) return json(res,400,{ok:false,msg:'الاسم مطلوب'});
    const rests=await readRests(); const rest=rests[sess.rid]||{categories:[],products:[],tables:[]};
    const cat={id:genId(),name:b.name,order:b.order??rest.categories?.length??0};
    rest.categories=[...(rest.categories||[]),cat]; rests[sess.rid]=rest; await writeRests(rests);
    json(res,200,{ok:true,cat});
  },
  'POST /api/admin/categories/update': async(req,res)=>{
    const sess=checkSession(req); if(!sess) return json(res,401,{ok:false,msg:'غير مصرّح'});
    const b=await body(req);
    const rests=await readRests(); const rest=rests[sess.rid]||{};
    const idx=(rest.categories||[]).findIndex(c=>c.id===b.id); if(idx<0) return json(res,404,{ok:false,msg:'غير موجود'});
    if(b.name!==undefined) rest.categories[idx].name=b.name;
    if(b.order!==undefined) rest.categories[idx].order=b.order;
    rests[sess.rid]=rest; await writeRests(rests); json(res,200,{ok:true});
  },
  'POST /api/admin/categories/delete': async(req,res)=>{
    const sess=checkSession(req); if(!sess) return json(res,401,{ok:false,msg:'غير مصرّح'});
    const b=await body(req);
    const rests=await readRests(); const rest=rests[sess.rid]||{};
    rest.categories=(rest.categories||[]).filter(c=>c.id!==b.id);
    rests[sess.rid]=rest; await writeRests(rests); json(res,200,{ok:true});
  },

  /* ─ أدمن: المنتجات ─ */
  'POST /api/admin/products/add': async(req,res)=>{
    const sess=checkSession(req); if(!sess) return json(res,401,{ok:false,msg:'غير مصرّح'});
    const b=await body(req); if(!b.name||!b.catId) return json(res,400,{ok:false,msg:'الاسم والفئة مطلوبان'});
    const rests=await readRests(); const rest=rests[sess.rid]||{products:[]};
    const prod={id:genId(),name:b.name,catId:b.catId,price:Number(b.price)||0,desc:b.desc||'',image:b.image||null,available:b.available!==false,badge:b.badge||''};
    rest.products=[...(rest.products||[]),prod]; rests[sess.rid]=rest; await writeRests(rests);
    json(res,200,{ok:true,prod});
  },
  'POST /api/admin/products/update': async(req,res)=>{
    const sess=checkSession(req); if(!sess) return json(res,401,{ok:false,msg:'غير مصرّح'});
    const b=await body(req);
    const rests=await readRests(); const rest=rests[sess.rid]||{};
    const idx=(rest.products||[]).findIndex(p=>p.id===b.id); if(idx<0) return json(res,404,{ok:false,msg:'غير موجود'});
    ['name','catId','price','desc','image','available','badge'].forEach(k=>{ if(b[k]!==undefined) rest.products[idx][k]=k==='price'?Number(b[k]):b[k]; });
    rests[sess.rid]=rest; await writeRests(rests); json(res,200,{ok:true});
  },
  'POST /api/admin/products/delete': async(req,res)=>{
    const sess=checkSession(req); if(!sess) return json(res,401,{ok:false,msg:'غير مصرّح'});
    const b=await body(req);
    const rests=await readRests(); const rest=rests[sess.rid]||{};
    rest.products=(rest.products||[]).filter(p=>p.id!==b.id);
    rests[sess.rid]=rest; await writeRests(rests); json(res,200,{ok:true});
  },

  /* ─ أدمن: الطاولات ─ */
  'POST /api/admin/tables/add': async(req,res)=>{
    const sess=checkSession(req); if(!sess) return json(res,401,{ok:false,msg:'غير مصرّح'});
    const b=await body(req); if(!b.name) return json(res,400,{ok:false,msg:'الاسم مطلوب'});
    const rests=await readRests(); const rest=rests[sess.rid]||{tables:[]};
    const table={id:genId(),name:b.name,createdAt:new Date().toISOString()};
    rest.tables=[...(rest.tables||[]),table]; rests[sess.rid]=rest; await writeRests(rests);
    json(res,200,{ok:true,table});
  },
  'POST /api/admin/tables/delete': async(req,res)=>{
    const sess=checkSession(req); if(!sess) return json(res,401,{ok:false,msg:'غير مصرّح'});
    const b=await body(req);
    const rests=await readRests(); const rest=rests[sess.rid]||{};
    rest.tables=(rest.tables||[]).filter(t=>t.id!==b.id);
    rests[sess.rid]=rest; await writeRests(rests); json(res,200,{ok:true});
  },

  /* ─ أدمن: الطلبات ─ */
  'GET /api/admin/orders': async(req,res,q)=>{
    const sess=checkSession(req); if(!sess) return json(res,401,{ok:false,msg:'غير مصرّح'});
    let orders=(await readOrds()).filter(o=>o.rid===sess.rid);
    if(q.status) orders=orders.filter(o=>o.status===q.status);
    if(q.from) orders=orders.filter(o=>o.date>=q.from);
    if(q.to) orders=orders.filter(o=>o.date<=q.to+'T23:59:59');
    const now=new Date(), today=now.toISOString().slice(0,10);
    const todayOrds=orders.filter(o=>o.date.startsWith(today));
    json(res,200,{ok:true,data:orders.slice().reverse(),
      stats:{total:orders.length,today:todayOrds.length,
        revenue:orders.reduce((s,o)=>s+(o.total||0),0),
        todayRevenue:todayOrds.reduce((s,o)=>s+(o.total||0),0),
        pending:orders.filter(o=>o.status==='pending').length,
        preparing:orders.filter(o=>o.status==='preparing').length}});
  },
  'POST /api/admin/orders/status': async(req,res)=>{
    const sess=checkSession(req); if(!sess) return json(res,401,{ok:false,msg:'غير مصرّح'});
    const b=await body(req);
    const ords=await readOrds(); const idx=ords.findIndex(o=>o.id===b.id&&o.rid===sess.rid);
    if(idx<0) return json(res,404,{ok:false,msg:'غير موجود'});
    ords[idx].status=b.status; await writeOrds(ords); json(res,200,{ok:true});
  },
  'POST /api/admin/orders/delete': async(req,res)=>{
    const sess=checkSession(req); if(!sess) return json(res,401,{ok:false,msg:'غير مصرّح'});
    const b=await body(req);
    await writeOrds((await readOrds()).filter(o=>!(o.id===b.id&&o.rid===sess.rid)));
    json(res,200,{ok:true});
  },
  'GET /api/admin/orders/new-count': async(req,res,q)=>{
    const sess=checkSession(req); if(!sess) return json(res,401,{ok:false,msg:'غير مصرّح'});
    const since=q.since||new Date(Date.now()-60000).toISOString();
    const count=(await readOrds()).filter(o=>o.rid===sess.rid&&o.status==='pending'&&o.date>since).length;
    json(res,200,{ok:true,count});
  },

  /* ══ المطوّر ══ */
  'GET /api/stats': async(req,res,q,auth)=>{
    if(!auth) return json(res,401,{ok:false,msg:'غير مصرّح'});
    const db=await readDB(), now=new Date();
    const active=db.filter(r=>!r.disabled&&new Date(r.expiry)>now).length;
    const expiring=db.filter(r=>!r.disabled&&new Date(r.expiry)>now&&Math.ceil((new Date(r.expiry)-now)/864e5)<=7).length;
    json(res,200,{ok:true,total:db.length,active,expiring,disabled:db.filter(r=>r.disabled).length,expired:db.filter(r=>!r.disabled&&new Date(r.expiry)<=now).length,storage:pool?'PostgreSQL':'JSON Files'});
  },
  'GET /api/licenses': async(req,res,q,auth)=>{
    if(!auth) return json(res,401,{ok:false,msg:'غير مصرّح'});
    json(res,200,{ok:true,data:(await readDB()).map(r=>({...r,passwordHash:undefined}))});
  },
  'POST /api/generate': async(req,res,q,auth)=>{
    if(!auth) return json(res,401,{ok:false,msg:'غير مصرّح'});
    const b=await body(req);
    if(!b.client||!b.rid||!b.username||!b.password) return json(res,400,{ok:false,msg:'client,rid,username,password مطلوبة'});
    const db=await readDB();
    if(db.find(r=>r.rid===b.rid.toLowerCase())) return json(res,400,{ok:false,msg:'المعرّف مستخدم'});
    if(db.find(r=>r.username===b.username.toLowerCase())) return json(res,400,{ok:false,msg:'اسم المستخدم مستخدم'});
    const rec={key:genKey(),rid:b.rid.toLowerCase().trim(),client:b.client,username:b.username.toLowerCase().trim(),passwordHash:hashPw(b.password),phone:b.phone||'',type:b.type||'monthly',note:b.note||'',expiry:calcExpiry(b.type||'monthly'),created:new Date().toISOString(),disabled:false};
    db.push(rec); await writeDB(db);
    const rests=await readRests();
    if(!rests[rec.rid]){rests[rec.rid]={name:rec.client,logo:null,colors:{primary:'#8B0000',secondary:'#c9953a',bg:'#0d0101'},whatsapp:'',address:'',mapsUrl:'',acceptOrders:true,categories:[],products:[],tables:[]};await writeRests(rests);}
    json(res,200,{ok:true,rec:{...rec,passwordHash:undefined}});
  },
  'POST /api/toggle': async(req,res,q,auth)=>{
    if(!auth) return json(res,401,{ok:false,msg:'غير مصرّح'});
    const b=await body(req); const db=await readDB();
    const rec=db.find(r=>r.rid===b.rid); if(!rec) return json(res,404,{ok:false,msg:'غير موجود'});
    rec.disabled=!rec.disabled; await writeDB(db);
    json(res,200,{ok:true,disabled:rec.disabled,client:rec.client});
  },
  'POST /api/renew': async(req,res,q,auth)=>{
    if(!auth) return json(res,401,{ok:false,msg:'غير مصرّح'});
    const b=await body(req); const db=await readDB();
    const rec=db.find(r=>r.rid===b.rid); if(!rec) return json(res,404,{ok:false,msg:'غير موجود'});
    const type=b.type||rec.type;
    rec.type=type; rec.expiry=calcExpiry(type,new Date(rec.expiry)>new Date()?rec.expiry:null);
    rec.disabled=false; await writeDB(db);
    json(res,200,{ok:true,rec:{...rec,passwordHash:undefined}});
  },
  'POST /api/delete-license': async(req,res,q,auth)=>{
    if(!auth) return json(res,401,{ok:false,msg:'غير مصرّح'});
    const b=await body(req);
    await writeDB((await readDB()).filter(r=>r.rid!==b.rid));
    json(res,200,{ok:true});
  },
  'GET /api/backup': async(req,res,q,auth)=>{
    if(!auth) return json(res,401,{ok:false,msg:'غير مصرّح'});
    const backup={version:2,exportedAt:new Date().toISOString(),storage:pool?'PostgreSQL':'Files',licenses:await readDB(),orders:await readOrds(),restaurants:await readRests()};
    cors(res);
    res.writeHead(200,{'Content-Type':'application/json;charset=utf-8','Content-Disposition':`attachment;filename="altaei-backup-${Date.now()}.json"`});
    res.end(JSON.stringify(backup,null,2));
  },
  'POST /api/restore': async(req,res,q,auth)=>{
    if(!auth) return json(res,401,{ok:false,msg:'غير مصرّح'});
    const b=await body(req);
    if(!b.licenses) return json(res,400,{ok:false,msg:'ملف غير صالح'});
    if(Array.isArray(b.licenses)) await writeDB(b.licenses);
    if(Array.isArray(b.orders)) await writeOrds(b.orders);
    if(b.restaurants&&typeof b.restaurants==='object') await writeRests(b.restaurants);
    json(res,200,{ok:true,restored:{licenses:(b.licenses||[]).length,orders:(b.orders||[]).length,restaurants:Object.keys(b.restaurants||{}).length}});
  },
};

/* ══ HTTP Server ══ */
http.createServer(async(req,res)=>{
  if(req.method==='OPTIONS'){cors(res);res.writeHead(204);res.end();return;}
  const parsed=url.parse(req.url,true);
  const routeKey=`${req.method} ${parsed.pathname}`;
  const devAuth=req.headers['x-dev-pass']===DEV_PASS;
  const handler=routes[routeKey];
  if(handler){
    try{ await handler(req,res,parsed.query,devAuth); }
    catch(e){ console.error(routeKey,e.message); json(res,500,{ok:false,msg:'خطأ: '+e.message}); }
    return;
  }
  /* ملفات ثابتة */
  let fp=path.join(__dirname,parsed.pathname==='/'?'index.html':parsed.pathname.replace(/^\/+/,''));
  if(!fp.startsWith(__dirname)) return json(res,403,{ok:false,msg:'محظور'});
  if(!fs.existsSync(fp)) return json(res,404,{ok:false,msg:'غير موجود'});
  const ext=path.extname(fp);
  const mimes={'html':'text/html','js':'application/javascript','css':'text/css','json':'application/json','svg':'image/svg+xml','png':'image/png','jpg':'image/jpeg','ico':'image/x-icon','webmanifest':'application/manifest+json'};
  const mime=mimes[ext.slice(1)]||'text/plain';
  cors(res);
  res.writeHead(200,{'Content-Type':mime+';charset=utf-8','X-Content-Type-Options':'nosniff',
    ...(fp.endsWith('sw.js')?{'Cache-Control':'no-cache','Service-Worker-Allowed':'/'}:{})});
  fs.createReadStream(fp).pipe(res);
}).listen(PORT, async()=>{
  await initDB();
  console.log(`\n✅ السيرفر: http://localhost:${PORT}`);
  console.log(`🔑 المطوّر: ${DEV_PASS}`);
  console.log(`👔 الأدمن: http://localhost:${PORT}/admin.html\n`);
});
