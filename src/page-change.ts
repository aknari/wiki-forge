/**
 * What a distillation actually added to a page.
 *
 * The merge pass asks the model to rewrite the pages a note belongs to, keeping
 * what they already say. Measured on this vault, that is where a whole ingest
 * can come back empty without anything saying so: `00 - Desarrollo de Lisa.md`
 * (which opens with "Lisa es un modelo de procesador RISC-V desarrollado en
 * C++…") was distilled three times, and the merge returned
 * `lisa-architecture-overview.md` **byte for byte as it was**, plus two pages
 * with nothing but a fixed typo. The log said "Processed …", the state recorded
 * the note as done, and the wiki had learned nothing. Three runs later the panel
 * was still reporting that the wiki did not know what Lisa was.
 *
 * The cause is not transport, parsing or writing — all three demonstrably
 * worked. It is that a small local model asked to *rewrite* four pages while
 * "never dropping content" takes the shortest road and copies. The prompt is
 * asked to be more precise about this (see `MERGE_OUTPUT_CONTRACT`); this module
 * is the second half of the answer, the one that does not depend on the model:
 * if a distillation added no statement, say so instead of recording a silent
 * no-op as a success.
 *
 * Why similarity and not "the text differs": a page that comes back with a fixed
 * typo, a reworded clause or a different accent is *different* and has learned
 * nothing, and a check on inequality would keep quiet about exactly the case
 * worth reporting. So each statement of the new page is compared against the
 * statements the page had, and only one that resembles none of them counts as
 * added.
 *
 * Two scales, and the larger one wins, because one alone gets the real cases
 * wrong. Measured on the pairs this vault actually produced:
 *
 * | statement, before → after                                    | words | letters |
 * |--------------------------------------------------------------|-------|---------|
 * | `dove-mode M: MIE.` → `- Modo M: MIE.` (a line re-rendered)   |  0.40 |    0.80 |
 * | `En el contexto de RISC-V…` → `En el contexto RISC-V…`        |  1.00 |    1.00 |
 * | the RISC-V sentence vs the opening the page had               |  0.23 |    0.62 |
 *
 * Words alone call the first pair *new content*, because the model rewrites
 * `dove-mode` as `Modo` and `mode` is not `modo` — and that is the local model's
 * documented letter-level noise (`Dispotcher` for *Dispatcher*, `sintencia` for
 * *síntesis*; see `sampling.ts`), so a word-only rule is defeated by exactly the
 * text a copy-back merge comes with. Letters alone call the third pair *already
 * said* (0.62), which would report a page as unchanged right after it learned
 * what it was missing. With both, the threshold sits in the gap: 0.7, with 0.80
 * above it (the restatement) and 0.62 below (the new fact).
 *
 * Pure on purpose (no Obsidian import), so the threshold and the splitter are
 * covered by tests (`test/page-change.test.ts`) with those measured pairs.
 */
import { splitFrontmatter } from './wikitext';

/** How alike two statements must be to count as "the page already said this". */
export const SIMILARITY_THRESHOLD = 0.7;

/** Words shorter than this say nothing about *which* statement is meant. */
const MIN_TOKEN_LENGTH = 3;

/** Lowercase without combining accents, so `Síntesis` and `sintesis` are one word. */
function fold(text: string): string {
  return text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

/**
 * The words of a statement, without repeats.
 *
 * Short words are dropped: `de`, `el`, `la` are shared by every sentence in the
 * language, and counting them would make any two statements about the same
 * subject look alike. `+` is kept as part of a word so `C++` survives, the same
 * rule the source search uses.
 */
export function statementTokens(statement: string): string[] {
  const seen = new Set<string>();
  for (const token of fold(statement).split(/[^\p{L}\p{N}+]+/u)) {
    if (token.length < MIN_TOKEN_LENGTH) continue;
    if (!/[\p{L}\p{N}]/u.test(token)) continue;
    seen.add(token);
  }
  return [...seen];
}

/**
 * The statements a page makes: the body split where prose ends — a line break, a
 * full stop, a `?` or a `!` — with the frontmatter out (it is metadata, and a
 * model rewriting a page is entitled to re-stamp it) and the code fences out
 * (their lines are not prose, and every fence marker would otherwise read as a
 * statement of its own).
 *
 * Statements with fewer than two words are dropped: a bullet like `- Sí` is not
 * a fact anyone can check for.
 */
export function statementsOf(text: string): string[] {
  const body = splitFrontmatter(text).body.replace(/^\s*(?:```|~~~).*$/gm, '\n');
  const out: string[] = [];
  let current = '';
  const push = (): void => {
    const statement = current.trim();
    current = '';
    if (statement !== '' && statementTokens(statement).length >= 2) out.push(statement);
  };
  for (let i = 0; i < body.length; i++) {
    const char = body[i] ?? '';
    if (char === '\n') {
      push();
      continue;
    }
    current += char;
    if (char === '.' || char === '!' || char === '?') {
      const next = body[i + 1];
      if (next === undefined || next === '\n' || next === ' ') push();
    }
  }
  push();
  return out;
}

/** Sørensen–Dice over two bags: 0 when nothing is shared, 1 when identical. */
function dice(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const item of a) if (b.has(item)) shared++;
  return (2 * shared) / (a.size + b.size);
}

/** Sørensen–Dice over the words: 0 when nothing is shared, 1 when identical. */
export function statementSimilarity(a: readonly string[], b: readonly string[]): number {
  return dice(new Set(a), new Set(b));
}

/**
 * The overlapping pairs of characters of a statement, whitespace collapsed.
 *
 * This is the scale that survives a model's letter noise: `dove-mode` and `Modo`
 * share no word, and share `mo`/`od`/`do`, which is what makes them the same line
 * said twice.
 */
function characterPairs(statement: string): Set<string> {
  const text = fold(statement).replace(/[^\p{L}\p{N}+]+/gu, ' ');
  const pairs = new Set<string>();
  for (let i = 0; i + 1 < text.length; i++) pairs.add(text.slice(i, i + 2));
  return pairs;
}

/**
 * How much two statements say the same thing: words or letters, whichever match
 * better. See the table at the top of the file for why it is the larger one.
 */
export function statementResemblance(a: string, b: string): number {
  return Math.max(
    statementSimilarity(statementTokens(a), statementTokens(b)),
    dice(characterPairs(a), characterPairs(b)),
  );
}

export interface PageChange {
  /** True when the page did not exist before, so everything on it is new. */
  created: boolean;
  /** Statements the rewrite added: the sentences the page did not have. */
  added: string[];
}

/**
 * The statements a rewrite added to a page, given the text it had before.
 *
 * `before` is `null` for a page that did not exist: a created page counts as
 * `created`, and its statements are not listed as "added" — one page's worth of
 * sentences in a notice is noise, and the caller has the page path for that.
 */
export function pageChange(
  before: string | null,
  after: string,
  threshold = SIMILARITY_THRESHOLD,
): PageChange {
  if (before === null) return { created: true, added: [] };
  const had = statementsOf(before);
  const added: string[] = [];
  for (const statement of statementsOf(after)) {
    const closest = had.reduce((best, old) => Math.max(best, statementResemblance(statement, old)), 0);
    if (closest < threshold) added.push(statement);
  }
  return { created: false, added };
}

/** The statements `after` added to `before`, without the shape around them. */
export function addedStatements(
  before: string | null,
  after: string,
  threshold = SIMILARITY_THRESHOLD,
): string[] {
  return pageChange(before, after, threshold).added;
}
