// Offline helpers that need no downloaded models: translation memory, phrasebook, glossary placeholders.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TranslationMemory, norm } from '../server/offline/memory.js';

process.env.DATA_DIR ||= fs.mkdtempSync(path.join(os.tmpdir(), 'lt-off-'));
const { parseGlossary, protect, restore, intact } = await import('../server/offline/glossary.js');
const phrasebookFile = path.resolve('server/offline/phrasebook.json');

test('phrasebook covers every language pair, with numbers and small differences', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lt-mem-')), 'learned.jsonl');
  const m = new TranslationMemory({ file, phrasebookFile });
  assert.equal(m.lookup('Thank you all for coming!', 'en', 'ar').text, 'شكرًا لكم جميعًا على حضوركم.');
  assert.equal(m.lookup('شكرا لكم جميعا على حضوركم', 'ar', 'de').text, 'Vielen Dank an alle fürs Kommen.', 'Arabic without vowel marks still matches');
  assert.equal(m.lookup('We will continue in 20 minutes.', 'en', 'fr').text, 'Nous reprendrons dans 20 minutes.', 'numbers are carried over');
  assert.equal(m.lookup('Thank you all for comming.', 'en', 'es').how, 'similar', 'a misheard letter still matches');
  assert.equal(m.lookup('We will continue tomorrow.', 'en', 'fr'), null);
  assert.equal(m.lookup('Thank you all for not coming.', 'en', 'fr'), null, 'a different meaning must not match');
});

test('learned translations are saved, reloaded and can be forgotten', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lt-mem-')), 'learned.jsonl');
  const m = new TranslationMemory({ file, phrasebookFile });
  m.add('en', 'tr', 'The solar panels arrive next week.', 'Güneş panelleri gelecek hafta geliyor.');
  m.flush();
  const again = new TranslationMemory({ file, phrasebookFile });
  assert.equal(again.lookup('the solar panels arrive next week', 'en', 'tr').text, 'Güneş panelleri gelecek hafta geliyor.');
  assert.equal(again.stats().learned, 1);
  again.clearLearned();
  assert.equal(again.lookup('The solar panels arrive next week.', 'en', 'tr'), null);
  assert.ok(again.lookup('Coffee break.', 'en', 'it'), 'the phrasebook survives forgetting');
  assert.equal(norm('  Hello, WORLD!! '), 'hello world');
});

test('glossary: names kept, per-language wording, placeholders checked', async () => {
  const g = parseGlossary('Seraj Fouzay\nnet zero = de: Netto-Null; fr: zéro émission nette\nannual conference = المؤتمر السنوي\n# comment');
  assert.equal(g.length, 3);
  const { text, slots } = protect('Seraj Fouzay talks about net zero at the annual conference.', g);
  assert.match(text, /^XQ\d talks about XQ\d at the XQ\d\.$/);
  const translated = text.replace('talks about', 'spricht über').replace('at the', 'auf der');
  assert.ok(intact(translated, slots));
  const out = await restore(translated, slots, 'de', async (term) => `[${term}]`);
  assert.equal(out, 'Seraj Fouzay spricht über Netto-Null auf der [annual conference].');
  assert.ok(!intact('Seraj spricht über XQ2.', slots), 'a lost placeholder is detected');
  const ar = await restore(text.replace('talks about', 'يتحدث عن').replace('at the', 'في'), slots, 'ar', async (t) => t);
  assert.match(ar, /المؤتمر السنوي/);
});
