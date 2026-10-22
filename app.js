'use strict';
const $ = s => document.querySelector(s);
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const allowMark = s => esc(s).replace(/&lt;mark&gt;/g, '<mark>').replace(/&lt;\/mark&gt;/g, '</mark>');
const fmtDate = s => new Date(s + 'T00:00:00Z').toLocaleDateString('ar-EG-u-nu-latn', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' });
const LEVELS = ['A1', 'A2', 'B1', 'B2'];
const LEVEL_NAME = { A1: 'مبتدئ', A2: 'أساسي', B1: 'متوسط', B2: 'فوق المتوسط' };

const MSG = {
  invalid_credentials: 'البريد الإلكتروني أو كلمة المرور غير صحيحة.',
  email_taken: 'هذا البريد الإلكتروني مسجّل مسبقًا.',
  email_invalid: 'البريد الإلكتروني غير صالح.',
  password_short: 'يجب ألّا تقل كلمة المرور عن 8 أحرف.',
  name_required: 'الرجاء إدخال الاسم.',
  too_many_requests: 'عدد المحاولات كبير. يرجى الانتظار قليلًا ثم المحاولة مجددًا.',
  default: 'حدث خطأ غير متوقع. يرجى المحاولة لاحقًا.'
};
const errMsg = e => MSG[e && e.message] || MSG.default;

/* المعاملان day وkey للمعاينة من لوحة التحكم فقط */
const qs = new URLSearchParams(location.search);
const extra = qs.get('day') ? 'day=' + encodeURIComponent(qs.get('day')) : '';
async function api(path, opts = {}) {
  const url = '/api' + path + (extra ? (path.includes('?') ? '&' : '?') + extra : '');
  const r = await fetch(url, opts);
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(data.error || 'error'), { status: r.status, data });
  return data;
}
const post = (path, body) => api(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });

function speak(t) {
  if (!('speechSynthesis' in window)) return;
  const u = new SpeechSynthesisUtterance(t); u.lang = 'en-US'; u.rate = .9;
  speechSynthesis.cancel(); speechSynthesis.speak(u);
}
const go = h => { if (location.hash === h) render(); else location.hash = h; };

let INFO = null, LIST = [], filter = { level: 'all', q: '' }, quiz = {};
const loadInfo = async () => { INFO = await api('/site'); };

function renderNav() {
  const u = INFO.user;
  $('#nav').innerHTML = `
    <a href="#/" data-r="home">الرئيسية</a>
    <a href="#/lessons" data-r="lessons">الدروس</a>
    <a href="#/about" data-r="about">عن الموقع</a>
    ${u ? '<a href="#" data-act="logout" role="button">تسجيل الخروج</a>'
        : '<a href="#/login" data-r="login">تسجيل الدخول</a>'}`;
}

/* ---------- العروض ---------- */
function lessonCard(l) {
  return `<a class="lesson-item" href="#/lesson/${esc(l.id)}">
    <span class="en t">${esc(l.title)}</span>
    <h3>${esc(l.titleAr || '')}</h3>
    <p class="muted" style="margin-bottom:6px">${esc(l.summary || '')}</p>
    <div class="meta"><span class="badge">اليوم ${l.n}</span><span class="badge">${esc(l.level)}</span>
    ${l.done ? `<span class="badge done">مكتمل ${l.done.score}/${l.done.total}</span>` : ''}</div>
  </a>`;
}

