// Background thread: offline speech recognition (Whisper via sherpa-onnx) with voice activity detection.
// Receives 16 kHz 16-bit mono PCM, finds where speech starts and ends, and transcribes each utterance.
const { parentPort } = require('node:worker_threads');
const sherpa = require('sherpa-onnx-node');

let vad = null;
let rec = null;
let opts = null;
let window = new Float32Array(0);
// Note: vad.front(false) copies samples; Electron forbids the default external buffers.
let speech = []; // samples of the utterance in progress (for live partial results)
let speechLen = 0;
let lastPartial = 0;
let preroll = []; // the last ~0.5 s before speech is detected, so the first word is not lost
let wasDetected = false;
const WINDOW = 512;
const HALLUCINATION = new RegExp('^(' + [
  '\\[.*\\]', '\\(.*\\)', '♪+', 'you', 'thank you', 'thanks for watching', 'thank you for watching', 'please subscribe',
  'subtitles by the amara\\.org community', '.*amara\\.org.*',
  'اشتركوا في( القناة)?', 'اشترك في القناة', 'شكرا للمشاهدة', 'شكرًا للمشاهدة', 'ترجمة نانسي قنقر', 'نانسي قنقر', 'شكرا', 'شكرًا',
  'grazie a tutti', 'grazie per la visione', 'sottotitoli.*', 'merci d.avoir regardé', 'sous-titr.*', 'gracias por ver', 'subtítulos.*',
  'vielen dank fürs zuschauen', 'untertitel.*', 'izlediğiniz için teşekkürler', 'altyazı.*', '请不吝点赞.*', '字幕.*', '谢谢观看',
].join('|') + ')$', 'iu');
const RATE = 16000;

function init(o) {
  opts = o;
  vad = new sherpa.Vad({
    sileroVad: { model: o.vad, threshold: 0.5, minSilenceDuration: 0.45, minSpeechDuration: 0.25, maxSpeechDuration: 14, windowSize: WINDOW },
    sampleRate: RATE, numThreads: 1, provider: 'cpu', debug: false,
  }, 60);
  rec = new sherpa.OfflineRecognizer({
    featConfig: { sampleRate: RATE, featureDim: 80 },
    modelConfig: {
      whisper: { encoder: o.encoder, decoder: o.decoder, language: o.language || '', task: 'transcribe', tailPaddings: -1 },
      tokens: o.tokens, numThreads: o.threads || 2, provider: 'cpu', debug: 0,
    },
  });
  // Warm up and time one decode: tells the app whether this laptop is fast enough for this model.
  const t0 = Date.now();
  try { transcribe(new Float32Array(RATE)); } catch { /* timing only */ }
  parentPort.postMessage({ type: 'ready', warmMs: Date.now() - t0 });
}

function transcribe(samples) {
  const st = rec.createStream();
  st.acceptWaveform({ samples, sampleRate: RATE });
  rec.decode(st);
  const r = rec.getResult(st);
  // Whisper can get stuck repeating a word ("نحن نحن نحن نحن…"): keep it once.
  const text = (r.text || '').trim().replace(/(\S+)(\s+\1){3,}/gu, '$1');
  // Whisper sometimes "hears" these in silence or noise (subtitle credits and video sign-offs it was trained on).
  if (!text || HALLUCINATION.test(text.replace(/[.!?。！？،,]+$/u, '').trim())) return null;
  return { text, lang: (r.lang || '').replace(/[<|>]/g, '') || undefined };
}

/** Transcribe a finished utterance and report how long it took (shown in the app and its diagnostics). */
function finalOf(samples) {
  const t0 = Date.now();
  const r = transcribe(samples);
  parentPort.postMessage({ type: 'stat', speechMs: Math.round((samples.length / RATE) * 1000), decodeMs: Date.now() - t0, empty: !r });
  if (r) parentPort.postMessage({ type: 'final', ...r });
}

function onAudio(buf) {
  const pcm = new Int16Array(buf.buffer, buf.byteOffset, buf.byteLength / 2);
  const f = new Float32Array(window.length + pcm.length);
  f.set(window);
  for (let i = 0; i < pcm.length; i += 1) f[window.length + i] = pcm[i] / 32768;
  let off = 0;
  while (off + WINDOW <= f.length) {
    const chunk = f.subarray(off, off + WINDOW);
    vad.acceptWaveform(chunk);
    const copy = Float32Array.from(chunk);
    const detected = vad.isDetected();
    if (detected) {
      if (!wasDetected) { speech = preroll.slice(); speechLen = speech.length * WINDOW; }
      speech.push(copy); speechLen += WINDOW;
    } else {
      preroll.push(copy);
      if (preroll.length > 16) preroll.shift();
    }
    wasDetected = detected;
    off += WINDOW;
    while (!vad.isEmpty()) {
      const seg = vad.front(false);
      vad.pop();
      speech = []; speechLen = 0;
      finalOf(seg.samples);
    }
  }
  window = f.slice(off);

  // A live preview while someone keeps talking (only with the fast model; the accurate one is too slow for this).
  if (opts.partials && speechLen > RATE * 1.2 && Date.now() - lastPartial > 1800) {
    lastPartial = Date.now();
    const all = new Float32Array(speechLen);
    let p = 0;
    for (const c of speech) { all.set(c, p); p += c.length; }
    const r = transcribe(all);
    if (r) parentPort.postMessage({ type: 'partial', ...r });
  }
}

parentPort.on('message', (m) => {
  try {
    if (m.type === 'init') init(m.opts);
    else if (m.type === 'partials') opts.partials = !!m.on;
    else if (m.type === 'audio' && rec) onAudio(m.data);
    else if (m.type === 'flush' && vad) {
      vad.flush();
      while (!vad.isEmpty()) { const seg = vad.front(false); vad.pop(); finalOf(seg.samples); }
      speech = []; speechLen = 0;
    }
  } catch (e) {
    parentPort.postMessage({ type: 'error', message: e.message });
  }
});
