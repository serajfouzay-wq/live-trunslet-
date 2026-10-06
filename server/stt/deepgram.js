import WebSocket from 'ws';

// Streaming speech-to-text through Deepgram. The browser captures the mic and
// sends 16 kHz mono PCM to us; we relay it and turn results into hub events.
// Model/language pairs to try in order; a 400 answer means "not supported", so the next pair is tried.
function candidatesFor(lang, multi, dialect) {
  if (multi) return [['nova-3', 'multi'], ['nova-2', 'multi']];
  const list = [];
  if (lang === 'ar' && dialect === 'ly') list.push(['nova-3', 'ar-LY']); // Libyan Arabic, if Deepgram offers it
  list.push(['nova-3', lang], ['nova-2', lang]);
  return list;
}
const BASE_URL = process.env.DEEPGRAM_URL || 'wss://api.deepgram.com/v1/listen'; // overridable for tests

export function createDeepgram({ key, lang, multi, dialect, diarize, onResult, onStatus }) {
  const candidates = candidatesFor(lang, multi, dialect);
  let ws = null;
  let closed = false;
  let ready = false;
  let idx = 0;
  let retries = 0;
  const pending = [];
  let keepAlive = null;
  let lastAudio = Date.now();

  function url([model, language]) {
    const q = new URLSearchParams({
      model,
      language,
      encoding: 'linear16',
      sample_rate: '16000',
      channels: '1',
      interim_results: 'true',
      smart_format: 'true',
      punctuate: 'true',
      endpointing: multi ? '100' : '450',
      utterance_end_ms: '1200',
      vad_events: 'true',
    });
    if (diarize) q.set('diarize', 'true');
    return `${BASE_URL}?${q}`;
  }

  function connect() {
    if (closed) return;
    const pair = candidates[idx];
    const model = `${pair[0]} ${pair[1]}`;
    onStatus?.({ state: 'connecting', detail: model });
    ws = new WebSocket(url(pair), { headers: { Authorization: `Token ${key}` } });

    ws.on('open', () => {
      ready = true;
      retries = 0;
      onStatus?.({ state: 'connected', detail: model });
      while (pending.length) ws.send(pending.shift());
      clearInterval(keepAlive);
      keepAlive = setInterval(() => {
        if (ready && Date.now() - lastAudio > 4000) ws.send(JSON.stringify({ type: 'KeepAlive' }));
      }, 4000);
    });

    ws.on('unexpected-response', (_req, res) => {
      // 400 usually means this model does not support the chosen language: try the next one.
      ready = false;
      if ((res.statusCode === 400 || res.statusCode === 404) && idx < candidates.length - 1) {
        idx += 1;
        return connect();
      }
      const msg = res.statusCode === 401 || res.statusCode === 403
        ? 'Deepgram rejected the API key'
        : `Deepgram error (HTTP ${res.statusCode})`;
      onStatus?.({ state: 'error', detail: msg });
    });

    ws.on('message', (raw) => {
      let m;
      try { m = JSON.parse(raw.toString()); } catch { return; }
      if (m.type === 'Results') {
        const alt = m.channel?.alternatives?.[0];
        if (!alt) return;
        const text = (alt.transcript || '').trim();
        let speaker = null;
        if (diarize && alt.words?.length) {
          const counts = {};
          for (const w of alt.words) if (w.speaker != null) counts[w.speaker] = (counts[w.speaker] || 0) + 1;
          const top = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
          if (top) speaker = Number(top[0]) + 1;
        }
        const detected = alt.languages?.[0]?.split('-')[0];
        if (!text && !m.speech_final) return;
        onResult({ text, final: !!m.is_final, speechFinal: !!m.speech_final, speaker, lang: multi ? detected : lang });
      } else if (m.type === 'UtteranceEnd') {
        onResult({ utteranceEnd: true });
      }
    });

    ws.on('error', (e) => onStatus?.({ state: 'error', detail: e.message }));
    ws.on('close', () => {
      ready = false;
      clearInterval(keepAlive);
      if (closed) return;
      if (retries < 5) {
        retries += 1;
        onStatus?.({ state: 'connecting', detail: 'reconnecting' });
        setTimeout(connect, 800 * retries);
      } else {
        onStatus?.({ state: 'error', detail: 'Connection to Deepgram lost' });
      }
    });
  }

  connect();

  return {
    send(buf) {
      lastAudio = Date.now();
      if (ready && ws.readyState === WebSocket.OPEN) ws.send(buf);
      else if (pending.length < 40) pending.push(buf); // ~4 s of audio while (re)connecting
    },
    close() {
      closed = true;
      clearInterval(keepAlive);
      try {
        if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'CloseStream' }));
        ws?.close();
      } catch { /* ignore */ }
    },
  };
}
