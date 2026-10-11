# Live Translate

Speak in one language; the room reads it in many. A Windows desktop app for live events.

- **Big screen**: 1–8 languages at the same time (Arabic, English, Chinese, French, German, Spanish, Turkish, Italian), with your event title, logo and background picture. It opens full screen on your projector or second monitor.
- **Phones**: the audience scans a QR code, picks up to 4 languages of their own (all shown together, the first one biggest), and reads along. They can also listen through earphones.
- **Always know it's working**: a live strip shows *Microphone → Speech → Text → Translation* and tells you in plain words where something stops.
- **Made for events**: announcements to the whole room, one-click looks, glossary for names and terms, saved events, standby screen, click-to-correct, faster mode, transcripts as PDF / text / subtitles.

## Install (Windows)

1. Open the **Releases** page of this repository and download **`LiveTranslate-Setup-….exe`**.
2. Double-click it, press *Next*, then *Install*. A *Live Translate* shortcut appears on your desktop and Start menu.
3. Open **Live Translate**. The first screen has a short checklist.

No installing wanted? **`LiveTranslate-Portable-….exe`** runs by double-clicking, nothing is installed.

> If Windows SmartScreen says *"Windows protected your PC"*, click **More info → Run anyway**. This appears because the app is not code-signed, which costs money. If Windows Firewall asks, click **Allow** (Private networks) so phones can connect.

## First run (2 minutes)

The app opens a **setup guide** the first time and walks you through every step below. You can reopen it any time with *Show me how* / *How to get it*.

**What are "keys"?** Two online services do the hard work: **Deepgram** is the *ears* (voice → text) and **Claude** is the *translator* (text → other languages). A key is a long password you copy from each service's website and paste into the app, once. You pay each service directly for what you use.

1. **Settings** → paste your two keys and press **Test key** on each:
   - **Deepgram** (speech to text): <https://deepgram.com>
   - **Anthropic** (translation, Claude): <https://console.anthropic.com>
2. **Live** → press **Test** next to the microphone and say a few words. The bars should move.
3. Pick the **speaker's language** (keys 1–9), press **Start listening**, and speak.
4. Press **Open big screen**. With a second monitor connected, it opens full screen there (change this in Settings → *Big screen window*). **Esc** leaves full screen.

Just looking? Choose **Demo** in the *Engine* box, or press *Try the demo*: it plays a short talk in all languages and needs no keys.

## If it doesn't hear or translate

Look at the strip under the *Start listening* button:

| Box is red/yellow | Meaning |
| --- | --- |
| **Microphone** | No sound reaches the app. Check the microphone is plugged in, not muted, and chosen in the list. Use **Test**. |
| **Speech** | The speech service is not connected. Check your Deepgram key (**Test key**) and the internet connection. |
| **Text** | Sound is sent but no words come back. Check the speaker's language is the right one, and speak closer or louder. |
| **Translation** | Text arrives but cannot be translated. Check your Claude key (**Test key**). |

Still stuck? **Settings → Troubleshooting → Copy diagnostics** and send that text to whoever helps you. It contains no keys and none of your speech. **Open data & logs folder** shows the log files.

## How the audience joins

