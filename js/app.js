import * as db from './db.js';
import * as auth from './auth.js';
import { encryptWithPassphrase, decryptWithPassphrase } from './crypto.js';
import { esc, uid, fmtDate, fmtDateTime, fmtDur, age, debounce, toLocalInput, fromLocalInput, mdToHtml, download, blobToBase64, base64ToBlob } from './util.js';
import { analyze, sortVisits, series, STATUS_LABEL } from './analysis.js';
import { lineChart } from './charts.js';
import { attachSettings, detachSettings, getSettings, saveSettings, runReview, runSoap, transcribeAudio, testConnection, providerLabel, isCloud } from './ai.js';
import { Recorder, speechSupported, recordingSupported } from './voice.js';

const app = document.getElementById('app');
const $ = (sel, root = app) => root.querySelector(sel);
const $$ = (sel, root = app) => [...root.querySelectorAll(sel)];

// ---------- helpers ----------
let toastTimer;
function toast(msg, isError = false) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = 'toast' + (isError ? ' error' : '');
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), isError ? 6000 : 2800);
}
let recordingActive = false;
const cleanups = [];
const onLeave = (fn) => cleanups.push(fn);
async function runCleanups() {
  while (cleanups.length) { try { await cleanups.pop()(); } catch (e) { console.error(e); } }
}
const fullName = (p) => `${p.firstName || ''} ${p.lastName || ''}`.trim() || 'Unnamed patient';
const VISIT_TYPES = { initial: 'Initial assessment', 'follow-up': 'Follow-up', reassessment: 'Re-assessment', discharge: 'Discharge' };
const hue = (str) => { let h = 0; for (const c of str) h = (h * 31 + c.charCodeAt(0)) % 360; return h; };
const initials = (p) => ((p.firstName || '?')[0] + (p.lastName || '')[0]).toUpperCase();
const avatar = (p, cls = '') => `<span class="avatar ${cls}" style="--h:${hue(fullName(p))}" aria-hidden="true">${esc(initials(p))}</span>`;
function spark(points) {
  if (points.length < 2) return '';
  const xs = points.map((q) => q.t), t0 = Math.min(...xs), t1 = Math.max(...xs) || 1;
  const X = (t) => 4 + ((t - t0) / (t1 - t0 || 1)) * 76, Y = (y) => 24 - (y / 10) * 20;
  const d = points.map((q, i) => `${i ? 'L' : 'M'}${X(q.t).toFixed(1)},${Y(q.y).toFixed(1)}`).join(' ');
  const l = points[points.length - 1];
  return `<svg class="spark" viewBox="0 0 84 28" aria-hidden="true"><path d="${d}"/><circle cx="${X(l.t).toFixed(1)}" cy="${Y(l.y).toFixed(1)}" r="2.8"/></svg>`;
}
const STATUS_BADGE = { 'on-track': 'ok', improving: 'ok', slow: 'warn', plateau: 'warn', worsening: 'danger', baseline: '', 'no-data': 'gray' };

function notFound() {
  app.innerHTML = '<div class="card"><h2>Not found</h2><p>That record does not exist (it may have been deleted).</p><a class="btn" href="#/">Back to patients</a></div>';
}

// ---------- router ----------
async function route() {
  await runCleanups();
  if (!session) return authView();
  const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean).map(decodeURIComponent);
  $$('[data-nav]', document).forEach((a) => a.classList.toggle('active', a.dataset.nav === (parts[0] === 'settings' ? 'settings' : 'patients')));
  try {
    if (!parts.length) await patientsView();
    else if (parts[0] === 'settings') await settingsView();
    else if (parts[0] === 'patient' && parts[1] === 'new') await patientForm();
    else if (parts[0] === 'patient' && parts[2] === 'edit') await patientForm(parts[1]);
    else if (parts[0] === 'patient' && parts[2] === 'visit' && parts[3] === 'new') await visitView(null, parts[1], parts[4]);
    else if (parts[0] === 'patient') await patientView(parts[1]);
    else if (parts[0] === 'visit') await visitView(parts[1]);
    else notFound();
  } catch (e) {
    console.error(e);
    app.innerHTML = `<div class="card"><h2>Something went wrong</h2><p>${esc(e.message)}</p><a class="btn" href="#/">Back</a></div>`;
  }
  window.scrollTo(0, 0);
  app.focus({ preventScroll: true });
}
window.addEventListener('hashchange', route);

// ---------- patients list ----------
async function patientsView() {
  const [patients, visits] = await Promise.all([db.getAll('patients'), db.getAll('visits')]);
  const byPatient = new Map();
  visits.forEach((v) => byPatient.set(v.patientId, [...(byPatient.get(v.patientId) || []), v]));
  const rows = patients.map((p) => {
    const vs = byPatient.get(p.id) || [];
    const a = analyze(p, vs);
    const last = sortVisits(vs).pop();
    return { p, a, last, activity: last ? new Date(last.date).getTime() : p.createdAt ? new Date(p.createdAt).getTime() : 0 };
  }).sort((x, y) => y.activity - x.activity);

  const hr = new Date().getHours();
  const weekAgo = Date.now() - 7 * 86400000;
  const activeCount = patients.filter((p) => (p.status || 'active') === 'active').length;
  const weekVisits = visits.filter((v) => new Date(v.date).getTime() >= weekAgo).length;
  const attention = rows.filter(({ p, a }) => (p.status || 'active') === 'active' && (a.alerts.length || a.flags.length)).length;
  const st = getSettings();
  const legacy = await db.legacyExists();
  app.innerHTML = `
    <section class="hero">
      <div class="row between"><div><h1>${hr < 12 ? 'Good morning' : hr < 18 ? 'Good afternoon' : 'Good evening'} 👋</h1><p>Here’s your caseload at a glance.</p></div>
        <a class="btn white" href="#/patient/new">+ New patient</a></div>
      <div class="stats"><div class="stat"><b>${activeCount}</b><span>Active patients</span></div><div class="stat"><b>${weekVisits}</b><span>Visits this week</span></div><div class="stat"><b>${attention}</b><span>Need attention</span></div></div>
    </section>
    ${legacy ? `<div class="setup row between"><div><strong>📦 Notes from before accounts were added</strong><div class="small">Found patient data saved unencrypted in this browser. Move it into your encrypted account (it will then be deleted from the old location).</div></div><button class="btn sm primary" id="claim">Import into my account</button></div>` : ''}
    ${st.provider === 'gemini' && !st.geminiKey ? `<div class="setup row between"><div><strong>✨ Turn on your free AI assistant</strong><div class="small">Connect Google Gemini in about a minute to get treatment recommendations and dictation-to-notes.</div></div><a class="btn sm primary" href="#/settings">Set up</a></div>` : ''}
    <div class="row" style="margin-bottom:1rem">
      <input id="q" class="grow" type="search" placeholder="🔍  Search name, condition, phone…" aria-label="Search patients">
      <select id="filter" style="width:auto" aria-label="Filter by status">
        <option value="active">Active</option><option value="discharged">Discharged</option><option value="all">All</option>
      </select>
    </div>
    <ul class="plist" id="list"></ul>`;

  const draw = () => {
    const q = $('#q').value.trim().toLowerCase();
    const f = $('#filter').value;
    const shown = rows.filter(({ p }) =>
      (f === 'all' || (p.status || 'active') === f) &&
      (!q || [fullName(p), p.condition, p.phone, p.email].join(' ').toLowerCase().includes(q)));
    $('#list').innerHTML = shown.length
      ? shown.map(({ p, a, last }) => `
        <li><a class="pitem" href="#/patient/${p.id}"><div class="card">
          ${avatar(p)}
          <div class="grow">
            <div class="pname">${esc(fullName(p))} ${p.status === 'discharged' ? '<span class="badge gray">Discharged</span>' : ''}</div>
            <div class="muted small">${[age(p.dob) != null ? age(p.dob) + ' y' : '', p.condition].filter(Boolean).map(esc).join(' · ') || 'No condition recorded'}</div>
            <div class="muted small">${a.visitCount} visit${a.visitCount === 1 ? '' : 's'}${last ? ' · last ' + fmtDate(last.date) : ''}</div>
          </div>
          ${spark(series(byPatient.get(p.id) || [], 'pain'))}
          <div style="text-align:right">
            <span class="badge ${STATUS_BADGE[a.status]}">${STATUS_LABEL[a.status]}</span>
            ${a.alerts.length || a.flags.length ? '<div class="small bad" style="margin-top:.25rem">⚠ needs attention</div>' : ''}
          </div></div></a></li>`).join('')
      : patients.length ? '<li class="card muted">No patients match.</li>'
      : `<li class="card empty"><svg viewBox="0 0 160 120" aria-hidden="true"><rect x="30" y="20" width="100" height="84" rx="14" fill="var(--brand-l)"/><circle cx="80" cy="52" r="16" fill="var(--brand)"/><path d="M52 94c4-16 52-16 56 0" fill="var(--brand)"/><path d="M122 18v18M113 27h18" stroke="var(--accent)" stroke-width="5" stroke-linecap="round"/></svg>
          <h2>Add your first patient</h2><p class="muted">Create a profile, then record voice notes during the visit.</p><a class="btn primary" href="#/patient/new">+ New patient</a></li>`;
  };
  $('#claim')?.addEventListener('click', async () => {
    try {
      const d = await db.readLegacy();
      for (const p of d.patients) await db.put('patients', p);
      for (const v of d.visits) await db.put('visits', v);
      for (const a of d.audio) await db.put('audio', a);
      try { // old plaintext settings (incl. API key) -> encrypted settings
        const old = JSON.parse(localStorage.getItem('physio-notes-settings') || 'null');
        if (old) { saveSettings({ ...getSettings(), ...old }); localStorage.removeItem('physio-notes-settings'); }
      } catch { /* ignore */ }
      await db.deleteLegacy();
      toast(`Imported ${d.patients.length} patients and ${d.visits.length} visits`);
      route();
    } catch (e) { toast('Import failed: ' + e.message, true); }
  });
  $('#q').addEventListener('input', draw);
  $('#filter').addEventListener('change', draw);
  draw();
}