async function viewHome() {
  const S = INFO.site;
  if (!INFO.user) {
    return `<section class="hero"><h1>${esc(S.tagline)}</h1><p>${esc(S.intro)}</p>
      <ul class="points">
        <li>درس جديد يُفتح لك كل يوم تلقائيًا.</li>
        <li>أمثلة مترجمة مع نطق صوتي للكلمات والجمل.</li>
        <li>اختبار قصير بعد كل درس لقياس تقدّمك.</li>
      </ul>
      <div class="actions-row"><a class="btn" href="#/register">أنشئ حسابك وابدأ</a>
      <a class="btn ghost" href="#/login">تسجيل الدخول</a></div></section>`;
  }
  const { lessons: list } = await api('/lessons');
  const today = list[0];
  return `<section class="hero"><h1>${esc(S.tagline)}</h1>
      <p>مرحبًا بك، ${esc(INFO.user.name)}.</p></section>
    ${today ? `<h2>درس اليوم</h2>${lessonCard(today)}
      <a class="btn" href="#/lesson/${esc(today.id)}">ابدأ الدرس</a>
      <p class="muted" style="margin-top:14px">${INFO.hasMore ? 'عُد غدًا لتجد درسًا جديدًا في انتظارك.' : 'لقد وصلت إلى آخر درس متاح حاليًا. ستُضاف دروس جديدة قريبًا.'}</p>
      ${list.length > 1 ? `<h2>الدروس السابقة</h2>${list.slice(1, 4).map(lessonCard).join('')}
        ${list.length > 4 ? '<a class="btn ghost" href="#/lessons">جميع الدروس</a>' : ''}` : ''}`
    : '<div class="empty">ستبدأ الدروس قريبًا.</div>'}`;
}

async function viewLessons() {
  LIST = (await api('/lessons')).lessons;
  return `<h1>الدروس</h1>
    <input type="search" id="search" placeholder="ابحث عن درس…" aria-label="بحث" value="${esc(filter.q)}">
    <div class="levels" id="levels">
      <button class="chip" data-l="all" aria-pressed="${filter.level === 'all'}">الكل</button>
      ${LEVELS.map(l => `<button class="chip" data-l="${l}" aria-pressed="${filter.level === l}">${l} · ${LEVEL_NAME[l]}</button>`).join('')}
    </div><div id="results"></div>`;
}
function drawResults() {
  const q = filter.q.trim().toLowerCase();
  const r = LIST.filter(l => (filter.level === 'all' || l.level === filter.level) &&
    (!q || ((l.title || '') + (l.titleAr || '') + (l.summary || '')).toLowerCase().includes(q)));
  $('#results').innerHTML = r.length ? r.map(lessonCard).join('') : '<div class="empty">لا توجد دروس مطابقة لبحثك.</div>';
}

function renderSection(s) {
  const h = s.title ? `<h2>${esc(s.title)}</h2>` : '';
  if (s.type === 'text') return h + (s.body || []).map(p => `<p>${allowMark(p)}</p>`).join('');
  if (s.type === 'examples') return h + (s.items || []).map(i => `<div class="example">
      <button class="say" data-say="${esc(i.en)}" aria-label="استمع إلى النطق">🔊</button>
      <div class="txt"><span class="en">${esc(i.en)}</span><span class="ar">${esc(i.ar)}</span></div></div>`).join('');
  if (s.type === 'vocab') return h + `<table>${(s.items || []).map(i => `<tr>
      <td><span class="en">${esc(i.en)}</span> <button class="say" style="width:30px;height:30px;font-size:13px;margin-inline-start:6px" data-say="${esc(i.en)}" aria-label="استمع إلى النطق">🔊</button></td>
      <td>${esc(i.ar)}</td></tr>`).join('')}</table>`;
  if (s.type === 'tip') return `<div class="tip"><strong>ملاحظة: </strong>${allowMark(s.body || '')}</div>`;
  return '';
}

