// Tiny, dependency-free language guesser for the seven supported languages.
// Scripts (Arabic, Chinese) are unambiguous; Latin-script languages are scored
// on common function words plus a few telltale characters.
const STOP = {
  en: 'the and is are of to in that it for with as was on be this you we have not but they at from by an or will your our can all',
  fr: 'bonjour bonsoir merci à le la les des du de un une et est sont que qui dans pour pas vous nous avec sur ce cette au aux ne se il elle plus mais ou être',
  es: 'el la los las de del un una y es son que en por para con no se su al lo como más pero sus le ya este esta muy hay ser está',
  it: 'il lo la gli le di del un una e è sono che in per con non si su al come più ma suo questo questa anche ci essere sono della',
  de: 'der die das und ist nicht ein eine zu den mit für auf ich sie wir es dem von im auch sich aber als wie bei nach noch werden sind wird dass oder hier',
  tr: 'bir ve bu da de için ile ben sen biz siz çok ne var yok mi mı mu mü olarak daha gibi ama en şey her kadar sonra çünkü ki',
};
const SETS = Object.fromEntries(Object.entries(STOP).map(([k, v]) => [k, new Set(v.split(' '))]));
const CHARS = {
  tr: /[ğışİĞŞ]/g,
  de: /[äß]|\b(ich|nicht|und)\b/gi,
  fr: /[çèêëîïôûùœ]|\b(l'|d'|qu')/gi,
  es: /[ñ¿¡]|ción\b/gi,
  it: /\b(gli|che|perché|più)\b|[àèìòù]\b/gi,
};

export function detectLang(text, hint = 'en') {
  const t = String(text || '');
  const ar = (t.match(/[؀-ۿ]/g) || []).length;
  const zh = (t.match(/[㐀-鿿]/g) || []).length;
  const latin = (t.match(/[A-Za-zÀ-ÿĞğŞşİı]/g) || []).length;
  if (ar > latin && ar > zh) return 'ar';
  if (zh > latin && zh > ar) return 'zh';
  if (latin === 0) return hint;

  const words = t.toLowerCase().match(/[a-zçğıöşüàâäßèéêëîïôûùœñáíóúü']+/g) || [];
  const score = {};
  for (const lang of Object.keys(SETS)) {
    let s = 0;
    for (const w of words) if (SETS[lang].has(w)) s += 1;
    const m = t.match(CHARS[lang] || /$^/);
    if (m) s += m.length * 1.5;
    score[lang] = s;
  }
  let best = hint, bestScore = 0;
  for (const [lang, s] of Object.entries(score)) if (s > bestScore) { best = lang; bestScore = s; }
  return bestScore === 0 ? (Object.keys(SETS).includes(hint) ? hint : 'en') : best;
}