// ---------- patient form ----------
async function patientForm(id) {
  const p = id ? await db.get('patients', id) : { status: 'active' };
  if (id && !p) return notFound();
  const f = (name, label, type = 'text', extra = '') =>
    `<div><label for="${name}">${label}</label><input id="${name}" name="${name}" type="${type}" value="${esc(p[name] || '')}" ${extra}></div>`;
  const ta = (name, label, ph = '') =>
    `<div><label for="${name}">${label}</label><textarea id="${name}" name="${name}" placeholder="${esc(ph)}">${esc(p[name] || '')}</textarea></div>`;
  app.innerHTML = `
    <h1>${id ? 'Edit patient' : 'New patient'}</h1>
    <form id="pf" class="stack">
      <div class="card"><h2>Details</h2><div class="grid2">
        ${f('firstName', 'First name *', 'text', 'required autocomplete="off"')}
        ${f('lastName', 'Last name *', 'text', 'required autocomplete="off"')}
        ${f('dob', 'Date of birth', 'date')}
        <div><label for="sex">Sex / gender</label><select id="sex" name="sex">${['', 'Female', 'Male', 'Other / prefer not to say'].map((o) => `<option ${p.sex === o ? 'selected' : ''}>${o}</option>`).join('')}</select></div>
        ${f('phone', 'Phone', 'tel')}
        ${f('email', 'Email', 'email')}
        ${f('occupation', 'Occupation / activities')}
        ${f('referral', 'Referral source / insurer / file #')}
      </div></div>
      <div class="card"><h2>Clinical background</h2><div class="stack">
        <div class="grid2">${f('condition', 'Primary condition / complaint', 'text', 'placeholder="e.g. Right rotator cuff tendinopathy"')}${f('onsetDate', 'Date of onset / injury', 'date')}</div>
        ${ta('history', 'Relevant medical & surgical history')}
        ${ta('medications', 'Medications')}
        ${ta('precautions', 'Precautions, contraindications & allergies')}
        ${ta('goals', 'Patient goals', 'e.g. Return to overhead lifting at work; sleep through the night')}
        <label class="check"><input type="checkbox" name="consent" ${p.consent ? 'checked' : ''}> Consent to assessment/treatment and to record voice notes documented</label>
      </div></div>
      <div class="row"><button class="btn primary" type="submit">Save patient</button><a class="btn" href="${id ? '#/patient/' + id : '#/'}">Cancel</a></div>
    </form>`;
  $('#pf').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const rec = { ...p, id: p.id || uid(), status: p.status || 'active', createdAt: p.createdAt || new Date().toISOString(), updatedAt: new Date().toISOString() };
    for (const [k, v] of fd.entries()) rec[k] = String(v).trim();
    rec.consent = fd.has('consent');
    await db.put('patients', rec);
    toast('Patient saved');
    location.hash = `#/patient/${rec.id}`;
  });
}

