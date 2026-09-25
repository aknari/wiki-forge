/**
 * Query-answer note tests. Run with: npm test
 *
 * These cover the three things that break once a saved answer lives inside the
 * wiki and is read back as a wiki page: the title the index lists it under, the
 * key the check reads to trace it, and the file name it gets. The last checks
 * tie the format to the two modules that consume it — `firstHeading` in the
 * index and `frontmatterList` in the check — so changing the format by accident
 * fails here instead of showing up as a strange line in the vault.
 */
import assert from 'node:assert/strict';
import {
  answerNotePath,
  answerStamp,
  dropIndexSection,
  evidencePages,
  isAnswerNote,
  queriesFolderWithinWiki,
  renderAnswerNote,
} from '../src/query-note';
import { firstHeading, frontmatterList, splitFrontmatter } from '../src/wikitext';

let failed = 0;
let total = 0;

function check(label: string, got: unknown, expected: unknown): void {
  total++;
  try {
    assert.deepStrictEqual(got, expected);
    console.log(`  ok   ${label}`);
  } catch {
    failed++;
    console.error(
      `  FAIL ${label}\n       got      ${JSON.stringify(got)}\n       expected ${JSON.stringify(expected)}`,
    );
  }
}

// --- the file name ---------------------------------------------------------
const when = new Date(2026, 8, 15, 18, 3);
check('the stamp is the date and the time', answerStamp(when), '2026-09-15-1803');
check('single-digit hour and minute are padded', answerStamp(new Date(2026, 0, 5, 9, 7)), '2026-01-05-0907');
check(
  'the path keeps the configured folder',
  answerNotePath('20-wiki/queries', when),
  '20-wiki/queries/2026-09-15-1803.md',
);
check(
  'a trailing slash on the folder does not double it',
  answerNotePath('20-wiki/queries/', when),
  '20-wiki/queries/2026-09-15-1803.md',
);
check(
  'the folder may live outside the wiki',
  answerNotePath('10-journal/queries', when),
  '10-journal/queries/2026-09-15-1803.md',
);

// --- the note itself -------------------------------------------------------
const question = '¿Cómo gestiona Lisa el acceso a memoria?';
const answer = '  Por capas, con una caché de dos niveles.\n';
const sources = ['20-wiki/01-lisa/capa-de-acceso-a-memoria.md'];
const note = renderAnswerNote(question, answer, sources, when);
const split = splitFrontmatter(note);