Phones and the laptop must be on the same Wi-Fi (or the laptop's hotspot). Tick *Show the QR code on the big screen* (*Invite the audience* card) or share the link. Only the laptop controls the event; phones can only read. Phones need no internet of their own, only a connection to your laptop. The laptop needs internet for Deepgram and Claude.

## Two speakers, two languages?

- One person at a time: press the number key for the language they speak (**1–9**). Switching is instant.
- **Auto** detects the language by itself, but only for the languages Deepgram's multilingual mode covers (English, Spanish, French, Italian, German and a few others). For **Arabic, Chinese and Turkish, pick the language** with its key.
- *Several people talking* labels speakers (Speaker 1, 2, …) inside one language.

## Offline mode (no internet, no cost)

The app can hear and translate **on the laptop itself**. In **Settings → Offline mode** press **Download everything** once, while you have internet (about 1.15 GB):

| Pack | What | Size |
| --- | --- | --- |
| Translation | Mozilla's Firefox Translations models (the same offline engine Firefox uses), all 8 languages | 375 MB |
| Speech · fast | Whisper *base*: text about 1 s after each sentence | 208 MB |
| Speech · accurate | Whisper *large-v3-turbo*: much better for Arabic and Italian, a few seconds slower | 564 MB |

With the default **Automatic** settings it uses Deepgram and Claude when the internet works, and switches by itself to the offline engines when it doesn't (and back again when the internet returns). You can also choose *Always offline* to never use the internet or pay anything.

**How the offline mode gets better ("training")**
- **Built-in phrasebook**: common event sentences (welcome, breaks, Q&A, thanks…) hand-translated into all 8 languages, used word-for-word.
- **It learns from Claude**: every sentence Claude translates is remembered. Offline, the same or nearly the same sentence (a misheard word, different numbers) comes out exactly like Claude's translation.
- **Teach it before the event**: paste speeches, the agenda and names into *Teach the offline mode*. Claude translates them once into every language; offline, those sentences come out perfectly.
- **Glossary** works offline too: names stay exactly as written, and your required wordings are used.

Honest note: the offline translation is good but below Claude for complex or idiomatic sentences, and offline speech recognition is weaker for Arabic than Deepgram. Retraining the neural models themselves needs large datasets and GPUs; the app instead improves through the memory above, which is where events repeat themselves anyway.

## Arabic, Libyan dialect and government events

Set this up in **Glossary → Arabic and official events**. The defaults are Libyan speakers at an official event.

- **Online (Claude)**: Claude is told the speakers use Libyan Arabic (هلبا، نبي، توا، باهي، شن، ما…ش), the event is official, and that titles and protocol are rendered formally (معالي الوزير → His Excellency the Minister). Arabic speech uses the stronger Claude model; you can switch that off.
- **Arabic on screen**: *Cleaned into formal Arabic* turns spoken Libyan into clear فصحى for Arabic readers. *Exactly as spoken* shows the recognised words.
- **Speech**: Deepgram is asked for Libyan Arabic (ar-LY) first and falls back to general Arabic if that is not offered.
- **Offline**: Libyan words and grammar are rewritten into formal Arabic before the offline translator sees them (Arabic → English, chrF score out of 100):

  | Test sentences | As spoken | v2.1 | v2.2 |
  | --- | --- | --- | --- |
  | 25 new sentences, written before any 2.2 change and never used for tuning | 48.5 | 70.1 | **75.6** |
  | 20 sentences used to develop 2.2 | 40.9 | 57.0 | 73.9 |

  Formal Arabic passes through unchanged (checked on 20 formal sentences and on the formal versions of the test sets).
- **Phrasebook**: protocol lines (Bismillah, welcoming delegations, the national anthem, signing ceremonies, adjourning) in all 8 languages, and common Libyan ways of saying them (يعطيكم الصحة، مرحبتين بيكم…).
- **Glossary preset**: the **Add Libyan institutions and cities** button fills in the Presidential Council, the Government of National Unity, the House of Representatives, the Central Bank, major cities and more, with official names in every language. Arabic terms are found even with و / ب / لل attached.

Honest note: the offline improvements were measured on written test sentences. Speech recognition of real Libyan voices has not been measured yet. Before an important event, test with a recording of a real speaker, and use *Teach the offline mode* with the speeches and the agenda.

## Faster mode (on by default)

The translation appears while the speaker is still talking, on the big screen **and on phones**, and the final, polished translation replaces it the moment the sentence ends (the text never jumps back shorter). When the offline translation pack is installed these live drafts come from the laptop itself: about 0.8 s behind the speaker, and free. Without the pack they come from Claude. Switch it off in *Live* if you prefer only finished sentences.

## What changed in 2.2

- **Cheaper and quicker Claude**: Claude Haiku 5.5 by default (about a tenth of the cost of Haiku 4.5), with no "thinking" delay. The event setup (rules, context, glossary) is cached, so each sentence sends only itself. If your key cannot use Haiku 5.5 the app switches to Haiku 4.5 by itself.
- **Safer accuracy**: a remembered translation is reused only when it really is the same sentence. Before, "We will **not** continue" could get the remembered translation of "We will continue". Online, only exact matches are reused.
- **Names are heard correctly**: names and terms in your glossary are sent to Deepgram as key terms.
- **Never gives up**: Deepgram keeps reconnecting until the internet is back; offline speech restarts itself if it crashes; if Claude is overloaded, that sentence is translated offline instead of waiting.
- **Fixes**: correcting a sentence while it was still being translated could show the old translation; Windows pausing the microphone's audio is now resumed automatically.
- **New look**: the *Majlis* theme (night blue, antique gold, a quiet eight-point star pattern), one bundled typeface for Arabic and Latin (works offline), words that fade in as they are spoken, sound bars on the language being spoken, and a greeting in each language while waiting. Phones get a live card and their own light/dark switch.

## Tips for a great event

- Use a real microphone close to the speaker. Echo and applause are the biggest cause of bad text.
- Claude **Haiku** (default) is the fastest; Sonnet or Opus give more nuance (Settings).
- Put names and terms in **Glossary** before the event.
- Wide picture for the big screen, tall picture for phones. Darken the picture (Design) if text is hard to read.
- 2–4 languages on the big screen are the most comfortable to read.

## For developers

```
npm install
npm run desktop     # the desktop app (Electron)
npm start           # server only; open http://localhost:3000/control in a browser
npm test            # pipeline tests against mock Deepgram and Claude
npm run test:mic    # drives the real page with a fake microphone (needs Playwright)
npm run dist        # builds the Windows installer (on Windows; on Linux it builds the portable exe + zip)
```

| Path | What |
| --- | --- |
| `electron/` | Desktop shell: window, big-screen window, menu, microphone permission |
| `server/offline/` | Offline engines: Bergamot translation, Whisper speech (sherpa-onnx), translation memory, phrasebook, glossary, model downloads |
| `server/` | Speech, translation, WebSockets, exports, logs |
| `public/`, `views/` | Big screen, phone page, control panel |
| `test/`, `scripts/` | Automated tests and end-to-end checks |
| `.github/workflows/` | Builds the Windows installer on GitHub and attaches it to a release |

Your settings, pictures, transcripts and logs live in `%APPDATA%\Live Translate\data` (desktop app) or `./data` (server only). Keys can also come from a `.env` file (`DEEPGRAM_API_KEY`, `ANTHROPIC_API_KEY`, `PORT`).
