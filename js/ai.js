// AI assistance. Three providers, all free to use:
//   local  – built-in rule-based review (offline, nothing leaves the device)  [default]
//   gemini – Google Gemini API free tier (you supply your own free API key)
//   ollama – a local open-source model running on your own computer (private)
import { analyze, sortVisits, toMarkdown, STATUS_LABEL } from './analysis.js';
import { age, blobToBase64 } from './util.js';
import { toWavChunks } from './voice.js';

const KEY = 'physio-notes-settings';
export const DEFAULTS = {
  provider: 'gemini',
  geminiKey: '',
  geminiModel: 'gemini-flash-latest',
  ollamaUrl: 'http://localhost:11434',
  ollamaModel: 'llama3.1',
  deidentify: true,
  speechLang: 'en-CA',
};

export function getSettings() {
  try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) || '{}') }; } catch { return { ...DEFAULTS }; }
}
export function saveSettings(s) {
  try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* storage unavailable */ }
}
export const providerLabel = (p) => ({ local: 'Built-in (offline)', gemini: 'Google Gemini', ollama: 'Ollama (local)' }[p] || p);
export const geminiReady = (s = getSettings()) => s.provider === 'gemini' && !!s.geminiKey;
export const isCloud = (p) => p === 'gemini';

// --- De-identification (applied before anything is sent to a cloud provider) -------------------

export function makeScrubber(patient, enabled) {
  if (!enabled) return (t) => t || '';
  const names = [patient.firstName, patient.lastName, patient.preferredName]
    .flatMap((n) => String(n || '').split(/\s+/))
    .filter((n) => n.length >= 2)
    .map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const nameRx = names.length ? new RegExp(`\\b(${names.join('|')})\\b`, 'gi') : null;
  return (t) => {
    let s = String(t || '');
    if (nameRx) s = s.replace(nameRx, '[PATIENT]');
    return s
      .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '[EMAIL]')
      .replace(/(\+?\d[\d\s().-]{8,}\d)/g, '[PHONE]')
      .replace(/\b[A-Za-z]\d[A-Za-z][ -]?\d[A-Za-z]\d\b/g, '[POSTAL]');
  };
}

export function chartText(patient, visits, scrub) {
  const vs = sortVisits(visits);
  const a = age(patient.dob);
  const L = [];
  L.push('## Patient');
  L.push(`Age: ${a ?? 'unknown'}${patient.sex ? ', sex: ' + patient.sex : ''}${patient.occupation ? ', occupation: ' + scrub(patient.occupation) : ''}`);
  if (patient.condition) L.push(`Primary condition / complaint: ${scrub(patient.condition)}`);
  if (patient.onsetDate) L.push(`Onset: ${patient.onsetDate}`);
  if (patient.history) L.push(`Relevant history: ${scrub(patient.history)}`);
  if (patient.medications) L.push(`Medications: ${scrub(patient.medications)}`);
  if (patient.precautions) L.push(`Precautions / contraindications: ${scrub(patient.precautions)}`);
  if (patient.goals) L.push(`Patient goals: ${scrub(patient.goals)}`);
  L.push('', '## Visits (oldest first)');
  vs.forEach((v, i) => {
    L.push(`### Visit ${i + 1} — ${new Date(v.date).toISOString().slice(0, 10)} (${v.type})`);
    if (v.pain != null && v.pain !== '') L.push(`Pain 0-10: ${v.pain}`);
    if (v.function != null && v.function !== '') L.push(`Function 0-10 (10 = fully able): ${v.function}`);
    for (const m of v.measures || []) if (m.name && m.value !== '') L.push(`Measure ${scrub(m.name)}: ${m.value}${m.unit ? ' ' + m.unit : ''} (${m.better === 'down' ? 'lower is better' : 'higher is better'})`);
    for (const [k, label] of [['subjective', 'S'], ['objective', 'O'], ['assessment', 'A'], ['plan', 'P'], ['treatment', 'Treatment given'], ['hep', 'Home exercise programme']]) {
      if ((v[k] || '').trim()) L.push(`${label}: ${scrub(v[k]).trim()}`);
    }
    if (!(v.subjective || v.objective || v.assessment || v.plan) && (v.transcript || '').trim()) L.push(`Dictated notes: ${scrub(v.transcript).trim()}`);
    L.push('');
  });
  return L.join('\n');
}

