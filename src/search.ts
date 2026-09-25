/**
 * Finding the source notes a question is likely to be answered from.
 *
 * This exists because the fallback used to answer that question with *recency*:
 * it took the newest fifteen notes of each source area and asked the model which
 * one held the answer. With a real vault that is not a search. Measured on the
 * vault this was written for — 101 notes in `00-src`, 78 in `10-journal` — the
 * window covered at most 45 of 179 notes, and the note that actually identified
 * the subject of the question sat at position **44 of 101**, ten times too deep
 * to ever be offered. The note was in the vault and the panel could never point
 * at it, which reads exactly like the note not existing.
 *
 * So the pool becomes the whole source set, and the filter becomes the words of
 * the question. Two properties are worth stating, because they are the reason
 * this is a separate, pure module:
 *
 * - **No model.** Scoring is string matching over text the vault has already
 *   cached. The model is still asked which candidate holds the answer, but the
 *   *finding* no longer depends on it — which matters on a model served on this
 *   machine, where a query can fail for reasons that have nothing to do with the
 *   question.
 * - **Every script.** Folding only strips combining accents, and the word split
 *   is by Unicode letter class, so Tifinagh, Greek or Cyrillic terms survive
 *   intact. A regex spelled `[a-z0-9]` would have thrown away exactly the notes
 *   this vault is full of.
 */

/**
 * Words that carry no signal about *which* note is meant.
 *
 * Written already folded (no accents), because that is what they are compared
 * against. The list is deliberately short: a term that is merely common costs a
 * little noise, whereas dropping a real term silently hides a note — and the
 * second failure is the one this module exists to remove.
 */
const STOPWORDS = new Set([
  // Spanish
  'que', 'cual', 'cuales', 'como', 'donde', 'quien', 'quienes', 'cuando', 'cuanto', 'cuanta',
  'los', 'las', 'del', 'una', 'uno', 'unos', 'unas', 'por', 'para', 'con', 'sin', 'sobre',
  'este', 'esta', 'esto', 'estos', 'estas', 'ese', 'esa', 'eso', 'esos', 'esas', 'aquel',
  'hay', 'ser', 'son', 'era', 'fue', 'esta', 'estan', 'tiene', 'tienen', 'hace', 'hacen',
  'mas', 'menos', 'muy', 'todo', 'toda', 'todos', 'todas', 'algo', 'alguien', 'nada',
  'segun', 'entre', 'desde', 'hasta', 'pero', 'porque', 'pues', 'sino', 'aunque',
  // English
  'the', 'and', 'for', 'with', 'from', 'about', 'what', 'which', 'where', 'when', 'who',
  'how', 'why', 'this', 'that', 'these', 'those', 'there', 'their', 'are', 'was', 'were',
  'does', 'did', 'doing', 'has', 'have', 'had', 'can', 'could', 'should', 'would', 'into',
]);

/** Anything that is not a letter, a number or a `+` separates two words. */
const WORD_SEPARATORS = /[^\p{L}\p{N}+]+/u;

/**
 * Lowercase, with combining accents removed.
 *
 * `NFD` plus the combining-mark range: `internacionalización` and
 * `internacionalizacion` become the same term, which is how the same word gets
 * written in different notes. It is not a transliteration — Tifinagh letters and
 * `ɣ` are unaffected, and they should be: two notes that differ in a letter are
 * two different words.
 */
