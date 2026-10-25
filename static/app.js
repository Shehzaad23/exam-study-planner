/* Exam Study Planner - frontend.
 *
 * Everything you type is saved in this browser (localStorage).
 * The study plan itself is calculated by the Flask server (POST /api/plan),
 * so the planning logic lives in one tested place: planner.py.
 */
(() => {
  'use strict';

  // ---------------------------------------------------------------- constants
  const STORE_KEY = 'exam-study-planner:v1';
  const COLORS = ['#ffe066', '#ffb3c7', '#a8d8ff', '#b8e986', '#ffc685', '#d7b8ff'];
  const DIFFICULTY = { easy: 'Easy', medium: 'Medium', hard: 'Hard' };
  const STATUS = {
    on_track:        { label: 'On track',        cls: 'good', note: 'Nice! Keep ticking off your daily tasks and you will be ready in time.' },
    slightly_behind: { label: 'Slightly behind', cls: 'warn', note: 'There is very little spare time. Try not to skip a day, or add a little more study time.' },
    way_behind:      { label: 'Way behind',      cls: 'bad',  note: 'Some units don\'t fit before the exam. Raise your daily hours or unblock a day in Settings.' },
    needs_units:     { label: 'Add units',       cls: 'warn', note: 'Add the units of your subjects so they can be planned.' },
    no_exams:        { label: 'No exams',        cls: 'idle', note: 'Add your exam timetable to get a plan.' },
    exam_today:      { label: 'Exam today',      cls: 'bad',  note: '' },
    finished:        { label: 'Finished',        cls: 'idle', note: '' },
  };
  const VIEWS = ['today', 'plan', 'subjects', 'settings'];

  // ---------------------------------------------------------------- small helpers
  const $ = (sel, root = document) => root.querySelector(sel);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const cssEsc = (s) => (window.CSS && CSS.escape ? CSS.escape(s) : String(s).replace(/["\\]/g, '\\$&'));
  const uid = () => (window.crypto && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : Date.now().toString(36) + Math.random().toString(36).slice(2, 10));
  const isIsoDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);

  const pad = (n) => String(n).padStart(2, '0');
  const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const todayIso = () => iso(new Date());
  const parseIso = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
  const addDays = (s, n) => { const d = parseIso(s); d.setDate(d.getDate() + n); return iso(d); };
  const daysBetween = (a, b) => Math.round((parseIso(b) - parseIso(a)) / 86400000);
  const fmtLong = (s) => parseIso(s).toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long' });
  const fmtShort = (s) => parseIso(s).toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' });
  const fmtH = (h) => `${Number(h)} h`;

  // ---------------------------------------------------------------- saved state
  const emptyState = () => ({ version: 1, settings: { hoursPerDay: 4 }, blockedDays: [], exams: [], log: [] });

  /** Clean any saved/restored data so a bad file can't break the app. */
  function sanitize(raw) {
    if (!raw || typeof raw !== 'object' || !Array.isArray(raw.exams)) throw new Error('Not a planner backup');
    const out = emptyState();
    const hours = Number(raw.settings && raw.settings.hoursPerDay);
    out.settings.hoursPerDay = Number.isFinite(hours) && hours >= 0.5 && hours <= 16 ? hours : 4;
    out.blockedDays = Array.isArray(raw.blockedDays) ? [...new Set(raw.blockedDays.filter(isIsoDate))] : [];
    out.exams = raw.exams.filter((e) => e && typeof e === 'object').map((e, i) => ({
      id: String(e.id || uid()),
      subject: String(e.subject || 'Subject').slice(0, 60),
      date: isIsoDate(e.date) ? e.date : todayIso(),
      color: COLORS.includes(e.color) ? e.color : COLORS[i % COLORS.length],
      units: (Array.isArray(e.units) ? e.units : []).filter((u) => u && typeof u === 'object').map((u) => ({
        id: String(u.id || uid()),
        name: String(u.name || 'Unit').slice(0, 80),
        difficulty: DIFFICULTY[u.difficulty] ? u.difficulty : 'medium',
        weightage: Math.max(0, Math.min(100, Number(u.weightage) || 0)),
        done: !!u.done,
        notes: String(u.notes || ''),
      })),
      doubts: (Array.isArray(e.doubts) ? e.doubts : []).filter((d) => d && d.text).map((d) => ({
        id: String(d.id || uid()),
        text: String(d.text).slice(0, 200),
        resolved: !!d.resolved,
      })),
    }));
    out.log = (Array.isArray(raw.log) ? raw.log : [])
      .filter((l) => l && isIsoDate(l.date) && l.taskId)
      .map((l) => ({
        date: l.date,
        taskId: String(l.taskId),
        unitId: l.unitId ? String(l.unitId) : null,
        examId: String(l.examId || ''),
        hours: Math.max(0, Number(l.hours) || 0),
      }));
    return out;
  }

  let storageOk = true;
  function load() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (raw) return sanitize(JSON.parse(raw));
    } catch (_) { /* empty or broken storage: start fresh */ }
    return emptyState();
  }
  function save() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(state));
      storageOk = true;
    } catch (_) {
      storageOk = false;
    }
    $('#storage-warning').hidden = storageOk;
  }

  // ---------------------------------------------------------------- app state
  let state = load();
  let plan = null;
  let planError = null;
  let planSeq = 0;
  let view = VIEWS.includes(location.hash.slice(1)) ? location.hash.slice(1) : 'today';
  let pendingFocus = null;
  const openNotes = new Set();
  const viewEl = $('#view');

  const findExam = (id) => state.exams.find((e) => e.id === id);
  const findUnit = (exam, id) => exam && exam.units.find((u) => u.id === id);
  const doneSet = (date) => new Set(state.log.filter((l) => l.date === date).map((l) => l.taskId));

  // ---------------------------------------------------------------- talking to the server
  /** What the planner needs. Hours ticked off before today count as "already studied". */
  function payload() {
    const t = todayIso();
    const studied = {};
    for (const l of state.log) {
      if (l.unitId && l.date < t) studied[l.unitId] = (studied[l.unitId] || 0) + l.hours;
    }
    return {
      today: t,
      hours_per_day: state.settings.hoursPerDay,
      blocked_days: state.blockedDays,
      exams: state.exams.map((e) => ({
        id: e.id,
        subject: e.subject,
        date: e.date,
        color: e.color,
        units: e.units.map((u) => ({
          id: u.id,
          name: u.name,
          difficulty: u.difficulty,
          weightage: u.weightage,
          done: u.done,
          studied_hours: studied[u.id] || 0,
        })),
      })),
    };
  }

  async function refreshPlan() {
    const seq = ++planSeq;
    try {
      const res = await fetch('/api/plan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload()),
      });
      const data = await res.json();
      if (seq !== planSeq) return;
      if (res.ok) { plan = data; planError = null; } else { plan = null; planError = data.error || 'Could not build the plan.'; }
    } catch (_) {
      if (seq !== planSeq) return;
      planError = 'Could not reach the planner server. Is it running?';
    }
    render();
  }

  function commit() {
    save();
    render();
    refreshPlan();
  }

  // ---------------------------------------------------------------- progress helpers
  function progressPct(stat) {
    if (!stat || !stat.total_hours) return 0;
    const t = todayIso();
    const ids = new Set(stat.units.map((u) => u.id));
    const today = state.log
      .filter((l) => l.date === t && l.unitId && ids.has(l.unitId))
      .reduce((sum, l) => sum + l.hours, 0);
    return Math.min(100, Math.round((100 * (stat.studied_hours + today)) / stat.total_hours));
  }

  function streak() {
    const days = new Set(state.log.map((l) => l.date));
    let d = todayIso();
    if (!days.has(d)) d = addDays(d, -1);
    let n = 0;
    while (days.has(d)) { n += 1; d = addDays(d, -1); }
    return n;
  }

  // ---------------------------------------------------------------- shared bits of UI
  const pill = (s) => `<span class="pill pill-${(STATUS[s] || STATUS.no_exams).cls}">${esc((STATUS[s] || { label: s }).label)}</span>`;
  const hl = (color, text) => `<span class="hl" style="--hl:${esc(color || COLORS[0])}">${esc(text)}</span>`;

  function bar(pct, color) {
    return `<div class="bar" role="progressbar" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100" aria-label="Progress">`
      + `<span class="${pct ? '' : 'empty'}" style="width:${pct}%;--hl:${esc(color)}"></span></div>`
      + `<span class="bar-label">${pct}% done</span>`;
  }

  function diffOptions(selected) {
    return Object.entries(DIFFICULTY)
      .map(([v, label]) => `<option value="${v}" ${v === selected ? 'selected' : ''}>${label}</option>`).join('');
  }

  function taskItem(task, isDone, interactive) {
    const part = task.parts > 1 ? `<span class="part">part ${task.part} of ${task.parts}</span>` : '';
    const diff = task.difficulty
      ? `<span class="diff diff-${task.difficulty}">${DIFFICULTY[task.difficulty]}</span>`
      : '<span class="diff diff-rev">Revision</span>';
    const box = interactive
      ? `<input type="checkbox" class="tick" data-action="tick" data-task="${esc(task.id)}" data-key="tick:${esc(task.id)}" ${isDone ? 'checked' : ''} aria-label="Done: ${esc(task.title)}">`
      : (isDone ? '<span class="tick-mark" aria-label="done">✓</span>' : '<span class="tick-dot" aria-hidden="true">•</span>');
    return `<li class="task ${isDone ? 'done' : ''}">
      <label class="task-row">${box}
        <span class="task-body">
          <span class="task-title">${esc(task.title)}</span>${part}
          <span class="task-meta">${hl(task.color, task.subject)}${diff}</span>
        </span>
        <span class="task-hours">${fmtH(task.hours)}</span>
      </label></li>`;
  }

  function statusStamp() {
    if (!plan) return '';
    const info = STATUS[plan.status] || STATUS.no_exams;
    return `<span class="stamp stamp-${info.cls}">${esc(info.label)}</span>`;
  }

  const loadingBlock = () => '<p class="hand-note">Writing your plan…</p>';
  const errorBlock = () => `<div class="sticky sticky-bad"><strong>Couldn't make the plan:</strong> ${esc(planError)}</div>`;

  function emptyBlock() {
    return `<section class="card taped empty">
      <h3 class="hand">Your diary is empty</h3>
      <p>Add your exam timetable and the units of each subject.<br>The planner splits everything into a day-by-day plan for you.</p>
      <div class="row">
        <button class="btn btn-primary" data-action="go" data-to="subjects">Add my exams</button>
        <button class="btn" data-action="sample">Try a sample timetable</button>
      </div>
    </section>`;
  }

  // ---------------------------------------------------------------- view: Today
  function viewToday() {
    const t = todayIso();
    let html = `<section class="today-head">
      <div><p class="eyebrow">Today is</p><h2 class="hand big">${esc(fmtLong(t))}</h2></div>
      ${statusStamp()}
    </section>`;
    if (!state.exams.length) return html + emptyBlock();
    if (!plan) return html + (planError ? '' : loadingBlock());

    const day = plan.days.find((d) => d.date === t);
    const next = plan.days.find((d) => d.date === addDays(t, 1));
    html += `<div class="today-grid">
      <div>${todayTasks(day)}${tomorrowBlock(next)}</div>
      <aside>${statusNote()}${streakBlock()}${countdowns()}${warningsBlock()}</aside>
    </div>`;
    return html;
  }

  function todayTasks(day) {
    const t = todayIso();
    const done = doneSet(t);
    let body;
    if (!day) {
      body = '<p class="hand-note">No more exams to study for. Enjoy the break!</p>';
    } else {
      const banner = day.exams.map((x) => `<div class="exam-banner">
          <span class="stamp stamp-red small">Exam today</span>${hl(x.color, x.subject)}
          <span>All the best, you've got this!</span></div>`).join('');
      if (!day.tasks.length) {
        const msg = {
          blocked: 'You blocked today. Rest, recharge, and come back tomorrow.',
          exam: 'Just focus on today\'s exam.',
        }[day.kind] || 'Nothing planned for today.';
        body = `${banner}<p class="hand-note">${msg}</p>`;
      } else {
        const total = day.tasks.reduce((sum, x) => sum + x.hours, 0);
        const count = day.tasks.filter((x) => done.has(x.id)).length;
        body = `${banner}<p class="tally">${count} of ${day.tasks.length} done · ${fmtH(total)} planned</p>
          <ul class="checklist">${day.tasks.map((x) => taskItem(x, done.has(x.id), true)).join('')}</ul>`;
        if (count === day.tasks.length) body += '<p class="hand-note well-done">All done for today. Well done!</p>';
      }
    }
    return `<section class="card taped"><h3 class="hand">Today's tasks</h3>${body}</section>`;
  }

  function tomorrowBlock(day) {
    if (!day) return '';
    const exams = day.exams.map((x) => `<p class="exam-line"><span class="stamp stamp-red small">Exam</span> ${hl(x.color, x.subject)}</p>`).join('');
    let body;
    if (day.tasks.length) {
      body = `<ul class="tomorrow-list">${day.tasks.map((x) => `<li><span>${hl(x.color, x.subject)} ${esc(x.title)}</span><span class="h">${fmtH(x.hours)}</span></li>`).join('')}</ul>`;
    } else {
      body = `<p class="muted small">${day.kind === 'blocked' ? 'Blocked day, no study.' : 'Nothing planned.'}</p>`;
    }
    return `<section class="card soft"><h3 class="hand">Tomorrow</h3>${exams}${body}</section>`;
  }

  function statusNote() {
    const info = STATUS[plan.status] || STATUS.no_exams;
    const levels = ['on_track', 'slightly_behind', 'way_behind'];
    const idx = levels.indexOf(plan.status);
    const meter = idx >= 0
      ? `<div class="meter">${levels.map((l, i) => `<span class="seg seg-${STATUS[l].cls} ${i === idx ? 'on' : ''}">${STATUS[l].label}</span>`).join('')}</div>`
      : '';
    return `<section class="sticky sticky-${info.cls}"><h3 class="hand">How am I doing?</h3>${meter}<p>${esc(info.note)}</p></section>`;
  }

  function streakBlock() {
    const n = streak();
    return `<section class="card streak">
      <div class="streak-num">${n}</div>
      <div><h3 class="hand">day${n === 1 ? '' : 's'} streak</h3>
      <p class="muted">${n ? 'Days in a row you ticked off at least one task.' : 'Tick off a task today to start your streak.'}</p></div>
    </section>`;
  }

  function countdowns() {
    const upcoming = plan.exams.filter((e) => e.status !== 'finished');
    if (!upcoming.length) return '';
    const items = upcoming.map((e) => {
      const n = e.days_left;
      const big = n === 0 ? 'Today!' : n === 1 ? 'Tomorrow' : `${n} days`;
      return `<li>
        <div class="cd-top">${hl(e.color, e.subject)}<span class="cd-days">${big}</span></div>
        <div class="cd-sub">${esc(fmtShort(e.date))} ${pill(e.status)}</div>
        ${bar(progressPct(e), e.color)}
      </li>`;
    }).join('');
    return `<section class="card"><h3 class="hand">Countdown</h3><ul class="countdown">${items}</ul></section>`;
  }

  function warningsBlock() {
    if (!plan.warnings.length) return '';
    return `<section class="sticky sticky-bad"><h3 class="hand">Heads up</h3>
      <ul class="warn-list">${plan.warnings.map((w) => `<li>${esc(w)}</li>`).join('')}</ul></section>`;
  }

  // ---------------------------------------------------------------- view: Full plan
  function viewPlan() {
    let html = `<section class="plan-head">
      <div><p class="eyebrow">Day by day</p><h2 class="hand big">Full study plan</h2></div>
      <div class="row no-print">
        <button class="btn" data-action="ics">Add to calendar</button>
        <button class="btn" data-action="print">Print / Save PDF</button>
      </div>
    </section>`;
    if (!state.exams.length) return html + emptyBlock();
    if (!plan) return html + (planError ? '' : loadingBlock());
    if (!plan.days.length) return html + '<p class="hand-note">No upcoming exams to plan.</p>';

    const t = todayIso();
    const tomorrow = addDays(t, 1);
    const done = doneSet(t);
    const kinds = { revision: 'Revision day', blocked: 'Blocked', exam: 'Exam day', study: '' };

    html += `<p class="print-only print-title">My study plan · made on ${esc(fmtLong(t))}</p>`;
    html += `<div class="diary">${plan.days.map((d) => {
      const label = d.date === t ? 'Today' : d.date === tomorrow ? 'Tomorrow' : '';
      const total = d.tasks.reduce((sum, x) => sum + x.hours, 0);
      const exams = d.exams.map((x) => `<p class="exam-line"><span class="stamp stamp-red small">Exam</span> ${hl(x.color, x.subject)}</p>`).join('');
      const tasks = d.tasks.length
        ? `<ul class="checklist compact">${d.tasks.map((x) => taskItem(x, d.date === t && done.has(x.id), false)).join('')}</ul>`
        : `<p class="muted small">${d.kind === 'blocked' ? 'No study, day blocked.' : 'Free time.'}</p>`;
      return `<article class="diary-day kind-${d.kind} ${d.date === t ? 'is-today' : ''}">
        <header>
          <h3 class="hand">${esc(fmtShort(d.date))}</h3>
          ${label ? `<span class="pill pill-today">${label}</span>` : ''}
          ${kinds[d.kind] ? `<span class="kind">${kinds[d.kind]}</span>` : ''}
          <span class="day-hours">${total ? fmtH(total) : ''}</span>
        </header>${exams}${tasks}
      </article>`;
    }).join('')}</div>`;
    return html;
  }

  // ---------------------------------------------------------------- view: Subjects
  function viewSubjects() {
    let html = `<section class="plan-head">
      <div><p class="eyebrow">Your exams</p><h2 class="hand big">Subjects &amp; units</h2></div>
    </section>
    <form class="card taped" data-action="add-exam">
      <h3 class="hand">Add an exam</h3>
      <div class="form-row">
        <label class="field"><span>Subject</span>
          <input name="subject" required maxlength="60" placeholder="e.g. Computer Networks" data-key="new-exam-subject"></label>
        <label class="field"><span>Exam date</span>
          <input type="date" name="date" required min="${todayIso()}" data-key="new-exam-date"></label>
        <button class="btn btn-primary" type="submit">Add exam</button>
      </div>
      ${state.exams.length ? '' : '<p class="muted small">Or <button type="button" class="link" data-action="sample">load a sample timetable</button> to see how it works.</p>'}
    </form>`;
    const stats = new Map((plan ? plan.exams : []).map((e) => [e.id, e]));
    const sorted = [...state.exams].sort((a, b) => a.date.localeCompare(b.date));
    html += sorted.map((e) => examCard(e, stats.get(e.id))).join('');
    return html;
  }

  function examCard(e, stat) {
    const left = daysBetween(todayIso(), e.date);
    const when = left < 0 ? 'already over' : left === 0 ? 'today' : left === 1 ? 'tomorrow' : `in ${left} days`;
    const needed = new Map((stat ? stat.units : []).map((u) => [u.id, u]));
    const swatches = COLORS.map((c) => `<button type="button" class="swatch ${c === e.color ? 'on' : ''}" style="--hl:${c}"
        data-action="color" data-exam="${e.id}" data-color="${c}" aria-label="Highlighter colour" aria-pressed="${c === e.color}"></button>`).join('');

    const units = e.units.length
      ? `<div class="units">
          <div class="unit unit-head"><span title="Finished">✓</span><span>Unit</span><span>Difficulty</span><span>Marks</span><span>Needs</span><span></span></div>
          ${e.units.map((u) => unitRow(e, u, needed.get(u.id))).join('')}
        </div>`
      : '<p class="muted small">No units yet. Add the chapters / units of this subject below.</p>';

    const doubts = e.doubts.length
      ? `<ul class="doubts">${e.doubts.map((d) => `<li class="${d.resolved ? 'resolved' : ''}">
          <label><input type="checkbox" class="tick" ${d.resolved ? 'checked' : ''} data-action="doubt-resolved"
            data-exam="${e.id}" data-doubt="${d.id}" data-key="doubt:${d.id}" aria-label="Doubt cleared"><span>${esc(d.text)}</span></label>
          <button type="button" class="icon-btn" data-action="del-doubt" data-exam="${e.id}" data-doubt="${d.id}" aria-label="Delete doubt">✕</button>
        </li>`).join('')}</ul>`
      : '<p class="muted small">No doubts written down.</p>';

    return `<section class="card subject" style="--hl:${e.color}">
      <div class="subject-head">
        <input class="subject-name" value="${esc(e.subject)}" maxlength="60" aria-label="Subject name"
          data-action="exam-field" data-field="subject" data-exam="${e.id}" data-key="exam-subject:${e.id}">
        <button type="button" class="icon-btn" data-action="del-exam" data-exam="${e.id}" aria-label="Delete ${esc(e.subject)}" title="Delete exam">✕</button>
      </div>
      <div class="subject-meta">
        <label class="field inline"><span>Exam on</span>
          <input type="date" value="${e.date}" data-action="exam-field" data-field="date" data-exam="${e.id}" data-key="exam-date:${e.id}"></label>
        <span class="muted">${when}</span>
        ${stat ? pill(stat.status) : ''}
        <span class="swatches">${swatches}</span>
      </div>
      ${bar(progressPct(stat), e.color)}

      <h4 class="hand">Units</h4>
      ${units}
      <form class="add-unit" data-action="add-unit" data-exam="${e.id}">
        <input name="name" required maxlength="80" placeholder="New unit, e.g. Routing algorithms" data-key="new-unit:${e.id}" aria-label="Unit name">
        <select name="difficulty" data-key="new-unit-diff:${e.id}" aria-label="Difficulty">${diffOptions('medium')}</select>
        <input name="weightage" type="number" min="0" max="100" step="1" placeholder="Marks" data-key="new-unit-marks:${e.id}" aria-label="Marks weightage">
        <button class="btn small" type="submit">+ Add unit</button>
      </form>

      <h4 class="hand">Doubts to ask</h4>
      ${doubts}
      <form class="add-doubt" data-action="add-doubt" data-exam="${e.id}">
        <input name="text" required maxlength="200" placeholder="Write a doubt to ask your teacher" data-key="new-doubt:${e.id}" aria-label="New doubt">
        <button class="btn small" type="submit">+ Add</button>
      </form>
    </section>`;
  }

  function unitRow(e, u, info) {
    const attrs = (field) => `data-action="unit-field" data-field="${field}" data-exam="${e.id}" data-unit="${u.id}" data-key="unit-${field}:${u.id}"`;
    return `<div class="unit ${u.done ? 'is-done' : ''}">
      <input type="checkbox" class="tick" ${u.done ? 'checked' : ''} ${attrs('done')} aria-label="Unit finished" title="Mark the whole unit as finished">
      <input class="unit-name" value="${esc(u.name)}" maxlength="80" ${attrs('name')} aria-label="Unit name">
      <select ${attrs('difficulty')} aria-label="Difficulty">${diffOptions(u.difficulty)}</select>
      <input type="number" min="0" max="100" step="1" value="${u.weightage || ''}" placeholder="–" ${attrs('weightage')} aria-label="Marks">
      <span class="needs">${info ? fmtH(info.needed_hours) : ''}</span>
      <span class="unit-actions">
        <button type="button" class="icon-btn ${u.notes ? 'has-notes' : ''}" data-action="toggle-notes" data-unit="${u.id}"
          aria-expanded="${openNotes.has(u.id)}" title="Notes for this unit" aria-label="Notes">✎</button>
        <button type="button" class="icon-btn" data-action="del-unit" data-exam="${e.id}" data-unit="${u.id}" title="Delete unit" aria-label="Delete unit">✕</button>
      </span>
      ${openNotes.has(u.id) ? `<textarea class="notes" rows="3" placeholder="Formulas, key points, page numbers…" ${attrs('notes')} aria-label="Notes">${esc(u.notes)}</textarea>` : ''}
    </div>`;
  }

  // ---------------------------------------------------------------- view: Settings
  function viewSettings() {
    const t = todayIso();
    const blocked = [...state.blockedDays].sort();
    const chips = blocked.length
      ? `<ul class="chips">${blocked.map((d) => `<li class="chip ${d < t ? 'past' : ''}">${esc(fmtShort(d))}
          <button type="button" data-action="del-blocked" data-date="${d}" aria-label="Unblock ${esc(fmtShort(d))}">✕</button></li>`).join('')}</ul>`
      : '<p class="muted small">No blocked days.</p>';
    return `<section class="plan-head">
      <div><p class="eyebrow">Your setup</p><h2 class="hand big">Settings</h2></div>
    </section>
    <div class="settings-grid">
      <section class="card taped">
        <h3 class="hand">Daily study hours</h3>
        <p class="muted">How many hours can you honestly study on a normal day?</p>
        <label class="field inline">
          <input type="number" min="0.5" max="16" step="0.5" value="${state.settings.hoursPerDay}" data-action="hours" data-key="hours" aria-label="Hours per day">
          <span>hours a day</span></label>
        <p class="muted small" style="margin-top:10px">Exam days get half of this, for your next exams.</p>
      </section>

      <section class="card">
        <h3 class="hand">Blocked days</h3>
        <p class="muted">Days you can't study: a fest, travel, a lab submission…</p>
        <form class="form-row" data-action="add-blocked">
          <input type="date" name="date" required min="${t}" data-key="new-blocked" aria-label="Day to block">
          <button class="btn small" type="submit">Block day</button>
        </form>
        ${chips}
      </section>

      <section class="card">
        <h3 class="hand">Calendar &amp; printing</h3>
        <p class="muted">Put your plan into Google Calendar, or stick it on your wall.</p>
        <div class="row">
          <button class="btn" data-action="ics">Download calendar file</button>
          <button class="btn" data-action="print">Print / Save PDF</button>
        </div>
        <p class="muted small" style="margin-top:10px">Google Calendar: Settings → Import &amp; export → choose the downloaded .ics file.</p>
      </section>

      <section class="card">
        <h3 class="hand">Backup &amp; restore</h3>
        <p class="muted">Your diary lives only in this browser. Download a backup to move it to another laptop or phone.</p>
        <div class="row">
          <button class="btn" data-action="backup">Download backup</button>
          <label class="btn file-btn">Restore backup
            <input type="file" accept="application/json,.json" data-action="restore" hidden></label>
        </div>
      </section>

      <section class="card">
        <h3 class="hand">Sample &amp; reset</h3>
        <p class="muted">Load a demo timetable, or wipe everything and start fresh.</p>
        <div class="row">
          <button class="btn" data-action="sample">Load sample timetable</button>
          <button class="btn btn-danger" data-action="clear">Erase everything</button>
        </div>
      </section>
    </div>`;
  }

  // ---------------------------------------------------------------- rendering
  const VIEW_FNS = { today: viewToday, plan: viewPlan, subjects: viewSubjects, settings: viewSettings };

  function render() {
    // Keep whatever the user is in the middle of typing, and keep focus where it was.
    const active = document.activeElement;
    const keep = {};
    viewEl.querySelectorAll('[data-key^="new"]').forEach((el) => { keep[el.dataset.key] = el.value; });
    let focusKey = pendingFocus;
    let selection = null;
    if (!focusKey && active && viewEl.contains(active) && active.dataset && active.dataset.key) {
      focusKey = active.dataset.key;
      if ('value' in active && active.type !== 'checkbox') keep[focusKey] = active.value;
      try {
        if (typeof active.selectionStart === 'number') selection = [active.selectionStart, active.selectionEnd];
      } catch (_) { /* some inputs have no text selection */ }
    }
    pendingFocus = null;

    const errors = planError && view !== 'settings' ? errorBlock() : '';
    viewEl.innerHTML = errors + VIEW_FNS[view]();

    for (const [key, value] of Object.entries(keep)) {
      const el = viewEl.querySelector(`[data-key="${cssEsc(key)}"]`);
      if (el && el.type !== 'file') el.value = value;
    }
    if (focusKey) {
      const el = viewEl.querySelector(`[data-key="${cssEsc(focusKey)}"]`);
      if (el) {
        el.focus({ preventScroll: true });
        if (selection) { try { el.setSelectionRange(selection[0], selection[1]); } catch (_) { /* ignore */ } }
      }
    }
    document.querySelectorAll('.tabs [data-view]').forEach((b) => {
      if (b.dataset.view === view) b.setAttribute('aria-current', 'page');
      else b.removeAttribute('aria-current');
    });
  }

  function setView(next) {
    if (!VIEWS.includes(next)) return;
    view = next;
    history.replaceState(null, '', `#${next}`);
    render();
    window.scrollTo({ top: 0 });
  }

  let toastTimer;
  function toast(message) {
    const el = $('#toast');
    el.textContent = message;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 2800);
  }

  // ---------------------------------------------------------------- actions
  function onTick(el) {
    const t = todayIso();
    const id = el.dataset.task;
    const day = plan && plan.days.find((d) => d.date === t);
    const task = day && day.tasks.find((x) => x.id === id);
    if (el.checked) {
      if (!task) return;
      if (!state.log.some((l) => l.date === t && l.taskId === id)) {
        state.log.push({
          date: t,
          taskId: id,
          unitId: task.unit_id,
          examId: task.exam_id,
          hours: task.type === 'study' ? task.hours : 0,
        });
      }
    } else {
      state.log = state.log.filter((l) => !(l.date === t && l.taskId === id));
    }
    save();
    render();
    if (el.checked && day.tasks.every((x) => doneSet(t).has(x.id))) toast('Every task for today is done. Brilliant!');
  }

  function onUnitField(el) {
    const exam = findExam(el.dataset.exam);
    const unit = findUnit(exam, el.dataset.unit);
    if (!unit) return;
    const field = el.dataset.field;
    if (field === 'done') unit.done = el.checked;
    else if (field === 'name') { const v = el.value.trim(); if (v) unit.name = v; }
    else if (field === 'difficulty' && DIFFICULTY[el.value]) unit.difficulty = el.value;
    else if (field === 'weightage') unit.weightage = Math.max(0, Math.min(100, Number(el.value) || 0));
    else if (field === 'notes') { unit.notes = el.value; save(); return; } // notes don't change the plan
    commit();
  }

  function downloadBlob(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async function downloadIcs() {
    if (!state.exams.length) { toast('Add an exam first.'); return; }
    try {
      const res = await fetch('/api/calendar', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload()),
      });
      if (!res.ok) { const data = await res.json().catch(() => ({})); toast(data.error || 'Could not make the calendar file.'); return; }
      downloadBlob(await res.blob(), `${todayIso()}-study-plan.ics`);
      toast('Calendar file downloaded.');
    } catch (_) {
      toast('Could not reach the planner server.');
    }
  }

  function printPlan() {
    setView('plan');
    setTimeout(() => window.print(), 150);
  }

  function backup() {
    const data = JSON.stringify({ ...state, exportedAt: new Date().toISOString() }, null, 2);
    downloadBlob(new Blob([data], { type: 'application/json' }), `${todayIso()}-study-planner-backup.json`);
    toast('Backup downloaded.');
  }

  function restore(input) {
    const file = input.files && input.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const next = sanitize(JSON.parse(reader.result));
        if (!confirm('Replace your current diary with this backup?')) return;
        state = next;
        openNotes.clear();
        commit();
        toast('Backup restored.');
      } catch (_) {
        toast('That file is not a planner backup.');
      } finally {
        input.value = '';
      }
    };
    reader.readAsText(file);
  }

  function sampleState() {
    const t = todayIso();
    const make = (subject, offset, color, units, doubts = []) => ({
      id: uid(),
      subject,
      date: addDays(t, offset),
      color,
      units: units.map(([name, difficulty, weightage]) => ({ id: uid(), name, difficulty, weightage, done: false, notes: '' })),
      doubts: doubts.map((text) => ({ id: uid(), text, resolved: false })),
    });
    const sepm = make('Software Engineering & PM', 7, COLORS[0], [
      ['Process models', 'easy', 10], ['Agile & Scrum', 'medium', 15], ['Requirements engineering', 'medium', 15],
      ['COCOMO estimation', 'hard', 20], ['Risk management', 'medium', 10],
    ], ['Difference between the spiral and incremental model?']);
    const cn = make('Computer Networks', 11, COLORS[2], [
      ['Physical layer', 'easy', 10], ['Data link layer', 'medium', 15], ['Routing algorithms', 'hard', 20],
      ['Transport layer (TCP/UDP)', 'hard', 20], ['Application layer', 'easy', 10],
    ], ['How does sliding-window flow control work?']);
    const cloud = make('Cloud Computing & DevOps', 16, COLORS[3], [
      ['Virtualization', 'easy', 10], ['Docker', 'medium', 15], ['Kubernetes', 'hard', 20], ['CI/CD with Jenkins', 'medium', 15],
    ]);
    sepm.units[0].notes = 'Waterfall, V-model, incremental, spiral: draw the diagrams once.';
    return {
      version: 1,
      settings: { hoursPerDay: 5 },
      blockedDays: [addDays(t, 3)],
      exams: [sepm, cn, cloud],
      // pretend you studied yesterday, so progress and the streak show up
      log: [{ date: addDays(t, -1), taskId: `study:${sepm.units[0].id}`, unitId: sepm.units[0].id, examId: sepm.id, hours: 1.5 }],
    };
  }

  function loadSample() {
    if (state.exams.length && !confirm('Replace your current diary with the sample timetable?')) return;
    state = sampleState();
    openNotes.clear();
    commit();
    setView('today');
    toast('Sample timetable loaded. Have a look around!');
  }

  // ---------------------------------------------------------------- events
  document.querySelector('.tabs').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-view]');
    if (btn) setView(btn.dataset.view);
  });

  viewEl.addEventListener('click', (e) => {
    const el = e.target.closest('[data-action]');
    if (!el) return;
    const exam = el.dataset.exam ? findExam(el.dataset.exam) : null;
    switch (el.dataset.action) {
      case 'go': setView(el.dataset.to); break;
      case 'sample': loadSample(); break;
      case 'ics': downloadIcs(); break;
      case 'print': printPlan(); break;
      case 'backup': backup(); break;
      case 'clear':
        if (confirm('Erase all exams, units, notes and progress? This cannot be undone.')) {
          state = emptyState();
          plan = null;
          openNotes.clear();
          commit();
          toast('Diary erased.');
        }
        break;
      case 'color':
        if (exam) { exam.color = el.dataset.color; commit(); }
        break;
      case 'del-exam':
        if (exam && confirm(`Delete ${exam.subject} with all its units, notes and doubts?`)) {
          state.exams = state.exams.filter((x) => x !== exam);
          state.log = state.log.filter((l) => l.examId !== exam.id);
          commit();
          toast(`${exam.subject} deleted.`);
        }
        break;
      case 'del-unit': {
        const unit = findUnit(exam, el.dataset.unit);
        if (unit && confirm(`Delete the unit "${unit.name}"?`)) {
          exam.units = exam.units.filter((u) => u !== unit);
          state.log = state.log.filter((l) => l.unitId !== unit.id);
          commit();
        }
        break;
      }
      case 'toggle-notes': {
        const id = el.dataset.unit;
        if (openNotes.has(id)) openNotes.delete(id);
        else { openNotes.add(id); pendingFocus = `unit-notes:${id}`; }
        render();
        break;
      }
      case 'del-doubt':
        if (exam) { exam.doubts = exam.doubts.filter((d) => d.id !== el.dataset.doubt); save(); render(); }
        break;
      case 'del-blocked':
        state.blockedDays = state.blockedDays.filter((d) => d !== el.dataset.date);
        commit();
        break;
      default: break;
    }
  });

  viewEl.addEventListener('change', (e) => {
    const el = e.target;
    const action = el.dataset && el.dataset.action;
    if (!action) return;
    if (action === 'tick') { onTick(el); return; }
    if (action === 'unit-field') { onUnitField(el); return; }
    if (action === 'restore') { restore(el); return; }
    if (action === 'exam-field') {
      const exam = findExam(el.dataset.exam);
      if (!exam) return;
      const value = el.value.trim();
      if (el.dataset.field === 'subject' && value) exam.subject = value;
      if (el.dataset.field === 'date' && isIsoDate(value)) exam.date = value;
      commit();
      return;
    }
    if (action === 'doubt-resolved') {
      const exam = findExam(el.dataset.exam);
      const doubt = exam && exam.doubts.find((d) => d.id === el.dataset.doubt);
      if (doubt) { doubt.resolved = el.checked; save(); render(); }
      return;
    }
    if (action === 'hours') {
      let v = Number(el.value);
      if (!Number.isFinite(v) || v <= 0) v = state.settings.hoursPerDay;
      state.settings.hoursPerDay = Math.min(16, Math.max(0.5, Math.round(v * 2) / 2));
      commit();
    }
  });

  viewEl.addEventListener('submit', (e) => {
    const form = e.target;
    const action = form.dataset.action;
    if (!action) return;
    e.preventDefault();
    const fd = new FormData(form);
    const exam = form.dataset.exam ? findExam(form.dataset.exam) : null;

    if (action === 'add-exam') {
      const subject = String(fd.get('subject') || '').trim();
      const date = String(fd.get('date') || '');
      if (!subject || !isIsoDate(date)) return;
      const used = new Set(state.exams.map((x) => x.color));
      const color = COLORS.find((c) => !used.has(c)) || COLORS[state.exams.length % COLORS.length];
      const id = uid();
      state.exams.push({ id, subject, date, color, units: [], doubts: [] });
      form.reset();
      pendingFocus = `new-unit:${id}`;
      commit();
      toast(`${subject} added. Now add its units.`);
    } else if (action === 'add-unit' && exam) {
      const name = String(fd.get('name') || '').trim();
      if (!name) return;
      const difficulty = DIFFICULTY[fd.get('difficulty')] ? fd.get('difficulty') : 'medium';
      const weightage = Math.max(0, Math.min(100, Number(fd.get('weightage')) || 0));
      exam.units.push({ id: uid(), name, difficulty, weightage, done: false, notes: '' });
      form.reset();
      pendingFocus = `new-unit:${exam.id}`;
      commit();
    } else if (action === 'add-doubt' && exam) {
      const text = String(fd.get('text') || '').trim();
      if (!text) return;
      exam.doubts.push({ id: uid(), text, resolved: false });
      form.reset();
      pendingFocus = `new-doubt:${exam.id}`;
      save();
      render();
    } else if (action === 'add-blocked') {
      const date = String(fd.get('date') || '');
      if (!isIsoDate(date)) return;
      if (!state.blockedDays.includes(date)) state.blockedDays.push(date);
      form.reset();
      commit();
    }
  });

  // Tab left open overnight? Rebuild the plan for the new day.
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && plan && plan.today !== todayIso()) refreshPlan();
  });

  // ---------------------------------------------------------------- start
  save();
  render();
  if (state.exams.length) refreshPlan();
  fetch('/api/version')
    .then((r) => r.json())
    .then((d) => { $('#version').textContent = `v${d.version}`; })
    .catch(() => {});
})();
