/*
 * خادم موقع تعلّم الإنجليزية — بلا أي مكتبات خارجية (يتطلب Node 18 أو أحدث).
 * - الحسابات: بريد وكلمة مرور (مشفّرة بـ scrypt) وجلسات موقّعة.
 * - الدروس: ملفات JSON داخل مجلد lessons/ ولا تُرسل إلا حين يحين يومها.
 * - لوحة التحكم: /admin محمية بكلمة مرور المدير.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { promisify } = require('util');
const scrypt = promisify(crypto.scrypt);

const ROOT = __dirname;
// المشروع مسطّح: كل الملفات في مجلد واحد. نسمح فقط بهذه الملفات للعموم.
const PUBLIC = ROOT;
const PUBLIC_FILES = new Set(['index.html', 'app.js', 'admin.html', 'admin.js', 'style.css']);
// STORAGE_DIR: مجلد التخزين الدائم (القرص الدائم في الاستضافة). إن لم يُضبط نستخدم مجلد المشروع.
const STORAGE = process.env.STORAGE_DIR ? path.resolve(process.env.STORAGE_DIR) : ROOT;
const LESSON_DIR = path.join(STORAGE, 'lessons');
const DATA_DIR = path.join(STORAGE, 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const CFG = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
const TZ = CFG.timezone || 'Africa/Casablanca';
const MODE = (CFG.schedule && CFG.schedule.mode) || 'visitor';
const LEVELS = ['A1', 'A2', 'B1', 'B2'];

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(LESSON_DIR, { recursive: true });
// أول تشغيل (أو بعد مسح القرص): ننسخ الدروس المرفقة (ملفات مثل 001-greetings.json) إلى مجلد الدروس
if (!fs.readdirSync(LESSON_DIR).some(f => f.endsWith('.json'))) {
  fs.readdirSync(ROOT).filter(f => /^\d{3}-.+\.json$/.test(f))
    .forEach(f => fs.copyFileSync(path.join(ROOT, f), path.join(LESSON_DIR, f)));
}

/* ---------- السر الذي يوقّع الجلسات ---------- */
function loadSecret() {
  if (process.env.SECRET) return process.env.SECRET;
  const f = path.join(DATA_DIR, 'secret.txt');
  if (!fs.existsSync(f)) fs.writeFileSync(f, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
  return fs.readFileSync(f, 'utf8').trim();
}
const SECRET = loadSecret();
if (!process.env.SECRET) console.warn('تنبيه: يُفضّل ضبط المتغير SECRET في الاستضافة لضمان بقاء الجلسات صالحة.');
if (!ADMIN_PASSWORD) console.warn('تنبيه: لوحة التحكم معطّلة. اضبط المتغير ADMIN_PASSWORD لتفعيلها.');

/* ---------- التواريخ ---------- */
const dateFmt = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
const todayStr = () => dateFmt.format(new Date());
const dayNum = s => { const [y, m, d] = s.split('-').map(Number); return Date.UTC(y, m - 1, d) / 86400000; };
const addDays = (s, k) => new Date((dayNum(s) + k) * 86400000).toISOString().slice(0, 10);

/* ---------- التوقيع والكوكيز ---------- */
const sign = v => crypto.createHmac('sha256', SECRET).update(v).digest('hex').slice(0, 32);
function safeEq(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
function parseCookies(req) {
  const o = {};
  (req.headers.cookie || '').split(';').forEach(p => {
    const i = p.indexOf('='); if (i > 0) o[p.slice(0, i).trim()] = p.slice(i + 1).trim();
  });
  return o;
}
function setCookie(req, res, name, value, maxAge) {
  const secure = (req.socket.encrypted || req.headers['x-forwarded-proto'] === 'https') ? '; Secure' : '';
  res.setHeader('Set-Cookie', `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`);
}

/* ---------- المستخدمون ---------- */
let users = [];
try { users = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8')).users || []; } catch (e) { users = []; }
function writeAtomic(file, text) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}
const saveUsers = () => writeAtomic(USERS_FILE, JSON.stringify({ users }, null, 1));
const hashPw = async (pw, salt) => (await scrypt(pw, salt, 64)).toString('hex');

function authUser(req) {
  const c = parseCookies(req).sid; if (!c) return null;
  const [uid, exp, sig] = c.split('.');
  if (!uid || !exp || !sig || !(+exp > Date.now() / 1000)) return null;
  if (!safeEq(sig, sign(`u:${uid}.${exp}`))) return null;
  return users.find(u => u.id === uid) || null;
}
function issueSession(req, res, user) {
  const exp = Math.floor(Date.now() / 1000) + 30 * 86400;
  setCookie(req, res, 'sid', `${user.id}.${exp}.${sign(`u:${user.id}.${exp}`)}`, 30 * 86400);
}
function isAdmin(req) {
  if (!ADMIN_PASSWORD) return false;
  const c = parseCookies(req).adm; if (!c) return false;
  const [exp, sig] = c.split('.');
  return !!exp && !!sig && +exp > Date.now() / 1000 && safeEq(sig, sign(`a:${exp}`));
}

/* ---------- الدروس ---------- */
const prefixNum = f => { const m = f.match(/^(\d+)/); return m ? parseInt(m[1], 10) : Infinity; };
function loadLessons() {
  let files = [];
  try { files = fs.readdirSync(LESSON_DIR).filter(f => f.endsWith('.json')); } catch (e) { return []; }
  files.sort((a, b) => { const x = prefixNum(a), y = prefixNum(b); return x === y ? a.localeCompare(b) : (x < y ? -1 : 1); });
  const out = [], seen = new Set();
  for (const f of files) {
    try {
      const l = JSON.parse(fs.readFileSync(path.join(LESSON_DIR, f), 'utf8'));
      l.id = String(l.id || f.replace(/\.json$/, '').replace(/^\d+[-_]?/, '')).toLowerCase();
      if (!/^[a-z0-9-]+$/.test(l.id) || seen.has(l.id)) { console.warn('معرّف غير صالح أو مكرر في الملف:', f); continue; }
      seen.add(l.id); l.file = f; out.push(l);
    } catch (e) { console.warn('ملف به خطأ وتم تجاهله:', f, e.message); }
  }
  out.forEach((l, i) => { l.n = i + 1; });
  return out;
}
const slugify = t => t.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50) || 'lesson';

/* تنظيف وفحص محتوى الدرس القادم من لوحة التحكم */
const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
function cleanLesson(b) {
  if (!b || typeof b !== 'object') return { error: 'invalid' };
  const title = str(b.title, 120), titleAr = str(b.titleAr, 120), summary = str(b.summary, 300);
  if (!title) return { error: 'title_required' };
  if (!LEVELS.includes(b.level)) return { error: 'level_invalid' };
  const pairs = a => (Array.isArray(a) ? a : []).slice(0, 100)
    .map(i => ({ en: str(i && i.en, 300), ar: str(i && i.ar, 300) })).filter(i => i.en);
  const sections = [];
  for (const s of (Array.isArray(b.sections) ? b.sections : []).slice(0, 40)) {
    if (!s || typeof s !== 'object') continue;
    if (s.type === 'text') {
      const body = (Array.isArray(s.body) ? s.body : [s.body]).map(x => str(x, 4000)).filter(Boolean);
      if (body.length) sections.push({ type: 'text', title: str(s.title, 120), body });
    } else if (s.type === 'examples' || s.type === 'vocab') {
      const items = pairs(s.items);
      if (items.length) sections.push({ type: s.type, title: str(s.title, 120), items });
    } else if (s.type === 'tip') {
      const body = str(s.body, 1000);
      if (body) sections.push({ type: 'tip', body });
    }
  }
  const quiz = [];
  for (const q of (Array.isArray(b.quiz) ? b.quiz : []).slice(0, 30)) {
    const text = str(q && q.q, 300);
    const options = (Array.isArray(q && q.options) ? q.options : []).slice(0, 6).map(o => str(o, 200));
    if (!text || options.length < 2 || options.some(o => !o) || !Number.isInteger(q.answer) || q.answer < 0 || q.answer >= options.length)
      return { error: 'quiz_invalid' };
    quiz.push({ q: text, options, answer: q.answer });
  }
  return { lesson: { title, titleAr, level: b.level, summary, sections, quiz } };
}

/* ---------- حماية من الإغراق ---------- */
const clientIp = req => ((process.env.TRUST_PROXY && req.headers['x-forwarded-for']) || '').split(',')[0].trim() || req.socket.remoteAddress;
function makeLimiter(max, windowMs) {
  const hits = new Map();
  setInterval(() => { const n = Date.now(); for (const [k, v] of hits) if (n > v.reset) hits.delete(k); }, 60000).unref();
  return req => {
    const ip = clientIp(req), now = Date.now(); let h = hits.get(ip);
    if (!h || now > h.reset) { h = { count: 0, reset: now + windowMs }; hits.set(ip, h); }
    return ++h.count > max;
  };
}
const generalLimited = makeLimiter(240, 60000);
const authLimited = makeLimiter(20, 15 * 60000);
const adminLimited = makeLimiter(10, 15 * 60000);

/* ---------- أدوات الرد ---------- */
const SEC = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'same-origin',
  'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; script-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'"
};
function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...SEC });
  res.end(JSON.stringify(obj));
}
function readBody(req, max = 4096) {
  return new Promise((resolve, reject) => {
    let b = '';
    req.on('data', c => { b += c; if (b.length > max) { reject(new Error('big')); req.destroy(); } });
    req.on('end', () => resolve(b));
    req.on('error', reject);
  });
}
async function readJson(req, max) { try { return JSON.parse(await readBody(req, max)); } catch (e) { return null; } }
const sameOrigin = req => { const o = req.headers.origin; if (!o) return true; try { return new URL(o).host === req.headers.host; } catch (e) { return false; } };
const lessonInfo = l => ({ id: l.id, n: l.n, title: l.title, titleAr: l.titleAr, level: l.level, summary: l.summary });

