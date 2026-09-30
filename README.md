# Live Translate

Speak in one language; the room reads it in many. Made for live events, run from a Windows laptop.

- **Big screen**: show 1–7 languages at the same time (Arabic, English, Chinese, French, Spanish, Turkish, Italian), with your event title, logo and a background picture.
- **Phones**: the audience scans a QR code, picks their language, and reads along on their own phone (optionally listening through the phone's speaker or earphones).
- **One speaker or many**: pick the speaker's language with one key, or let it label several speakers.
- **Made for events**: glossary for names and terms, saved events, standby screen, click-to-correct, transcripts as PDF / text / subtitles.

## Start it (Windows)

1. Install **Node.js LTS** (20.12 or newer) from <https://nodejs.org>.
2. Double-click **`start.bat`**. The first run installs what it needs; then the control panel opens in your browser.
3. Open **Settings** and paste your two keys:
   - **Deepgram** (speech to text): <https://deepgram.com>
   - **Anthropic** (translation, Claude): <https://console.anthropic.com>
4. Press **Open big screen ↗** and drag that window onto the projector or second monitor. Press **F** for full screen.
5. Press **Start listening** and speak.

No keys yet? Choose the **Demo** engine on the Live tab to see everything working with a built-in talk.

If Windows Firewall asks about `node.exe`, allow **Private networks**, otherwise phones cannot connect.

## How the audience joins

Phones and the laptop must be on the same Wi-Fi (or the laptop's mobile hotspot). Show the QR code on the big screen (*Invite the audience* card), or share the link. Only the laptop can open the control panel; phones can only read.
Phones need no internet of their own, only a connection to your laptop. The laptop needs internet for Deepgram and Claude.

## Two speakers, two languages?

- One person at a time: press the number key for the language they speak (**1–8**). Switching is instant.
- **Auto** detects the language by itself, but only for the languages Deepgram's multilingual mode covers (English, Spanish, French, Italian and a few others). For **Arabic, Chinese and Turkish, pick the language** with its key.
- *Several people talking* labels speakers (Speaker 1, 2, …) inside one language.

## Tips for a great event

- Use a real microphone close to the speaker. Room echo and applause are the biggest cause of bad text.
- Use **Claude Haiku** (default) for the fastest text; switch to Sonnet or Opus in Settings if quality matters more than speed.
- Put names and terms in **Glossary** before the event.
- Use a wide picture for the big screen and a tall picture for phones. They are resized automatically. Darken the picture (Design) if text is hard to read.
- 2–4 languages on the big screen are the most comfortable to read.

## Files

| Path | What |
| --- | --- |
| `server/` | Node server: speech, translation, WebSockets, exports |
| `public/` | Big screen (`display`), phone page (`join`), styles |
| `views/control.html` | Operator panel (laptop only) |
| `data/` | Your keys, settings, uploads, saved events and transcripts (not in git) |
| `test/` | `npm test` runs the whole pipeline against mock Deepgram and Claude |

Keys can also be set in a `.env` file (`DEEPGRAM_API_KEY=…`, `ANTHROPIC_API_KEY=…`, `PORT=3000`).