// ---------- patient detail ----------
async function patientView(id) {
  const patient = await db.get('patients', id);
  if (!patient) return notFound();
  const visits = sortVisits(await db.byIndex('visits', 'patientId', id));
  const clipCounts = await Promise.all(visits.map((v) => db.countBy('audio', 'visitId', v.id)));
  const a = analyze(patient, visits);
  const settings = getSettings();
  const gemOK = settings.provider !== 'gemini' || !!settings.geminiKey;
  const delta = (t, lowerBetter) => {
    if (!t || t.n < 2) return '<span class="d neutral">baseline</span>';
    const good = lowerBetter ? t.change < 0 : t.change > 0;
    const cls = t.change === 0 ? 'neutral' : good ? 'good' : 'bad';
    return `<span class="d ${cls}">${t.change > 0 ? '+' : ''}${t.change} since start (${esc(t.direction)}${t.plateau ? ', plateau' : ''})</span>`;
  };
  const tile = (k, v, d) => `<div class="tile"><div class="k">${k}</div><div class="v">${v}</div>${d || ''}</div>`;
  const nextLabel = visits.length ? '+ Follow-up visit' : '+ Initial assessment';
  const nextType = visits.length ? 'follow-up' : 'initial';

  app.innerHTML = `
    <div class="stack">
    <div class="card">
      <div class="row between">
        <div class="row" style="flex-wrap:nowrap">${avatar(patient, 'lg')}<div>
          <h1 style="margin:0">${esc(fullName(patient))} ${patient.status === 'discharged' ? '<span class="badge gray">Discharged</span>' : ''}</h1>
          <div class="muted">${[age(patient.dob) != null ? age(patient.dob) + ' y' : '', patient.sex, patient.occupation].filter(Boolean).map(esc).join(' · ')}</div>
          <div class="muted small">${[patient.phone, patient.email].filter(Boolean).map(esc).join(' · ')}</div>
        </div></div>
        <div class="row">
          <a class="btn primary" href="#/patient/${id}/visit/new/${nextType}">${nextLabel}</a>
          <a class="btn" href="#/patient/${id}/edit">Edit</a>
          <button class="btn" id="printBtn">Print</button>
        </div>
      </div>
      <details style="margin-top:.75rem" open>
        <summary>Clinical background</summary>
        <dl class="bg">
          ${[['Condition', patient.condition], ['Onset', patient.onsetDate ? fmtDate(patient.onsetDate) : ''], ['History', patient.history], ['Medications', patient.medications], ['Precautions', patient.precautions], ['Goals', patient.goals], ['Referral', patient.referral]]
            .filter(([, v]) => v).map(([k, v]) => `<dt>${k}</dt><dd>${esc(v)}</dd>`).join('') || '<dd class="muted">Nothing recorded yet.</dd>'}
        </dl>
      </details>
    </div>

    ${a.alerts.length || a.flags.length ? `<div class="banner ${a.flags.length ? 'danger' : 'warn'}" role="alert"><strong>⚠ Review needed</strong><ul>
      ${a.alerts.map((t) => `<li>${esc(t)}</li>`).join('')}
      ${a.flags.map((f) => `<li>Possible red flag: <strong>${esc(f.label)}</strong> — “${esc(f.excerpt)}” <span class="muted">(${fmtDate(f.date)})</span></li>`).join('')}
    </ul><div class="small">Keyword scan only — confirm clinically.</div></div>` : ''}

    <div class="card">
      <div class="row between"><h2>Progress</h2><span class="badge ${STATUS_BADGE[a.status]}">${STATUS_LABEL[a.status]}</span></div>
      ${lineChart([
        { label: 'Pain (0–10, lower is better)', color: 'var(--pain)', points: series(visits, 'pain') },
        { label: 'Function (0–10, higher is better)', color: 'var(--func)', points: series(visits, 'function') },
      ])}
      <div class="tiles">
        ${tile('Pain', a.pain ? a.pain.last + '/10' : '–', delta(a.pain, true))}
        ${tile('Function', a.function ? a.function.last + '/10' : '–', delta(a.function, false))}
        ${tile('Visits', a.visitCount, `<span class="d neutral">${a.episodeDays} days in episode</span>`)}
        ${a.measures.map((m) => tile(esc(m.name), `${m.last}${m.unit ? ' <small>' + esc(m.unit) + '</small>' : ''}`, `<span class="d neutral">from ${m.first} · ${esc(m.direction)}</span>`)).join('')}
      </div>
    </div>

    <div class="card ai-card" id="aiCard">
      <div class="row between"><h2>✨ AI treatment assistant</h2><span class="badge">${esc(providerLabel(settings.provider))}</span></div>
      <p class="muted small" style="margin-top:0">Reviews every note, tracks progress and suggests the course of treatment.
        ${isCloud(settings.provider) && gemOK ? (settings.deidentify ? 'Names, DOB and contact details are removed before sending.' : '<strong class="bad">De-identification is OFF.</strong>') : ''}</p>
      ${gemOK ? '' : '<div class="setup"><strong>Connect Gemini to switch this on.</strong><div class="small">It’s free and takes about a minute. Until then you can still run the quick offline review.</div></div>'}
      <div class="row">
        ${gemOK ? `<button class="btn primary" id="reviewBtn" ${visits.length ? '' : 'disabled'}>Review progress &amp; recommend treatment</button>`
          : `<a class="btn primary" href="#/settings">Connect free Gemini</a><button class="btn" id="offlineBtn" ${visits.length ? '' : 'disabled'}>Quick offline review</button>`}
      </div>
      ${gemOK && settings.provider !== 'local' ? `<div class="row" style="margin-top:.7rem"><input id="askQ" class="grow" placeholder="Ask about this patient, e.g. “How should I progress loading next visit?”"><button class="btn" id="askBtn" ${visits.length ? '' : 'disabled'}>Ask</button></div>` : ''}
      <div id="aiOut">${patient.lastReview ? `<div class="ai-out">${mdToHtml(patient.lastReview.text)}<div class="disclaimer">Saved review · ${fmtDateTime(patient.lastReview.at)} · ${esc(providerLabel(patient.lastReview.provider))}</div></div>` : ''}</div>
      <p class="disclaimer">AI output is decision support only. You remain responsible for clinical decisions and documentation.</p>
    </div>

    <div class="card">
      <div class="row between"><h2>Visit history</h2><span class="muted small">${visits.length} total</span></div>
      ${visits.length ? [...visits].reverse().map((v, i) => visitCard(v, clipCounts[visits.length - 1 - i])).join('') : '<p class="muted">No visits yet.</p>'}
    </div>

    <div class="card row between">
      <span class="muted small">Created ${fmtDate(patient.createdAt)}</span>
      <div class="row">
        <button class="btn sm" id="dischargeBtn">${patient.status === 'discharged' ? 'Reopen file' : 'Mark discharged'}</button>
        <button class="btn sm danger" id="delBtn">Delete patient</button>
      </div>
    </div></div>`;

  $('#printBtn').onclick = () => window.print();
  $('#dischargeBtn').onclick = async () => {
    patient.status = patient.status === 'discharged' ? 'active' : 'discharged';
    patient.updatedAt = new Date().toISOString();
    await db.put('patients', patient);
    route();
  };
  $('#delBtn').onclick = async () => {
    if (!confirm(`Permanently delete ${fullName(patient)} and all ${visits.length} visit(s) and recordings? This cannot be undone.`)) return;
    await db.deletePatient(id);
    toast('Patient deleted');
    location.hash = '#/';
  };

  const out = $('#aiOut');
  const runAI = async (question, forceLocal = false) => {
    const btns = $$('#aiCard button');
    btns.forEach((b) => (b.disabled = true));
    out.innerHTML = '<p class="muted"><span class="spinner"></span> Reviewing notes…</p>';
    try {
      const res = await runReview(patient, visits, { question, forceLocal });
      patient.lastReview = { at: new Date().toISOString(), provider: res.provider, text: res.text };
      await db.put('patients', patient);
      out.innerHTML = `<div class="ai-out">${mdToHtml(res.text)}<div class="disclaimer">${fmtDateTime(patient.lastReview.at)} · ${esc(providerLabel(res.provider))}</div></div>`;
    } catch (e) {
      out.innerHTML = `<div class="banner danger" role="alert">${esc(e.message)}<div style="margin-top:.5rem"><button class="btn sm" id="fallbackBtn">Show offline review instead</button></div></div>`;
      $('#fallbackBtn').onclick = () => runAI('', true);
    } finally {
      btns.forEach((b) => (b.disabled = false));
    }
  };
  if ($('#reviewBtn')) $('#reviewBtn').onclick = () => runAI('');
  if ($('#offlineBtn')) $('#offlineBtn').onclick = () => runAI('', true);
  if ($('#askBtn')) $('#askBtn').onclick = () => { const q = $('#askQ').value.trim(); if (q) runAI(q); };
}

function visitCard(v, clips) {
  const body = [['S', v.subjective], ['O', v.objective], ['A', v.assessment], ['P', v.plan], ['Treatment', v.treatment], ['HEP', v.hep]].filter(([, t]) => (t || '').trim());
  const meas = (v.measures || []).filter((m) => m.name && m.value !== '');
  return `<div class="visit">
    <div class="vh"><strong>${fmtDateTime(v.date)}</strong><span class="badge">${esc(VISIT_TYPES[v.type] || v.type)}</span>
      ${v.status === 'draft' ? '<span class="badge warn">Draft</span>' : ''}
      ${v.pain != null && v.pain !== '' ? `<span class="badge">Pain ${v.pain}</span>` : ''}${v.function != null && v.function !== '' ? `<span class="badge">Function ${v.function}</span>` : ''}
      ${clips ? `<span class="badge gray">🎙 ${clips}</span>` : ''}
      <a class="small" href="#/visit/${v.id}">Open / edit</a></div>
    <dl>${body.map(([k, t]) => `<dt>${k}</dt><dd>${esc(t)}</dd>`).join('')}
      ${meas.length ? `<dt>Measures</dt><dd>${meas.map((m) => `${esc(m.name)}: ${esc(m.value)}${m.unit ? ' ' + esc(m.unit) : ''}`).join(' · ')}</dd>` : ''}</dl>
    ${(v.transcript || '').trim() ? `<details style="margin-top:.4rem"><summary class="small">Transcript</summary><p class="small" style="white-space:pre-wrap">${esc(v.transcript)}</p></details>` : ''}
  </div>`;
}

