'use strict';
const $ = s => document.querySelector(s);
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const allowMark = s => esc(s).replace(/&lt;mark&gt;/g, '<mark>').replace(/&lt;\/mark&gt;/g, '</mark>');
const LEVELS = ['A1', 'A2', 'B1', 'B2'];
const LEVEL_NAME = { A1: 'مبتدئ', A2: 'أساسي', B1: 'متوسط', B2: 'فوق المتوسط' };
const TYPE_NAME = { text: 'شرح', examples: 'أمثلة', vocab: 'مفردات', tip: 'ملاحظة' };
const ERR = {
  wrong_password: 'كلمة المرور غير صحيحة.',
  admin_disabled: 'لوحة التحكم غير مفعّلة. اضبط المتغير ADMIN_PASSWORD على الخادم ثم أعد تشغيله.',
  too_many_requests: 'عدد المحاولات كبير. يرجى الانتظار قليلًا.',
  title_required: 'العنوان بالإنجليزية مطلوب.',
  level_invalid: 'المستوى غير صالح.',
  quiz_invalid: 'يوجد خطأ في أسئلة الاختبار: تأكد من نص السؤال، ووجود خيارين على الأقل غير فارغين، وتحديد الإجابة الصحيحة.',
  admin_required: 'انتهت الجلسة. يرجى تسجيل الدخول من جديد.',
  default: 'حدث خطأ غير متوقع. حاول مرة أخرى.'
};
const errMsg = e => ERR[e && e.message] || ERR.default;