/* ---------- واجهة المدير ---------- */
async function adminApi(req, res, url) {
  const p = url.pathname, method = req.method;
  if (!ADMIN_PASSWORD) return json(res, 503, { error: 'admin_disabled' });

  if (method === 'POST' && p === '/api/admin/login') {
    if (adminLimited(req)) return json(res, 429, { error: 'too_many_requests' });
    const b = await readJson(req);
    if (!b || typeof b.password !== 'string' || !safeEq(sign('p:' + b.password), sign('p:' + ADMIN_PASSWORD)))
      return json(res, 401, { error: 'wrong_password' });
    const exp = Math.floor(Date.now() / 1000) + 8 * 3600;
    setCookie(req, res, 'adm', `${exp}.${sign('a:' + exp)}`, 8 * 3600);
    return json(res, 200, { ok: true });
  }
  if (method === 'POST' && p === '/api/admin/logout') {
    setCookie(req, res, 'adm', '', 0);
    return json(res, 200, { ok: true });
  }
  if (!isAdmin(req)) return json(res, 401, { error: 'admin_required' });

  if (method === 'GET' && p === '/api/admin/session') return json(res, 200, { ok: true });

  if (method === 'GET' && p === '/api/admin/lessons') {
    return json(res, 200, { lessons: loadLessons().map(l => ({ id: l.id, n: l.n, title: l.title, titleAr: l.titleAr, level: l.level })) });
  }
  if (method === 'POST' && p === '/api/admin/lessons') {
    const { lesson, error } = cleanLesson(await readJson(req, 300000));
    if (error) return json(res, 400, { error });
    const existing = loadLessons();
    const base = slugify(lesson.title); let id = base, k = 2;
    while (existing.some(l => l.id === id)) id = `${base}-${k++}`;
    const maxPrefix = Math.max(0, ...fs.readdirSync(LESSON_DIR).map(prefixNum).filter(Number.isFinite));
    const file = `${String(maxPrefix + 1).padStart(3, '0')}-${id}.json`;
    writeAtomic(path.join(LESSON_DIR, file), JSON.stringify(lesson, null, 2));
    return json(res, 201, { id });
  }
  if (method === 'POST' && p === '/api/admin/reorder') {
    const b = await readJson(req, 20000);
    const lessons = loadLessons();
    const ids = b && Array.isArray(b.ids) ? b.ids : null;
    if (!ids || ids.length !== lessons.length || new Set(ids).size !== ids.length || !ids.every(i => lessons.some(l => l.id === i)))
      return json(res, 400, { error: 'invalid' });
    const moves = ids.map((id, i) => {
      const l = lessons.find(x => x.id === id);
      return { from: l.file, to: `${String(i + 1).padStart(3, '0')}-${id}.json` };
    });
    moves.forEach((m, i) => fs.renameSync(path.join(LESSON_DIR, m.from), path.join(LESSON_DIR, `.tmp-${i}`)));
    moves.forEach((m, i) => fs.renameSync(path.join(LESSON_DIR, `.tmp-${i}`), path.join(LESSON_DIR, m.to)));
    return json(res, 200, { ok: true });
  }
  let m = p.match(/^\/api\/admin\/lessons\/([a-z0-9-]+)$/);
  if (m) {
    const l = loadLessons().find(x => x.id === m[1]);
    if (!l) return json(res, 404, { error: 'not_found' });
    if (method === 'GET') {
      const { file, ...rest } = l;
      return json(res, 200, rest);
    }
    if (method === 'PUT') {
      const { lesson, error } = cleanLesson(await readJson(req, 300000));
      if (error) return json(res, 400, { error });
      writeAtomic(path.join(LESSON_DIR, l.file), JSON.stringify(lesson, null, 2));
      return json(res, 200, { ok: true });
    }
    if (method === 'DELETE') {
      fs.unlinkSync(path.join(LESSON_DIR, l.file));
      return json(res, 200, { ok: true });
    }
  }
  if (method === 'GET' && p === '/api/admin/users') {
    return json(res, 200, { users: users.map(u => ({ id: u.id, name: u.name, email: u.email, start: u.start, created: u.created, done: Object.keys(u.done || {}).length })) });
  }
  m = p.match(/^\/api\/admin\/users\/([a-f0-9-]+)$/);
  if (method === 'DELETE' && m) {
    const before = users.length;
    users = users.filter(u => u.id !== m[1]);
    if (users.length === before) return json(res, 404, { error: 'not_found' });
    saveUsers();
    return json(res, 200, { ok: true });
  }
  return json(res, 404, { error: 'not_found' });
}

