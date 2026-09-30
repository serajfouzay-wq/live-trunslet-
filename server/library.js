import fs from 'node:fs';
import path from 'node:path';
import { DIRS } from './config.js';
import { buildExport } from './export.js';

const ID = /^[\w-]{1,60}$/;
const readJson = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };

/** Saved events (design + languages + glossary), session history and transcript export. */
export function registerLibrary(api, hub) {
  /* ------------------------------------------------------------ events */
  api.get('/events', (req, res) => {
    const list = fs.readdirSync(DIRS.events).filter((f) => f.endsWith('.json')).map((f) => readJson(path.join(DIRS.events, f)))
      .filter(Boolean)
      .map((e) => ({ id: e.id, name: e.name, savedAt: e.savedAt, title: e.settings?.title, langs: e.settings?.screenLangs, theme: e.settings?.theme, logo: e.settings?.logo, bg: e.settings?.bgLandscape || e.settings?.bgPortrait }))
      .sort((a, b) => b.savedAt - a.savedAt);
    res.json(list);
  });

  api.post('/events', (req, res) => {
    const name = String(req.body?.name || '').trim().slice(0, 80);
    if (!name) return res.status(400).json({ error: 'Give the event a name.' });
    let id = String(req.body?.id || '');
    if (!ID.test(id)) id = `${name.toLowerCase().replace(/[^\w]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'event'}-${Date.now().toString(36)}`;
    const { blank, showQR, ...settings } = hub.settings; // eslint-disable-line no-unused-vars
    fs.writeFileSync(path.join(DIRS.events, `${id}.json`), JSON.stringify({ id, name, savedAt: Date.now(), settings }, null, 2));
    res.json({ id });
  });

  api.post('/events/:id/load', (req, res) => {
    if (!ID.test(req.params.id)) return res.status(400).end();
    const e = readJson(path.join(DIRS.events, `${req.params.id}.json`));
    if (!e) return res.status(404).json({ error: 'Event not found.' });
    hub.updateSettings(e.settings);
    res.json({ ok: true });
  });

  api.delete('/events/:id', (req, res) => {
    if (!ID.test(req.params.id)) return res.status(400).end();
    try { fs.unlinkSync(path.join(DIRS.events, `${req.params.id}.json`)); } catch { /* already gone */ }
    res.json({ ok: true });
  });

  /* ---------------------------------------------------------- sessions */
  const loadSession = (id) => {
    if (id === hub.session.id) return { session: hub.session, segments: hub.segments, settings: hub.settings };
    const s = readJson(path.join(DIRS.sessions, `${id}.json`));
    return s ? { session: { id: s.id, name: s.name, startedAt: s.startedAt }, segments: s.segments || [], settings: { ...hub.settings, ...(s.settings || {}) } } : null;
  };

  api.get('/sessions', (req, res) => {
    hub.persistNow();
    const files = fs.readdirSync(DIRS.sessions).filter((f) => f.endsWith('.json'));
    const list = files.map((f) => {
      const s = readJson(path.join(DIRS.sessions, f));
      return s && { id: s.id, name: s.name, startedAt: s.startedAt, count: s.segments?.length || 0 };
    }).filter(Boolean);
    if (!list.some((s) => s.id === hub.session.id)) list.push({ ...hub.session, count: hub.segments.length });
    list.sort((a, b) => b.startedAt - a.startedAt);
    res.json({ current: hub.session.id, sessions: list });
  });

  api.get('/sessions/:id/export', async (req, res) => {
    if (!ID.test(req.params.id)) return res.status(400).end();
    const data = loadSession(req.params.id);
    if (!data) return res.status(404).send('Session not found.');
    try {
      const out = await buildExport(data, {
        format: String(req.query.format || 'html'),
        langs: String(req.query.langs || '').split(',').filter(Boolean),
        fill: req.query.fill === '1',
      });
      res.type(out.type);
      if (!out.inline) res.setHeader('Content-Disposition', `attachment; filename="${out.file}"`);
      res.send(out.body);
    } catch (e) { res.status(500).send(e.message); }
  });

  api.delete('/sessions/:id', (req, res) => {
    if (!ID.test(req.params.id) || req.params.id === hub.session.id) return res.status(400).json({ error: 'The current session cannot be deleted. Start a new one first.' });
    try { fs.unlinkSync(path.join(DIRS.sessions, `${req.params.id}.json`)); } catch { /* ignore */ }
    res.json({ ok: true });
  });

}