async function api(method, path, body) {
  const r = await fetch('/api' + path, {
    method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(d.error || 'error'), { status: r.status, data: d });
  return d;
}

let tab = 'lessons', L = null, editId = null, notice = null;

function setNotice(msg, bad) { notice = { msg, bad: !!bad }; }
const noticeHtml = () => { const n = notice; notice = null; return n ? `<div class="notice${n.bad ? ' bad' : ''}" role="status">${esc(n.msg)}</div>` : ''; };

/* ---------- الدخول ---------- */
function loginView(msg) {
  $('#nav').innerHTML = '';
  $('#app').innerHTML = `<div class="auth"><h1>دخول المدير</h1>
    <form id="admin-login">
      <div class="field"><label for="apw">كلمة مرور المدير</label>
        <input id="apw" type="password" autocomplete="current-password" required></div>
      <p class="error" role="alert">${esc(msg || '')}</p>
      <button class="btn" type="submit">دخول</button>
    </form></div>`;
}

/* ---------- قائمة الدروس والمستخدمين ---------- */
function drawNav() {
  $('#nav').innerHTML = `<a href="/" target="_blank" rel="noopener">عرض الموقع</a><a href="#" data-act="logout">تسجيل الخروج</a>`;
}
async function listView() {
  drawNav();
  const tabs = `<div class="levels">
    <button class="chip" data-act="tab" data-tab="lessons" aria-pressed="${tab === 'lessons'}">الدروس</button>
    <button class="chip" data-act="tab" data-tab="users" aria-pressed="${tab === 'users'}">المستخدمون</button></div>`;
  let body = '';
  if (tab === 'lessons') {
    const { lessons } = await api('GET', '/admin/lessons');
    body = `<div class="admin-bar"><h1 style="margin:0">الدروس (${lessons.length})</h1>
      <button class="btn" data-act="new" style="margin:0">+ درس جديد</button></div>
      <p class="muted">ترتيب الدروس هنا هو ترتيب أيام الفتح: الأول في اليوم الأول، والثاني في اليوم الثاني، وهكذا.</p>
      ${lessons.length ? lessons.map((l, i) => `<div class="row">
        <span class="badge">اليوم ${l.n}</span>
        <div class="grow"><strong class="ltr">${esc(l.title)}</strong><span class="muted">${esc(l.titleAr || '')} · ${esc(l.level)}</span></div>
        <div class="acts">
          <button class="btn ghost sm" data-act="up" data-id="${esc(l.id)}" ${i === 0 ? 'disabled' : ''} aria-label="تقديم">↑</button>
          <button class="btn ghost sm" data-act="down" data-id="${esc(l.id)}" ${i === lessons.length - 1 ? 'disabled' : ''} aria-label="تأخير">↓</button>
          <button class="btn sm" data-act="edit" data-id="${esc(l.id)}">تعديل</button>
          <button class="btn danger sm" data-act="delete" data-id="${esc(l.id)}">حذف</button>
        </div></div>`).join('') : '<div class="empty">لا توجد دروس بعد. أضف أول درس.</div>'}`;
  } else {
    const { users } = await api('GET', '/admin/users');
    body = `<h1>المستخدمون (${users.length})</h1>
      ${users.length ? users.map(u => `<div class="row">
        <div class="grow"><strong>${esc(u.name)}</strong><span class="muted ltr">${esc(u.email)}</span></div>
        <span class="muted">بدأ: ${esc(u.start)} · أكمل ${u.done} اختبار</span>
        <button class="btn danger sm" data-act="del-user" data-id="${esc(u.id)}">حذف</button></div>`).join('')
        : '<div class="empty">لا يوجد مستخدمون مسجّلون بعد.</div>'}`;
  }
  $('#app').innerHTML = noticeHtml() + tabs + body;
}

/* ---------- محرر الدرس ---------- */
const blankLesson = () => ({ title: '', titleAr: '', level: 'A1', summary: '', sections: [], quiz: [] });
function fromServer(d) {
  return {
    title: d.title || '', titleAr: d.titleAr || '', level: d.level, summary: d.summary || '',
    sections: (d.sections || []).map(s => s.type === 'text' ? { type: 'text', title: s.title || '', text: (s.body || []).join('\n\n') }
      : s.type === 'tip' ? { type: 'tip', text: s.body || '' }
      : { type: s.type, title: s.title || '', items: (s.items || []).map(i => ({ en: i.en, ar: i.ar })) }),
    quiz: (d.quiz || []).map(q => ({ q: q.q, options: [...q.options], answer: q.answer }))
  };
}
function toServer() {
  const sections = L.sections.map(s => s.type === 'text'
    ? { type: 'text', title: s.title, body: s.text.split(/\n\s*\n/).map(x => x.trim()).filter(Boolean) }
    : s.type === 'tip' ? { type: 'tip', body: s.text }
    : { type: s.type, title: s.title, items: s.items.filter(i => i.en.trim()) });
  const quiz = [];
  for (const q of L.quiz) {
    const kept = [];
    let newAnswer = -1;
    q.options.forEach((o, i) => { if (o.trim()) { if (i === q.answer) newAnswer = kept.length; kept.push(o.trim()); } });
    quiz.push({ q: q.q, options: kept, answer: newAnswer });
  }
  return { title: L.title, titleAr: L.titleAr, level: L.level, summary: L.summary, sections, quiz };
}

function sectionHtml(s, si) {
  const ctl = `<div class="acts">
    <button class="btn ghost sm" data-act="s-up" data-si="${si}" ${si === 0 ? 'disabled' : ''} aria-label="تقديم">↑</button>
    <button class="btn ghost sm" data-act="s-down" data-si="${si}" ${si === L.sections.length - 1 ? 'disabled' : ''} aria-label="تأخير">↓</button>
    <button class="btn danger sm" data-act="s-del" data-si="${si}">حذف</button></div>`;
  let inner = '';
  if (s.type === 'text') {
    inner = `<div class="field"><label>عنوان القسم (اختياري)</label><input type="text" data-path="sections.${si}.title" value="${esc(s.title)}"></div>
      <div class="field"><label>النص</label><textarea rows="5" data-path="sections.${si}.text">${esc(s.text)}</textarea>
      <div class="hint">افصل بين الفقرات بسطر فارغ. لإبراز كلمة اكتبها هكذا: &lt;mark&gt;word&lt;/mark&gt;</div></div>`;
  } else if (s.type === 'tip') {
    inner = `<div class="field"><label>نص الملاحظة</label><textarea rows="3" data-path="sections.${si}.text">${esc(s.text)}</textarea></div>`;
  } else {
    inner = `<div class="field"><label>عنوان القسم</label><input type="text" data-path="sections.${si}.title" value="${esc(s.title)}"></div>
      ${s.items.map((it, ii) => `<div class="pair">
        <input type="text" class="ltr" placeholder="English" aria-label="بالإنجليزية" data-path="sections.${si}.items.${ii}.en" value="${esc(it.en)}">
        <input type="text" placeholder="الترجمة العربية" aria-label="الترجمة" data-path="sections.${si}.items.${ii}.ar" value="${esc(it.ar)}">
        <button class="btn danger sm" data-act="i-del" data-si="${si}" data-ii="${ii}" aria-label="حذف الصف">×</button></div>`).join('')}
      <button class="btn ghost sm" data-act="i-add" data-si="${si}">+ إضافة ${s.type === 'vocab' ? 'كلمة' : 'مثال'}</button>`;
  }
  return `<div class="block"><div class="block-h"><span>${TYPE_NAME[s.type]}</span>${ctl}</div>${inner}</div>`;
}
function quizHtml(q, qi) {
  return `<div class="block"><div class="block-h"><span>السؤال ${qi + 1}</span>
      <button class="btn danger sm" data-act="q-del" data-qi="${qi}">حذف</button></div>
    <div class="field"><label>نص السؤال (بالإنجليزية)</label><input type="text" class="ltr" data-path="quiz.${qi}.q" value="${esc(q.q)}"></div>
    <label class="hint" style="display:block;margin-bottom:6px">الخيارات — حدّد الدائرة بجانب الإجابة الصحيحة:</label>
    ${q.options.map((o, oi) => `<div class="optrow">
      <input type="radio" name="ans-${qi}" data-act="answer" data-qi="${qi}" data-oi="${oi}" ${q.answer === oi ? 'checked' : ''} aria-label="الإجابة الصحيحة">
      <input type="text" class="ltr" data-path="quiz.${qi}.options.${oi}" value="${esc(o)}" aria-label="الخيار ${oi + 1}">
      <button class="btn danger sm" data-act="o-del" data-qi="${qi}" data-oi="${oi}" ${q.options.length <= 2 ? 'disabled' : ''} aria-label="حذف الخيار">×</button></div>`).join('')}
    <button class="btn ghost sm" data-act="o-add" data-qi="${qi}" ${q.options.length >= 6 ? 'disabled' : ''}>+ إضافة خيار</button></div>`;
}
function drawEditor() {
  drawNav();
  $('#app').innerHTML = `${noticeHtml()}
    <a class="back" href="#" data-act="cancel">← العودة إلى الدروس</a>
    <h1>${editId ? 'تعديل الدرس' : 'درس جديد'}</h1>
    <div class="field"><label>العنوان بالإنجليزية</label><input type="text" class="ltr" data-path="title" value="${esc(L.title)}" maxlength="120"></div>
    <div class="field"><label>العنوان بالعربية</label><input type="text" data-path="titleAr" value="${esc(L.titleAr)}" maxlength="120"></div>
    <div class="field"><label>المستوى</label><select data-path="level">${LEVELS.map(l => `<option value="${l}" ${L.level === l ? 'selected' : ''}>${l} · ${LEVEL_NAME[l]}</option>`).join('')}</select></div>
    <div class="field"><label>ملخص قصير</label><textarea rows="2" data-path="summary" maxlength="300">${esc(L.summary)}</textarea></div>
    <h2>أقسام الدرس</h2>
    ${L.sections.map(sectionHtml).join('') || '<div class="empty">لم تُضف أقسام بعد.</div>'}
    <div class="addbar">
      <button class="btn ghost sm" data-act="s-add" data-type="text">+ شرح</button>
      <button class="btn ghost sm" data-act="s-add" data-type="examples">+ أمثلة</button>
      <button class="btn ghost sm" data-act="s-add" data-type="vocab">+ مفردات</button>
      <button class="btn ghost sm" data-act="s-add" data-type="tip">+ ملاحظة</button></div>
    <h2>الاختبار</h2>
    ${L.quiz.map(quizHtml).join('') || '<div class="empty">لا توجد أسئلة. الاختبار اختياري.</div>'}
    <div class="addbar"><button class="btn ghost sm" data-act="q-add">+ إضافة سؤال</button></div>
    <div class="actions-row" style="margin-top:20px">
      <button class="btn" data-act="save">حفظ الدرس</button>
      <button class="btn ghost" data-act="preview">معاينة</button></div>
    <div id="preview"></div>`;
}

function renderSection(s) {
  const h = s.title ? `<h2>${esc(s.title)}</h2>` : '';
  if (s.type === 'text') return h + s.body.map(p => `<p>${allowMark(p)}</p>`).join('');
  if (s.type === 'examples') return h + s.items.map(i => `<div class="example"><span class="say" aria-hidden="true" style="display:grid;place-items:center">🔊</span>
      <div class="txt"><span class="en">${esc(i.en)}</span><span class="ar">${esc(i.ar)}</span></div></div>`).join('');
  if (s.type === 'vocab') return h + `<table>${s.items.map(i => `<tr><td><span class="en">${esc(i.en)}</span></td><td>${esc(i.ar)}</td></tr>`).join('')}</table>`;
  if (s.type === 'tip') return `<div class="tip"><strong>ملاحظة: </strong>${allowMark(s.body)}</div>`;
  return '';
}
function showPreview() {
  const d = toServer();
  $('#preview').innerHTML = `<div class="preview">
    <div class="meta"><span class="badge">${esc(d.level)} · ${LEVEL_NAME[d.level]}</span></div>
    <h1 class="lesson-title">${esc(d.title)}</h1><p class="muted" style="font-size:19px">${esc(d.titleAr)}</p>
    ${d.sections.map(renderSection).join('')}
    ${d.quiz.length ? `<h2>اختبر نفسك</h2>${d.quiz.map(q => `<div class="q"><span class="en qt">${esc(q.q)}</span>
      ${q.options.map((o, i) => `<span class="opt${i === q.answer ? ' right' : ''}" style="display:block">${esc(o)}</span>`).join('')}</div>`).join('')}` : ''}</div>`;
  $('#preview').scrollIntoView({ behavior: 'smooth' });
}

function setPath(obj, p, v) {
  const k = p.split('.'); let o = obj;
  for (let i = 0; i < k.length - 1; i++) o = o[k[i]];
  o[k[k.length - 1]] = v;
}

/* ---------- الإجراءات ---------- */
async function refresh() {
  try { await listView(); }
  catch (e) { if (e.status === 401) loginView(); else { setNotice(errMsg(e), true); $('#app').innerHTML = noticeHtml(); } }
}
async function move(id, dir) {
  const { lessons } = await api('GET', '/admin/lessons');
  const ids = lessons.map(l => l.id), i = ids.indexOf(id), j = i + dir;
  if (j < 0 || j >= ids.length) return;
  [ids[i], ids[j]] = [ids[j], ids[i]];
  await api('POST', '/admin/reorder', { ids });
}

document.addEventListener('click', async e => {
  const b = e.target.closest('[data-act]'); if (!b) return;
  const a = b.dataset.act, d = b.dataset;
  if (['logout', 'cancel'].includes(a)) e.preventDefault();
  try {
    switch (a) {
      case 'logout': await api('POST', '/admin/logout'); loginView(); return;
      case 'tab': tab = d.tab; return refresh();
      case 'new': L = blankLesson(); editId = null; return drawEditor();
      case 'edit': L = fromServer(await api('GET', '/admin/lessons/' + d.id)); editId = d.id; return drawEditor();
      case 'cancel': L = null; return refresh();
      case 'up': await move(d.id, -1); return refresh();
      case 'down': await move(d.id, 1); return refresh();
      case 'delete':
        if (!confirm('هل تريد حذف هذا الدرس نهائيًا؟ ستنتقل الدروس التالية يومًا واحدًا إلى الأمام.')) return;
        await api('DELETE', '/admin/lessons/' + d.id); setNotice('تم حذف الدرس.'); return refresh();
      case 'del-user':
        if (!confirm('هل تريد حذف هذا المستخدم وكل تقدّمه؟')) return;
        await api('DELETE', '/admin/users/' + d.id); setNotice('تم حذف المستخدم.'); return refresh();
      case 's-add': L.sections.push(d.type === 'text' ? { type: 'text', title: '', text: '' } : d.type === 'tip' ? { type: 'tip', text: '' }
        : { type: d.type, title: d.type === 'vocab' ? 'مفردات جديدة' : 'أمثلة', items: [{ en: '', ar: '' }] }); return drawEditor();
      case 's-del': L.sections.splice(+d.si, 1); return drawEditor();
      case 's-up': { const i = +d.si; [L.sections[i - 1], L.sections[i]] = [L.sections[i], L.sections[i - 1]]; return drawEditor(); }
      case 's-down': { const i = +d.si; [L.sections[i + 1], L.sections[i]] = [L.sections[i], L.sections[i + 1]]; return drawEditor(); }
      case 'i-add': L.sections[+d.si].items.push({ en: '', ar: '' }); return drawEditor();
      case 'i-del': L.sections[+d.si].items.splice(+d.ii, 1); return drawEditor();
      case 'q-add': L.quiz.push({ q: '', options: ['', '', ''], answer: 0 }); return drawEditor();
      case 'q-del': L.quiz.splice(+d.qi, 1); return drawEditor();
      case 'o-add': L.quiz[+d.qi].options.push(''); return drawEditor();
      case 'o-del': {
        const q = L.quiz[+d.qi], oi = +d.oi; q.options.splice(oi, 1);
        if (q.answer === oi) q.answer = 0; else if (q.answer > oi) q.answer--;
        return drawEditor();
      }
      case 'preview': return showPreview();
      case 'save': {
        const body = toServer();
        if (editId) await api('PUT', '/admin/lessons/' + editId, body); else await api('POST', '/admin/lessons', body);
        setNotice('تم حفظ الدرس بنجاح.'); L = null; return refresh();
      }
    }
  } catch (err) {
    if (err.status === 401 && err.message === 'admin_required') return loginView(ERR.admin_required);
    setNotice(errMsg(err), true);
    if (L) { drawEditor(); window.scrollTo(0, 0); } else refresh();
  }
});
document.addEventListener('input', e => { const p = e.target.dataset.path; if (p && L) setPath(L, p, e.target.value); });
document.addEventListener('change', e => {
  if (e.target.dataset.act === 'answer') L.quiz[+e.target.dataset.qi].answer = +e.target.dataset.oi;
  if (e.target.dataset.path && L) setPath(L, e.target.dataset.path, e.target.value);
});
document.addEventListener('submit', async e => {
  if (e.target.id !== 'admin-login') return;
  e.preventDefault();
  try { await api('POST', '/admin/login', { password: $('#apw').value }); await refresh(); }
  catch (err) { loginView(errMsg(err)); }
});

(async () => {
  try { await api('GET', '/admin/session'); await refresh(); }
  catch (e) { loginView(e.message === 'admin_disabled' ? ERR.admin_disabled : ''); }
})();
