// Fake Deepgram + Claude services for end-to-end checks without real keys.
import http from 'node:http';
import { WebSocketServer } from 'ws';

export async function startMocks() {
  const stats = { audioBytes: 0 };
  const dg = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise((r) => dg.on('listening', r));
  dg.on('connection', (ws) => {
    let sent = 0;
    ws.on('message', (d, bin) => {
      if (!bin) return;
      stats.audioBytes += d.length;
      if (stats.audioBytes > 16000 && sent === 0) { sent = 1; ws.send(JSON.stringify({ type: 'Results', is_final: false, channel: { alternatives: [{ transcript: 'hello there', words: [] }] } })); }
      if (stats.audioBytes > 48000 && sent === 1) { sent = 2; ws.send(JSON.stringify({ type: 'Results', is_final: true, speech_final: true, channel: { alternatives: [{ transcript: 'hello there everyone.', words: [] }] } })); }
    });
  });
  const an = http.createServer((req, res) => {
    if (req.method === 'GET') { res.writeHead(200); return res.end('{}'); }
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => {
      const u = JSON.parse(b).messages[0].content;
      const l = /into (\w+):/.exec(u)?.[1];
      const t = /<text>([\s\S]*?)<\/text>/.exec(u)?.[1];
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const ev = (n, d) => res.write(`event: ${n}\ndata: ${JSON.stringify(d)}\n\n`);
      ev('message_start', { type: 'message_start', message: { id: 'm', type: 'message', role: 'assistant', model: 'x', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } });
      ev('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
      ev('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: `[${l}] ${t}` } });
      ev('content_block_stop', { type: 'content_block_stop', index: 0 });
      ev('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } });
      ev('message_stop', { type: 'message_stop' });
      res.end();
    });
  });
  await new Promise((r) => an.listen(0, '127.0.0.1', r));
  const anUrl = `http://127.0.0.1:${an.address().port}`;
  return {
    stats,
    env: { DEEPGRAM_API_KEY: 'k', ANTHROPIC_API_KEY: 'k', ANTHROPIC_BASE_URL: anUrl, DEEPGRAM_URL: `ws://127.0.0.1:${dg.address().port}`, DEEPGRAM_REST_URL: anUrl },
    close() { dg.close(); an.close(); },
  };
}