// ---------- visit form (new / follow-up / edit) ----------
async function visitView(id, pid, requestedType) {
  let v = id ? await db.get('visits', id) : null;
  if (id && !v) return notFound();
  const patient = await db.get('patients', v ? v.patientId : pid);
  if (!patient) return notFound();
  const others = sortVisits((await db.byIndex('visits', 'patientId', patient.id)).filter((x) => !v || x.id !== v.id));
  let existing = !!v;
  let prev;
  if (!v) {
    prev = others[others.length - 1];
    v = {
      id: uid(), patientId: patient.id, date: new Date().toISOString(), status: 'draft', createdAt: new Date().toISOString(),
      type: others.length ? (VISIT_TYPES[requestedType] ? requestedType : 'follow-up') : 'initial',
      pain: null, function: null, subjective: '', objective: '', assessment: '', plan: '', treatment: '', hep: '', transcript: '',
      // carry measure names forward so the same tests are repeated and comparable
      measures: prev ? (prev.measures || []).filter((m) => m.name).map((m) => ({ name: m.name, unit: m.unit, better: m.better, value: '' })) : [],
    };
  } else {
    prev = others.filter((x) => new Date(x.date) < new Date(v.date)).pop();
  }
  const settings = getSettings();
  const chips = (f, cls, lo, hi) => `<div class="chips ${cls}" data-chips="${f}">${[...Array(11).keys()].map((n) => `<button type="button" class="chip ${v[f] === n ? 'on' : ''}" style="--n:${n}" data-n="${n}" aria-pressed="${v[f] === n}">${n}</button>`).join('')}</div><div class="scale"><span>${lo}</span><span>${hi}</span></div>`;
  const ta = (f, label, ph, rows = 4) => `<div><label for="${f}">${label}</label><textarea id="${f}" data-f="${f}" rows="${rows}" placeholder="${esc(ph)}">${esc(v[f])}</textarea></div>`;

  app.innerHTML = `
    <div class="row between" style="margin-bottom:.75rem">
      <div><a href="#/patient/${patient.id}" class="small">← ${esc(fullName(patient))}</a>
        <h1 style="margin:0">${existing ? 'Edit visit' : v.type === 'initial' ? 'Initial assessment' : 'Follow-up visit'}</h1></div>
      <span id="saveState" class="muted small" aria-live="polite">${existing ? 'Saved' : 'Not saved yet'}</span>
    </div>
    <form id="vf" class="stack">
      ${prev ? `<div class="prev"><div><b>Last visit · ${fmtDate(prev.date)}</b> ${prev.pain != null && prev.pain !== '' ? ` · pain ${prev.pain}` : ''}${prev.function != null && prev.function !== '' ? ` · function ${prev.function}` : ''}</div>
        ${prev.assessment ? `<p><b>Assessment:</b> ${esc(prev.assessment)}</p>` : ''}${prev.plan ? `<p><b>Plan:</b> ${esc(prev.plan)}</p>` : ''}${prev.hep ? `<p><b>HEP:</b> ${esc(prev.hep)}</p>` : ''}
        ${patient.goals ? `<p><b>Goals:</b> ${esc(patient.goals)}</p>` : ''}</div>` : (patient.goals ? `<div class="prev"><b>Patient goals:</b> ${esc(patient.goals)}</div>` : '')}

      <div class="card"><div class="grid2">
        <div><label for="date">Date &amp; time</label><input id="date" type="datetime-local" data-f="date" value="${toLocalInput(v.date)}"></div>
        <div><label for="type">Visit type</label><select id="type" data-f="type">${Object.entries(VISIT_TYPES).map(([k, n]) => `<option value="${k}" ${v.type === k ? 'selected' : ''}>${n}</option>`).join('')}</select></div>
      </div>
      <div style="margin-top:1rem"><label>Pain right now — <b id="val-pain">${v.pain ?? '–'}</b>/10</label>${chips('pain', 'pain', 'No pain', 'Worst possible')}</div>
      <div style="margin-top:1rem"><label>Function (ability to do daily tasks) — <b id="val-function">${v.function ?? '–'}</b>/10</label>${chips('function', 'func', 'Unable', 'Fully able')}</div></div>

      <div class="card mic-card"><h2>Voice notes</h2>
        <button type="button" class="mic" id="recBtn" aria-label="Start recording">🎙</button>
        <div id="recLabel" class="muted small" style="margin-top:.4rem">Tap to start recording</div>
        <div class="rec-time" id="recLive" hidden><span id="recTime">0:00</span></div>
        <div class="interim" id="interim" aria-live="off"></div>
        <div id="clips"></div>
        <p class="small muted" style="margin:.6rem 0 0">${!recordingSupported ? '⚠ Audio recording is not supported in this browser. ' : ''}${speechSupported ? 'Live transcription is on while recording (' + esc(settings.speechLang) + ').' : 'Live transcription isn’t available in this browser — recordings are still saved. Use “Transcribe with AI” or type below.'}</p>
        <div style="margin-top:.9rem;text-align:left"><label for="transcript">Transcript (editable)</label>
          <textarea id="transcript" data-f="transcript" rows="6" placeholder="Your recording’s transcript appears here. You can also type, or use your keyboard’s dictation.">${esc(v.transcript)}</textarea></div>
        <div class="row" style="margin-top:.6rem;justify-content:flex-start"><button type="button" class="btn sm" id="soapBtn">✨ Turn transcript into SOAP note</button><span class="muted small" id="soapMsg"></span></div>
      </div>

      <div class="card"><h2>Clinical note</h2><div class="stack">
        ${ta('subjective', '<span class="soap-l">S</span>Subjective — what the patient reports', 'Since last visit… aggravating / easing factors, sleep, function, adherence to HEP')}
        ${ta('objective', '<span class="soap-l">O</span>Objective — what you found', 'Findings today')}
        ${ta('assessment', '<span class="soap-l">A</span>Assessment — your clinical impression', 'Progress vs. last visit and goals')}
        ${ta('plan', '<span class="soap-l">P</span>Plan — next steps', 'Plan / next visit')}
        ${ta('treatment', 'Treatment provided today', 'Manual therapy, exercises, education…', 3)}
        ${ta('hep', 'Home exercise programme / advice', 'Exercises, sets × reps, frequency', 3)}
      </div></div>

      <details class="card" ${v.measures.length ? 'open' : ''}><summary><h2 style="display:inline">Outcome measures</h2> <span class="muted small">(ROM, strength, tests)</span></summary>
        <p class="muted small" style="margin-top:.5rem">ROM, strength, functional tests, questionnaire scores — tracked across visits. Names carry forward to the next visit.</p>
        <div id="measures"></div>
        <button type="button" class="btn sm" id="addMeasure">+ Add measure</button>
      </details>

      <div class="savebar">
        <button type="button" class="btn primary" id="finishBtn">Save &amp; finish</button>
        <button type="button" class="btn" id="draftBtn">Save draft &amp; exit</button>
        <span class="grow"></span>
        <button type="button" class="btn danger sm" id="delVisit">${existing ? 'Delete visit' : 'Discard'}</button>
      </div>
    </form>`;

  $('#vf').addEventListener('submit', (e) => e.preventDefault());

  // --- saving ---
  const state = $('#saveState');
  let discarded = false;
  const save = async () => {
    if (discarded) return;
    v.updatedAt = new Date().toISOString();
    await db.put('visits', v);
    existing = true;
    state.textContent = 'Saved ' + new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  };
  const autosave = debounce(() => save().catch((e) => toast('Autosave failed: ' + e.message, true)), 1000);
  onLeave(() => autosave.flush());
  const touch = () => { state.textContent = 'Saving…'; autosave(); };

  $('#vf').addEventListener('input', (e) => {
    const f = e.target.dataset.f;
    if (f) {
      if (f === 'date') v.date = fromLocalInput(e.target.value);
      else if (f === 'pain' || f === 'function') v[f] = e.target.value === '' ? null : Math.min(10, Math.max(0, parseFloat(e.target.value)));
      else v[f] = e.target.value;
      touch();
    } else if (e.target.dataset.mi !== undefined) {
      v.measures[+e.target.dataset.mi][e.target.dataset.mk] = e.target.value;
      touch();
    }
  });
  $('#vf').addEventListener('change', (e) => {
    if (e.target.dataset.mi !== undefined && e.target.dataset.mk === 'better') { v.measures[+e.target.dataset.mi].better = e.target.value; touch(); }
  });

  $$('[data-chips]').forEach((box) => box.addEventListener('click', (e) => {
    const b = e.target.closest('.chip');
    if (!b) return;
    const f = box.dataset.chips, n = +b.dataset.n;
    v[f] = v[f] === n ? null : n;
    $$('.chip', box).forEach((c) => { const on = v[f] === +c.dataset.n; c.classList.toggle('on', on); c.setAttribute('aria-pressed', on); });
    $('#val-' + f).textContent = v[f] ?? '–';
    touch();
  }));

  // --- measures ---
  const drawMeasures = () => {
    $('#measures').innerHTML = v.measures.map((m, i) => `<div class="mrow">
      <input data-mi="${i}" data-mk="name" value="${esc(m.name)}" placeholder="e.g. Shoulder flexion ROM" aria-label="Measure name">
      <input data-mi="${i}" data-mk="value" value="${esc(m.value)}" inputmode="decimal" placeholder="Value" aria-label="Value">
      <input data-mi="${i}" data-mk="unit" value="${esc(m.unit || '')}" placeholder="Unit (°, kg, s)" aria-label="Unit">
      <select data-mi="${i}" data-mk="better" aria-label="Which direction is better"><option value="up" ${m.better !== 'down' ? 'selected' : ''}>Higher = better</option><option value="down" ${m.better === 'down' ? 'selected' : ''}>Lower = better</option></select>
      <button type="button" class="btn sm" data-rm="${i}" aria-label="Remove measure">✕</button></div>`).join('') || '<p class="muted small">None yet.</p>';
    $$('[data-rm]', $('#measures')).forEach((b) => (b.onclick = () => { v.measures.splice(+b.dataset.rm, 1); drawMeasures(); touch(); }));
  };
  $('#addMeasure').onclick = () => { v.measures.push({ name: '', value: '', unit: '', better: 'up' }); drawMeasures(); touch(); $$('[data-mk=name]').pop()?.focus(); };
  drawMeasures();

  // --- transcript helpers ---
  const appendTranscript = (text) => {
    if (!text) return;
    const t = $('#transcript');
    const stamp = new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    t.value = (t.value.trim() ? t.value.trimEnd() + '\n\n' : '') + `[${stamp}] ${text}`;
    v.transcript = t.value;
    touch();
  };

  // --- audio clips ---
  let urls = [];
  onLeave(() => urls.forEach(URL.revokeObjectURL));
  const drawClips = async () => {
    urls.forEach(URL.revokeObjectURL);
    urls = [];
    const clips = existing ? (await db.byIndex('audio', 'visitId', v.id)).sort((a, b) => a.createdAt.localeCompare(b.createdAt)) : [];
    $('#clips').innerHTML = clips.map((c, i) => {
      const url = URL.createObjectURL(c.blob);
      urls.push(url);
      return `<div class="clip"><div class="row between"><span class="small"><strong>Recording ${i + 1}</strong> · ${fmtDateTime(c.createdAt)} · ${fmtDur(c.durationSec || 0)}</span>
        <span class="row"><button type="button" class="btn sm" data-tr="${c.id}">Transcribe with AI</button><button type="button" class="btn sm danger" data-dc="${c.id}">Delete</button></span></div>
        <audio controls preload="metadata" src="${url}"></audio></div>`;
    }).join('');
    $$('[data-dc]').forEach((b) => (b.onclick = async () => {
      if (!confirm('Delete this recording? The transcript text stays in the note.')) return;
      await db.del('audio', b.dataset.dc);
      drawClips();
    }));
    $$('[data-tr]').forEach((b) => (b.onclick = async () => {
      const clip = clips.find((c) => c.id === b.dataset.tr);
      b.disabled = true; b.innerHTML = '<span class="spinner"></span> Transcribing…';
      try {
        const text = await transcribeAudio(clip.blob);
        clip.transcript = text;
        await db.put('audio', clip);
        appendTranscript(text || '(no speech detected)');
        toast('Transcript added');
      } catch (e) { toast(e.message, true); }
      b.disabled = false; b.textContent = 'Transcribe with AI';
    }));
  };
  drawClips();

  // --- recording ---
  let recorder = null;
  const setMic = (on) => {
    recordingActive = on;
    const b = $('#recBtn');
    b.textContent = on ? '■' : '🎙';
    b.classList.toggle('live', on);
    b.setAttribute('aria-label', on ? 'Stop recording' : 'Start recording');
    $('#recLabel').textContent = on ? 'Recording… tap to stop & save' : 'Tap to start recording';
    $('#recLive').hidden = !on;
  };
  const stopRecording = async () => {
    const r = recorder;
    recorder = null;
    setMic(false);
    $('#interim').textContent = '';
    const res = await r.stop();
    await save(); // make sure the visit exists before attaching audio
    await db.put('audio', { id: uid(), visitId: v.id, blob: res.blob, mime: res.mime, durationSec: res.durationSec, createdAt: new Date().toISOString(), transcript: res.transcript });
    if (res.transcript) appendTranscript(res.transcript);
    else toast('Recording saved. No live transcript was captured — use “Transcribe with AI” or type notes.');
    if (app.contains($('#clips'))) drawClips();
  };
  onLeave(async () => { if (recorder) await stopRecording(); });
  $('#recBtn').onclick = async () => {
    if (recorder) return stopRecording().catch((e) => toast(e.message, true));
    if (!recordingSupported) return toast('This browser cannot record audio. Try Chrome, Edge or Safari over HTTPS.', true);
    const r = new Recorder({
      lang: settings.speechLang,
      onTick: (s) => ($('#recTime').textContent = fmtDur(s)),
      onInterim: (t) => ($('#interim').textContent = (r.finalText ? r.finalText + ' ' : '') + t),
      onFinal: () => ($('#interim').textContent = r.finalText),
      onSpeechError: (err) => toast(`Live transcription issue (${err}). Audio is still being recorded.`, true),
    });
    try { await r.start(); } catch (e) {
      return toast(e.name === 'NotAllowedError' ? 'Microphone permission denied. Allow it in your browser settings.' : 'Could not start recording: ' + e.message, true);
    }
    recorder = r;
    setMic(true);
  };
  const warnUnload = (e) => { if (recorder) { e.preventDefault(); e.returnValue = ''; } };
  window.addEventListener('beforeunload', warnUnload);
  onLeave(() => window.removeEventListener('beforeunload', warnUnload));

  // --- AI: dictation -> SOAP ---
  $('#soapBtn').onclick = async () => {
    const text = $('#transcript').value.trim();
    if (!text) return toast('Record or type some notes first.', true);
    const btn = $('#soapBtn');
    btn.disabled = true; $('#soapMsg').innerHTML = '<span class="spinner"></span> Structuring…';
    try {
      const res = await runSoap(patient, text);
      let filled = 0;
      for (const [k, val] of Object.entries(res)) {
        if (val && !(v[k] || '').trim()) { v[k] = val; $('#' + k).value = val; filled++; }
      }
      $('#soapMsg').textContent = filled ? `Filled ${filled} empty field(s) — please review.` : 'No empty fields to fill (existing text kept).';
      touch();
    } catch (e) { $('#soapMsg').textContent = ''; toast(e.message, true); }
    btn.disabled = false;
  };

  // --- finish / discard ---
  const leaveToPatient = () => (location.hash = `#/patient/${patient.id}`);
  $('#finishBtn').onclick = async () => {
    if (recorder) await stopRecording();
    v.status = 'final';
    await save();
    toast('Visit saved');
    leaveToPatient();
  };
  $('#draftBtn').onclick = async () => { if (recorder) await stopRecording(); await save(); leaveToPatient(); };
  $('#delVisit').onclick = async () => {
    if (!confirm(existing ? 'Delete this visit and its recordings permanently?' : 'Discard this visit?')) return;
    discarded = true;
    if (recorder) { try { await recorder.stop(); } catch { /* ignore */ } recorder = null; }
    if (existing) await db.deleteVisit(v.id);
    leaveToPatient();
  };
}

