// Built-in demo talk: lets you try the whole app (screens, layouts, phones)
// without any API keys. Each line exists in all seven languages.
const LINES = [
  { src: 'en', en: 'Good evening everyone, and welcome to our annual conference.',
    ar: 'مساء الخير جميعًا، ومرحبًا بكم في مؤتمرنا السنوي.',
    zh: '大家晚上好，欢迎来到我们的年度大会。',
    fr: 'Bonsoir à tous, et bienvenue à notre conférence annuelle.',
    es: 'Buenas noches a todos, y bienvenidos a nuestra conferencia anual.',
    tr: 'Herkese iyi akşamlar, yıllık konferansımıza hoş geldiniz.',
    it: 'Buonasera a tutti, e benvenuti alla nostra conferenza annuale.' },
  { src: 'ar', ar: 'يسعدنا أن نجمع اليوم أشخاصًا من أكثر من ثلاثين دولة تحت سقف واحد.',
    en: 'We are delighted to bring together people from more than thirty countries under one roof today.',
    zh: '今天，我们很高兴能将来自三十多个国家的人们汇聚一堂。',
    fr: 'Nous sommes ravis de réunir aujourd’hui des personnes venues de plus de trente pays sous un même toit.',
    es: 'Nos alegra reunir hoy bajo un mismo techo a personas de más de treinta países.',
    tr: 'Bugün otuzdan fazla ülkeden insanı tek bir çatı altında bir araya getirmekten mutluluk duyuyoruz.',
    it: 'Siamo lieti di riunire oggi sotto lo stesso tetto persone provenienti da più di trenta paesi.' },
  { src: 'fr', fr: 'Chacun parle sa langue, mais ici, tout le monde se comprend.',
    en: 'Everyone speaks their own language, but here, everyone understands each other.',
    ar: 'كلٌّ يتحدث لغته، لكن هنا يفهم الجميع بعضهم بعضًا.',
    zh: '每个人都说自己的语言，但在这里，大家都能彼此理解。',
    es: 'Cada uno habla su propio idioma, pero aquí todos se entienden.',
    tr: 'Herkes kendi dilini konuşuyor, ama burada herkes birbirini anlıyor.',
    it: 'Ognuno parla la propria lingua, ma qui tutti si capiscono.' },
  { src: 'en', en: 'Our first session starts in ten minutes, so please find your seats.',
    ar: 'تبدأ جلستنا الأولى بعد عشر دقائق، فيُرجى التوجه إلى مقاعدكم.',
    zh: '我们的第一场会议将在十分钟后开始，请大家就座。',
    fr: 'Notre première session commence dans dix minutes, veuillez donc rejoindre vos places.',
    es: 'Nuestra primera sesión comienza en diez minutos, así que por favor busquen sus asientos.',
    tr: 'İlk oturumumuz on dakika sonra başlayacak, lütfen yerlerinizi alın.',
    it: 'La nostra prima sessione inizia tra dieci minuti, quindi vi prego di prendere posto.' },
  { src: 'es', es: 'Gracias por estar aquí; este evento es posible gracias a todos ustedes.',
    en: 'Thank you for being here; this event is possible thanks to all of you.',
    ar: 'شكرًا لحضوركم؛ هذا الحدث ممكن بفضلكم جميعًا.',
    zh: '感谢大家的到来，这次活动离不开各位的支持。',
    fr: 'Merci d’être ici ; cet événement est possible grâce à vous tous.',
    tr: 'Burada olduğunuz için teşekkürler; bu etkinlik hepiniz sayesinde mümkün.',
    it: 'Grazie per essere qui; questo evento è possibile grazie a tutti voi.' },
  { src: 'tr', tr: 'Şimdi sözü ilk konuşmacımıza bırakıyorum.',
    en: 'Now I will hand the floor to our first speaker.',
    ar: 'والآن أترك الكلمة لمتحدثنا الأول.',
    zh: '现在，我把发言权交给我们的第一位演讲嘉宾。',
    fr: 'Je laisse maintenant la parole à notre premier intervenant.',
    es: 'Ahora le cedo la palabra a nuestro primer orador.',
    it: 'Ora cedo la parola al nostro primo relatore.' },
];

// text (in its source language) -> all translations
export const DEMO_TRANSLATIONS = new Map(LINES.map((l) => [l[l.src], l]));

const sleep = (ms, signal) => new Promise((res) => {
  const t = setTimeout(res, ms);
  signal?.addEventListener('abort', () => { clearTimeout(t); res(); }, { once: true });
});

/** Plays the demo talk into the hub as if it were live speech. Loops until aborted. */
export async function runDemo(hub, signal) {
  let i = 0;
  while (!signal.aborted) {
    const line = LINES[i % LINES.length];
    const text = line[line.src];
    const cjk = line.src === 'zh';
    const words = cjk ? Array.from(text) : text.split(' ');
    let shown = [];
    for (const w of words) {
      if (signal.aborted) return;
      shown.push(w);
      hub.ingestStt({ text: shown.join(cjk ? '' : ' '), final: false, lang: line.src, speaker: (i % 3) + 1 });
      await sleep(cjk ? 90 : 170, signal);
    }
    if (signal.aborted) return;
    hub.ingestStt({ text, final: true, speechFinal: true, lang: line.src, speaker: (i % 3) + 1 });
    i += 1;
    await sleep(4200, signal);
  }
}
