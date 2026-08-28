/**
 * Duplicate detection for news articles.
 *
 * The crawler pulls the same event from many outlets, so URL-level dedup is not
 * enough: one policy announcement can arrive as 6 near-identical headlines.
 * This module scores headline similarity cheaply so the AI is only asked to
 * judge the genuinely ambiguous pairs.
 */

/** Identical normalized titles: duplicate without spending an AI call. */
export const EXACT_DUPLICATE_SCORE = 0.999;
/** Above this, headlines overlap so heavily that AI confirmation is wasted. */
export const AUTO_DUPLICATE_THRESHOLD = 0.85;
/** Below this, the stories share only generic vocabulary. Not worth an AI call. */
export const CANDIDATE_THRESHOLD = 0.45;

/** Words that appear in nearly every crypto headline and carry no signal. */
const STOPWORDS = new Set([
  // Vietnamese
  'va', 'cua', 'cho', 'voi', 'tai', 'tu', 'den', 'trong', 'tren', 'duoc', 'la', 'co',
  'khong', 'nhung', 'cac', 'mot', 'nay', 'do', 'se', 'da', 've', 'ra', 'vao', 'theo',
  'sau', 'truoc', 'khi', 'ma', 'nguoi', 'tin', 'tuc', 'bao', 'moi', 'the', 'nhat',
  // English
  'the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'with', 'at', 'by',
  'from', 'as', 'is', 'are', 'was', 'were', 'be', 'has', 'have', 'it', 'its', 'this',
  'that', 'after', 'over', 'new', 'says', 'said', 'will', 'amid'
]);

/**
 * Strips Vietnamese diacritics so "tài sản số" and "tai san so" compare equal.
 */
function removeDiacritics(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D');
}

/**
 * Reduces a headline to a comparable form: no diacritics, no outlet suffix,
 * no punctuation. Aggregators append " - VnExpress" or " | CoinDesk", which
 * would otherwise make identical stories look different.
 */
export function normalizeTitle(title: string): string {
  let text = removeDiacritics(String(title || '')).toLowerCase();

  // Drop a trailing outlet name, e.g. "... - VnExpress" or "... | CoinDesk".
  text = text.replace(/\s+[-|–—]\s+[^-|–—]{2,40}$/u, '');

  // Drop bracketed prefixes such as "[HOT]" or "(Video)".
  text = text.replace(/^\s*[\[(][^\])]{1,20}[\])]\s*/u, '');

  text = text
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  return text;
}

/**
 * Splits a normalized title into meaningful tokens.
 */
export function tokenize(normalized: string): string[] {
  return normalized
    .split(' ')
    .filter(word => word.length > 1 || /\d/.test(word))
    .filter(word => !STOPWORDS.has(word));
}

/**
 * Jaccard similarity over token sets, nudged up when one headline is fully
 * contained in the other ("Bo Tai chinh de xuat sandbox" vs the same headline
 * plus three extra words is the same story).
 */
export function similarity(tokensA: string[], tokensB: string[]): number {
  const setA = new Set(tokensA);
  const setB = new Set(tokensB);
  if (setA.size === 0 || setB.size === 0) return 0;

  let intersection = 0;
  for (const token of setA) {
    if (setB.has(token)) intersection++;
  }
  if (intersection === 0) return 0;

  const union = setA.size + setB.size - intersection;
  const jaccard = intersection / union;
  const containment = intersection / Math.min(setA.size, setB.size);

  // Containment alone over-fires on short headlines, so it only pulls the score
  // partway up rather than replacing it.
  return Math.max(jaccard, containment * 0.9);
}

export interface TitleFingerprint {
  normalized: string;
  tokens: string[];
}

export function fingerprint(title: string): TitleFingerprint {
  const normalized = normalizeTitle(title);
  return { normalized, tokens: tokenize(normalized) };
}