// ---------- settings ----------
async function settingsView() {
  const s = getSettings();
  const est = navigator.storage?.estimate ? await navigator.storage.estimate().catch(() => null) : null;
  const opt = (val, title, desc, tag = '') => `<label class="opt"><input type="radio" name="provider" value="${val}" ${s.provider === val ? 'checked' : ''}><span><strong>${title}</strong> ${tag}<br><span class="muted small">${desc}</span></span></label>`;
  app.innerHTML = `
    <h1>Settings</h1>
    <div class="stack">
    <div class="card"><h2>✨ AI assistant</h2>
      ${opt('gemini', 'Google Gemini', 'Free. Written treatment recommendations, ask-anything about a patient, dictation → SOAP note, and audio transcription.', '<span class="badge ok">Recommended</span>')}
      ${opt('local', 'Offline only', 'No account. Simple rule-based review of trends, plateaus and red-flag words. Nothing leaves your device.')}
      ${opt('ollama', 'Ollama (advanced)', 'Runs an open-source model on your own computer. Private. Needs ollama.com installed and started with <code>OLLAMA_ORIGINS=*</code>.')}
      <div id="geminiBox" class="stack" hidden style="margin-top:.9rem">
        <div><strong>Connect Gemini in 3 steps</strong>
          <ol class="steps"><li>Open <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener">Google AI Studio → API keys</a> and sign in with a Google account.</li>
          <li>Click <em>Create API key</em> (the free tier needs no payment details) and copy it.</li><li>Paste it below, then press <em>Save &amp; test</em>.</li></ol></div>
        <div><label for="gkey">Gemini API key</label><input id="gkey" type="password" autocomplete="off" value="${esc(s.geminiKey)}" placeholder="Paste your key here"></div>
        <details><summary class="small">Advanced</summary><div style="margin-top:.5rem"><label for="gmodel">Model (auto-corrected if unavailable)</label><input id="gmodel" value="${esc(s.geminiModel)}"></div></details>
        <div class="warnbox"><strong>Privacy:</strong> Gemini’s free tier sends your text/audio to Google, whose terms allow free-tier inputs to be used to improve its products — it is not a health-privacy-compliant arrangement. Use it with patient consent and keep de-identification on, and check your regulator’s rules (e.g. PHIPA / PIPEDA).</div>
      </div>
      <div id="ollamaBox" class="grid2" hidden style="margin-top:.9rem">
        <div><label for="ourl">Ollama URL</label><input id="ourl" value="${esc(s.ollamaUrl)}"></div>
        <div><label for="omodel">Model</label><input id="omodel" value="${esc(s.ollamaModel)}"></div>
      </div>
      <label class="check" style="margin-top:1rem"><input type="checkbox" id="deid" ${s.deidentify ? 'checked' : ''}> Remove names, emails, phone numbers and postal codes before sending to an AI (sends age instead of date of birth)</label>
      <div class="row" style="margin-top:1rem"><button class="btn primary" id="testAI">Save &amp; test</button><span id="aiMsg" class="small muted" aria-live="polite"></span></div>
    </div>

    <div class="card"><h2>Voice</h2>
      <label for="lang">Dictation language</label>
      <select id="lang" style="max-width:260px">${[['en-CA', 'English (Canada)'], ['en-US', 'English (US)'], ['en-GB', 'English (UK)'], ['fr-CA', 'Français (Canada)'], ['es-US', 'Español']].map(([c, n]) => `<option value="${c}" ${s.speechLang === c ? 'selected' : ''}>${n}</option>`).join('')}</select>
      <p class="muted small">Live transcription uses your browser’s speech recognition (Chrome/Edge send audio to their speech service; Safari may too). For maximum privacy, record audio only and transcribe with a local method, or type notes.</p>
    </div>

    <div class="card"><h2>🔒 Account &amp; security</h2>
      <p class="muted small" style="margin-top:0">Signed in as <strong>${esc(session.user.displayName)}</strong> (@${esc(session.user.username)}). Your patients, notes, recordings and API key are encrypted with a key only your password (or recovery key) can unlock. Colleagues using this app can’t see them.</p>
      <div class="grid2"><div><label for="lockMin">Auto-lock after inactivity</label><select id="lockMin">${[5, 10, 15, 30].map((m) => `<option value="${m}" ${s.lockMinutes === m ? 'selected' : ''}>${m} minutes</option>`).join('')}</select></div></div>
      <div class="row" style="margin-top:.8rem"><button class="btn" id="chPw">Change password</button><button class="btn" id="newRec">New recovery key</button><button class="btn danger" id="delAcct">Delete my account</button></div>
    </div>

    <div class="card"><h2>Backup &amp; data</h2>
      <p class="muted small" style="margin-top:0">Data is stored <strong>only on this device</strong>, inside your encrypted account. Clearing browser data or losing the device loses it — export a backup regularly. Backups are <strong>encrypted with a passphrase you choose</strong>, so a stray file can’t leak patient data. They can also be imported on another device.${est ? ` Using ${(est.usage / 1048576).toFixed(1)} MB.` : ''}</p>
      <div class="row">
        <button class="btn" id="expNo">Export encrypted backup</button>
        <button class="btn" id="expYes">Export with audio</button>
        <label class="btn" for="impFile" style="margin:0;color:var(--text)">Import backup…</label><input type="file" id="impFile" accept="application/json,.json" hidden>
        <button class="btn" id="persist">Protect storage from auto-clearing</button>
        <button class="btn danger" id="wipe">Delete all my patient data</button>
      </div><span id="dataMsg" class="small muted"></span>
    </div></div>`;

  const showBoxes = () => {
    const p = $('input[name=provider]:checked').value;
    $('#geminiBox').hidden = p !== 'gemini';
    $('#ollamaBox').hidden = p !== 'ollama';
  };
  $$('input[name=provider]').forEach((r) => r.addEventListener('change', () => { showBoxes(); saveSettings(collect()); }));
  showBoxes();
  const collect = () => ({
    ...getSettings(),
    provider: $('input[name=provider]:checked').value,
    geminiKey: $('#gkey').value.trim(), geminiModel: $('#gmodel').value.trim() || 'gemini-flash-latest',
    ollamaUrl: $('#ourl').value.trim() || 'http://localhost:11434', ollamaModel: $('#omodel').value.trim() || 'llama3.1',
    deidentify: $('#deid').checked, speechLang: $('#lang').value,
  });
  $('#lang').onchange = () => saveSettings(collect());
  $('#testAI').onclick = async () => {
    saveSettings(collect());
    if (collect().provider === 'local') { $('#aiMsg').textContent = '✓ Saved.'; return; }
    $('#aiMsg').innerHTML = '<span class="spinner"></span> Testing…';
    try { $('#aiMsg').textContent = '✓ ' + await testConnection(); } catch (e) { $('#aiMsg').textContent = '✗ ' + e.message; }
  };

  $('#lockMin').onchange = () => saveSettings({ ...getSettings(), lockMinutes: +$('#lockMin').value });

  const exportAll = async (withAudio) => {
    const v = await askDialog({ title: 'Encrypt this backup', text: 'Choose a passphrase. You will need it to restore the backup — it cannot be recovered.', fields: [{ name: 'p1', label: 'Passphrase' }, { name: 'p2', label: 'Repeat passphrase' }], ok: 'Export' });
    if (!v) return;
    if (v.p1 !== v.p2) return toast('Passphrases do not match.', true);
    const bad = auth.validatePassword(v.p1);
    if (bad) return toast(bad, true);
    $('#dataMsg').innerHTML = '<span class="spinner"></span> Encrypting…';
    const [patients, visits, audioRows] = await Promise.all([db.getAll('patients'), db.getAll('visits'), db.getAll('audio')]);
    const audio = withAudio ? await Promise.all(audioRows.map(async ({ blob, ...a }) => ({ ...a, mime: blob.type, data: await blobToBase64(blob) }))) : [];
    const file = await encryptWithPassphrase(v.p1, JSON.stringify({ app: 'physio-notes', version: 2, exportedAt: new Date().toISOString(), patients, visits, audio }));
    download(`physio-notes-backup-${new Date().toISOString().slice(0, 10)}${withAudio ? '-audio' : ''}.enc.json`, new Blob([JSON.stringify(file)], { type: 'application/json' }));
    $('#dataMsg').textContent = `Exported ${patients.length} patients, ${visits.length} visits${withAudio ? `, ${audio.length} recordings` : ''} (encrypted).`;
  };
  $('#expNo').onclick = () => exportAll(false).catch((e) => toast(e.message, true));
  $('#expYes').onclick = () => exportAll(true).catch((e) => toast(e.message, true));
  $('#impFile').onchange = async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    try {
      let d = JSON.parse(await file.text());
      if (d.encrypted) {
        const v = await askDialog({ title: 'Backup passphrase', fields: [{ name: 'p', label: 'Passphrase used when exporting' }], ok: 'Decrypt' });
        if (!v) return;
        d = JSON.parse(await decryptWithPassphrase(v.p, d));
      }
      if (d.app !== 'physio-notes') throw new Error('Not a PhysioNotes backup file.');
      if (!confirm(`Import ${d.patients?.length || 0} patients and ${d.visits?.length || 0} visits into your account? Records with the same ID will be overwritten.`)) return;
      for (const p of d.patients || []) await db.put('patients', p);
      for (const x of d.visits || []) await db.put('visits', x);
      for (const { data, ...a } of d.audio || []) await db.put('audio', { ...a, blob: base64ToBlob(data, a.mime) });
      $('#dataMsg').textContent = 'Import complete.';
    } catch (err) { toast('Import failed: ' + err.message, true); }
  };
  $('#persist').onclick = async () => {
    const ok = navigator.storage?.persist ? await navigator.storage.persist() : false;
    toast(ok ? 'Storage protected from automatic clearing.' : 'Browser declined (installing the app to your home screen may help).', !ok);
  };
  $('#wipe').onclick = async () => {
    const v = await askDialog({ title: 'Delete all patient data?', text: 'This permanently deletes ALL your patients, notes and recordings on this device. Type DELETE to confirm.', fields: [{ name: 'c', label: 'Type DELETE', type: 'text' }], ok: 'Delete everything', danger: true });
    if (!v || v.c !== 'DELETE') return;
    await db.clearPatientData();
    toast('All patient data deleted');
    location.hash = '#/';
  };

  // --- account actions ---
  $('#chPw').onclick = async () => {
    const v = await askDialog({ title: 'Change password', fields: [{ name: 'o', label: 'Current password', ac: 'current-password' }, { name: 'n', label: 'New password', ac: 'new-password' }, { name: 'n2', label: 'Repeat new password', ac: 'new-password' }], ok: 'Change password' });
    if (!v) return;
    if (v.n !== v.n2) return toast('New passwords do not match.', true);
    try { await auth.changePassword(session.user.username, v.o, v.n); toast('Password changed'); } catch (e) { toast(e.message, true); }
  };
  $('#newRec').onclick = async () => {
    const v = await askDialog({ title: 'New recovery key', text: 'This replaces your old recovery key.', fields: [{ name: 'p', label: 'Your password', ac: 'current-password' }], ok: 'Generate' });
    if (!v) return;
    try { await showRecoveryKey(await auth.newRecoveryKey(session.user.username, v.p), session.user.username, () => route()); } catch (e) { toast(e.message, true); }
  };
  $('#delAcct').onclick = async () => {
    const v = await askDialog({ title: 'Delete my account', text: 'Permanently deletes your account and ALL of your encrypted patient data from this device. This cannot be undone. Export a backup first if you need one.', fields: [{ name: 'p', label: 'Your password', ac: 'current-password' }, { name: 'c', label: 'Type DELETE', type: 'text' }], ok: 'Delete account', danger: true });
    if (!v) return;
    if (v.c !== 'DELETE') return toast('Type DELETE to confirm.', true);
    try {
      const id = await auth.removeAccount(session.user.username, v.p);
      await runCleanups();
      session = null; db.lock(); detachSettings(); renderUserbox(); stopIdle();
      await db.destroyUserDb(id);
      toast('Account deleted');
      authView('login');
    } catch (e) { toast(e.message, true); }
  };
}