const SYSTEM = `You are a clinical decision-support assistant for a registered physiotherapist in Canada. You review chart notes, track patient progress and suggest a course of treatment.
Rules:
- Use ONLY information in the chart; never invent findings, scores or history. Say "not documented" where data is missing.
- You support, never replace, clinical judgment. Do not give a definitive diagnosis; offer differentials/working hypotheses with uncertainty.
- Always call out red/yellow flags and when to refer or re-screen.
- Be concise, practical and evidence-informed (exercise dosage, progression, education, manual therapy only where supported, modalities sparingly).
- Output GitHub-flavoured markdown with these sections: ## Progress summary, ## Concerns & red flags, ## Trajectory vs goals, ## Recommended plan (next 2–4 weeks), ## Outcome measures to track, ## Reassess / refer if.
- Finish with one line: "Decision support only — verify against your clinical judgment."`;

async function post(url, headers, body, signal) {
  let res;
  try {
    res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body), signal });
  } catch (e) {
    throw new Error(`Could not reach the AI service (${e.message}). Check your connection / settings.`);
  }
  if (!res.ok) {
    let detail = '';
    try { const j = await res.json(); detail = j.error?.message || JSON.stringify(j).slice(0, 300); } catch { /* ignore */ }
    if (res.status === 429) detail = 'Free-tier rate limit reached — wait a minute and retry. ' + detail;
    throw new Error(`AI service error ${res.status}: ${detail}`);
  }
  return res.json();
}

const GEMINI = 'https://generativelanguage.googleapis.com/v1beta';

// Calls Gemini; if the configured model name is unknown (404) picks an available Flash model once and retries.
async function gemini(s, body, signal) {
  if (!s.geminiKey) throw new Error('Add your free Gemini API key in Settings first.');
  const url = (m) => `${GEMINI}/models/${encodeURIComponent(m)}:generateContent`;
  const headers = { 'x-goog-api-key': s.geminiKey };
  try {
    return await post(url(s.geminiModel), headers, body, signal);
  } catch (e) {
    if (!/error 404/.test(e.message)) throw e;
    const res = await fetch(`${GEMINI}/models?pageSize=100`, { headers });
    if (!res.ok) throw e;
    const models = ((await res.json()).models || []).filter((m) => (m.supportedGenerationMethods || []).includes('generateContent'));
    const pick = models.find((m) => /flash/i.test(m.name) && !/(lite|image|tts|live|thinking|exp)/i.test(m.name)) || models[0];
    if (!pick) throw e;
    const name = pick.name.replace(/^models\//, '');
    saveSettings({ ...getSettings(), geminiModel: name });
    return post(url(name), headers, body, signal);
  }
}

async function callLLM(s, system, user, { json = false, signal } = {}) {
  if (s.provider === 'gemini') {
    const data = await gemini(
      s,
      {
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: 'user', parts: [{ text: user }] }],
        generationConfig: { temperature: 0.3, ...(json ? { responseMimeType: 'application/json' } : {}) },
      },
      signal
    );
    const text = data.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('') || '';
    if (!text) throw new Error('The model returned no text (it may have been blocked). Try again.');
    return text;
  }
  if (s.provider === 'ollama') {
    const data = await post(
      `${s.ollamaUrl.replace(/\/$/, '')}/api/chat`,
      {},
      { model: s.ollamaModel, stream: false, ...(json ? { format: 'json' } : {}), messages: [{ role: 'system', content: system }, { role: 'user', content: user }], options: { temperature: 0.3 } },
      signal
    );
    return data.message?.content || '';
  }
  throw new Error('No AI provider selected.');
}