async function viewLesson(id) {
  const back = '<p><a class="back" href="#/lessons">← العودة إلى الدروس</a></p>';
  let l;
  try { l = await api('/lessons/' + encodeURIComponent(id)); }
  catch (e) {
    if (e.status === 403) return `<div class="empty">لم يُفتح هذا الدرس بعد. سيتوفر بتاريخ ${fmtDate(e.data.unlockDate)}.</div>${back}`;
    if (e.status === 404) return `<div class="empty">هذا الدرس غير موجود.</div>${back}`;
    throw e;
  }
  quiz = { id: l.id, answered: 0, correct: 0, total: l.quiz.length };
  document.title = `${l.title} — ${INFO.site.name}`;
  return `<a class="back" href="#/lessons">← جميع الدروس</a>
    <div class="meta"><span class="badge">اليوم ${l.n}</span><span class="badge">${esc(l.level)} · ${LEVEL_NAME[l.level] || ''}</span><span>${fmtDate(l.unlockDate)}</span></div>
    <h1 class="lesson-title">${esc(l.title)}</h1>
    <p class="muted" style="font-size:19px">${esc(l.titleAr || '')}</p>
    ${l.sections.map(renderSection).join('')}
    ${l.quiz.length ? `<h2>اختبر نفسك</h2>
      ${l.quiz.map((q, qi) => `<div class="q" data-qi="${qi}">
        <span class="en qt">${esc(q.q)}</span>
        ${q.options.map((o, oi) => `<button class="opt" data-oi="${oi}">${esc(o)}</button>`).join('')}
      </div>`).join('')}
      <div class="score" id="score" aria-live="polite"></div>` : ''}
    <div style="display:flex;justify-content:space-between;gap:10px;margin-top:28px;flex-wrap:wrap">
      ${l.prevId ? `<a class="btn ghost" href="#/lesson/${esc(l.prevId)}">← الدرس السابق</a>` : '<span></span>'}
      ${l.nextId ? `<a class="btn ghost" href="#/lesson/${esc(l.nextId)}">الدرس التالي →</a>` : ''}
    </div>`;
}

function viewAbout() {
  const S = INFO.site;
  return `<h1>عن الموقع</h1>${S.about.map(p => `<p>${esc(p)}</p>`).join('')}
    <h2>تواصل معنا</h2><p>${esc(S.contact)}</p>`;
}

function viewLogin() {
  return `<div class="auth"><h1>تسجيل الدخول</h1>
    <form id="login-form">
      <div class="field"><label for="email">البريد الإلكتروني</label>
        <input id="email" type="email" class="ltr" autocomplete="email" required></div>
      <div class="field"><label for="pw">كلمة المرور</label>
        <input id="pw" type="password" autocomplete="current-password" required></div>
      <p class="error" id="form-error" role="alert"></p>
      <button class="btn" type="submit">دخول</button>
    </form>
    <p class="muted" style="margin-top:18px">ليس لديك حساب؟ <a href="#/register">أنشئ حسابًا جديدًا</a></p></div>`;
}
function viewRegister() {
  return `<div class="auth"><h1>إنشاء حساب</h1>
    <form id="register-form">
      <div class="field"><label for="name">الاسم</label>
        <input id="name" type="text" autocomplete="name" maxlength="60" required></div>
      <div class="field"><label for="email">البريد الإلكتروني</label>
        <input id="email" type="email" class="ltr" autocomplete="email" required></div>
      <div class="field"><label for="pw">كلمة المرور</label>
        <input id="pw" type="password" autocomplete="new-password" minlength="8" required>
        <div class="hint">8 أحرف على الأقل.</div></div>
      <p class="error" id="form-error" role="alert"></p>
      <button class="btn" type="submit">إنشاء الحساب</button>
    </form>
    <p class="muted" style="margin-top:18px">لديك حساب بالفعل؟ <a href="#/login">سجّل الدخول</a></p></div>`;
}
function viewAuthRequired() {
  return `<div class="auth"><h1>الدروس للمسجّلين</h1>
    <p class="muted">يلزم تسجيل الدخول لعرض الدروس ومتابعة تقدّمك.</p>
    <div class="actions-row"><a class="btn" href="#/login">تسجيل الدخول</a>
    <a class="btn ghost" href="#/register">إنشاء حساب</a></div></div>`;
}