// ---------- modal dialog ----------
function askDialog({ title, text = '', fields = [], ok = 'Continue', danger = false }) {
  return new Promise((resolve) => {
    const d = document.createElement('dialog');
    d.className = 'modal';
    d.innerHTML = `<form method="dialog" class="stack"><h2>${esc(title)}</h2>${text ? `<p class="muted small" style="margin:0">${esc(text)}</p>` : ''}
      ${fields.map((f) => `<div><label>${esc(f.label)}<input name="${f.name}" type="${f.type || 'password'}" autocomplete="${f.ac || 'off'}" required style="margin-top:.25rem"></label></div>`).join('')}
      <div class="row" style="justify-content:flex-end"><button type="button" class="btn" value="cancel">Cancel</button><button class="btn ${danger ? 'danger' : 'primary'}" value="ok">${esc(ok)}</button></div></form>`;
    document.body.appendChild(d);
    let result = null;
    const form = $('form', d);
    form.addEventListener('submit', (e) => { e.preventDefault(); result = Object.fromEntries(new FormData(form)); d.close(); });
    $('button[value=cancel]', d).onclick = () => d.close();
    d.addEventListener('close', () => { d.remove(); resolve(result); });
    d.showModal();
    d.querySelector('input')?.focus();
  });
}

// ---------- accounts: sign in / sign up / recovery ----------
let session = null;       // { user: {id, username, displayName} }
let lastUserId = null;    // so an auto-lock returns the same person to where they were

