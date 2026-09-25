/**
 * Matching the model's answer back onto the list it was given.
 *
 * The fallback hands the model a list of **vault paths** — `00-src/30-dev/30-lisa/
 * Comments and ideas concerning Lisa.md` — and asks which of them contains the
 * answer. The model very often replies with the bare file name, or with the name
 * wrapped in a list bullet, quotes or a word of prose. Those words were taken
 * literally, and the result was a suggestion that existed nowhere: the row could
 * not be opened, could not be ingested, and explained itself with a reason that
 * was nonsense ("outside the sources folder") because a name with no folder is
 * outside everything.
 *
 * The point is that this needs no guessing: the candidates were known exactly a
 * moment earlier, so the answer is *resolved against them*. Anything that
 * matches nothing is dropped — it is not a note the plugin can point at, and a
 * dead row is worse than a shorter list.
 *
 * There is a second caller with the same problem in the other direction: the
 * query's selection phase (`query.ts`) asks an LLM to name the wiki pages that
 * answer a question. The index it is shown lists the pages as wikilinks —
 * `[[lisa-architecture-overview|Arquitectura de Lisa]]` — and the query rules
 * explicitly ask for "the pages (`[[wikilinks]]`)", so the model answers
 * `[[lisa-architecture-overview]]`. That was compared against a file name as
 * written, brackets included, so it matched nothing, the context came out empty
 * and every question fell through to the raw-note fallback: the wiki could hold
 * the answer and the plugin still said it did not. Hence `[[…]]`, the alias and
 * the `#heading` are stripped here rather than in the caller.
 *
 * The second shape of the same bug was reported from the panel again, with the
 * wiki pages present and the index listing all three: the pool names pages
 * *relative to the wiki* (`04-lisa/lisa-architecture-overview.md`) and the model
 * answered `20-wiki/04-lisa/lisa-architecture-overview.md` — the wiki folder in
 * front, because the rules it reads name one. The name was compared as a whole
 * against the candidates' file names, so `20-wiki/…` matched nothing, the
 * context came out empty and the wiki reported that it had no answer. Same
 * symptom, different dressing: hence matching by file name on **both** sides.
 *
 * Pure on purpose — no Obsidian import — so the matching rules are covered by
 * tests (`test/suggestions.test.ts`).
 */
import { linkTarget } from './wikitext';

/**
 * Strips what a model wraps a name in: bullets, numbering, quotes, brackets,
 * and the wikilink dressing (`[[target|alias#heading]]` → `target`).
 */
function clean(answer: string): string {
  const stripped = answer
    .trim()
    .replace(/^\s*[-*•]\s+/, '')
    .replace(/^\s*\d+[.)]\s+/, '')
    .replace(/^["'`[<*]+/, '')
    .replace(/["'`\]>*;,]+$/, '')
    .trim();
  // The link is read off the *original* answer: stripping the opening brackets
  // first would leave `[[a|b]]` as `a|b]], which is no longer a link to parse.
  return linkTarget(answer.includes('[[') ? answer.trim() : stripped);
}

const withoutExtension = (value: string): string => value.replace(/\.md$/i, '');
const baseName = (path: string): string => path.split('/').pop() ?? path;

/**
 * The vault path an answer meant, or `null` when it meant nothing on the list.
 * Tried in order of confidence: the whole path, the file name, then a trailing
 * path fragment (`30-lisa/nota.md`).
 */
export function resolveCandidate(answer: string, candidates: readonly string[]): string | null {
  const cleaned = clean(answer);
  if (cleaned === '') return null;

  const exact = candidates.find(candidate => candidate === cleaned);
  if (exact !== undefined) return exact;

  // Both sides by file name: the answer may carry folders the candidate list
  // does not, and the name is what the answer is trying to say.
  const name = withoutExtension(baseName(cleaned)).toLowerCase();
  const byName = candidates.find(
    candidate => withoutExtension(baseName(candidate)).toLowerCase() === name,
  );
  if (byName !== undefined) return byName;

  const tail = cleaned.toLowerCase();
  return candidates.find(candidate => candidate.toLowerCase().endsWith(`/${tail}`)) ?? null;
}

/**
 * The answers that name a real candidate, in order, without repeats. Answers
 * that match nothing are dropped rather than passed on.
 */
export function resolveCandidates(answers: readonly string[], candidates: readonly string[]): string[] {
  const out: string[] = [];
  for (const answer of answers) {
    const path = resolveCandidate(answer, candidates);
    if (path !== null && !out.includes(path)) out.push(path);
  }
  return out;
}

function tryParseList(text: string): string[] | null {
  try {
    const parsed: unknown = JSON.parse(text);
    return Array.isArray(parsed) ? parsed.map((x: unknown) => String(x)) : null;
  } catch {
    return null;
  }
}

/**
 * The list of names a model answered with, dug out of whatever it wrapped them
 * in: a JSON array, that array inside a code fence, or the array inside a
 * sentence — the query's selection phase is asked for a JSON list and does not
 * always get one.
 *
 * When there is no list at all, the lines are taken. That last resort is safe by
 * construction rather than by luck: everything read here is put through
 * `resolveCandidates`, which resolves each name against the pages that exist and
 * **drops what matches nothing**, so a line of prose costs a lookup and never
 * becomes a page that cannot be opened. Refusing to look was the expensive
 * option — it turned a reply in the wrong shape into "the wiki has no answer".
 */
export function parsePageNames(answer: string): string[] {
  const text = answer
    .replace(/```json/gi, '')
    .replace(/```/g, '')
    .trim();
  const direct = tryParseList(text);
  if (direct !== null) return direct;
  const bracketed = /\[[\s\S]*\]/.exec(text);
  if (bracketed !== null) {
    const parsed = tryParseList(bracketed[0]);
    if (parsed !== null) return parsed;
  }
  return text
    .split('\n')
    .map(line => line.trim())
    .filter(line => line !== '');
}
