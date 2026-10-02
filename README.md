# Live Translate

Speak in one language; the room reads it in many. A Windows desktop app for live events.

- **Big screen**: 1–8 languages at the same time (Arabic, English, Chinese, French, German, Spanish, Turkish, Italian), with your event title, logo and background picture. It opens full screen on your projector or second monitor.
- **Phones**: the audience scans a QR code, picks up to 4 languages of their own (all shown together, the first one biggest), and reads along. They can also listen through earphones.
- **Always know it's working**: a live strip shows *Microphone → Speech → Text → Translation* and tells you in plain words where something stops.
- **Made for events**: glossary for names and terms, saved events, standby screen, click-to-correct, faster mode, transcripts as PDF / text / subtitles.

## Install (Windows)

1. Open the **Releases** page of this repository and download **`LiveTranslate-Setup-….exe`**.
2. Double-click it, press *Next*, then *Install*. A *Live Translate* shortcut appears on your desktop and Start menu.
3. Open **Live Translate**. The first screen has a short checklist.

No installing wanted? **`LiveTranslate-Portable-….exe`** runs by double-clicking, nothing is installed.

> If Windows SmartScreen says *"Windows protected your PC"*, click **More info → Run anyway**. This appears because the app is not code-signed, which costs money. If Windows Firewall asks, click **Allow** (Private networks) so phones can connect.

## First run (2 minutes)

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

## Faster mode

Normally each sentence is translated when the speaker finishes it. **Faster mode** translates while they are still talking, so the screen is only a moment behind. It makes more Claude requests (more cost). Turn it on in *Live*.

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
| `server/` | Speech, translation, WebSockets, exports, logs |
| `public/`, `views/` | Big screen, phone page, control panel |
| `test/`, `scripts/` | Automated tests and end-to-end checks |
| `.github/workflows/` | Builds the Windows installer on GitHub and attaches it to a release |

Your settings, pictures, transcripts and logs live in `%APPDATA%\Live Translate\data` (desktop app) or `./data` (server only). Keys can also come from a `.env` file (`DEEPGRAM_API_KEY`, `ANTHROPIC_API_KEY`, `PORT`).
