/**
 * Text helpers for the pages the wiki is made of: frontmatter, wikilinks,
 * titles, and the traces a language model leaves behind when it is unsure.
 *
 * No Obsidian import on purpose — every rule here is covered by tests, because
 * these are the rules that decide what the checker reports and what the
 * mechanical cleaner is allowed to touch.
 */

/** A page split into its optional frontmatter block and the body after it. */
export interface SplitPage {
  /** Raw frontmatter without the `---` fences, or `null` when there is none. */
  frontmatter: string | null;
  /** Everything after the closing fence (or the whole text when there is none). */
  body: string;
  /** First value seen for each top-level key, kept as raw text. */
  keys: Record<string, string>;
}

const FENCE = /^(?:---|\.\.\.)\s*$/;

/**
 * Splits the frontmatter off a note. Only a block that *starts* the file counts,
 * which is what Obsidian reads as properties: a `---` further down is a
 * horizontal rule, not frontmatter.
 */
export function splitFrontmatter(content: string): SplitPage {
  const text = content.replace(/^\uFEFF/, '');
  const lines = text.split('\n');
  if (lines.length === 0 || !FENCE.test(lines[0] ?? '')) {
    return { frontmatter: null, body: text, keys: {} };
  }
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (FENCE.test(lines[i] ?? '')) {
      end = i;
      break;
    }
  }
  if (end === -1) return { frontmatter: null, body: text, keys: {} };

  const raw = lines.slice(1, end).join('\n');
  return { frontmatter: raw, body: lines.slice(end + 1).join('\n'), keys: parseKeys(raw) };
}

/** `key: value` lines at column zero; indented lines are list items or continuations. */
function parseKeys(raw: string): Record<string, string> {
  const keys: Record<string, string> = {};
  for (const line of raw.split('\n')) {
    if (/^\s/.test(line)) continue;
    const match = /^([A-Za-z0-9_.-]+)\s*:\s*(.*)$/.exec(line);
    if (match?.[1] === undefined) continue;
    keys[match[1]] = (match[2] ?? '').trim();
  }
  return keys;
}

/**
 * Reads a frontmatter key as a list. Accepts the three shapes that turn up in
 * practice: `[a, b]`, a quoted single value, and a `- item` block.
 */
export function frontmatterList(page: SplitPage, key: string): string[] {
  const inline = page.keys[key];
  if (inline !== undefined && inline !== '') {
    if (inline.startsWith('[')) {
      return inline
        .replace(/^\[|\]$/g, '')
        .split(',')
        .map(unquote)
        .filter(Boolean);
    }
    return [unquote(inline)].filter(Boolean);
  }
  const block = new RegExp(`^${key}\\s*:\\s*$`, 'm');
  if (page.frontmatter === null || !block.test(page.frontmatter)) return [];
  const after = page.frontmatter.split(block)[1] ?? '';
  return after
    .split('\n')
    .filter(line => /^\s+-\s+/.test(line))
    .map(line => unquote(line.replace(/^\s+-\s+/, '')))
    .filter(Boolean);
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2) {
    const first = trimmed[0];
    const last = trimmed[trimmed.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return trimmed.slice(1, -1).trim();
    }
  }
  return trimmed;
}

/** The target of every `[[...]]` in the text, in order, duplicates included. */
export function wikilinkTargets(text: string): string[] {
  const out: string[] = [];
  for (const link of wikilinkParts(text)) out.push(link.target);
  return out;
}

interface LinkParts {
  target: string;
  /** Text after `|` (may be empty), and the surrounding whitespace of the link. */
  alias: string;
  start: number;
  end: number;
}

function wikilinkParts(text: string): LinkParts[] {
  const out: LinkParts[] = [];
  let index = 0;
  while (index < text.length) {
    const start = text.indexOf('[[', index);
    if (start === -1) break;
    const close = text.indexOf(']]', start + 2);
    if (close === -1) break;
    const inner = text.slice(start + 2, close);
    const bar = inner.indexOf('|');
    const target = (bar === -1 ? inner : inner.slice(0, bar)).split('#')[0]?.trim() ?? '';
    if (target !== '') {
      out.push({ target, alias: bar === -1 ? '' : inner.slice(bar), start, end: close + 2 });
    }
    index = close + 2;
  }
  return out;
}