function renderUserbox() {
  const box = document.getElementById('userbox');
  const nav = document.querySelector('.topbar nav');
  nav.hidden = !session;
  box.innerHTML = session ? `<span class="userchip" title="@${esc(session.user.username)}"><span class="uav" aria-hidden="true">${esc(session.user.displayName[0].toUpperCase())}</span><span class="uname">${esc(session.user.displayName)}</span></span><button class="btn sm white" id="lockBtn" title="Lock now">🔒 Lock</button><button class="btn sm ghost" id="outBtn" style="color:#fff">Sign out</button>` : '';
  if (session) {
    $('#lockBtn', box).onclick = () => lockApp('Locked.');
    $('#outBtn', box).onclick = () => lockApp('Signed out.', true);
  }
}

async function lockApp(notice, signOut = false) {
  if (!session) return;
  stopIdle();
  await runCleanups(); // flushes autosave and stops any recording before the key is dropped
  lastUserId = signOut ? null : session.user.id;
  session = null;
  db.lock();
  detachSettings();
  document.getElementById('toast').hidden = true;
  renderUserbox();
  authView('login', { notice });
}

async function startSession(user, key) {
  await db.openUser(user.id, key);
  const saved = await db.get('settings', 'main').catch(() => null);
  const { id: _id, ...rest } = saved || {};
  attachSettings(rest, (o) => db.put('settings', { id: 'main', ...o }).catch((e) => console.error(e)));
  session = { user };
  renderUserbox();
  startIdle();
  if (user.id !== lastUserId) history.replaceState(null, '', '#/');
  lastUserId = user.id;
  await route();
}

const busyBtn = (btn, on, label) => { btn.disabled = on; btn.innerHTML = on ? `<span class="spinner"></span> ${label}` : btn.dataset.label; };