export function fold(text: string): string {
  return text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

/**
 * The words of a question worth looking for, in order and without repeats.
 *
 * Terms shorter than three characters and bare numbers are dropped: they match
 * half the vault and push the real terms out of the limit. A question made only
 * of stopwords — "¿qué es?" — comes back empty on purpose, and an empty term list
 * is what sends the caller to the recency fallback.
 */
export function queryTerms(question: string): string[] {
  const seen = new Set<string>();
  for (const term of fold(question).split(WORD_SEPARATORS)) {
    if (term.length < 3) continue;
    // `+` is a word character here, so `C++` survives as one term. A run of `+`
    // with nothing else (`+++`) is punctuation, and it is dropped by requiring a
    // letter or a digit. Stripping the `+` instead — the obvious-looking fix —
    // turned `C++` into `c`, one character, and threw the term away.
    if (!/[\p{L}\p{N}]/u.test(term)) continue;
    if (STOPWORDS.has(term)) continue;
    // A bare number says nothing about which note is meant.
    if (/^\d+$/.test(term)) continue;
    seen.add(term);
  }
  return [...seen];
}

/** A note to score: its vault path, its text, and when it was last written. */
export interface SourceDoc {
  path: string;
  text: string;
  mtime: number;
}

/** A note that matched, with the terms that made it match. */
export interface SourceHit {
  path: string;
  score: number;
  matched: string[];
}

/**
 * How much a term is worth in the file name against its body.
 *
 * A name is a title, and a title that contains the word is almost always about
 * it; a body mention can be a passing reference. Measured on this vault with
 * "¿Qué es Lisa?": the four notes with `Lisa` in the name take the first four
 * places, and `00 - Desarrollo de Lisa.md` — the one that says what Lisa is, and
 * the one that by date sat at position 44 of 101 — lands third of the 83 notes
 * that mention the term, well inside the twenty that are offered.
 */
const NAME_WEIGHT = 4;
/**
 * Repeats of one term inside one note stop counting here. A note that says "lisa"
 * forty times is about Lisa, not forty times more about it than one that says it
 * ten — and without a cap, a single long note would fill the whole candidate list.
 */
const BODY_CAP = 4;

const isWordChar = (char: string | undefined): boolean =>
  char !== undefined && /[\p{L}\p{N}]/u.test(char);

/**
 * Occurrences of `term` that begin a word: `lisa` matches `Lisa` and `lisas`, not
 * `analisa`. Substring matching alone is how a search picks up notes that merely
 * *contain* the letters, which is most of the noise it can avoid for free.
 */
function countWordStarts(haystack: string, term: string): number {
  let count = 0;
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(term, from);
    if (at === -1) return count;
    if (!isWordChar(haystack[at - 1])) count++;
    from = at + 1;
  }
}

/**
 * Every note that mentions any term of the question, best first.
 *
 * Ties are broken by recency and then by path, so the order is total and two runs
 * of the same query hand the model the same list — a screenshot of the panel is
 * then worth something.
 */
export function rankSources(question: string, docs: readonly SourceDoc[]): SourceHit[] {
  const terms = queryTerms(question);
  if (terms.length === 0) return [];

  const hits: SourceHit[] = [];
  for (const doc of docs) {
    const name = fold(doc.path.split('/').pop() ?? doc.path);
    const body = fold(doc.text);
    let score = 0;
    const matched: string[] = [];
    for (const term of terms) {
      let worth = 0;
      if (countWordStarts(name, term) > 0) worth += NAME_WEIGHT;
      const inBody = countWordStarts(body, term);
      if (inBody > 0) worth += Math.min(inBody, BODY_CAP);
      if (worth > 0) {
        score += worth;
        matched.push(term);
      }
    }
    // A note has to match *something* to be a candidate: handing the model notes
    // that score zero is how the old window filled up with whatever was touched
    // most recently, none of it about the question.
    if (score > 0) hits.push({ path: doc.path, score, matched });
  }

  hits.sort(
    (a, b) =>
      b.score - a.score || mtimeOf(b, docs) - mtimeOf(a, docs) || a.path.localeCompare(b.path),
  );
  return hits;
}

/** The mtime of a hit's path. A map would be faster and this is not the hot path. */
function mtimeOf(hit: SourceHit, docs: readonly SourceDoc[]): number {
  return docs.find(doc => doc.path === hit.path)?.mtime ?? 0;
}

/**
 * The newest notes of each configured area — the *old* behaviour, kept as the
 * fallback for a question with no usable term ("¿qué es?").
 *
 * Each area contributes its own newest notes, so adding a second source folder
 * widens the net instead of hiding the first one, and `checkboxDir` — which sits
 * inside `00-src` — still gets its own slice.
 */
export function recencyCandidates(
  docs: readonly SourceDoc[],
  areas: readonly string[],
  perArea: number,
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const area of areas) {
    const root = area.trim().replace(/\/+$/, '');
    if (root === '') continue;
    const under = docs
      .filter(doc => doc.path.startsWith(`${root}/`))
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, perArea);
    for (const doc of under) {
      if (seen.has(doc.path)) continue;
      seen.add(doc.path);
      out.push(doc.path);
    }
  }
  return out;
}