/* ---------- واجهة الزوار ---------- */
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/;
async function api(req, res, url) {
  if (generalLimited(req)) return json(res, 429, { error: 'too_many_requests' });
  const p = url.pathname, method = req.method;
  if (method !== 'GET' && !sameOrigin(req)) return json(res, 403, { error: 'forbidden' });
  if (p.startsWith('/api/admin/')) return adminApi(req, res, url);

  /* --- الحسابات --- */
  if (method === 'POST' && (p === '/api/register' || p === '/api/login')) {
    if (authLimited(req)) return json(res, 429, { error: 'too_many_requests' });
    const b = await readJson(req);
    if (!b) return json(res, 400, { error: 'invalid' });
    const email = str(b.email, 254).toLowerCase(), password = typeof b.password === 'string' ? b.password : '';
    if (p === '/api/register') {
      const name = str(b.name, 60);
      if (!name) return json(res, 400, { error: 'name_required' });
      if (!EMAIL_RE.test(email)) return json(res, 400, { error: 'email_invalid' });
      if (password.length < 8 || password.length > 200) return json(res, 400, { error: 'password_short' });
      if (users.some(u => u.email === email)) return json(res, 409, { error: 'email_taken' });
      const salt = crypto.randomBytes(16).toString('hex');
      const user = { id: crypto.randomUUID(), name, email, salt, hash: await hashPw(password, salt), start: todayStr(), created: new Date().toISOString(), done: {} };
      users.push(user); saveUsers();
      issueSession(req, res, user);
      return json(res, 201, { ok: true });
    }
    const user = users.find(u => u.email === email);
    const salt = user ? user.salt : 'x'.repeat(32);
    const hash = await hashPw(password.slice(0, 200), salt);
    if (!user || !safeEq(hash, user.hash)) return json(res, 401, { error: 'invalid_credentials' });
    issueSession(req, res, user);
    return json(res, 200, { ok: true });
  }
  if (method === 'POST' && p === '/api/logout') {
    setCookie(req, res, 'sid', '', 0);
    return json(res, 200, { ok: true });
  }

  const user = authUser(req), admin = isAdmin(req);
  const lessons = loadLessons();
  const start = MODE === 'calendar' ? CFG.schedule.startDate : (user ? user.start : todayStr());
  let day = dayNum(todayStr()) - dayNum(start) + 1;
  const qd = url.searchParams.get('day');
  if (admin && qd && /^\d{1,4}$/.test(qd)) day = +qd;            // معاينة للمدير فقط

  if (method === 'GET' && p === '/api/site') {
    const signedIn = !!(user || admin);
    return json(res, 200, {
      site: CFG.site,
      user: user ? { name: user.name, email: user.email } : null,
      day: signedIn ? day : null,
      hasMore: signedIn ? lessons.length > day : null
    });
  }

  /* --- ما بعد هذا يتطلب تسجيل الدخول --- */
  if (!user && !admin) return json(res, 401, { error: 'auth_required' });

  if (method === 'GET' && p === '/api/lessons') {
    const list = lessons.filter(l => l.n <= day).reverse().map(l => ({
      ...lessonInfo(l), unlockDate: addDays(start, l.n - 1), done: (user && user.done && user.done[l.id]) || null
    }));
    return json(res, 200, { day, lessons: list });
  }
  let m = p.match(/^\/api\/lessons\/([a-z0-9-]+)$/);
  if (method === 'GET' && m) {
    const l = lessons.find(x => x.id === m[1]);
    if (!l) return json(res, 404, { error: 'not_found' });
    if (l.n > day) return json(res, 403, { error: 'locked', daysLeft: l.n - day, unlockDate: addDays(start, l.n - 1) });
    const prev = lessons[l.n - 2], next = l.n < day ? lessons[l.n] : null;
    return json(res, 200, {
      ...lessonInfo(l),
      unlockDate: addDays(start, l.n - 1),
      sections: l.sections || [],
      quiz: (l.quiz || []).map(q => ({ q: q.q, options: q.options })),   // الإجابات لا تغادر الخادم
      prevId: prev ? prev.id : null,
      nextId: next ? next.id : null
    });
  }
  m = p.match(/^\/api\/lessons\/([a-z0-9-]+)\/(check|progress)$/);
  if (method === 'POST' && m) {
    const l = lessons.find(x => x.id === m[1]);
    if (!l) return json(res, 404, { error: 'not_found' });
    if (l.n > day) return json(res, 403, { error: 'locked' });
    const body = await readJson(req);
    if (!body) return json(res, 400, { error: 'invalid' });
    if (m[2] === 'check') {
      const q = (l.quiz || [])[body.qi];
      if (!q || !Number.isInteger(body.choice)) return json(res, 400, { error: 'invalid' });
      return json(res, 200, { correct: body.choice === q.answer, answer: q.answer });
    }
    const total = (l.quiz || []).length;
    if (user && Number.isInteger(body.score) && body.score >= 0 && body.score <= total && total > 0) {
      user.done = user.done || {};
      const prev = user.done[l.id];
      if (!prev || body.score > prev.score) { user.done[l.id] = { score: body.score, total }; saveUsers(); }
    }
    return json(res, 200, { ok: true });
  }
  return json(res, 404, { error: 'not_found' });
}

/* ---------- الملفات العامة ---------- */
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8' };
function serveStatic(req, res, url) {
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405, SEC); return res.end(); }
  let rel;
  try { rel = decodeURIComponent(url.pathname); } catch (e) { res.writeHead(400, SEC); return res.end(); }
  if (rel === '/') rel = '/index.html';
  if (rel === '/admin' || rel === '/admin/') rel = '/admin.html';
  const name = rel.replace(/^\//, '');
  if (!PUBLIC_FILES.has(name)) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', ...SEC }); return res.end('404'); }
  const file = path.join(PUBLIC, name);
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', ...SEC }); return res.end('404'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache', ...SEC });
    res.end(req.method === 'HEAD' ? undefined : data);
  });
}

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname.startsWith('/api/')) {
    api(req, res, url).catch(e => { console.error(e); if (!res.headersSent) json(res, 500, { error: 'server_error' }); });
  } else serveStatic(req, res, url);
}).listen(PORT, () => console.log(`الموقع يعمل على http://localhost:${PORT}  (نمط الجدولة: ${MODE})`));