/**
 * Rewrites the target of every wikilink for which `fn` returns a new one,
 * keeping the alias and the heading (`[[old#part|alias]]` → `[[new#part|alias]]`).
 * This is how a broken link is repaired: the alias is the author's wording and
 * must survive.
 */
export function mapWikilinks(text: string, fn: (target: string) => string | null): string {
  const parts = wikilinkParts(text);
  if (parts.length === 0) return text;
  let out = '';
  let cursor = 0;
  for (const part of parts) {
    const next = fn(part.target);
    out += text.slice(cursor, part.start);
    if (next === null || next === part.target) {
      out += text.slice(part.start, part.end);
    } else {
      const inner = text.slice(part.start + 2, part.end - 2);
      const bar = inner.indexOf('|');
      const hash = inner.indexOf('#');
      const suffix = hash !== -1 && (bar === -1 || hash < bar) ? inner.slice(hash, bar === -1 ? undefined : bar) : '';
      out += `[[${next}${suffix}${part.alias}]]`;
    }
    cursor = part.end;
  }
  return out + text.slice(cursor);
}

/**
 * Comparison key for a note name or a link target: case, accents, punctuation
 * and separators all stop mattering, so `Metodología de Verificación`,
 * `metodologia-de-verificacion` and `metodología_de_verificación` are one thing.
 */
export function titleKey(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\.[a-z0-9]{1,4}$/i, '') // a link written with its .md extension
    .replace(/[^a-z0-9]+/g, '');
}

/** The first `# heading` of a body, without the hashes. */
export function firstHeading(body: string): string | null {
  for (const line of body.split('\n')) {
    const match = /^#{1,6}\s+(.+?)\s*$/.exec(line);
    if (match?.[1] !== undefined && match[1] !== '') return match[1];
  }
  return null;
}

/**
 * The opening of a page, in the page's own words: what it is about.
 *
 * This is what puts the *content* in the index. The index is the entry point of
 * every query, and it used to list each page as `[[link|Title]] — tipo`, so the
 * selection phase had to choose which pages answer a question from titles alone —
 * while the query rules say in so many words that the index carries "the
 * hierarchy and **summaries** of the available pages". With a real case: asked
 * "¿Qué es Lisa?", `Modelado de CSRs en Lisa` reads like a page about one part,
 * and it is exactly the page that says RISC-V; a selection by title drops it and
 * the wiki answers that it does not know.
 *
 * The first *prose* line, because a heading only repeats the title the index
 * already shows, and a code block is not prose: code fences are skipped rather
 * than ending the search, since a page may legitimately open with a sample and
 * say what it is right after.
 */
export function firstSentence(body: string, max = 160): string | null {
  let inFence = false;
  for (const raw of body.split('\n')) {
    const line = raw.trim();
    if (/^(?:```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence || line === '' || /^#{1,6}\s/.test(line)) continue;
    const text = plainLine(line);
    if (text !== '') return clipToSentence(text, max);
  }
  return null;
}

/** A line of markdown as prose: link dressing, emphasis and list bullets out. */
function plainLine(line: string): string {
  return line
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+/, '')
    .replace(/^\s*>\s*/, '')
    .replace(/\[\[([^\]|]*)\|([^\]]*)\]\]/g, '$2')
    .replace(/\[\[([^\]]*)\]\]/g, '$1')
    .replace(/[*_`]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * The first sentence, when it fits; otherwise as much as fits, cut at a word.
 *
 * The minimum length before a full stop counts is what keeps `p. ej.` and an
 * initial `A.` from ending the summary after three words.
 */
function clipToSentence(text: string, max: number): string {
  for (const match of text.matchAll(/[.!?](?:\s|$)/g)) {
    const at = match.index + 1;
    if (at > max) break;
    if (at >= 20) return text.slice(0, at);
  }
  if (text.length <= max) return text;
  const cut = text.lastIndexOf(' ', max);
  return `${text.slice(0, cut > 0 ? cut : max).trimEnd()}…`;
}

/** A file name turned into something readable: `modelo-lisa` → `modelo lisa`. */
export function humanTitle(path: string): string {
  const base = path.split('/').pop() ?? path;
  return base.replace(/\.md$/i, '').replace(/[-_]+/g, ' ').trim();
}

/** Levenshtein distance with an early exit once `limit` is exceeded. */
export function editDistance(a: string, b: string, limit = 3): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > limit) return limit + 1;
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const value = Math.min((previous[j] ?? 0) + 1, (current[j - 1] ?? 0) + 1, (previous[j - 1] ?? 0) + cost);
      current[j] = value;
      if (value < best) best = value;
    }
    if (best > limit) return limit + 1;
    previous = current;
  }
  return previous[b.length] ?? limit + 1;
}

