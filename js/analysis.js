// Pure, offline progress analysis. No DOM, no network: runs in the browser and in Node tests.
// This is decision support only -- thresholds follow commonly cited MCIDs (NPRS / PSFS ~2 points).

const DAY = 86400000;

export function num(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

export function sortVisits(visits) {
  return [...visits].sort((a, b) => new Date(a.date) - new Date(b.date));
}

export function series(visits, key) {
  return sortVisits(visits)
    .map((v) => ({ t: new Date(v.date).getTime(), y: num(v[key]), visitId: v.id }))
    .filter((p) => p.y !== null && Number.isFinite(p.t));
}

export function measureSeries(visits) {
  const map = new Map();
  for (const v of sortVisits(visits)) {
    for (const m of v.measures || []) {
      const name = (m.name || '').trim();
      const y = num(m.value);
      if (!name || y === null) continue;
      const k = name.toLowerCase();
      if (!map.has(k)) map.set(k, { name, unit: m.unit || '', better: m.better === 'down' ? 'down' : 'up', points: [] });
      map.get(k).points.push({ t: new Date(v.date).getTime(), y, visitId: v.id });
    }
  }
  return [...map.values()];
}

const round1 = (x) => Math.round(x * 10) / 10;

/**
 * @param points  [{t, y}] sorted by time
 * @param opts    {lowerIsBetter, mcid, pctMeaningful, plateauTol, atGoal(last)}
 */
export function trend(points, opts = {}) {
  const { lowerIsBetter = false, mcid = 2, pctMeaningful = null, plateauTol = 1, atGoal = () => false } = opts;
  if (!points.length) return null;
  const first = points[0].y;
  const last = points[points.length - 1].y;
  const change = round1(last - first);
  const pct = first !== 0 ? Math.round(((last - first) / Math.abs(first)) * 100) : null;
  const best = lowerIsBetter ? Math.min(...points.map((p) => p.y)) : Math.max(...points.map((p) => p.y));
  const out = { n: points.length, first, last, change, pct, best, lowerIsBetter, direction: 'baseline', plateau: false };
  if (points.length < 2) return out;

  const good = lowerIsBetter ? -change : change;
  const goodPct = pct === null ? 0 : lowerIsBetter ? -pct : pct;
  const meaningful = pctMeaningful !== null ? Math.abs(goodPct) >= pctMeaningful : Math.abs(good) >= mcid;
  const slight = pctMeaningful !== null ? Math.abs(goodPct) >= pctMeaningful / 3 : Math.abs(good) >= 1;
  if (good > 0 && (meaningful || (pctMeaningful === null && goodPct >= 30 && good >= 1))) out.direction = 'improving';
  else if (good > 0 && slight) out.direction = 'slightly improving';
  else if (good < 0 && meaningful) out.direction = 'worsening';
  else if (good < 0 && slight) out.direction = 'slightly worsening';
  else out.direction = 'stable';

  const spanDays = (points[points.length - 1].t - points[0].t) / DAY;
  out.slopePerWeek = spanDays >= 1 ? round1(((last - first) / spanDays) * 7) : null;

  if (points.length >= 3) {
    const tail = points.slice(-3);
    const ys = tail.map((p) => p.y);
    const range = Math.max(...ys) - Math.min(...ys);
    const tol = pctMeaningful !== null ? (Math.abs(ys.reduce((a, b) => a + b, 0) / 3) * pctMeaningful) / 100 / 3 : plateauTol;
    const tailDays = (tail[2].t - tail[0].t) / DAY;
    out.plateau = range <= tol && tailDays >= 7 && !atGoal(last);
  }
  return out;
}

// --- Red-flag scan -----------------------------------------------------------------------------

const RED_FLAGS = [
  ['Bladder/bowel change or saddle numbness (possible cauda equina)', /\b(saddle (anaesthesia|anesthesia|numbness|paraesthesia|paresthesia)|(bladder|bowel) (dysfunction|incontinence|retention|changes?|control)|(urinary|faecal|fecal) (retention|incontinence)|cauda equina)\b/i],
  ['Unexplained weight loss', /\b(unexplained|unintentional|unintended) weight loss\b|\bweight loss\b/i],
  ['Night / constant non-mechanical pain', /\b(night pain|pain at night|constant pain|non-?mechanical|unrelenting)\b/i],
  ['History of cancer / malignancy concern', /\b(cancer|malignan\w*|metasta\w*|tumou?r)\b/i],
  ['Fever / infection signs', /\b(fever|febrile|infection|night sweats|rigors)\b/i],
  ['Chest pain / shortness of breath', /\b(chest pain|shortness of breath|dyspn[o]?ea)\b/i],
  ['Progressive neurological deficit', /\b(progressive (weakness|numbness|neurolog\w*)|foot drop|drop foot|myelopathy|bilateral (arm|leg) (weakness|numbness|symptoms?))\b/i],
  ['Possible fracture / significant trauma', /\b(fracture|fall from|high[- ]energy|motor vehicle|mva)\b/i],
  ['Dizziness / vascular signs (5 Ds, 3 Ns)', /\b(dizz(y|iness)|diplopia|dysarthria|dysphagia|drop attacks?|nystagmus|vertigo)\b/i],
  ['Calf swelling / possible DVT', /\b(calf (swelling|tenderness)|dvt|deep vein)\b/i],
  ['Self-harm / safety concern', /\b(suicid\w*|self[- ]harm|hopeless)\b/i],
];
const NEGATION = /\b(no|not|nil|denies|denied|negative|neg|without|absent|ruled out|r\/o|unremarkable|clear of)\b/i;

export function scanRedFlags(visits) {
  const found = new Map();
  for (const v of sortVisits(visits)) {
    const text = [v.subjective, v.objective, v.assessment, v.plan, v.transcript].filter(Boolean).join('\n');
    for (const sentence of text.split(/[.\n;!?]+/)) {
      if (!sentence.trim() || NEGATION.test(sentence)) continue;
      for (const [label, rx] of RED_FLAGS) {
        if (rx.test(sentence) && !found.has(label)) {
          found.set(label, { label, date: v.date, excerpt: sentence.trim().slice(0, 140) });
        }
      }
    }
  }
  return [...found.values()];
}

// --- Main analysis -----------------------------------------------------------------------------

export function analyze(patient, visits, now = Date.now()) {
  const vs = sortVisits(visits).filter((v) => Number.isFinite(new Date(v.date).getTime()));
  const pain = trend(series(vs, 'pain'), { lowerIsBetter: true, mcid: 2, atGoal: (y) => y <= 2 });
  const fn = trend(series(vs, 'function'), { lowerIsBetter: false, mcid: 2, atGoal: (y) => y >= 8 });
  const measures = measureSeries(vs).map((m) => ({
    name: m.name,
    unit: m.unit,
    better: m.better,
    ...trend(m.points, { lowerIsBetter: m.better === 'down', pctMeaningful: 15 }),
  }));

  const first = vs[0];
  const last = vs[vs.length - 1];
  const episodeDays = first && last ? Math.round((new Date(last.date) - new Date(first.date)) / DAY) : 0;
  const daysSinceLast = last ? Math.floor((now - new Date(last.date).getTime()) / DAY) : null;

  const flags = scanRedFlags(vs);
  const alerts = [];
  const suggestions = [];
  const add = (priority, text) => suggestions.push({ priority, text });

  // Worsening between consecutive visits
  const ps = series(vs, 'pain');
  if (ps.length >= 2 && ps[ps.length - 1].y - ps[ps.length - 2].y >= 2) {
    alerts.push(`Pain rose ${round1(ps[ps.length - 1].y - ps[ps.length - 2].y)} points since the previous visit (${ps[ps.length - 2].y} → ${ps[ps.length - 1].y}).`);
  }
  const fs = series(vs, 'function');
  if (fs.length >= 2 && fs[fs.length - 2].y - fs[fs.length - 1].y >= 2) {
    alerts.push(`Function dropped ${round1(fs[fs.length - 2].y - fs[fs.length - 1].y)} points since the previous visit (${fs[fs.length - 2].y} → ${fs[fs.length - 1].y}).`);
  }
  if (pain && pain.last >= 8) alerts.push(`Current pain is high (${pain.last}/10).`);
  if (patient && patient.status !== 'discharged' && daysSinceLast !== null && daysSinceLast > 21) {
    alerts.push(`No visit in ${daysSinceLast} days — consider a check-in or discharge review.`);
  }

  // Overall status
  let status = 'no-data';
  const dirs = [pain, fn].filter(Boolean);
  if (vs.length === 0) status = 'no-data';
  else if (vs.length === 1 || dirs.every((d) => d.direction === 'baseline')) status = 'baseline';
  else if (dirs.some((d) => d.direction === 'worsening')) status = 'worsening';
  else if (dirs.some((d) => d.plateau)) status = 'plateau';
  else if (dirs.every((d) => d.direction === 'improving')) status = 'on-track';
  else if (dirs.some((d) => d.direction === 'improving' || d.direction === 'slightly improving')) status = 'improving';
  else status = 'slow';

  // Rule-based suggestions
  if (flags.length) add('high', 'Possible red-flag content documented (see below). Confirm clinically; consider medical referral / urgent screening before continuing treatment.');
  if (status === 'baseline') {
    add('info', 'Only baseline data so far. Re-score pain and function at each visit, and add 1–2 objective measures (ROM, strength, a functional test) so progress can be tracked.');
  }
  if (status === 'worsening') {
    add('high', 'Trend is worsening. Re-assess the working diagnosis, screen for red/yellow flags, review recent load and adherence, and reconsider the plan or refer back to the physician if no clear mechanical explanation.');
  }
  if (status === 'plateau') {
    add('med', 'Scores have plateaued over the last 3 visits. Change one variable: progress/regress loading, switch the treatment emphasis, address barriers (fear-avoidance, sleep, work demands), or consider imaging/specialist opinion via the referrer.');
  }
  if (status === 'on-track' || status === 'improving') {
    add('info', 'Responding to treatment. Continue the current plan, progress exercise load/complexity, shift toward self-management, and consider tapering visit frequency.');
  }
  if (status === 'slow' && vs.length >= 4) {
    add('med', 'Little change over several visits. Reassess goals and contributing factors; consider a re-evaluation or a second opinion.');
  }
  if (vs.length >= 6 && pain && fn && pain.direction !== 'improving' && fn.direction !== 'improving') {
    add('med', `${vs.length} visits without a meaningful improvement in pain or function — review the treatment rationale and consider referral.`);
  }
  if (fn && fn.last <= 4 && fn.n >= 1) {
    add('info', 'Function is still limited: use task-specific, goal-based training and graded exposure to the patient\'s key activities.');
  }
  if (pain && pain.last <= 2 && fn && fn.last >= 8) {
    add('info', 'Pain and function are near goal. Plan discharge with a home programme, flare-up advice and a return-to-activity timeline.');
  }
  if (last && !(last.hep || '').trim() && vs.length >= 1) {
    add('info', 'No home exercise programme documented at the latest visit.');
  }
  if (vs.length >= 2 && !measures.length) {
    add('info', 'No objective measures (ROM, strength, functional tests) recorded — adding them makes progress easier to demonstrate.');
  }
  if (patient && !(patient.goals || '').trim()) {
    add('info', 'No patient goals recorded. Documenting 1–3 functional goals helps judge when treatment is complete.');
  }

  return {
    visitCount: vs.length,
    episodeDays,
    daysSinceLast,
    pain,
    function: fn,
    measures,
    status,
    flags,
    alerts,
    suggestions,
  };
}

export const STATUS_LABEL = {
  'no-data': 'No visits yet',
  baseline: 'Baseline only',
  'on-track': 'On track',
  improving: 'Improving',
  slow: 'Slow progress',
  plateau: 'Plateau',
  worsening: 'Worsening',
};

export function toMarkdown(a) {
  const L = [];
  L.push(`## Progress summary`);
  L.push(`- Status: **${STATUS_LABEL[a.status]}** — ${a.visitCount} visit(s) over ${a.episodeDays} day(s)`);
  if (a.pain) L.push(`- Pain (0–10): ${a.pain.first} → ${a.pain.last} (${a.pain.change > 0 ? '+' : ''}${a.pain.change}, ${a.pain.direction})`);
  if (a.function) L.push(`- Function (0–10): ${a.function.first} → ${a.function.last} (${a.function.change > 0 ? '+' : ''}${a.function.change}, ${a.function.direction})`);
  for (const m of a.measures) L.push(`- ${m.name}: ${m.first} → ${m.last}${m.unit ? ' ' + m.unit : ''} (${m.direction})`);
  if (a.alerts.length || a.flags.length) {
    L.push('', '## Alerts');
    for (const t of a.alerts) L.push(`- ${t}`);
    for (const f of a.flags) L.push(`- Possible red flag: ${f.label} — “${f.excerpt}”`);
  }
  L.push('', '## Suggested next steps (rule-based)');
  if (!a.suggestions.length) L.push('- No specific suggestions yet — add more visit data.');
  for (const s of a.suggestions) L.push(`- ${s.priority === 'high' ? '**Priority:** ' : ''}${s.text}`);
  L.push('', '*Offline rule-based review (no data left this device). For a richer, narrative review choose Gemini or Ollama in Settings. Clinical judgment always takes precedence.*');
  return L.join('\n');
}
