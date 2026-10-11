// The languages the app supports. `dg` is the Deepgram code, `web` the browser
// speech-recognition / speech-synthesis locale.
export const LANGUAGES = {
  ar: { code: 'ar', name: 'Arabic',  native: 'العربية',  dir: 'rtl', dg: 'ar', web: 'ar-SA', color: '#f2b84b', welcome: 'أهلًا وسهلًا', waiting: 'في انتظار المتحدث' },
  en: { code: 'en', name: 'English', native: 'English',  dir: 'ltr', dg: 'en', web: 'en-US', color: '#5aa2ff', welcome: 'Welcome', waiting: 'Waiting for the speaker' },
  zh: { code: 'zh', name: 'Chinese', native: '中文',      dir: 'ltr', dg: 'zh', web: 'zh-CN', color: '#ff6b6b', welcome: '欢迎', waiting: '等待发言人' },
  fr: { code: 'fr', name: 'French',  native: 'Français', dir: 'ltr', dg: 'fr', web: 'fr-FR', color: '#7c8cff', welcome: 'Bienvenue', waiting: 'En attente de l’orateur' },
  es: { code: 'es', name: 'Spanish', native: 'Español',  dir: 'ltr', dg: 'es', web: 'es-ES', color: '#ff9f5a', welcome: 'Bienvenidos', waiting: 'Esperando al orador' },
  tr: { code: 'tr', name: 'Turkish', native: 'Türkçe',   dir: 'ltr', dg: 'tr', web: 'tr-TR', color: '#e8556d', welcome: 'Hoş geldiniz', waiting: 'Konuşmacı bekleniyor' },
  de: { code: 'de', name: 'German',  native: 'Deutsch',  dir: 'ltr', dg: 'de', web: 'de-DE', color: '#c78bff', welcome: 'Willkommen', waiting: 'Warten auf den Redner' },
  it: { code: 'it', name: 'Italian', native: 'Italiano', dir: 'ltr', dg: 'it', web: 'it-IT', color: '#52d1a0', welcome: 'Benvenuti', waiting: 'In attesa dell’oratore' },
};

export const LANG_CODES = Object.keys(LANGUAGES);
export const isLang = (c) => Object.prototype.hasOwnProperty.call(LANGUAGES, c);