/**
 * Picks the one existing title a broken target most likely meant, or `null`
 * when nothing is close enough or several candidates tie: a wrong automatic
 * repair is worse than a broken link the checker keeps reporting.
 */
export function closestTitle(target: string, known: readonly string[]): string | null {
  const key = titleKey(target);
  if (key === '') return null;
  // One edit for a short name, two for a long one. `plasmoids` is two edits away
  // from `20-plasmoids`, and those are two different things; the long
  // `metodologia-de-verificacion` is two away from the page it means.
  const distance = key.length < 12 ? 1 : 2;

  const scored: Array<{ candidate: string; score: number }> = [];
  for (const candidate of new Set(known)) {
    const candidateKey = titleKey(candidate);
    if (candidateKey === '' || candidateKey === key) continue;
    const score = editDistance(key, candidateKey, distance);
    if (score > distance) continue;
    scored.push({ candidate, score });
  }
  if (scored.length === 0) return null;
  scored.sort((a, b) => a.score - b.score || a.candidate.localeCompare(b.candidate));
  const [best, second] = scored;
  if (best === undefined) return null;
  if (second !== undefined && second.score === best.score) return null; // ambiguous
  return best.candidate;
}

/** What the checker knows about a leftover of the model's own process. */
export type ArtifactKind =
  | 'preamble-block'
  | 'dangling-marker'
  | 'fenced-metadata'
  | 'empty-page'
  | 'duplicate-frontmatter';

export interface Artifact {
  kind: ArtifactKind;
  detail: string;
  /** Whether `stripArtifacts` can remove it without guessing at the content. */
  fixable: boolean;
}

