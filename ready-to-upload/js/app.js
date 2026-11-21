import * as db from './db.js';
import * as auth from './auth.js';
import * as sync from './sync.js';
import * as central from './central.js';
import { beginAuth, takeAuthReturn, exchangeCode, redirectUri } from './dropbox.js';
import { encryptWithPassphrase, decryptWithPassphrase, generateClinicKeyPair } from './crypto.js';
import { openRecovered, toBackup } from './recovery.js';
import { esc, uid, fmtDate, fmtDateTime, fmtDur, age, debounce, toLocalInput, fromLocalInput, mdToHtml, download, blobToBase64, base64ToBlob } from './util.js';
import { analyze, sortVisits, series, STATUS_LABEL } from './analysis.js';
import { lineChart } from './charts.js';
import { attachSettings, detachSettings, getSettings, saveSettings, runReview, runSoap, transcribeAudio, testConnection, providerLabel, isCloud } from './ai.js';
import { Recorder, speechSupported, recordingSupported } from './voice.js';

const app = document.getElementById('app');
const CLINIC_ON = central.enabled(); // clinic mode: central sign-in, approval, admin directory
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
let lockNotice = '';
async function route() {
  await runCleanups();
  if (!session) return authView();
  const hadSession = true;
  const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean).map(decodeURIComponent);
  $$('[data-nav]', document).forEach((a) => a.classList.toggle('active', a.dataset.nav === (parts[0] === 'settings' ? 'settings' : parts[0] === 'admin' ? 'admin' : 'patients')));
  try {
    if (CLINIC_ON && session?.profile?.role === 'admin' && !session.profile.clinic_key) await recoverySetupView(); // admins must finish this before anything else
    else if (!parts.length) await patientsView();
    else if (parts[0] === 'settings') await settingsView();
    else if (parts[0] === 'admin' && parts[1] === 'recover') await recoverView(parts[2]);
    else if (parts[0] === 'admin') await adminView();
    else if (parts[0] === 'patient' && parts[1] === 'new') await patientForm();
    else if (parts[0] === 'patient' && parts[2] === 'edit') await patientForm(parts[1]);
    else if (parts[0] === 'patient' && parts[2] === 'visit' && parts[3] === 'new') await visitView(null, parts[1], parts[4]);
    else if (parts[0] === 'patient') await patientView(parts[1]);
    else if (parts[0] === 'visit') await visitView(parts[1]);
    else notFound();
  } catch (e) {
    if (session) { console.error(e); app.innerHTML = `<div class="card"><h2>Something went wrong</h2><p>${esc(e.message)}</p><a class="btn" href="#/">Back</a></div>`; }
  }
  // The app was locked while this page was still being drawn: discard whatever it drew and restore the sign-in screen,
  // so decrypted data can never be left on screen (or an error page shown) after locking.
  if (hadSession && !session) return authView('login', { notice: lockNotice });
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
      ${v.conflictOf ? '<span class="badge danger">Conflict copy</span>' : ''}${v.status === 'draft' ? '<span class="badge warn">Draft</span>' : ''}
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
    ${v.conflictOf ? `<div class="banner warn" style="margin-bottom:.75rem"><strong>Conflict copy.</strong> This visit was edited on two devices at once. The other version was kept as <a href="#/visit/${esc(v.conflictOf)}">the original visit</a>. Copy across anything you need, then delete one of them.</div>` : ''}
    <div class="banner warn" id="remoteBanner" hidden style="margin-bottom:.75rem"><strong>This visit was changed on another device.</strong> <button type="button" class="btn sm" id="loadTheirs">Load their version</button> <button type="button" class="btn sm" id="keepMine">Keep mine</button></div>
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

  let discarded = false;
  const onRemoteChange = (e) => { if (e.detail.has('v:' + v.id)) $('#remoteBanner').hidden = false; };
  window.addEventListener('remote-change', onRemoteChange);
  onLeave(() => window.removeEventListener('remote-change', onRemoteChange));
  $('#loadTheirs').onclick = () => { discarded = true; route(); };
  $('#keepMine').onclick = () => { $('#remoteBanner').hidden = true; };

  // --- saving ---
  const state = $('#saveState');
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

    ${syncCard()}

    <div class="card"><h2>🔒 Account &amp; security</h2>
      <p class="muted small" style="margin-top:0">Signed in as <strong>${esc(session.user.displayName)}</strong> (@${esc(session.user.username)}). Your patients, notes, recordings and API key are encrypted with a key only your password (or recovery key) can unlock. Colleagues using this app can’t see them.${CLINIC_ON && session.profile?.clinic_key ? ` <strong>Clinic recovery is on</strong> (key ${esc(session.profile.clinic_key.kid)}): if your account is ever disabled, the clinic can recover your patient records for continuity of care; each use is logged.` : ''}</p>
      <div class="grid2"><div><label for="lockMin">Auto-lock after inactivity</label><select id="lockMin">${[5, 10, 15, 30].map((m) => `<option value="${m}" ${s.lockMinutes === m ? 'selected' : ''}>${m} minutes</option>`).join('')}</select></div></div>
      <div class="row" style="margin-top:.8rem"><button class="btn" id="chPw">Change password</button><button class="btn" id="newRec">New recovery key</button><button class="btn danger" id="delAcct">Delete my account</button></div>
      <h3 style="margin:1.2rem 0 .4rem">Accounts on this device</h3>
      <ul class="plist" style="gap:.4rem">${auth.listAccounts().map((a) => `<li class="row" style="gap:.6rem"><span class="uav" style="background:var(--brand-l)">${esc((a.displayName || a.username)[0].toUpperCase())}</span><span class="grow"><strong>${esc(a.displayName)}</strong> <span class="muted small">@${esc(a.username)} · created ${fmtDate(a.createdAt)}</span></span>${a.id === session.user.id ? '<span class="badge ok">You</span>' : ''}</li>`).join('')}</ul>
      <p class="muted small" style="margin-bottom:0">This list is stored only on this device. PhysioNotes has no central server and doesn’t collect email addresses, so there is no master list of users — each person’s patients stay private to them.</p>
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

  wireSyncCard();
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
    try {
      const oldSecret = central.currentSecret();
      await auth.changePassword(session.user.username, v.o, v.n, CLINIC_ON ? {
        // the clinic server is updated first; if that fails nothing changes on this device either
        commit: async ({ account, authSecret }) => {
          await central.updatePassword(authSecret);
          try { await central.rpc('update_account_blob', { blob: account }); }
          catch (e) { if (oldSecret) await central.updatePassword(oldSecret).catch(() => {}); throw e; }
        },
      } : {});
      toast('Password changed');
      if (!CLINIC_ON) await sync.pushAccount(auth.publicAccount(session.user.username)).catch(() => toast('Password changed here, but it could not be saved to Dropbox yet — other devices keep the old password until you change it again while online.', true));
    } catch (e) { toast(e instanceof TypeError ? 'You need to be online to change your password.' : e.message, true); }
  };
  $('#newRec').onclick = async () => {
    const v = await askDialog({ title: 'New recovery key', text: 'This replaces your old recovery key.', fields: [{ name: 'p', label: 'Your password', ac: 'current-password' }], ok: 'Generate' });
    if (!v) return;
    try {
      const k = await auth.newRecoveryKey(session.user.username, v.p, CLINIC_ON ? { commit: async ({ account }) => { await central.rpc('update_account_blob', { blob: account }); } } : {});
      if (!CLINIC_ON) await sync.pushAccount(auth.publicAccount(session.user.username)).catch(() => {});
      await showRecoveryKey(k, session.user.username, () => route());
    } catch (e) { toast(e.message, true); }
  };
  $('#delAcct').onclick = async () => {
    const v = await askDialog({ title: 'Delete my account', text: 'Permanently deletes your account and ALL of your encrypted patient data from this device. This cannot be undone. Export a backup first if you need one.', fields: [{ name: 'p', label: 'Your password', ac: 'current-password' }, { name: 'c', label: 'Type DELETE', type: 'text' }], ok: 'Delete account', danger: true });
    if (!v) return;
    if (v.c !== 'DELETE') return toast('Type DELETE to confirm.', true);
    try {
      const id = await auth.removeAccount(session.user.username, v.p, { beforeRemove: CLINIC_ON ? () => central.rpc('delete_me') : undefined });
      await runCleanups();
      if (sync.isEnabled()) await sync.disable({ deleteRemote: confirm('Also delete this account’s encrypted copy from your Dropbox?\n\nOK = delete it from Dropbox too\nCancel = leave it in Dropbox') }).catch((e) => toast('Could not update Dropbox: ' + e.message, true));
      session = null; db.lock(); detachSettings(); renderUserbox(); stopIdle();
      await db.destroyUserDb(id);
      toast('Account deleted');
      authView('login');
    } catch (e) { toast(e.message, true); }
  };
}

