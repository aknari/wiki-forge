/**
 * Wiki-check, index and repair tests. Run with: npm test
 *
 * The fixture is a miniature of the vault the checker was written for, and every
 * number below can be counted by hand:
 *
 *   index.md lists five things: one page the wiki has, one typo (`de`), one name
 *   that exists nowhere, one note from outside the wiki, and the log.
 *   Three pages live in two folders; one of them holds a leftover block, another
 *   is linked by nobody, and one declares a source that does not exist.
 */
import assert from 'node:assert/strict';
import { checkWiki, renderWikiReport } from '../src/wiki-check';
import { buildWikiIndex, indexableEntries } from '../src/wiki-index';
import { planRepairs, repairPage, summarizeRepairs } from '../src/wiki-clean';

let failed = 0;

function check(description: string, actual: unknown, expected: unknown): void {
  try {
    assert.deepStrictEqual(actual, expected);
    console.log(`  ok   ${description}`);
  } catch {
    failed += 1;
    console.error(`  FAIL ${description}\n       got ${JSON.stringify(actual)} (expected ${JSON.stringify(expected)})`);
  }
}

const pages = [
  {
    path: 'index.md',
    content: [
      '# Índice de Conocimiento',
      '',
      '- [[modelo-lisa|Modelo Lisa]]',
      '- [[metodologia-de-verificacion|Flujo de Trabajo]]',
      '- [[soporte|Guía de Estilo]]',
      '- [[00 - Lisa|Desarrollo de Lisa]]',
      '- [[log|Historial]]',
    ].join('\n'),
  },
  { path: 'log.md', content: '# Historial\n' },
  {
    path: '01-lisa/modelo-lisa.md',
    content: [
      '---',
      'tipo: concepto',
      'fuentes: ["[[00 - Lisa]]"]',
      '---',
      '# Modelo Lisa',
      '',
      'Enlaza con [[pipeline-de-datos]] y con [[kde]].',
    ].join('\n'),
  },
  {
    path: '01-lisa/pipeline-de-datos.md',
    content: [
      '---',
      'tipo: concepto',
      'fuentes: ["[[00 - Lisa]]"]',
      '---',
      '# Pipeline de datos',
      '',
      'Vuelve a [[modelo-lisa]].',
    ].join('\n'),
  },
  {
    path: '02-plasma/sbbclock.md',
    content: [
      '---',
      'tipo: fuente',
      'fuentes: ["[[no-existe]]"]',
      '---',
      '```',
      'created: 2026-01-01',
      'updated: 2026-01-01 --> 2026-01-02 (or current datetime)',
      '```',
      '# sbbclock',
      '',
      'Sin enlaces salientes.',
    ].join('\n'),
  },
];

/** `metodologia-verificacion` exists outside the wiki; `soporte` and `kde` do not. */
const knownTitles = ['index', 'log', 'modelo-lisa', 'pipeline-de-datos', 'sbbclock', 'metodologia-verificacion', '00 - Lisa'];

const report = checkWiki({ pages, knownTitles });

check('the index and the log are not pages', report.pages, 3);
check('every link is counted, frontmatter included', report.links, 11);
check(
  'the broken targets',
  report.brokenLinks.map(link => link.target),
  ['kde', 'metodologia-de-verificacion', 'no-existe', 'soporte'],
);
check(
  'the one typo gets a unique suggestion, the rest none',
  report.brokenLinks.map(link => link.suggestion),
  [null, 'metodologia-verificacion', null, null],
);
check('a broken link is attributed to the page holding it', report.brokenLinks[1]?.sources, ['index.md']);
check('pages the index does not list', report.missingFromIndex, ['01-lisa/pipeline-de-datos.md', '02-plasma/sbbclock.md']);
check('index entries pointing nowhere', report.staleIndexEntries, ['metodologia-de-verificacion', 'soporte']);
check('index entries pointing outside the wiki', report.foreignIndexEntries, ['00 - Lisa']);
check('the page nobody links to is the orphan', report.orphans, ['02-plasma/sbbclock.md']);
check('one leftover block, counted once', report.artifacts.length, 1);
check('and it is in the page holding it', report.artifacts[0]?.path, '02-plasma/sbbclock.md');
check('the page whose source does not exist', report.untraceable, ['02-plasma/sbbclock.md']);
check('what can be fixed without judgement', [report.fixableLinks, report.fixableArtifacts], [1, 1]);