const FENCE_OPEN = /^\s*```/;

/**
 * Finds the leftovers of the model talking to itself: a fenced block at the top
 * holding a second copy of the frontmatter, a dangling `-->` from an
 * instruction nobody carried out, or a page that ended up empty.
 */
export function detectArtifacts(content: string): Artifact[] {
  const found: Artifact[] = [];
  const lines = content.split('\n');

  const { keys } = splitFrontmatter(content);
  const block = findBlock(lines, keys);
  if (block !== null) {
    found.push({
      kind: block.kind,
      detail: `code block on line ${block.open + 1} holding ${block.reason}`,
      // Misplaced metadata is a decision, not a leftover: the keys inside it are
      // the only copy, so removing the block would lose them.
      fixable: block.kind === 'preamble-block',
    });
  }

  for (let i = 0; i < lines.length; i++) {
    // A marker inside the block above goes away with the block: reporting it
    // twice would make one leftover look like two.
    if (block !== null && i >= block.open && i <= block.close) continue;
    const line = lines[i] ?? '';
    if (isDanglingMarker(line)) {
      found.push({ kind: 'dangling-marker', detail: `line ${i + 1}: ${line.trim().slice(0, 60)}`, fixable: true });
    }
  }

  const { body } = splitFrontmatter(content);
  if (body.trim() === '') {
    found.push({ kind: 'empty-page', detail: 'no content outside the frontmatter', fixable: false });
  } else if (/^\s*---\s*$/m.test(body.split('\n').slice(0, 3).join('\n'))) {
    found.push({ kind: 'duplicate-frontmatter', detail: 'a second frontmatter block starts the body', fixable: false });
  }

  return found;
}

interface Block {
  open: number;
  close: number;
  reason: string;
  kind: ArtifactKind;
}

/**
 * The fenced block near the top of a page that is not meant to be content.
 *
 * The closing fence is only looked for a few lines down on purpose: a fence that
 * runs to the end of the page is the whole page inside a code block, and
 * cutting it out would delete the page rather than tidy it.
 */
function findBlock(lines: string[], frontmatterKeys: Record<string, string>): Block | null {
  const limit = Math.min(lines.length, 15);
  for (let i = 0; i < limit; i++) {
    if (!FENCE_OPEN.test(lines[i] ?? '')) continue;
    const last = Math.min(i + 15, lines.length - 1);
    for (let j = i + 1; j <= last; j++) {
      if (!FENCE_OPEN.test(lines[j] ?? '')) continue;
      const inner = lines.slice(i + 1, j).join('\n');
      if (inner.includes('-->')) {
        return { open: i, close: j, reason: 'a leftover instruction', kind: 'preamble-block' };
      }
      const innerKeys = Object.keys(parseKeys(inner));
      if (innerKeys.length === 0) return null;
      return innerKeys.every(key => key in frontmatterKeys)
        ? { open: i, close: j, reason: 'a duplicated frontmatter', kind: 'preamble-block' }
        : { open: i, close: j, reason: 'frontmatter inside a code block', kind: 'fenced-metadata' };
    }
    return null;
  }
  return null;
}

/**
 * A closing comment marker with no opening one on the same line: frontmatter
 * syntax escaped into the body, or the tail of an instruction like
 * `--> 2026-09-01T16:00 (or current datetime)`.
 */
function isDanglingMarker(line: string): boolean {
  if (!line.includes('-->') || line.includes('<!--')) return false;
  return /(-->\s*\d{4}-\d{2}-\d{2})|\(or current datetime\)|-->\s*20\d\d-\d\d-\d\dT/.test(line);
}

/**
 * The target of a value that may be written as a wikilink: `[[a|b]]` → `a`.
 * Frontmatter lists hold links as text, brackets included.
 */
export function linkTarget(value: string): string {
  const match = /\[\[([^\]]*)\]\]/.exec(value);
  const inner = match?.[1] ?? value;
  return (inner.split('|')[0] ?? '').split('#')[0]?.trim() ?? '';
}

/**
 * A page whose metadata arrived inside a code fence, put back where Obsidian
 * reads it: `tags`, `tipo`, `fuentes`… in the frontmatter, not in a ```yaml
 * block at the top of the body.
 *
 * Where it came from: the model is asked to write a page with YAML frontmatter,
 * and when its first answer is a whole document instead of FILE:/CONTENT: blocks
 * it is asked to reformat **its own text**. It reformats faithfully — frontmatter
 * included, fence included. The page then exists, reads well, and is wrong in two
 * quiet ways: Obsidian shows no properties for it, and every key the wiki is
 * organised by (`tipo` above all: the index lists each page with the one in its
 * frontmatter, and the checker reads `fuentes` from there) is invisible.
 *
 * Why hoist instead of delete: the keys inside the fence are the only copy, which
 * is why the checker reports this as `fenced-metadata` and refuses to touch it.
 * Moving them up keeps every one of them and needs no judgement about content —
 * the block is either metadata (all of it) or not, and a block that is not is
 * left exactly as it was.
 *
 * A key the page already declares wins: the frontmatter is where plugins and the
 * person write, so the copy inside the fence is the second-hand one, and letting
 * it overwrite is how a `created` would get replaced by a guess from a model.
 */