// --- Public API --------------------------------------------------------------------------------

export async function runReview(patient, visits, { question = '', signal, forceLocal = false } = {}) {
  const s = getSettings();
  const a = analyze(patient, visits);
  if (s.provider === 'local' || forceLocal) {
    return { text: toMarkdown(a), provider: 'local' };
  }
  const scrub = makeScrubber(patient, s.deidentify || false);
  const facts = [
    `Computed trends: status=${STATUS_LABEL[a.status]}; visits=${a.visitCount}; span=${a.episodeDays} days.`,
    a.pain ? `Pain ${a.pain.first}→${a.pain.last} (${a.pain.direction}${a.pain.plateau ? ', plateau' : ''}).` : '',
    a.function ? `Function ${a.function.first}→${a.function.last} (${a.function.direction}${a.function.plateau ? ', plateau' : ''}).` : '',
    a.flags.length ? `Possible red-flag mentions detected by keyword scan: ${a.flags.map((f) => f.label).join('; ')}.` : '',
  ].filter(Boolean).join('\n');
  const user = `${chartText(patient, visits, scrub)}\n\n## Automated trend facts\n${facts}\n\n${question ? `## Clinician's question\n${scrub(question)}\n\nAnswer the question first, then give the structured review.` : 'Please review this chart and recommend the course of treatment.'}`;
  const text = await callLLM(s, SYSTEM, user, { signal });
  return { text, provider: s.provider };
}

// Turn a dictated transcript into SOAP fields (requires an LLM provider).
export async function runSoap(patient, transcript, { signal } = {}) {
  const s = getSettings();
  if (s.provider === 'local') throw new Error('Structuring dictation into SOAP needs an AI provider — choose Gemini or Ollama in Settings.');
  const scrub = makeScrubber(patient, s.deidentify);
  const system = 'You convert a physiotherapist\'s dictated session notes into structured clinical notes. Use ONLY what was said; leave a field as an empty string if nothing was said. Use concise clinical language. Respond with JSON only: {"subjective":"","objective":"","assessment":"","plan":"","treatment":"","hep":""} where treatment = interventions performed today and hep = home exercise programme prescribed.';
  const raw = await callLLM(s, system, scrub(transcript), { json: true, signal });
  const cleaned = raw.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  let obj;
  try { obj = JSON.parse(cleaned); } catch { throw new Error('The model did not return valid JSON. Try again.'); }
  const out = {};
  for (const k of ['subjective', 'objective', 'assessment', 'plan', 'treatment', 'hep']) out[k] = typeof obj[k] === 'string' ? obj[k].trim() : '';
  return out;
}

// Transcribe a recording with Gemini (works in any browser, incl. Firefox where live dictation is unavailable).
export async function transcribeAudio(blob, { signal } = {}) {
  const s = getSettings();
  if (s.provider !== 'gemini' || !s.geminiKey) throw new Error('Audio transcription uses Gemini — select it and add your free API key in Settings.');
  const chunks = await toWavChunks(blob);
  const parts = [];
  for (const c of chunks) {
    const data = await gemini(
      s,
      { contents: [{ role: 'user', parts: [{ text: 'Transcribe this physiotherapy session dictation verbatim. Output only the transcript text, no commentary.' }, { inlineData: { mimeType: 'audio/wav', data: await blobToBase64(c) } }] }], generationConfig: { temperature: 0 } },
      signal
    );
    parts.push((data.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('').trim());
  }
  return parts.filter(Boolean).join(' ');
}

export async function testConnection() {
  const s = getSettings();
  if (s.provider === 'local') return 'Built-in mode needs no connection.';
  const out = await callLLM(s, 'Reply with the single word OK.', 'ping');
  return `Connected (${providerLabel(s.provider)}): ${out.trim().slice(0, 40)}`;
}
