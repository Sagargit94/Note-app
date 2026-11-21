// Voice capture: records audio (MediaRecorder) and, where the browser supports it, live-transcribes
// with the Web Speech API. NOTE: in Chrome/Edge the Web Speech API streams audio to the browser
// vendor's speech service; Safari may use on-device or Apple servers. See README.

const SR = typeof window !== 'undefined' ? window.SpeechRecognition || window.webkitSpeechRecognition : null;
export const speechSupported = !!SR;
export const recordingSupported = typeof MediaRecorder !== 'undefined' && !!navigator.mediaDevices?.getUserMedia;

function pickMime() {
  const c = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'];
  return c.find((m) => MediaRecorder.isTypeSupported?.(m)) || '';
}

export class Recorder {
  constructor({ lang = 'en-CA', onInterim = () => {}, onFinal = () => {}, onTick = () => {}, onSpeechError = () => {} } = {}) {
    Object.assign(this, { lang, onInterim, onFinal, onTick, onSpeechError });
    this.active = false;
  }

  async start() {
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const mimeType = pickMime();
    this.mr = new MediaRecorder(this.stream, mimeType ? { mimeType } : undefined);
    this.chunks = [];
    this.finalText = '';
    this.mr.ondataavailable = (e) => e.data.size && this.chunks.push(e.data);
    this.mr.start(1000);
    this.t0 = Date.now();
    this.active = true;
    this.timer = setInterval(() => this.onTick(Math.floor((Date.now() - this.t0) / 1000)), 500);
    this._startSpeech();
  }

  _startSpeech() {
    if (!SR) return;
    const r = new SR();
    r.continuous = true;
    r.interimResults = true;
    r.lang = this.lang;
    r.onresult = (e) => {
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const t = e.results[i][0].transcript;
        if (e.results[i].isFinal) { this.finalText += (this.finalText ? ' ' : '') + t.trim(); this.onFinal(t.trim()); }
        else interim += t;
      }
      this.onInterim(interim);
    };
    r.onerror = (e) => {
      if (e.error === 'no-speech' || e.error === 'aborted') return;
      this.onSpeechError(e.error);
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed' || e.error === 'network') this.speechDead = true;
    };
    r.onend = () => {
      this.onInterim('');
      if (this.active && !this.speechDead) { try { r.start(); } catch { /* already started */ } }
      this._speechEnded?.();
    };
    this.recog = r;
    try { r.start(); } catch { /* ignore */ }
  }

  async stop() {
    this.active = false;
    clearInterval(this.timer);
    const done = new Promise((res) => { this.mr.onstop = res; });
    const speechDone = new Promise((res) => { this._speechEnded = res; setTimeout(res, 1500); });
    if (this.mr.state !== 'inactive') this.mr.stop();
    try { this.recog?.stop(); } catch { /* ignore */ }
    await done;
    if (this.recog) await speechDone;
    this.stream.getTracks().forEach((t) => t.stop());
    const mime = this.mr.mimeType || 'audio/webm';
    return {
      blob: new Blob(this.chunks, { type: mime }),
      mime,
      durationSec: Math.round((Date.now() - this.t0) / 1000),
      transcript: this.finalText.trim(),
    };
  }
}

// Convert any decodable audio blob to 16 kHz mono WAV chunks (for AI transcription).
export async function toWavChunks(blob, chunkSec = 300) {
  const AC = window.AudioContext || window.webkitAudioContext;
  const ctx = new AC();
  let buf;
  try { buf = await ctx.decodeAudioData(await blob.arrayBuffer()); } finally { ctx.close?.(); }
  const rate = 16000;
  const off = new OfflineAudioContext(1, Math.max(1, Math.ceil(buf.duration * rate)), rate);
  const src = off.createBufferSource();
  src.buffer = buf;
  src.connect(off.destination);
  src.start();
  const samples = (await off.startRendering()).getChannelData(0);
  const per = chunkSec * rate;
  const chunks = [];
  for (let i = 0; i < samples.length; i += per) chunks.push(encodeWav(samples.subarray(i, i + per), rate));
  return chunks;
}

function encodeWav(f32, rate) {
  const buf = new ArrayBuffer(44 + f32.length * 2);
  const v = new DataView(buf);
  const w = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  w(0, 'RIFF'); v.setUint32(4, 36 + f32.length * 2, true); w(8, 'WAVE'); w(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  w(36, 'data'); v.setUint32(40, f32.length * 2, true);
  for (let i = 0; i < f32.length; i++) {
    const s = Math.max(-1, Math.min(1, f32[i]));
    v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Blob([buf], { type: 'audio/wav' });
}