/* ---------- التوجيه ---------- */
let renderId = 0;
async function render() {
  const my = ++renderId;
  const [route, arg] = location.hash.replace(/^#\/?/, '').split('/');
  const r = route || 'home';
  document.title = INFO.site.name;
  renderNav();
  document.querySelectorAll('#nav a').forEach(a => a.classList.toggle('on', a.dataset.r === (r === 'lesson' ? 'lessons' : r)));
  $('#app').innerHTML = '<p class="muted">جارٍ التحميل…</p>';
  let html;
  try {
    if ((r === 'login' || r === 'register') && INFO.user) { go('#/'); return; }
    if ((r === 'lessons' || r === 'lesson') && !INFO.user && INFO.day === null) html = viewAuthRequired();
    else if (r === 'lessons') html = await viewLessons();
    else if (r === 'lesson') html = await viewLesson(decodeURIComponent(arg || ''));
    else if (r === 'about') html = viewAbout();
    else if (r === 'login') html = viewLogin();
    else if (r === 'register') html = viewRegister();
    else html = await viewHome();
  } catch (e) {
    if (e.status === 401) { await loadInfo(); renderNav(); html = viewAuthRequired(); }
    else html = '<div class="empty">حدث خطأ أثناء التحميل. يرجى المحاولة لاحقًا.</div>';
  }
  if (my !== renderId) return;
  $('#app').innerHTML = html;
  if (r === 'lessons' && $('#results')) drawResults();
  window.scrollTo(0, 0);
}

/* ---------- الأحداث ---------- */
document.addEventListener('click', async e => {
  const say = e.target.closest('[data-say]'); if (say) return speak(say.dataset.say);
  const act = e.target.closest('[data-act="logout"]');
  if (act) {
    e.preventDefault();
    try { await post('/logout'); } catch (err) { /* تجاهل */ }
    await loadInfo(); go('#/'); return;
  }
  const chip = e.target.closest('[data-l]');
  if (chip) {
    filter.level = chip.dataset.l;
    document.querySelectorAll('#levels .chip').forEach(c => c.setAttribute('aria-pressed', c === chip));
    return drawResults();
  }
  const opt = e.target.closest('.opt');
  if (opt && !opt.disabled) {
    const qEl = opt.closest('.q'), qi = +qEl.dataset.qi, choice = +opt.dataset.oi;
    qEl.querySelectorAll('.opt').forEach(b => b.disabled = true);
    try {
      const r = await post('/lessons/' + encodeURIComponent(quiz.id) + '/check', { qi, choice });
      const btns = qEl.querySelectorAll('.opt');
      btns[r.answer].classList.add('right');
      if (!r.correct) btns[choice].classList.add('wrong');
      quiz.answered++; if (r.correct) quiz.correct++;
      if (quiz.answered === quiz.total) {
        $('#score').textContent = `النتيجة: ${quiz.correct} من ${quiz.total}`;
        post('/lessons/' + encodeURIComponent(quiz.id) + '/progress', { score: quiz.correct }).catch(() => {});
      }
    } catch (err) { qEl.querySelectorAll('.opt').forEach(b => b.disabled = false); }
  }
});
document.addEventListener('input', e => { if (e.target.id === 'search') { filter.q = e.target.value; drawResults(); } });
document.addEventListener('submit', async e => {
  const f = e.target;
  if (f.id !== 'login-form' && f.id !== 'register-form') return;
  e.preventDefault();
  const btn = f.querySelector('button[type=submit]'); btn.disabled = true;
  const body = { email: f.email.value, password: f.pw.value };
  if (f.id === 'register-form') body.name = f.name.value;
  try {
    await post(f.id === 'login-form' ? '/login' : '/register', body);
    await loadInfo(); go('#/');
  } catch (err) {
    $('#form-error').textContent = errMsg(err); btn.disabled = false;
  }
});
window.addEventListener('hashchange', render);

(async () => {
  try { await loadInfo(); }
  catch (e) { $('#app').innerHTML = '<div class="empty">تعذّر الاتصال بالخادم. يرجى المحاولة لاحقًا.</div>'; return; }
  $('#brand').innerHTML = `<span class="en">${esc(INFO.site.name)}</span>`;
  $('#foot').textContent = `© ${new Date().getFullYear()} ${INFO.site.author}. جميع الحقوق محفوظة.`;
  render();
})();