// ---------- sync settings card ----------
function syncCard() {
  if (CLINIC_ON) {
    return `<div class="card"><div class="row between"><h2>☁ Clinic sync</h2><span class="badge ok">${esc(central.clinicName())}</span></div>
      <p class="muted small" style="margin-top:0">Your notes sync automatically between your devices through the clinic’s server. Everything is encrypted on this device first, so neither the server nor the clinic administrators can read your patients.</p>
      <div class="small" id="syncInfo" aria-live="polite"></div><div class="row" style="margin-top:.7rem"><button class="btn" id="syncNow">Sync now</button></div></div>`;
  }
  const on = sync.isEnabled();
  if (on) {
    return `<div class="card"><div class="row between"><h2>☁ Sync across devices</h2><span class="badge ok">Connected to Dropbox</span></div>
      <p class="muted small" style="margin-top:0">Changes sync automatically between your devices. Everything is encrypted on this device first, so Dropbox only stores unreadable files.</p>
      <div class="small" id="syncInfo" aria-live="polite"></div>
      <div class="row" style="margin-top:.7rem"><button class="btn" id="syncNow">Sync now</button><button class="btn danger" id="syncOff">Disconnect…</button></div></div>`;
  }
  const key = (() => { try { return localStorage.getItem('physio-dbx-appkey') || ''; } catch { return ''; } })();
  return `<div class="card"><h2>☁ Sync across devices</h2>
    <p class="muted small" style="margin-top:0">Use PhysioNotes on your phone <em>and</em> laptop. Notes and recordings are encrypted here before they are saved in <strong>your own Dropbox</strong>, so Dropbox can’t read them. Needs the app to be opened from a secure (https) address.</p>
    <details><summary>One-time Dropbox setup (about 5 minutes)</summary>
      <ol class="steps"><li>Open <a href="https://www.dropbox.com/developers/apps" target="_blank" rel="noopener">dropbox.com/developers/apps</a> and click <em>Create app</em>.</li>
      <li>Choose <em>Scoped access</em> → <em>App folder</em>, and give it a name (e.g. “PhysioNotes-yourname”).</li>
      <li>On the <em>Permissions</em> tab tick <code>files.metadata.read</code>, <code>files.metadata.write</code>, <code>files.content.read</code>, <code>files.content.write</code>, then <em>Submit</em>.</li>
      <li>On the <em>Settings</em> tab, add this under <em>Redirect URIs</em> and click <em>Add</em>: <code id="redir">${esc(redirectUri())}</code> <button class="btn sm" id="cpRedir" type="button">Copy</button></li>
      <li>Copy the <em>App key</em> from the same page and paste it below.</li></ol></details>
    <div class="row" style="margin-top:.8rem"><input id="appKey" class="grow" value="${esc(key)}" placeholder="Dropbox App key" autocomplete="off" spellcheck="false"><button class="btn primary" id="dbxConnect">Connect Dropbox</button></div>
    <p class="disclaimer">On your other device: open PhysioNotes → sign-in screen → “Set up from Dropbox”, using the same App key. Register each web address you use (e.g. your phone’s and laptop’s) as a redirect URI.</p></div>`;
}
function wireSyncCard() {
  if (CLINIC_ON || sync.isEnabled()) {
    const show = (st) => { const el = $('#syncInfo'); if (el) el.textContent = ({ idle: 'Up to date', syncing: 'Syncing…', offline: 'Offline — will sync when you’re back online', error: st.msg || 'Sync problem' }[st.status] || '') + (st.last ? ` · last synced ${new Date(st.last).toLocaleTimeString()}` : ''); };
    show(sync.state);
    const h = (e) => show(e.detail);
    window.addEventListener('sync-status', h);
    onLeave(() => window.removeEventListener('sync-status', h));
    $('#syncNow').onclick = () => sync.syncNow();
    if ($('#syncOff')) $('#syncOff').onclick = async () => {
      if (!confirm('Disconnect Dropbox on this account? Your data stays on this device and keeps working. Other devices stop receiving changes.')) return;
      const del = confirm('Also delete the encrypted copy from Dropbox?\n\nOK = delete it from Dropbox\nCancel = leave it in Dropbox');
      try { await sync.disable({ deleteRemote: del }); toast('Dropbox disconnected'); updateChip({ status: 'off' }); route(); } catch (e) { toast(e.message, true); }
    };
    return;
  }
  $('#cpRedir').onclick = () => navigator.clipboard?.writeText(redirectUri()).then(() => toast('Copied'), () => {});
  $('#dbxConnect').onclick = () => {
    const k = $('#appKey').value.trim();
    if (!k) return toast('Paste your Dropbox App key first.', true);
    try { localStorage.setItem('physio-dbx-appkey', k); } catch { /* ignore */ }
    if (!crypto.subtle || location.protocol === 'file:') return toast('Open the app from https:// (or localhost) to connect Dropbox.', true);
    beginAuth(k, 'enable');
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
  box.innerHTML = session ? `<span class="userchip" title="@${esc(session.user.username)}"><span class="uav" aria-hidden="true">${esc(session.user.displayName[0].toUpperCase())}</span><span class="uname">${esc(session.user.displayName)}</span></span><button class="btn sm ghost syncchip" id="syncChip" hidden title="Sync now"></button><button class="btn sm white" id="lockBtn" title="Lock now">🔒 Lock</button><button class="btn sm ghost" id="outBtn" style="color:#fff">Sign out</button>` : '';
  applyProfile();
  if (session) {
    $('#syncChip', box).onclick = () => sync.syncNow();
    $('#lockBtn', box).onclick = () => lockApp('Locked.');
    $('#outBtn', box).onclick = () => lockApp('Signed out.', true);
  }
}

async function lockApp(notice, signOut = false) {
  if (!session) return;
  stopIdle();
  lockNotice = notice;
  await runCleanups(); // flushes autosave and stops any recording before the key is dropped
  await sync.stop();   // pushes pending edits to the cloud folder, then detaches
  lastUserId = signOut ? null : session.user.id;
  if (CLINIC_ON) { if (signOut) await central.signOut(); else central.clear(); }
  session = null;
  db.lock();
  detachSettings();
  document.getElementById('toast').hidden = true;
  renderUserbox();
  authView('login', { notice });
}

const syncHooks = { onStatus: (st) => updateChip(st), onRemote: (c) => handleRemote(c) };
let pendingDbx = null; // { tokens, intent } between returning from Dropbox and signing in

const CHIP = { idle: '☁ Synced', syncing: '⟳ Syncing…', offline: '☁ Offline', error: '⚠ Sync issue' };
function updateChip(st) {
  const c = document.getElementById('syncChip');
  if (!c) return;
  c.hidden = st.status === 'off';
  c.textContent = CHIP[st.status] || '';
  c.title = st.msg || (st.last ? 'Last synced ' + new Date(st.last).toLocaleTimeString() + ' — click to sync now' : 'Sync now');
  c.classList.toggle('bad', st.status === 'error');
}

async function handleRemote(changed) {
  if (!session) return;
  if (changed.has('s:main')) {
    const saved = await db.get('settings', 'main').catch(() => null);
    if (saved) { const { id: _i, ...rest } = saved; attachSettings(rest, (o) => db.put('settings', { id: 'main', ...o, updatedAt: new Date().toISOString() }).catch(console.error)); }
  }
  window.dispatchEvent(new CustomEvent('remote-change', { detail: changed }));
  const h = location.hash;
  if (h.startsWith('#/visit/') || h.includes('/visit/new') || h.startsWith('#/settings') || /\/edit$/.test(h) || h === '#/patient/new') return; // don't disturb an open form
  await route();
}

async function handleDropboxReturn(ret) {
  if (ret.error) return authView(undefined, { notice: ret.error });
  try {
    const tokens = await exchangeCode(ret);
    pendingDbx = { tokens, intent: ret.intent };
    if (ret.intent === 'newdevice') return await newDeviceView();
    authView('login', { notice: 'Dropbox is authorized. Sign in to finish connecting.' });
  } catch (e) { authView(undefined, { notice: 'Dropbox connection failed: ' + e.message }); }
}

// Set up this device from an existing account stored in the user's Dropbox.
async function newDeviceView() {
  app.innerHTML = `<div class="auth"><div class="card auth-card"><div class="auth-logo" aria-hidden="true">☁</div><h1>Your Dropbox</h1><p class="muted"><span class="spinner"></span> Looking for your PhysioNotes account…</p></div></div>`;
  let found = [];
  try { found = await sync.findAccounts(pendingDbx.tokens); } catch (e) { pendingDbx = null; return authView('login', { notice: 'Could not read Dropbox: ' + e.message }); }
  app.innerHTML = `<div class="auth"><div class="card auth-card stack"><div class="auth-logo" aria-hidden="true">☁</div><h1>${found.length ? 'Choose your account' : 'Nothing found yet'}</h1>
    ${found.length ? `<p class="muted" style="margin:0">Pick the account to open on this device. You’ll sign in with the same password you use elsewhere.</p>
      <div class="picker" style="flex-direction:column;align-items:stretch">${found.map((a, i) => `<button type="button" class="pick" data-i="${i}"><span class="uav">${esc((a.displayName || a.username)[0].toUpperCase())}</span>${esc(a.displayName || a.username)} <span class="muted small">@${esc(a.username)}</span></button>`).join('')}</div>`
      : '<p class="muted">This Dropbox has no PhysioNotes account yet. On your first device, open Settings → Sync across devices and connect Dropbox first.</p>'}
    <div id="authErr" class="banner danger" role="alert" hidden></div>
    <a href="#" id="back" class="small" style="text-align:center">Cancel</a></div></div>`;
  $('#back').onclick = (e) => { e.preventDefault(); pendingDbx = null; authView('login'); };
  $$('.pick').forEach((b) => (b.onclick = () => {
    try {
      const u = auth.importAccount(found[+b.dataset.i]);
      authView('login', { notice: `Account added. Sign in as ${u.displayName}.` });
      $('#username').value = u.username; $('#password').focus();
    } catch (e) { const el = $('#authErr'); el.textContent = e.message; el.hidden = false; }
  }));
}

async function startSession(user, key, profile = null) {
  await db.openUser(user.id, key);
  const saved = await db.get('settings', 'main').catch(() => null);
  const { id: _id, ...rest } = saved || {};
  attachSettings(rest, (o) => db.put('settings', { id: 'main', ...o, updatedAt: new Date().toISOString() }).catch((e) => console.error(e)));
  session = { user, profile };
  renderUserbox();
  startIdle();
  const hooks = syncHooks;
  try {
    if (CLINIC_ON) { if (central.hasSession()) await sync.startCentral(user, hooks); }
    else if (pendingDbx) {
      const p = pendingDbx; pendingDbx = null;
      await sync.enable(p.tokens, user, auth.publicAccount(user.username), hooks);
      toast('Dropbox connected — syncing…');
    } else await sync.start(user, hooks);
  } catch (e) { console.error(e); toast('Could not start sync: ' + e.message, true); }
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
    shell(`<h1>Welcome back</h1><p class="muted" style="margin-top:0">${opts.notice ? esc(opts.notice) + ' ' : ''}${CLINIC_ON ? 'Sign in to ' + esc(central.clinicName()) + '.' : 'Sign in to open your patients.'}</p>
      ${accounts.length ? `<div class="picker">${accounts.map((a) => `<button type="button" class="pick" data-u="${esc(a.username)}"><span class="uav">${esc(a.displayName[0].toUpperCase())}</span>${esc(a.displayName)}</button>`).join('')}</div>` : ''}
      <form id="af" class="stack">${CLINIC_ON ? field('username', 'Email', 'email', 'username', 'autocapitalize="none" spellcheck="false"') : field('username', 'Username', 'text', 'username', 'autocapitalize="none" spellcheck="false"')}${field('password', 'Password', 'password', 'current-password')}
      <div id="authErr" class="banner danger" role="alert" hidden></div>
      <button class="btn primary" id="go" data-label="Sign in" type="submit">Sign in</button></form>
      <div class="row between small" style="margin-top:.8rem"><a href="#" id="toRecover">Forgot password?</a><a href="#" id="toSignup">Create an account</a></div>
      ${CLINIC_ON ? '' : '<p class="small" style="text-align:center;margin:.9rem 0 0"><a href="#" id="toDevice">Already use PhysioNotes on another device? Set up from Dropbox →</a></p>'}`);
    $('#toDevice')?.addEventListener('click', (e) => { e.preventDefault(); deviceConnectView(); });
    $$('.pick').forEach((b) => (b.onclick = () => { $('#username').value = b.dataset.u; $('#password').focus(); }));
    if (accounts.length === 1) $('#username').value = accounts[0].username;
    (accounts.length === 1 ? $('#password') : $('#username')).focus();
    $('#toSignup').onclick = (e) => { e.preventDefault(); authView('signup'); };
    $('#toRecover').onclick = (e) => { e.preventDefault(); authView('recover'); };
    $('#af').onsubmit = async (e) => {
      e.preventDefault(); err('');
      busyBtn($('#go'), true, 'Unlocking…');
      try {
        if (CLINIC_ON) await clinicSignIn($('#username').value, $('#password').value);
        else { const { user, key } = await auth.logIn($('#username').value, $('#password').value); await startSession(user, key); }
      }
      catch (x) { err(x.message); busyBtn($('#go'), false); $('#password').value = ''; $('#password').focus(); }
    };
  } else if (mode === 'signup') {
    shell(`<h1>${accounts.length ? 'Create your account' : 'Set up PhysioNotes'}</h1>
      <p class="muted" style="margin-top:0">Each clinician has a private account. Patients and notes you add are visible <strong>only to you</strong>.${CLINIC_ON ? ' New accounts must be approved by your clinic administrator before you can sign in.' : ''}</p>
      <form id="af" class="stack">${field('displayName', 'Your name', 'text', 'name', 'placeholder="e.g. Sam Patel, RPT"')}${CLINIC_ON ? field('username', 'Work email', 'email', 'username', 'autocapitalize="none" spellcheck="false"') : field('username', 'Username', 'text', 'username', 'autocapitalize="none" spellcheck="false" placeholder="letters and numbers"')}
      ${field('password', `Password (min ${auth.MIN_PASSWORD} characters)`, 'password', 'new-password')}${field('password2', 'Repeat password', 'password', 'new-password')}
      <div class="warnbox">${CLINIC_ON ? 'Your patients are encrypted with your password, so <strong>an administrator can’t read them or reset your password for you</strong>.' : 'There’s no central server, so <strong>nobody can reset your password for you</strong>.'} You’ll get a one-time recovery key on the next screen — keep it somewhere safe.</div>
      ${CLINIC_ON ? `<div class="setup" style="margin:0"><strong>🔑 Clinic recovery is on.</strong><div class="small">So the clinic never loses patient records when someone leaves, a copy of your encryption key is sealed so that only the clinic’s recovery-key holder can open it — and only <em>after your account has been disabled</em>. Every use is logged.</div></div>` : ''}
      <div id="authErr" class="banner danger" role="alert" hidden></div>
      <button class="btn primary" id="go" data-label="Create account" type="submit">Create account</button></form>
      <p class="small" style="text-align:center;margin:.4rem 0 0">${accounts.length ? '<a href="#" id="toLogin">Back to sign in</a> · ' : CLINIC_ON ? '<a href="#" id="toLogin">Already have a clinic account? Sign in</a>' : ''}${CLINIC_ON ? '' : '<a href="#" id="toDevice">Already use PhysioNotes on another device? Set up from Dropbox →</a>'}</p>`);
    $('#toLogin')?.addEventListener('click', (e) => { e.preventDefault(); authView('login'); });
    $('#toDevice')?.addEventListener('click', (e) => { e.preventDefault(); deviceConnectView(); });
    $('#displayName').focus();
    $('#af').onsubmit = async (e) => {
      e.preventDefault(); err('');
      if ($('#password').value !== $('#password2').value) return err('Passwords do not match.');
      busyBtn($('#go'), true, 'Creating encrypted account…');
      try {
        if (CLINIC_ON) return await clinicSignUp($('#displayName').value, $('#username').value, $('#password').value);
        const r = await auth.signUp({ username: $('#username').value, displayName: $('#displayName').value, password: $('#password').value });
        await showRecoveryKey(r.recoveryKey, r.user.username, () => startSession(r.user, r.key));
      } catch (x) { err(x.message); busyBtn($('#go'), false); }
    };
  } else if (mode === 'recover') {
    if (CLINIC_ON) return clinicRecoverView();
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

// ---------- clinic mode: sign-in, sign-up, approval gate, password reset ----------
function gateView(kind, email) {
  central.clear();
  const pending = kind === 'pending';
  app.innerHTML = `<div class="auth"><div class="card auth-card stack" style="text-align:center"><div class="auth-logo" aria-hidden="true">${pending ? '⏳' : '⛔'}</div>
    <h1>${pending ? 'Waiting for approval' : 'Access disabled'}</h1>
    <p class="muted" style="margin:0">${pending ? `An administrator at ${esc(central.clinicName())} needs to approve <strong>${esc(email)}</strong> before you can sign in. You can close this page — just sign in again once they have.`
      : `Your access to ${esc(central.clinicName())} has been disabled. Please contact your clinic administrator.`}</p>
    <button class="btn primary" id="back">Back to sign in</button></div></div>`;
  $('#back').onclick = () => authView('login');
}

async function clinicSignUp(displayName, email, password) {
  let ck = null;
  try { ck = await central.clinicKey(); } catch (e) { throw e instanceof TypeError ? new Error('Could not reach the clinic server. Check your connection and try again.') : e; }
  const r = await auth.signUp({ username: email, displayName, password, central: true, escrow: ck });
  try { await central.signUp(r.user.username, r.authSecret); }
  catch (e) {
    auth.forgetAccount(r.user.id); central.clear();
    throw e instanceof TypeError ? new Error('Could not reach the clinic server. Check your connection and try again.') : e;
  }
  let regErr = null;
  const reg = await central.rpc('register_account', { name: r.user.displayName, blob: auth.publicAccount(r.user.username) }).catch((e) => { regErr = e; return null; });
  await showRecoveryKey(r.recoveryKey, r.user.username, async () => {
    if (reg?.status === 'active') await startSession(r.user, r.key, await central.rpc('my_profile'));
    else if (reg) gateView('pending', r.user.username);
    else { central.clear(); authView('login', { notice: regErr?.code === 'clinic_not_ready' ? 'Your account is created, but ' + regErr.message.charAt(0).toLowerCase() + regErr.message.slice(1) + ' Sign in again later and it will finish automatically.' : 'Almost there — sign in to finish creating your clinic account.' }); }
  });
}

async function clinicSignIn(emailRaw, password) {
  const email = String(emailRaw).trim().toLowerCase();
  const local = auth.listAccounts().find((a) => a.username === email);
  let res = null;
  if (local) { try { res = await auth.logIn(email, password); } catch { res = null; } }
  const revoked = !!local?.revoked;

  if (!res) { // new device, or the password was changed on another device: ask the clinic
    let kdf;
    try { kdf = await central.kdfParams(email); }
    catch (e) { throw e instanceof TypeError ? new Error(revoked ? 'Your clinic access has been disabled. Connect to the internet and ask your administrator.' : local ? 'Incorrect email or password.' : 'You appear to be offline. Connect to the internet to sign in on a new device.') : e; }
    try { await central.signIn(email, await auth.deriveAuthSecret(password, kdf)); } // throws "Incorrect email or password" / "disabled"
    catch (e) { if (e.code === 'disabled' && local) auth.revokeLocal(local.id); throw e; }
    const prof = await central.rpc('my_profile');
    if (prof.status === 'pending') return gateView('pending', email);
    if (prof.status !== 'active' || !prof.blob) { if (local) auth.revokeLocal(local.id); return gateView('disabled', email); }
    auth.importAccount(prof.blob); // (also restores access on this device after a re-enable)
    res = await auth.logIn(email, password);
    return finishClinicSignIn(res, prof, email, password);
  }

  try { await central.signIn(email, res.authSecret); }
  catch (e) {
    if (e instanceof TypeError) { // offline: open the local copy -- but only within the clinic's offline allowance; re-checked when back online
      if (!leaseOk(res.user.id)) throw new Error(`For security, the app can be used offline for up to ${central.offlineDays()} days between clinic check-ins. Connect to the internet and sign in.`);
      central.prime(email, res.authSecret); return startSession(res.user, res.key, null);
    }
    if (e.code === 'disabled') auth.revokeLocal(res.user.id);
    if (e.code === 'bad_credentials') throw new Error('Your password was changed on another device, or your clinic account no longer exists. Sign in with your latest password, or contact your administrator.');
    throw e;
  }
  let prof = await central.rpc('my_profile');
  if (prof.status === 'unregistered') { // sign-up was interrupted earlier: finish registering
    const ck0 = await central.clinicKey();
    if (ck0 && auth.publicAccount(email).escrow?.kid !== ck0.kid) await auth.addEscrow(email, password, ck0);
    await central.rpc('register_account', { name: res.user.displayName, blob: auth.publicAccount(email) });
    prof = await central.rpc('my_profile');
  }
  if (prof.status === 'pending') return gateView('pending', email);
  if (prof.status !== 'active') { auth.revokeLocal(res.user.id); return gateView('disabled', email); }
  return finishClinicSignIn(res, prof, email, password);
}

// Clinic confirmed this person is active: record the check-in, make sure their key is sealed to the CURRENT clinic
// recovery key (covers accounts that pre-date it, and key changes), then open the app.
const LEASE = (id) => 'physio-lease-' + id;
function markLease(id) { try { localStorage.setItem(LEASE(id), String(Date.now())); } catch { /* ignore */ } }
function leaseOk(id) { try { const t = +localStorage.getItem(LEASE(id)); return !!t && Date.now() - t < central.offlineDays() * 86400000; } catch { return false; } }
async function finishClinicSignIn(res, prof, email, password) {
  markLease(res.user.id);
  const ck = prof.clinic_key;
  if (ck && auth.publicAccount(email).escrow?.kid !== ck.kid) {
    try { await auth.addEscrow(email, password, ck, { commit: async ({ account }) => { await central.rpc('update_account_blob', { blob: account }); } }); }
    catch (e) { console.error('could not seal recovery key', e); }
  }
  return startSession(res.user, res.key, prof);
}

function clinicRecoverView() {
  app.innerHTML = `<div class="auth"><div class="card auth-card stack"><div class="auth-logo" aria-hidden="true">🔑</div><h1>Reset password</h1>
    <p class="muted" style="margin:0">We’ll email you a reset link. When you open it on this device you’ll enter the <strong>recovery key</strong> you saved at sign-up — that key is what unlocks your encrypted patients, so the email alone is not enough.</p>
    <form id="af" class="stack"><div><label for="email">Email</label><input id="email" type="email" required autocomplete="username" autocapitalize="none"></div>
    <div id="authErr" class="banner danger" role="alert" hidden></div><div id="authOk" class="banner" hidden style="background:var(--ok-l);color:var(--ok)"></div>
    <button class="btn primary" id="go" data-label="Send reset link" type="submit">Send reset link</button></form>
    <p class="small" style="text-align:center"><a href="#" id="toLogin">Back to sign in</a></p></div></div>`;
  $('#toLogin').onclick = (e) => { e.preventDefault(); authView('login'); };
  $('#af').onsubmit = async (e) => {
    e.preventDefault(); $('#authErr').hidden = true;
    busyBtn($('#go'), true, 'Sending…');
    try {
      await central.recoverEmail($('#email').value.trim().toLowerCase(), redirectUri());
      const ok = $('#authOk'); ok.textContent = 'If that email has an account, a reset link is on its way. Open it on this device.'; ok.hidden = false;
    } catch (x) { const er = $('#authErr'); er.textContent = x instanceof TypeError ? 'Could not reach the clinic server.' : x.message; er.hidden = false; }
    busyBtn($('#go'), false);
  };
}

async function handleRecoveryReturn() {
  let r;
  try { r = await central.takeRecoveryReturn(); } catch (e) { return authView('login', { notice: 'That reset link could not be used: ' + e.message }); }
  if (!r) return route();
  if (r.error) return authView('login', { notice: r.error });
  app.innerHTML = `<div class="auth"><div class="card auth-card stack"><div class="auth-logo" aria-hidden="true">🔑</div><h1>Choose a new password</h1>
    <p class="muted" style="margin:0">Enter your recovery key and a new password for <strong>${esc(r.email)}</strong>.</p>
    <form id="af" class="stack"><div><label for="rkey">Recovery key</label><input id="rkey" required autocomplete="off" spellcheck="false" autocapitalize="characters" placeholder="XXXX-XXXX-XXXX-…"></div>
    <div><label for="password">New password (min ${auth.MIN_PASSWORD} characters)</label><input id="password" type="password" required autocomplete="new-password"></div>
    <div><label for="password2">Repeat new password</label><input id="password2" type="password" required autocomplete="new-password"></div>
    <div id="authErr" class="banner danger" role="alert" hidden></div>
    <button class="btn primary" id="go" data-label="Reset password" type="submit">Reset password</button></form></div></div>`;
  $('#af').onsubmit = async (e) => {
    e.preventDefault(); const er = $('#authErr'); er.hidden = true;
    if ($('#password').value !== $('#password2').value) { er.textContent = 'Passwords do not match.'; er.hidden = false; return; }
    busyBtn($('#go'), true, 'Resetting…');
    try {
      const prof = await central.rpc('my_profile');
      if (prof.status !== 'active' || !prof.blob) throw new Error('This account is not active, so it can’t be reset here.');
      auth.importAccount(prof.blob); // make sure this device has the clinic's current key file
      const out = await auth.resetWithRecovery(r.email, $('#rkey').value, $('#password').value, {
        commit: async ({ account, authSecret }) => { await central.updatePassword(authSecret); await central.rpc('update_account_blob', { blob: account }); },
      });
      central.clear();
      await showRecoveryKey(out.recoveryKey, r.email, () => authView('login', { notice: 'Password reset — sign in with your new password.' }), 'Password reset. Your old recovery key no longer works — save this new one.');
    } catch (x) { er.textContent = x.message; er.hidden = false; busyBtn($('#go'), false); }
  };
}

// ---------- clinic mode: who is signed in, and are they still allowed? ----------
function applyProfile() {
  const a = document.getElementById('navAdmin');
  if (!a) return;
  const admin = !!session && session.profile?.role === 'admin';
  a.hidden = !admin;
  const dot = document.getElementById('navDot');
  const n = admin ? session.profile.pending_count || 0 : 0;
  dot.hidden = !n; dot.textContent = n;
}
async function checkAccess() {
  if (!session || !CLINIC_ON) return;
  try {
    const p = await central.rpc('my_profile');
    if (p.status !== 'active') { if (p.status === 'disabled') auth.revokeLocal(session.user.id); return lockApp(p.status === 'disabled' ? 'Your access to the clinic was disabled by an administrator.' : 'Your clinic account is not active.'); }
    session.profile = p; applyProfile(); markLease(session.user.id);
    if (sync.kind !== 'clinic') await sync.startCentral(session.user, syncHooks); // we were offline at sign-in; start syncing now
  } catch (e) { if (e.code === 'disabled' || e.code === 'not_active') { auth.revokeLocal(session.user.id); lockApp('Your access to the clinic was disabled by an administrator.'); } /* offline etc.: try again later */ }
}

// ---------- clinic recovery setup (administrator, mandatory, once) ----------
async function recoverySetupView() {
  app.innerHTML = `<div class="auth"><div class="card auth-card stack" style="max-width:520px"><div class="auth-logo" aria-hidden="true">🔑</div><h1>Set up clinic recovery</h1>
    <p class="muted" style="margin:0">Because every clinician’s notes are encrypted with their own password, nobody — including you — could open them if that person left. Clinic recovery fixes that, safely:</p>
    <ul class="small" style="margin:0;padding-left:1.2rem"><li>Each account stores a copy of its key <strong>sealed to a clinic recovery key</strong>. Without the recovery file it’s unreadable.</li>
      <li>It can only be used for accounts <strong>after you disable them</strong>, never for active colleagues, and <strong>every use is logged</strong>.</li><li>New colleagues can’t sign up until this is done. They’re told recovery exists when they sign up.</li></ul>
    <form id="af" class="stack">
      <div><label for="pp">Passphrase to protect the recovery file (min ${auth.MIN_PASSWORD} characters)</label><input id="pp" type="password" autocomplete="new-password" required></div>
      <div><label for="pp2">Repeat passphrase</label><input id="pp2" type="password" autocomplete="new-password" required></div>
      <div><label for="mypw">Your own password (to seal your own key too)</label><input id="mypw" type="password" autocomplete="current-password" required></div>
      <div id="authErr" class="banner danger" role="alert" hidden></div>
      <button class="btn primary" id="go" data-label="Create recovery key" type="submit">Create recovery key</button></form></div></div>`;
  const err = (m) => { const e = $('#authErr'); e.textContent = m; e.hidden = !m; };
  $('#af').onsubmit = async (e) => {
    e.preventDefault(); err('');
    const pp = $('#pp').value, pw = $('#mypw').value;
    if (pp !== $('#pp2').value) return err('Passphrases do not match.');
    const bad = auth.validatePassword(pp);
    if (bad) return err(bad);
    busyBtn($('#go'), true, 'Creating key (a few seconds)…');
    try {
      await auth.verifyPassword(session.user.username, pw);
      const kp = await generateClinicKeyPair();
      const file = { ...(await encryptWithPassphrase(pp, JSON.stringify({ kid: kp.kid, privateJwk: kp.privateJwk }))), kind: 'clinic-recovery-key', kid: kp.kid, clinic: central.clinicName() };
      app.innerHTML = `<div class="auth"><div class="card auth-card stack" style="max-width:520px"><div class="auth-logo" aria-hidden="true">🔑</div><h1>Save your recovery file</h1>
        <p class="muted" style="margin:0">Key ID <code>${esc(kp.kid)}</code>. This file plus the passphrase you just chose are the <strong>only</strong> way to recover a departed colleague’s records. Keep them <strong>separately</strong> (e.g. the file in a password manager or safe, the passphrase written down elsewhere) — not together on this computer. If both are lost, recovery is impossible.</p>
        <div class="row"><button class="btn primary" id="dl">⬇ Download recovery file</button></div>
        <label class="check"><input type="checkbox" id="saved"> I’ve saved the file and the passphrase somewhere safe</label>
        <div id="authErr" class="banner danger" role="alert" hidden></div>
        <button class="btn primary" id="fin" disabled>Finish setup</button></div></div>`;
      let downloaded = false;
      $('#dl').onclick = () => { download('physionotes-clinic-recovery-key.json', new Blob([JSON.stringify(file)], { type: 'application/json' })); downloaded = true; };
      $('#saved').onchange = (ev) => ($('#fin').disabled = !ev.target.checked);
      $('#fin').onclick = async () => {
        if (!downloaded && !confirm('You haven’t downloaded the file yet. Without it, recovery will be impossible. Continue anyway?')) return;
        $('#fin').disabled = true;
        const er = $('#authErr'); er.hidden = true;
        try {
          await central.rpc('set_clinic_key', { jwk: kp.publicJwk, kid: kp.kid });
          await auth.addEscrow(session.user.username, pw, { jwk: kp.publicJwk, kid: kp.kid }, { commit: async ({ account }) => { await central.rpc('update_account_blob', { blob: account }); } });
          session.profile = await central.rpc('my_profile'); applyProfile();
          toast('Clinic recovery is on'); location.hash = '#/admin'; await route();
        } catch (x) { er.textContent = x.message; er.hidden = false; $('#fin').disabled = false; }
      };
    } catch (x) { err(x instanceof TypeError ? 'You need to be online to set this up.' : x.message); busyBtn($('#go'), false); }
  };
}

// ---------- clinic recovery of a departed (disabled) colleague's records ----------
async function recoverView(userId) {
  if (!CLINIC_ON || session?.profile?.role !== 'admin') return notFound();
  const dir = await central.rpc('admin_directory');
  if (!session) return;
  const t = dir.find((d) => d.id === userId);
  if (!t || t.status !== 'disabled') { app.innerHTML = '<div class="card"><h2>Recovery isn’t available</h2><p>Recovery is only for accounts that have been <strong>disabled</strong>. Disable the person first.</p><a class="btn" href="#/admin">Back to the directory</a></div>'; return; }
  app.innerHTML = `<div class="stack"><a href="#/admin" class="small">← Clinic directory</a>
    <div class="card stack"><h1 style="margin:0">Recover ${esc(t.name)}’s records</h1>
      <p class="muted" style="margin:0">${esc(t.email)} · ${t.records} record${t.records === 1 ? '' : 's'} · ${t.recoverable ? 'sealed to the clinic recovery key ✔' : '<strong class="bad">not sealed to the current recovery key — recovery may not be possible</strong>'}</p>
      <div class="banner warn">This reads a former colleague’s patient notes. It is recorded in the activity log (who, whom, when). Use it only to keep clinical records the clinic is responsible for.</div>
      <form id="rf" class="stack"><div><label for="rfile">Clinic recovery file</label><input id="rfile" type="file" accept="application/json,.json" required></div>
        <div><label for="rpass">Recovery file passphrase</label><input id="rpass" type="password" autocomplete="off" required></div>
        <div id="authErr" class="banner danger" role="alert" hidden></div><button class="btn primary" id="go" data-label="Decrypt &amp; recover" type="submit">Decrypt &amp; recover</button></form>
      <div id="result"></div></div></div>`;
  $('#rf').onsubmit = async (e) => {
    e.preventDefault();
    const er = $('#authErr'); er.hidden = true;
    busyBtn($('#go'), true, 'Recovering…');
    try {
      const file = JSON.parse(await $('#rfile').files[0].text());
      if (file.kind !== 'clinic-recovery-key') throw new Error('That isn’t a clinic recovery file.');
      const { privateJwk, kid } = JSON.parse(await decryptWithPassphrase($('#rpass').value, file)); // wrong passphrase -> error
      const first = await central.rpc('admin_user_records', { user: userId }); // logged on the server
      const escrow = first.account?.escrow;
      if (!escrow) throw new Error('This account has no recovery seal, so its records can’t be recovered.');
      if (escrow.kid !== kid) throw new Error('This recovery file belongs to a different clinic key than the one this account was sealed to.');
      let r = first;
      const items = [...first.items];
      while (r.more) { r = await central.rpc('admin_user_records', { user: userId, since: items[items.length - 1].seq }); items.push(...r.items); }
      const rec = await openRecovered({ escrow, privateJwk, items }); // throws if the key doesn't open it
      $('#result').innerHTML = `<div class="banner" style="background:var(--ok-l);color:var(--ok)"><strong>Recovered:</strong> ${rec.patients.length} patient${rec.patients.length === 1 ? '' : 's'}, ${rec.visits.length} visit${rec.visits.length === 1 ? '' : 's'}, ${rec.audio.length} recording${rec.audio.length === 1 ? '' : 's'}${rec.skipped ? ` (${rec.skipped} damaged record${rec.skipped === 1 ? '' : 's'} skipped)` : ''}. Nothing is saved yet — choose what to do:</div>
        <div class="row" style="margin-top:.7rem"><button type="button" class="btn primary" id="dlBk">⬇ Download encrypted backup</button><button type="button" class="btn" id="impMine">Import into my account</button></div>
        <p class="small muted">Give the backup to the colleague taking over these patients; they import it under Settings → Backup &amp; data.</p>`;
      $('#dlBk').onclick = async () => {
        const v = await askDialog({ title: 'Encrypt this backup', text: 'Choose a passphrase for the backup file. Share it separately from the file.', fields: [{ name: 'p1', label: 'Passphrase' }, { name: 'p2', label: 'Repeat passphrase' }], ok: 'Download' });
        if (!v) return;
        if (v.p1 !== v.p2) return toast('Passphrases do not match.', true);
        const bad = auth.validatePassword(v.p1);
        if (bad) return toast(bad, true);
        download(`physio-notes-recovered-${t.email.split('@')[0]}.enc.json`, new Blob([JSON.stringify(await encryptWithPassphrase(v.p1, JSON.stringify(toBackup(rec))))], { type: 'application/json' }));
      };
      $('#impMine').onclick = async () => {
        if (!confirm(`Import ${rec.patients.length} patients into YOUR account? You will then be able to see them.`)) return;
        for (const x of rec.patients) await db.put('patients', x);
        for (const x of rec.visits) await db.put('visits', x);
        for (const { data, ...x } of rec.audio) await db.put('audio', { ...x, blob: base64ToBlob(data, x.mime) });
        toast('Imported into your account'); location.hash = '#/';
      };
    } catch (x) { er.textContent = x instanceof TypeError ? 'You need to be online.' : /Wrong passphrase/.test(x.message) ? 'Wrong passphrase for the recovery file.' : x.message; er.hidden = false; busyBtn($('#go'), false); }
  };
}

// ---------- clinic directory (administrators) ----------
async function adminView() {
  if (!CLINIC_ON || session?.profile?.role !== 'admin') return notFound();
  app.innerHTML = '<p class="muted pad"><span class="spinner"></span> Loading the clinic directory…</p>';
  const [dir, audit] = await Promise.all([central.rpc('admin_directory'), central.rpc('admin_audit')]);
  if (!session) return; // locked while loading
  const count = (st) => dir.filter((d) => d.status === st).length;
  const size = (b) => (b > 1048576 ? (b / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(b / 1024)) + ' KB');
  const STATUS = { pending: ['warn', 'Pending approval'], active: ['ok', 'Active'], disabled: ['danger', 'Disabled'] };
  const meId = session.profile.id;
  const row = (d) => {
    const me = d.id === meId;
    const btn = (act, label, cls = '') => `<button class="btn sm ${cls}" data-act="${act}" data-id="${d.id}">${label}</button>`;
    const actions = me ? '<span class="muted small">This is you</span>' : d.status === 'pending' ? btn('approve', 'Approve', 'primary') + btn('remove', 'Decline', 'danger')
      : d.status === 'active' ? btn('disable', 'Disable', 'danger') + btn('role', d.role === 'admin' ? 'Make clinician' : 'Make admin')
      : btn('enable', 'Re-enable') + btn('recover', 'Recover data…') + btn('remove', 'Remove permanently', 'danger');
    return `<li class="card dir-item ${d.status}">
      <span class="avatar" style="--h:${hue(d.email)}" aria-hidden="true">${esc((d.name || d.email)[0].toUpperCase())}</span>
      <div class="grow"><div class="pname">${esc(d.name)} ${d.role === 'admin' ? '<span class="badge">Admin</span>' : ''} <span class="badge ${STATUS[d.status][0]}">${STATUS[d.status][1]}</span></div>
        <div class="muted small">${esc(d.email)}</div>
        <div class="muted small">Joined ${fmtDate(d.created_at)} · ${d.last_seen ? 'last active ' + fmtDateTime(d.last_seen) : 'never signed in'} · cloud data ${d.records} record${d.records === 1 ? '' : 's'} (${size(d.bytes)})</div></div>
      <div class="row dir-actions">${actions}</div></li>`;
  };
  const label = (l) => {
    const d = l.detail || {};
    return ({ register: `${d.email} signed up (${d.status})`, approve: `${d.actor_email} approved ${d.target_email}`, disable: `${d.actor_email} disabled ${d.target_email}`, enable: `${d.actor_email} re-enabled ${d.target_email}`,
      set_role: `${d.actor_email} made ${d.target_email} ${d.role === 'admin' ? 'an admin' : 'a clinician'}`, remove: `${d.actor_email} removed ${d.target_email}`, delete_self: `${d.email} deleted their own account`, account_key_update: `${d.email} changed their password or recovery key`, set_clinic_key: `${d.actor_email} set up the clinic recovery key (ID ${d.kid})`, recover_data: `${d.actor_email} recovered the records of ${d.target_email}` })[l.action] || l.action;
  };
  app.innerHTML = `
    <section class="hero"><div class="row between"><div><h1>Clinic directory</h1><p>${esc(central.clinicName())}</p></div></div>
      <div class="stats"><div class="stat"><b>${count('active')}</b><span>Active</span></div><div class="stat"><b>${count('pending')}</b><span>Waiting for approval</span></div><div class="stat"><b>${count('disabled')}</b><span>Disabled</span></div></div></section>
    <div class="setup" style="background:var(--brand-l);border-color:transparent"><strong>What administrators can and can’t see.</strong>
      <div class="small">You see names, emails, status and how much encrypted storage each person uses. You <strong>can’t</strong> read an active colleague’s patients or notes — they’re encrypted with that person’s own password. <strong>Disabling</strong> someone blocks their sign-in and cloud access immediately, and their devices lock the data (it stays on the device but can’t be opened until you re-enable them). For a disabled account you can <strong>recover</strong> their records with the clinic recovery file — each recovery is logged. Clinic recovery key: <code>${esc(session.profile.clinic_key?.kid || 'not set')}</code>.</div></div>
    <ul class="plist">${dir.map(row).join('')}</ul>
    <details class="card" style="margin-top:1rem"><summary>Activity log (last ${audit.length})</summary>
      <ul style="margin:.6rem 0 0;padding-left:1.1rem">${audit.map((l) => `<li class="small"><span class="muted">${fmtDateTime(l.at)}</span> — ${esc(label(l))}</li>`).join('') || '<li class="muted small">Nothing yet.</li>'}</ul></details>`;
  const verbs = { approve: ['admin_set_status', { status: 'active' }, 'Approved'], enable: ['admin_set_status', { status: 'active' }, 'Re-enabled'], disable: ['admin_set_status', { status: 'disabled' }, 'Disabled'], remove: ['admin_remove_user', {}, 'Removed'] };
  $$('[data-act]').forEach((b) => (b.onclick = async () => {
    const d = dir.find((x) => x.id === b.dataset.id), act = b.dataset.act;
    if (act === 'recover') { location.hash = '#/admin/recover/' + d.id; return; }
    const ask = { disable: `Disable ${d.name}? They are signed out and blocked from the clinic immediately.`, remove: `Permanently remove ${d.name} (${d.email}) and delete their encrypted cloud data? If you haven't recovered their records yet, do that FIRST — after removal they cannot be recovered. This cannot be undone.`, role: `Make ${d.name} ${d.role === 'admin' ? 'a clinician (no admin access)' : 'an administrator'}?` }[act];
    if (ask && !confirm(ask)) return;
    b.disabled = true;
    try {
      if (act === 'role') await central.rpc('admin_set_role', { user: d.id, role: d.role === 'admin' ? 'clinician' : 'admin' });
      else { const [fn, args, done] = verbs[act]; await central.rpc(fn, { user: d.id, ...args }); toast(`${done}: ${d.name}`); }
      await checkAccess(); await adminView();
    } catch (e) { toast(e.message, true); b.disabled = false; }
  }));
}

function deviceConnectView() {
  const saved = (() => { try { return localStorage.getItem('physio-dbx-appkey') || ''; } catch { return ''; } })();
  app.innerHTML = `<div class="auth"><div class="card auth-card stack"><div class="auth-logo" aria-hidden="true">☁</div><h1>Set up from Dropbox</h1>
    <p class="muted" style="margin:0">Connect the same Dropbox you use on your other device. Your notes are downloaded and decrypted here with your password.</p>
    <form id="af" class="stack"><div><label for="appkey">Dropbox App key</label><input id="appkey" value="${esc(saved)}" required autocomplete="off" spellcheck="false" placeholder="The key you created in Settings → Sync on your other device"></div>
    <div class="small muted">Redirect address to allow in your Dropbox app: <code>${esc(redirectUri())}</code></div>
    <button class="btn primary" type="submit">Connect Dropbox</button></form><a href="#" id="back" class="small" style="text-align:center">Back to sign in</a></div></div>`;
  $('#back').onclick = (e) => { e.preventDefault(); authView('login'); };
  $('#af').onsubmit = (e) => { e.preventDefault(); const k = $('#appkey').value.trim(); try { localStorage.setItem('physio-dbx-appkey', k); } catch { /* ignore */ } beginAuth(k, 'newdevice'); };
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
let accessTimer = null;
const bump = () => { lastActive = Date.now(); };
const ACTIVITY = ['pointerdown', 'keydown', 'touchstart', 'scroll', 'input'];
function idleCheck() {
  if (!session || recordingActive) return;
  if (Date.now() - lastActive > (getSettings().lockMinutes || 10) * 60000) lockApp('Locked after inactivity.');
}
const onVisAccess = () => { if (!document.hidden) checkAccess(); };
function startIdle() {
  lastActive = Date.now();
  ACTIVITY.forEach((ev) => window.addEventListener(ev, bump, { passive: true, capture: true }));
  idleTimer = setInterval(idleCheck, 10000);
  document.addEventListener('visibilitychange', idleCheck);
  if (CLINIC_ON) { accessTimer = setInterval(checkAccess, 60000); document.addEventListener('visibilitychange', onVisAccess); window.addEventListener('online', checkAccess); }
}
function stopIdle() {
  ACTIVITY.forEach((ev) => window.removeEventListener(ev, bump, { capture: true }));
  clearInterval(idleTimer); clearInterval(accessTimer);
  document.removeEventListener('visibilitychange', idleCheck);
  document.removeEventListener('visibilitychange', onVisAccess);
  window.removeEventListener('online', checkAccess);
}

// ---------- boot ----------
if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js').catch(() => {});
navigator.storage?.persist?.().catch(() => {});
renderUserbox();
const dbxReturn = takeAuthReturn(); // coming back from Dropbox's sign-in page?
if (dbxReturn) handleDropboxReturn(dbxReturn);
else if (CLINIC_ON && /^#(access_token|error)=/.test(location.hash)) handleRecoveryReturn(); // came back from a password-reset email
else route(); // not signed in yet -> shows the sign-in / set-up screen