function authView(mode, opts = {}) {
  const accounts = auth.listAccounts();
  if (!mode) mode = accounts.length ? 'login' : 'signup';
  document.title = 'PhysioNotes';
  const shell = (inner) => { app.innerHTML = `<div class="auth"><div class="card auth-card"><div class="auth-logo" aria-hidden="true">✚</div>${inner}<p class="disclaimer" style="text-align:center">🔒 Everything you enter is encrypted on this device with your password.</p></div></div>`; };
  const err = (msg) => { const e = $('#authErr'); e.textContent = msg; e.hidden = !msg; };
  const field = (id, label, type = 'text', ac = 'off', extra = '') => `<div><label for="${id}">${label}</label><input id="${id}" name="${id}" type="${type}" autocomplete="${ac}" required ${extra}></div>`;

  if (mode === 'login') {
    shell(`<h1>Welcome back</h1><p class="muted" style="margin-top:0">${opts.notice ? esc(opts.notice) + ' ' : ''}Sign in to open your patients.</p>
      ${accounts.length ? `<div class="picker">${accounts.map((a) => `<button type="button" class="pick" data-u="${esc(a.username)}"><span class="uav">${esc(a.displayName[0].toUpperCase())}</span>${esc(a.displayName)}</button>`).join('')}</div>` : ''}
      <form id="af" class="stack">${field('username', 'Username', 'text', 'username', 'autocapitalize="none" spellcheck="false"')}${field('password', 'Password', 'password', 'current-password')}
      <div id="authErr" class="banner danger" role="alert" hidden></div>
      <button class="btn primary" id="go" data-label="Sign in" type="submit">Sign in</button></form>
      <div class="row between small" style="margin-top:.8rem"><a href="#" id="toRecover">Forgot password?</a><a href="#" id="toSignup">Create an account</a></div>`);
    $$('.pick').forEach((b) => (b.onclick = () => { $('#username').value = b.dataset.u; $('#password').focus(); }));
    if (accounts.length === 1) $('#username').value = accounts[0].username;
    (accounts.length === 1 ? $('#password') : $('#username')).focus();
    $('#toSignup').onclick = (e) => { e.preventDefault(); authView('signup'); };
    $('#toRecover').onclick = (e) => { e.preventDefault(); authView('recover'); };
    $('#af').onsubmit = async (e) => {
      e.preventDefault(); err('');
      busyBtn($('#go'), true, 'Unlocking…');
      try { const { user, key } = await auth.logIn($('#username').value, $('#password').value); await startSession(user, key); }
      catch (x) { err(x.message); busyBtn($('#go'), false); $('#password').value = ''; $('#password').focus(); }
    };
  } else if (mode === 'signup') {
    shell(`<h1>${accounts.length ? 'Create your account' : 'Set up PhysioNotes'}</h1>
      <p class="muted" style="margin-top:0">Each clinician has a private account. Patients and notes you add are visible <strong>only to you</strong>.</p>
      <form id="af" class="stack">${field('displayName', 'Your name', 'text', 'name', 'placeholder="e.g. Sam Patel, RPT"')}${field('username', 'Username', 'text', 'username', 'autocapitalize="none" spellcheck="false" placeholder="letters and numbers"')}
      ${field('password', `Password (min ${auth.MIN_PASSWORD} characters)`, 'password', 'new-password')}${field('password2', 'Repeat password', 'password', 'new-password')}
      <div class="warnbox">There’s no central server, so <strong>nobody can reset your password for you</strong>. You’ll get a one-time recovery key on the next screen — keep it somewhere safe.</div>
      <div id="authErr" class="banner danger" role="alert" hidden></div>
      <button class="btn primary" id="go" data-label="Create account" type="submit">Create account</button></form>
      ${accounts.length ? '<p class="small" style="text-align:center"><a href="#" id="toLogin">Back to sign in</a></p>' : ''}`);
    $('#toLogin')?.addEventListener('click', (e) => { e.preventDefault(); authView('login'); });
    $('#displayName').focus();
    $('#af').onsubmit = async (e) => {
      e.preventDefault(); err('');
      if ($('#password').value !== $('#password2').value) return err('Passwords do not match.');
      busyBtn($('#go'), true, 'Creating encrypted account…');
      try {
        const r = await auth.signUp({ username: $('#username').value, displayName: $('#displayName').value, password: $('#password').value });
        await showRecoveryKey(r.recoveryKey, r.user.username, () => startSession(r.user, r.key));
      } catch (x) { err(x.message); busyBtn($('#go'), false); }
    };
  } else if (mode === 'recover') {
    shell(`<h1>Reset password</h1><p class="muted" style="margin-top:0">Enter the recovery key you saved when you created your account.</p>
      <form id="af" class="stack">${field('username', 'Username', 'text', 'username', 'autocapitalize="none"')}${field('rkey', 'Recovery key', 'text', 'off', 'placeholder="XXXX-XXXX-XXXX-…" spellcheck="false" autocapitalize="characters"')}
      ${field('password', `New password (min ${auth.MIN_PASSWORD} characters)`, 'password', 'new-password')}
      <div id="authErr" class="banner danger" role="alert" hidden></div>
      <button class="btn primary" id="go" data-label="Reset password" type="submit">Reset password</button></form>
      <p class="small" style="text-align:center"><a href="#" id="toLogin">Back to sign in</a></p>`);
    $('#toLogin').onclick = (e) => { e.preventDefault(); authView('login'); };
    $('#af').onsubmit = async (e) => {
      e.preventDefault(); err('');
      busyBtn($('#go'), true, 'Resetting…');
      try {
        const u = $('#username').value;
        const r = await auth.resetWithRecovery(u, $('#rkey').value, $('#password').value);
        await showRecoveryKey(r.recoveryKey, u, () => authView('login', { notice: 'Password reset — please sign in.' }), 'Password reset. Your old recovery key no longer works — save this new one.');
      } catch (x) { err(x.message); busyBtn($('#go'), false); }
    };
  }
}

function showRecoveryKey(key, username, next, heading = 'Save your recovery key') {
  return new Promise((resolve) => {
    app.innerHTML = `<div class="auth"><div class="card auth-card stack"><div class="auth-logo" aria-hidden="true">🔑</div><h1>${esc(heading)}</h1>
      <p class="muted" style="margin:0">If you forget your password, this key is the <strong>only</strong> way back into your patient data. It is shown once. Store it in a password manager or print it and keep it somewhere safe — not on this computer’s desktop.</p>
      <div class="reckey" id="rk" aria-label="Recovery key">${esc(key)}</div>
      <div class="row"><button class="btn" id="dlKey">⬇ Download</button><button class="btn" id="cpKey">Copy</button><button class="btn" id="prKey">Print</button></div>
      <label class="check"><input type="checkbox" id="saved"> I’ve saved my recovery key somewhere safe</label>
      <button class="btn primary" id="cont" disabled>Continue</button></div></div>`;
    $('#saved').onchange = (e) => ($('#cont').disabled = !e.target.checked);
    $('#dlKey').onclick = () => download('physionotes-recovery-key.txt', new Blob([`PhysioNotes recovery key for @${username}

${key}

Keep this private. Anyone with it and your username can reset your password.
`], { type: 'text/plain' }));
    $('#cpKey').onclick = () => navigator.clipboard?.writeText(key).then(() => toast('Copied'), () => toast('Copy failed — select and copy manually.', true));
    $('#prKey').onclick = () => window.print();
    $('#cont').onclick = async () => { await next(); resolve(); };
  });
}

// ---------- auto-lock ----------
let lastActive = Date.now();
let idleTimer = null;
const bump = () => { lastActive = Date.now(); };
const ACTIVITY = ['pointerdown', 'keydown', 'touchstart', 'scroll', 'input'];
function idleCheck() {
  if (!session || recordingActive) return;
  if (Date.now() - lastActive > (getSettings().lockMinutes || 10) * 60000) lockApp('Locked after inactivity.');
}
function startIdle() {
  lastActive = Date.now();
  ACTIVITY.forEach((ev) => window.addEventListener(ev, bump, { passive: true, capture: true }));
  idleTimer = setInterval(idleCheck, 10000);
  document.addEventListener('visibilitychange', idleCheck);
}
function stopIdle() {
  ACTIVITY.forEach((ev) => window.removeEventListener(ev, bump, { capture: true }));
  clearInterval(idleTimer);
  document.removeEventListener('visibilitychange', idleCheck);
}

// ---------- boot ----------
if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js').catch(() => {});
navigator.storage?.persist?.().catch(() => {});
renderUserbox();
route(); // not signed in yet -> shows the sign-in / set-up screen