check('the title is the question itself', firstHeading(split.body), question);
check('so the index does not list it as a bare "Question"', firstHeading(split.body) === 'Question', false);
check('no leftover "## Question" heading survives', note.includes('## Question'), false);
check(
  'the sources are declared in fuentes, the key the wiki uses',
  frontmatterList(split, 'fuentes'),
  ['[[20-wiki/01-lisa/capa-de-acceso-a-memoria]]'],
);
check('and nothing is left in sources, which the check never reads', frontmatterList(split, 'sources'), []);
check('the question is in the frontmatter as well', split.keys['question'], `"${question}"`);
check('with an ISO date', split.keys['date'], when.toISOString());
check('the answer is trimmed into its section', /## Answer\n\nPor capas, con una caché de dos niveles\./.test(note), true);
check(
  'the sources are not listed again in the body',
  note.includes('## Sources'),
  false,
);
check(
  'the answer itself is what closes the note',
  note.trimEnd().endsWith('Por capas, con una caché de dos niveles.'),
  true,
);
check(
  'the frontmatter opens and closes the file',
  [note.startsWith('---\n'), note.split('\n').slice(0, 5).join('\n').includes('\n---')],
  [true, true],
);

// --- earlier answers are pages, but not evidence ---------------------------
// A saved answer is listed in the index, so the selection phase is shown a page
// titled exactly like the question being asked again. It must never be read as
// a source: an answer is derived from the distilled pages, and reading it back
// lets a stale answer — an error in it included — cite itself.
const pool = [
  'queries/2026-09-16-1007.md',
  '04-lisa/lisa-architecture-overview.md',
  '03-plasma/i18n-workflow.md',
];
check('a saved answer is known by its folder', isAnswerNote('queries', 'queries/2026-09-16-1007.md'), true);
check('a distilled page is not', isAnswerNote('queries', '04-lisa/lisa-architecture-overview.md'), false);
check('a trailing slash on the folder does not break it', isAnswerNote('queries/', 'queries/a.md'), true);
check('an empty folder excludes nothing', isAnswerNote('', 'queries/a.md'), false);
check('a sibling folder is not the queries folder', isAnswerNote('queries', 'queries-old/a.md'), false);
check(
  'the queries folder is located inside the wiki',
  queriesFolderWithinWiki('20-wiki', '20-wiki/queries'),
  'queries',
);
check(
  'trailing slashes on either side are tolerated',
  queriesFolderWithinWiki('20-wiki/', '20-wiki/queries/'),
  'queries',
);
check(
  'a nested queries folder keeps its path',
  queriesFolderWithinWiki('20-wiki', '20-wiki/support/queries'),
  'support/queries',
);
check(
  'a folder outside the wiki is not inside it',
  queriesFolderWithinWiki('20-wiki', '10-journal/queries'),
  '',
);
check(
  'a folder that merely starts with the wiki name is not inside it',
  queriesFolderWithinWiki('20-wiki', '20-wiki-old/queries'),
  '',
);
check('the wiki folder itself excludes nothing', queriesFolderWithinWiki('20-wiki', '20-wiki'), '');
check(
  'the pool an answer is built from leaves the earlier answers out',
  evidencePages('queries', pool),
  ['04-lisa/lisa-architecture-overview.md', '03-plasma/i18n-workflow.md'],
);
check('a queries folder outside the wiki leaves the whole pool', evidencePages('', pool), pool);

// --- the map the *ingest* is shown -----------------------------------------
// The index lists the answers with the question as their title, and a note about
// the same subject can read that as the page to update. What a page cannot see
// it cannot choose, so the answers section is not in the map the ingest gets.
const indexText = [
  '# Índice de Conocimiento',
  '',
  '## 04-lisa — 3',
  '',
  '- [[lisa-architecture-overview|Arquitectura de Lisa]] — `concepto`',
  '',
  '## queries — 1',
  '',
  '- [[2026-09-16-1007|¿Qué es Lisa?]]',
  '',
].join('\n');
check(
  'the answers section is not in the map the ingest sees',
  dropIndexSection(indexText, 'queries').includes('¿Qué es Lisa?'),
  false,
);
check(
  'and the distilled pages stay',
  dropIndexSection(indexText, 'queries').includes('Arquitectura de Lisa'),
  true,
);
check(
  'a section in the middle does not take the rest with it',
  dropIndexSection('## queries — 1\n- [[a]]\n\n## 04-lisa — 1\n- [[b]]\n', 'queries').includes('[[b]]'),
  true,
);
check(
  'a nested answers folder is dropped whole',
  dropIndexSection('## support/queries — 2\n- [[a]]\n', 'support/queries').includes('[[a]]'),
  false,
);
check('a map with no answers folder comes back untouched', dropIndexSection(indexText, ''), indexText);
check(
  'a folder that is not in the map leaves it alone',
  dropIndexSection(indexText, 'nowhere').includes('¿Qué es Lisa?'),
  true,
);
check(
  'another folder is not mistaken for it',
  dropIndexSection(indexText, 'lisa').includes('¿Qué es Lisa?'),
  true,
);

// --- awkward questions -----------------------------------------------------
check(
  'a question typed over two lines is folded into one heading',
  firstHeading(splitFrontmatter(renderAnswerNote('¿Cómo va\nesto?', 'x', [], when)).body),
  '¿Cómo va esto?',
);
check(
  'double quotes are escaped in the frontmatter',
  splitFrontmatter(renderAnswerNote('dijo "hola"', 'x', [], when)).keys['question'],
  '"dijo \\"hola\\""',
);
check(
  'an answer that read no page declares an empty fuentes list',
  renderAnswerNote('q', 'a', [], when).includes('fuentes: []'),
  true,
);
check(
  'several sources are listed in order',
  frontmatterList(splitFrontmatter(renderAnswerNote('q', 'a', ['20-wiki/a.md', '20-wiki/b.md'], when)), 'fuentes'),
  ['[[20-wiki/a]]', '[[20-wiki/b]]'],
);

if (failed > 0) {
  console.error(`\n${failed} of ${total} query-note checks failed.`);
  process.exit(1);
}
console.log('\nquery-note checks passed.');