const rendered = renderWikiReport(report, {
  wikiDir: '20-wiki',
  generatedAt: '2026-09-15T10:00:00.000Z',
  reportPath: '80-support/wiki-forge/informe.md',
});
for (const row of [
  '| Pages | 3 |',
  '| Links | 11 |',
  '| Broken links (missing target) | 4 |',
  '| Pages the index does not list | 2 |',
  '| Index entries pointing nowhere | 2 |',
  '| Orphan pages (no link from another page) | 1 |',
  '| Leftover blocks / markers | 1 |',
  '| Pages with a source that does not resolve | 1 |',
  '| Mechanical fixes available | 2 |',
]) {
  check(`the report carries "${row}"`, rendered.includes(row), true);
}
check('the report names the suggestion', rendered.includes('`metodologia-verificacion`'), true);
check('the report says where it was written', rendered.includes('80-support/wiki-forge/informe.md'), true);

// ------------------------------------------------------------------- the index
const entries = indexableEntries(pages, { indexName: 'index.md', logName: 'log.md' });
const index = buildWikiIndex(entries, {
  wikiDir: '20-wiki',
  indexName: 'index.md',
  logName: 'log.md',
  generatedAt: '2026-09-15T10:00:00.000Z',
});
check('the index leaves out the log', index.includes('[[log|'), false);
check('and its own entry', index.includes('- [[index|'), false);
check('it groups by folder and counts', index.includes('## 01-lisa — 2'), true);
check('the second folder too', index.includes('## 02-plasma — 1'), true);
check('a page is listed with its own heading and type', index.includes('- [[modelo-lisa|Modelo Lisa]] — `concepto`'), true);
check('and one without a heading falls back to its file name', index.includes('- [[sbbclock|sbbclock]] — `fuente`'), true);
check('the index is marked as generated', index.includes('generated_by: WikiForge'), true);
// The type alone was not enough to select by: a title says nothing about what a
// page answers, and the query rules promise the index carries summaries.
check(
  'and the opening of the page, so it can be chosen by content',
  index.includes('- [[modelo-lisa|Modelo Lisa]] — `concepto` — Enlaza con pipeline-de-datos y con kde.'),
  true,
);
check(
  'a page whose metadata sits in a fence still shows its opening',
  index.includes('- [[sbbclock|sbbclock]] — `fuente` — Sin enlaces salientes.'),
  true,
);
check('an empty wiki says so', buildWikiIndex([], {
  wikiDir: '20-wiki',
  indexName: 'index.md',
  logName: 'log.md',
  generatedAt: '2026-09-15T10:00:00.000Z',
}).includes('La wiki está vacía'), true);

// ------------------------------------------------------------------- repairs
const repairs = planRepairs(entries, knownTitles);
check('only the page that changes is planned', repairs.map(r => r.path), ['02-plasma/sbbclock.md']);
check('the leftover is what changes there', repairs[0]?.fixes.map(f => f.kind), ['artifact']);
check('the block is gone from the result', repairs[0]?.after.includes('```'), false);
check('and the frontmatter survives', repairs[0]?.after.includes('tipo: fuente'), true);
check('the summary counted it once', summarizeRepairs(repairs), { pages: 1, links: 0, artifacts: 1 });

const typo = repairPage({ path: 'x.md', content: 'Ver [[metodologia-de-verificacion]].\n' }, ['metodologia-verificacion']);
check('a unique typo is retargeted', typo.after, 'Ver [[metodologia-verificacion]].\n');
check('and reported as a link fix', typo.fixes.map(f => f.detail), ['[[metodologia-de-verificacion]] → [[metodologia-verificacion]]']);

const aliased = repairPage({ path: 'x.md', content: 'Ver [[metodologia-de-verificacion|Flujo de Trabajo]].\n' }, ['metodologia-verificacion']);
check('the author’s alias survives the repair', aliased.after, 'Ver [[metodologia-verificacion|Flujo de Trabajo]].\n');

const ambiguous = repairPage({ path: 'x.md', content: 'Ver [[plasma]].\n' }, ['plasma5', 'plasma6']);
check('an ambiguous link is left alone', ambiguous.fixes, []);

const linkOutside = repairPage({ path: 'x.md', content: 'Ver [[00 - Lisa]].\n' }, ['00 - Lisa']);
check('a working link is left alone', linkOutside.fixes, []);

// A declared source is written as a wikilink in the frontmatter. Read with the
// brackets still on it, a source that does exist was reported as missing.
const traced = checkWiki({
  pages: [
    { path: 'index.md', content: '# i\n' },
    {
      path: '01-x/a.md',
      content: '---\ntipo: fuente\nfuentes: ["[[00-src/30-dev/30-lisa/00 - Lisa.md]]"]\n---\n# A\n',
    },
  ],
  knownTitles: ['index', 'a', '00-src/30-dev/30-lisa/00 - Lisa'],
});
check('a source written as a bracketed path resolves', traced.untraceable, []);

if (failed > 0) {
  console.error(`\n${failed} wiki check test(s) failed.`);
  process.exit(1);
}
console.log('\nwiki check tests passed.');
