/**
 * The note a query answer is saved to: where it goes and what it says.
 *
 * Pure on purpose — no Obsidian import — so the format, which is what makes the
 * answer usable *afterwards*, is covered by tests. Three decisions live here,
 * and all three come from the same fact: these notes are meant to end up inside
 * the wiki folder, so they are read back as wiki pages.
 *
 * - The **first heading is the question**. The index titles a page by its first
 *   heading, so the old `## Question` heading listed every saved answer in the
 *   index as “Question”, one identical line after another.
 * - The sources go in **`fuentes:`**, the key the wiki pages use and the one the
 *   check reads. Written as `sources:` every saved answer was reported as a page
 *   whose source does not resolve. They go **only** there: the answer already
 *   closes with the model's own "Fuentes" section of wikilinks, which is the
 *   clickable one, so a second list in the body only repeated it — with real
 *   paths, but repeated. An answer that read no page declares `fuentes: []`.
 * - The file name keeps the **`YYYY-MM-DD-HHMM` stamp** rather than a slug of the
 *   question: it is the convention the query notes already had, a stamp cannot
 *   collide with a topic page, and a whole question is not a good file name
 *   (accents, punctuation and length all become problems).
 */

const pad = (n: number): string => String(n).padStart(2, '0');

/**
 * Marks of the moment, as `YYYY-MM-DD-HHMM` (minute resolution, like the query
 * notes this replaces). Two saves inside the same minute write the same file.
 */
export function answerStamp(now: Date): string {
  return (
    `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-` +
    `${pad(now.getHours())}${pad(now.getMinutes())}`
  );
}

/** `queriesDir/YYYY-MM-DD-HHMM.md`. */
export function answerNotePath(queriesDir: string, now: Date): string {
  const dir = queriesDir.replace(/\/+$/, '');
  return `${dir}/${answerStamp(now)}.md`;
}

/**
 * Is this vault path a saved answer (a page under the queries folder)?
 *
 * A saved answer is a page like any other — listed in the index, measured by
 * *Check wiki*, readable — and that is deliberate: the answers are meant to
 * enrich the wiki. But it is **not evidence**. An answer is derived from the
 * distilled pages, so feeding one back into a new answer lets a stale answer
 * argue for itself: the question that produced it is the question being asked
 * again, the selection phase sees a page titled exactly like it, and an error
 * saved yesterday comes back as a source today — *after* the pages it was drawn
 * from have been corrected. The pool the selection phase may read therefore
 * leaves these out (`evidencePages`), and the index keeps listing them.
 *
 * Both paths are vault paths, so a queries folder outside the wiki simply
 * excludes nothing — which is the honest reading: the pool is the wiki.
 */
export function isAnswerNote(queriesDir: string, vaultPath: string): boolean {
  const dir = queriesDir.replace(/\/+$/, '');
  if (dir === '') return false;
  return vaultPath.startsWith(`${dir}/`);
}

/**
 * The queries folder as a path *within the wiki*, or `''` when there is nothing
 * to exclude: it lives outside the wiki, or it is the wiki folder itself.
 *
 * The pages the query pipeline handles are named relative to the wiki folder
 * (`queries/2026-09-16-1007.md`), while the setting is a vault path
 * (`20-wiki/queries`), so the comparison has to happen in one space or not at
 * all. Trailing slashes are tolerated on both sides: read off a settings string
 * they are easy to leave behind, and a folder that silently stopped matching
 * would put the earlier answers back in the pool without anyone noticing.
 */
export function queriesFolderWithinWiki(wikiDir: string, queriesDir: string): string {
  const wiki = wikiDir.replace(/\/+$/, '');
  const queries = queriesDir.replace(/\/+$/, '');
  if (wiki === '' || queries === wiki) return '';
  return queries.startsWith(`${wiki}/`) ? queries.slice(wiki.length + 1) : '';
}

/**
 * The pages a new answer may be built from: the wiki's distilled pages, without
 * the earlier answers. `queriesFolder` is wiki-relative, as
 * `queriesFolderWithinWiki` returns it.
 */
export function evidencePages(queriesFolder: string, wikiPaths: readonly string[]): string[] {
  return wikiPaths.filter(path => !isAnswerNote(queriesFolder, path));
}

/**
 * The index without the answers folder's section — what the *ingest* is shown.
 *
 * The index lists every page with its title, and that map is what keeps a note
 * from writing a second page beside the one it belongs to. An answer is not a
 * page a source note may distil into, but its title is the *question*, and a
 * note about the same subject can read as the place to put it: the local model
 * updating `[[2026-09-16-1007|¿Qué es Lisa?]]` from a note about Lisa is the
 * mistake this removes the opportunity for. What a page cannot see it cannot
 * choose — which is cheaper and clearer than refusing afterwards.
 *
 * Recognises the section by its heading, which the index writes as the folder
 * path relative to the wiki (`## queries — 3`), so a nested answers folder is
 * dropped whole. Text with no such section comes back untouched, and so does an
 * empty folder name.
 */
export function dropIndexSection(indexText: string, folder: string): string {
  if (folder === '') return indexText;
  const heading = /^##\s+(.*?)\s+—\s+\d+\s*$/;
  const kept: string[] = [];
  let dropping = false;
  for (const line of indexText.split('\n')) {
    const found = heading.exec(line);
    if (found !== null) dropping = found[1].trim() === folder;
    if (!dropping) kept.push(line);
  }
  return kept.join('\n').replace(/\n+$/, '\n');
}

/**
 * The question as one line: a heading and a YAML value both end at the first
 * line break, so a question typed over several lines has to be folded.
 */
function oneLine(question: string): string {
  return question.replace(/\s+/g, ' ').trim();
}

/**
 * The saved answer as Markdown: the question as the title, then the answer and
 * the pages it came from. A link is written the way Obsidian resolves it, from
 * the vault root, so it works from inside the wiki and from anywhere else.
 */
export function renderAnswerNote(
  question: string,
  answer: string,
  sources: readonly string[],
  now: Date,
): string {
  const title = oneLine(question);
  const links = sources.map(source => `[[${source.replace(/\.md$/i, '')}]]`);

  const frontmatter = [
    '---',
    `question: "${title.replace(/"/g, '\\"')}"`,
    `date: ${now.toISOString()}`,
    `fuentes: [${links.map(link => `"${link}"`).join(', ')}]`,
    '---',
  ].join('\n');

  const body = [`# ${title}`, '', '## Answer', '', answer.trim()];

  return `${frontmatter}\n\n${body.join('\n').replace(/\n+$/, '')}\n`;
}
