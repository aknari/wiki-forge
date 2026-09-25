/**
 * The sources an answer claims, reconciled with the pages that exist.
 *
 * The query rules require the answer to end with a *Fuentes* section of
 * wikilinks, and a model writing those links from memory gets names wrong:
 * `lisa-rchitecture-overview.md` looks like a link, reads like a link, and leads
 * nowhere. That list is the part a reader uses to check the answer, so it is the
 * last place a name should be taken on faith.
 *
 * Two things happen here, and nothing else:
 *
 *  - **A name that means an existing page is pointed at that page.** Resolution
 *    is by title key first — so a bare name, a name with folders in front and a
 *    name carrying its `.md` are one thing, which is how Obsidian resolves a
 *    link too — and then by `closestTitle`, the one-typo, unambiguous-only rule
 *    the checker uses to *suggest* a repair. A link saved today is therefore a
 *    link `Clean wiki` would have repaired tomorrow: same policy, earlier.
 *  - **A name that means nothing is left exactly as written** and reported, so
 *    the panel can say so. Nothing is invented, and nothing disappears quietly:
 *    a citation that does not resolve is worth knowing about, and the checker
 *    keeps reporting it in the page it was saved into.
 *
 * The link *text* is never rewritten — an alias is the author's wording — only
 * the target behind it. A list item that is nothing but a file name becomes a
 * link to that page, because a link is what it was trying to be.
 *
 * Pure on purpose (no Obsidian import), so the rules are covered by tests.
 */
import { closestTitle, mapWikilinks, titleKey, wikilinkTargets } from './wikitext';

export interface ReconciledAnswer {
  /** The answer, with every resolvable source link pointed at the real page. */
  answer: string;
  /**
   * The cited names that match no page that exists, in order and without
   * repeats. Empty when there was nothing to report — including when the answer
   * has no source list at all.
   */
  unresolved: string[];
}

/**
 * A list item holding nothing but a reference: `* lisa-trap-management.md`,
 * `* 20-wiki/04-lisa/lisa-trap-management`, `* lisa-trap-management`.
 *
 * Recognised by *shape* rather than by a trailing `.md`, and that word is the
 * whole fix. Requiring the extension meant a source list written without it fell
 * through every branch of this module: not a link, so not repaired; not a `.md`
 * name, so not reported either. The answer was shipped with a citation pointing
 * at a page that does not exist and the panel said nothing — the one outcome this
 * file exists to prevent, and the one it cannot detect from the inside.
 */
