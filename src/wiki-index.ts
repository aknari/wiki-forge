/**
 * The wiki index, built from the folder instead of asked of a model.
 *
 * The index is the entry point of every query, so it has to be right: a page
 * missing from it is a page the wiki cannot answer from. Building it with an
 * LLM meant it drifted from the folder (pages left out, links pointing at names
 * that never existed) and collected the model's leftovers on every rewrite.
 * Reading the directory cannot drift, cannot invent a name and costs nothing.
 *
 * Pure on purpose: the folder is passed in, so the shape of the index is
 * covered by tests.
 */
import { firstHeading, firstSentence, frontmatterList, humanTitle, splitFrontmatter } from './wikitext';

/**
 * How much of a page's opening goes into the index.
 *
 * Long enough to say what the page is and what it is not — the whole point of the
 * line — and short enough that the index stays far smaller than the pages it
 * summarises, because it is pasted into every distillation and every selection
 * prompt.
 */
const SUMMARY_MAX = 180;

export interface IndexEntry {
  /** Path relative to the wiki folder, e.g. `01-lisa/modelo-lisa.md`. */
  path: string;
  content: string;
}

export interface IndexOptions {
  wikiDir: string;
  indexName: string;
  logName: string;
  /** ISO timestamp, written to the frontmatter. */
  generatedAt: string;
  /** Frontmatter key holding the entity type. Default: `tipo`. */
  typeKey?: string;
}

/** How a page is shown: its own heading if it has one, else its file name. */
function displayTitle(path: string, content: string): string {
  const body = splitFrontmatter(content).body;
  const heading = firstHeading(body);
  return heading ?? humanTitle(path);
}

/**
 * The index as Markdown. Pages are grouped by their subfolder (the numbered
 * taxonomy the rules describe), folders in name order and pages by title, with
 * the pages sitting directly in the wiki folder last.
 */
export function buildWikiIndex(entries: IndexEntry[], options: IndexOptions): string {
  const typeKey = options.typeKey ?? 'tipo';
  const groups = new Map<string, IndexEntry[]>();
  for (const entry of entries) {
    const parts = entry.path.split('/');
    const folder = parts.length > 1 ? parts[0] : '';
    groups.set(folder, [...(groups.get(folder) ?? []), entry]);
  }

  const folders = [...groups.keys()].filter(folder => folder !== '').sort((a, b) => a.localeCompare(b));
  const ordered: string[] = [...folders];
  if (groups.has('')) ordered.push('');

  const lines: string[] = [];
  lines.push('---');
  lines.push(`generated: ${options.generatedAt}`);
  lines.push('generated_by: WikiForge — rebuilt from the wiki folder');
  lines.push('---');
  lines.push('# Índice de Conocimiento');
  lines.push('');
  lines.push(
    `<!-- Reconstruido por WikiForge a partir de los ficheros de \`${options.wikiDir}\`. ` +
      'Cualquier edición manual se pierde en la siguiente reconstrucción. -->',
  );
  lines.push('');

  if (entries.length === 0) {
    lines.push('_La wiki está vacía: todavía no se ha destilado ninguna nota._');
    return `${lines.join('\n')}\n`;
  }

  for (const folder of ordered) {
    const items = (groups.get(folder) ?? [])
      .slice()
      .sort((a, b) => displayTitle(a.path, a.content).localeCompare(displayTitle(b.path, b.content)));
    if (items.length === 0) continue;
    lines.push(`## ${folder === '' ? '(raíz)' : folder} — ${items.length}`);
    lines.push('');
    for (const entry of items) {
      const base = entry.path.split('/').pop() ?? entry.path;
      const link = base.replace(/\.md$/i, '');
      const page = splitFrontmatter(entry.content);
      const type = frontmatterList(page, typeKey)[0];
      // The type and the opening of the page, which is what lets a selection be
      // made by content instead of by title (see `firstSentence`).
      const notes = [type === undefined ? null : `\`${type}\``, firstSentence(page.body, SUMMARY_MAX)]
        .filter((note): note is string => note !== null && note !== '')
        .join(' — ');
      lines.push(`- [[${link}|${displayTitle(entry.path, entry.content)}]]${notes === '' ? '' : ` — ${notes}`}`);
    }
    lines.push('');
  }

  return `${lines.join('\n').replace(/\n+$/, '')}\n`;
}

/** The wiki pages an index should be built from: everything but the index and the log. */
export function indexableEntries(
  pages: IndexEntry[],
  options: Pick<IndexOptions, 'indexName' | 'logName'>,
): IndexEntry[] {
  return pages
    .filter(page => page.path !== options.indexName && page.path !== options.logName)
    .filter(page => page.path.toLowerCase().endsWith('.md'));
}