export function hoistFencedFrontmatter(content: string): string {
  const page = splitFrontmatter(content);
  const block = leadingMetadataBlock(page.body);
  if (block === null) return content;

  const present = new Set(Object.keys(parseKeys(page.frontmatter ?? '')));
  const added = metadataEntries(block.lines)
    .filter(entry => !present.has(entry.key))
    .flatMap(entry => entry.lines);

  const kept = (page.frontmatter ?? '').split('\n').filter(line => line.trim() !== '');
  const frontmatter = [...kept, ...added].join('\n');
  if (frontmatter === '') return content; // a fence that held no keys: not ours to remove

  const body = block.after
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^\n+/, '')
    .replace(/\s*$/, '\n');
  return `---\n${frontmatter}\n---\n${body}`;
}

interface MetadataEntry {
  key: string;
  /** The whole entry: the `key:` line and any indented lines that belong to it. */
  lines: string[];
}

/** The leading fence of a body, when it holds YAML metadata rather than a sample. */
function leadingMetadataBlock(body: string): { lines: string[]; after: string } | null {
  const lines = body.split('\n');
  let i = 0;
  while (i < lines.length && (lines[i] ?? '').trim() === '') i++;
  if (!FENCE_OPEN.test(lines[i] ?? '')) return null;

  const inner: string[] = [];
  for (let j = i + 1; j < lines.length; j++) {
    if (FENCE_OPEN.test(lines[j] ?? '')) {
      if (!looksLikeMetadata(inner)) return null;
      const after = lines.slice(j + 1).join('\n');
      return { lines: inner, after };
    }
    inner.push(lines[j] ?? '');
  }
  // No closing fence: the whole page is inside a code block, which is content,
  // not metadata — and cutting it out would delete the page rather than tidy it.
  return null;
}

/**
 * Whether every meaningful line of a fenced block is YAML metadata: a `key:` at
 * column zero, or an indented continuation of one. A single line that is neither
 * — `def f():`, `int main() {` — makes it a code sample, and a sample is left
 * alone. Being wrong here in the "hoist" direction would push a code example into
 * the frontmatter; being wrong in the other direction only leaves a page as it is,
 * which is what the checker will report.
 */
function looksLikeMetadata(lines: readonly string[]): boolean {
  let keys = 0;
  for (const line of lines) {
    if (line.trim() === '') continue;
    if (/^\s/.test(line)) continue;
    if (!/^[A-Za-z0-9_.-]+\s*:/.test(line)) return false;
    keys++;
  }
  return keys > 0;
}

/** Splits fenced metadata into its entries, each with the lines that belong to it. */
function metadataEntries(lines: readonly string[]): MetadataEntry[] {
  const trimmed = [...lines];
  while (trimmed.length > 0 && (trimmed[trimmed.length - 1] ?? '').trim() === '') trimmed.pop();

  const out: MetadataEntry[] = [];
  for (const line of trimmed) {
    if (/^\s/.test(line)) {
      // An indented line belongs to the key above (`tags:` followed by `- a`).
      out[out.length - 1]?.lines.push(line);
      continue;
    }
    const key = /^([A-Za-z0-9_.-]+)\s*:/.exec(line)?.[1];
    if (key !== undefined) out.push({ key, lines: [line] });
  }
  return out;
}

/**
 * Removes what can be removed without judgement: the duplicated block and the
 * dangling markers. Everything else (`duplicate-frontmatter`, an empty page) is
 * reported and left alone, because taking it out means deciding about content.
 */
export function stripArtifacts(content: string): { content: string; removed: ArtifactKind[] } {
  const removed: ArtifactKind[] = [];
  const lines = content.split('\n');

  const block = findBlock(lines, splitFrontmatter(content).keys);
  if (block !== null && block.kind === 'preamble-block') {
    lines.splice(block.open, block.close - block.open + 1);
    removed.push('preamble-block');
  }

  const kept = lines.filter(line => !isDanglingMarker(line));
  if (kept.length !== lines.length) removed.push('dangling-marker');

  if (removed.length === 0) return { content, removed };
  // Collapse the hole the removal left behind, and keep one trailing newline.
  const out = kept
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^\n+/, '')
    .replace(/\s*$/, '\n');
  return { content: out, removed };
}