const BARE_REFERENCE = /^\s*[-*+]\s+[*_`]*([^\s()[\]*_`]+?)[*_`]*\s*$/u;
const LIST_ITEM = /^\s*[-*+]\s/u;

/**
 * Whether a lone token is a reference to a file rather than a word of prose.
 *
 * Three shapes, which are the three a model writes: a path (has a slash), a name
 * with an extension, and a slug (`modelo-lisa`, separated by `-` or `_`, with a
 * letter in it so a bare date is not mistaken for a page name). Everything else
 * — a phrase, a word, `(ninguna)` — is prose and is left alone; the cost of
 * guessing wrong here is a citation turned into a link that leads nowhere.
 */
function isReference(token: string): boolean {
  if (token.includes('/')) return true;
  if (/\.[a-z0-9]{1,6}$/iu.test(token)) return true;
  return /\p{L}/u.test(token) && /^[\p{L}\p{N}]+(?:[-_][\p{L}\p{N}]+)+$/u.test(token);
}

const withoutExtension = (value: string): string => value.replace(/\.md$/iu, '');
const baseName = (path: string): string => path.split('/').pop() ?? path;

/**
 * Whether the line is the label the source list hangs from: `Fuentes`,
 * `## Fuentes`, `**Sources:**`. Written as a plain comparison rather than a
 * pattern so a line of prose that merely mentions the word is not mistaken for
 * the heading that opens the list.
 */
function isSourceLabel(line: string): boolean {
  const text = line.replace(/[#*_>`\s:]/gu, '').toLowerCase();
  return text === 'fuentes' || text === 'sources';
}

/**
 * The lines of the answer's closing source list. The label is looked for from
 * the end, so an answer that quotes a *Fuentes* section earlier on is not the
 * one rewritten; when there is no label at all, the list block the answer ends
 * with is taken instead — the rules ask for a section, and models sometimes
 * deliver the list without its heading.
 */
function sourceLineIndexes(lines: readonly string[]): number[] {
  let start = -1;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (isSourceLabel(lines[i] ?? '')) {
      start = i + 1;
      break;
    }
  }
  if (start === -1) {
    let end = lines.length - 1;
    while (end >= 0 && (lines[end] ?? '').trim() === '') end -= 1;
    let begin = end;
    while (begin >= 0 && LIST_ITEM.test(lines[begin] ?? '')) begin -= 1;
    if (begin === end) return [];
    start = begin + 1;
  }
  const out: number[] = [];
  for (let i = start; i < lines.length; i += 1) {
    if ((lines[i] ?? '').trim() === '') continue;
    if (!LIST_ITEM.test(lines[i] ?? '')) break;
    out.push(i);
  }
  return out;
}

interface Lookup {
  /** By file name: how a link with no folders is written. */
  byName: Map<string, string>;
  /** By full path without extension: how a link from the vault root is written. */
  byPath: Map<string, string>;
  /** Every file name, for the one-typo repair. */
  names: string[];
}

function makeLookup(knownPaths: readonly string[]): Lookup {
  const byName = new Map<string, string>();
  const byPath = new Map<string, string>();
  for (const path of knownPaths) {
    const nameKey = titleKey(baseName(path));
    if (nameKey !== '' && !byName.has(nameKey)) byName.set(nameKey, path);
    const pathKey = titleKey(path);
    if (pathKey !== '' && !byPath.has(pathKey)) byPath.set(pathKey, path);
  }
  return { byName, byPath, names: [...new Set(knownPaths.map(baseName))] };
}

/** The page a cited name means, or `null` when it means none that exists. */
function resolveTarget(target: string, lookup: Lookup): string | null {
  const key = titleKey(target);
  if (key === '') return null;
  const exact = lookup.byName.get(key) ?? lookup.byPath.get(key);
  if (exact !== undefined) return exact;
  // The one-typo repair runs on the **file name**, so a target carrying folders is
  // compared by its name and not by its path. Comparing the path key against bare
  // names is a comparison that can never succeed — `20wiki04lisalis...` is tens of
  // edits away from `lisaarchitectureoverview`, all of them the folders — and that
  // is why `20-wiki/04-lisa/lis-rchitecture-overview` was reported as matching
  // nothing while the same typo with no folders in front was repaired.
  const closest = closestTitle(baseName(target), lookup.names);
  if (closest === null) return null;
  return lookup.byName.get(titleKey(closest)) ?? null;
}

function reconcileLine(line: string, lookup: Lookup, unresolved: string[]): string {
  const note = (name: string): void => {
    if (!unresolved.includes(name)) unresolved.push(name);
  };

  if (wikilinkTargets(line).length > 0) {
    return mapWikilinks(line, target => {
      const resolved = resolveTarget(target, lookup);
      if (resolved === null) {
        note(target);
        return null; // left as written: a citation that cannot be resolved is not this plugin's to invent
      }
      return withoutExtension(resolved);
    });
  }

  const bare = BARE_REFERENCE.exec(line);
  if (bare === null) return line;
  const name = bare[1] ?? '';
  if (!isReference(name)) return line;
  const resolved = resolveTarget(name, lookup);
  if (resolved === null) {
    note(name);
    return line;
  }
  // The visible text is the written name — unless the name was *wrong*, in which
  // case it is the page's own name. Keeping a name that is a typo in the one list
  // the reader checks the answer against leaves the repair half done: the link
  // works and the citation still reads `lis-rchitecture-overview`.
  const resolvedName = withoutExtension(baseName(resolved));
  const text = titleKey(baseName(name)) === titleKey(resolvedName) ? name : resolvedName;
  return line.replace(name, `[[${withoutExtension(resolved)}|${text}]]`);
}

/**
 * Points the answer's own source list at pages that exist, and reports the names
 * that match none. `knownPaths` are vault paths of the pages an answer may cite
 * (so the link written back resolves from anywhere in the vault).
 */
export function reconcileAnswerSources(
  answer: string,
  knownPaths: readonly string[],
): ReconciledAnswer {
  const lines = answer.split('\n');
  const lookup = makeLookup(knownPaths);
  const unresolved: string[] = [];
  for (const index of sourceLineIndexes(lines)) {
    lines[index] = reconcileLine(lines[index] ?? '', lookup, unresolved);
  }
  return { answer: lines.join('\n'), unresolved };
}
