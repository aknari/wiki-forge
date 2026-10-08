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
      'type: concept',
      'sources: ["[[00 - Lisa]]"]',
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
      'type: concept',
      'sources: ["[[00 - Lisa]]"]',
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
      'type: source',
      'sources: ["[[no-existe]]"]',
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
check('the report counts the strong suggestions', rendered.includes('| Missing cross-references (suggested) | 0 |'), true);
check('the report counts the weak evidence', rendered.includes('| Weak evidence (2 mentions) | 0 |'), true);
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
check('a page is listed with its own heading and type', index.includes('- [[modelo-lisa|Modelo Lisa]] — `concept`'), true);
check('and one without a heading falls back to its file name', index.includes('- [[sbbclock|sbbclock]] — `source`'), true);
check('the index is marked as generated', index.includes('generated_by: WikiForge'), true);
// The type alone was not enough to select by: a title says nothing about what a
// page answers, and the query rules promise the index carries summaries.
check(
  'and the opening of the page, so it can be chosen by content',
  index.includes('- [[modelo-lisa|Modelo Lisa]] — `concept` — Enlaza con pipeline-de-datos y con kde.'),
  true,
);
check(
  'a page whose metadata sits in a fence still shows its opening',
  index.includes('- [[sbbclock|sbbclock]] — `source` — Sin enlaces salientes.'),
  true,
);
check('an empty wiki says so', buildWikiIndex([], {
  wikiDir: '20-wiki',
  indexName: 'index.md',
  logName: 'log.md',
  generatedAt: '2026-09-15T10:00:00.000Z',
}).includes('The wiki is empty'), true);

// ------------------------------------------------------------------- repairs
const repairs = planRepairs(entries, knownTitles);
check('only the page that changes is planned', repairs.map(r => r.path), ['02-plasma/sbbclock.md']);
check('the leftover is what changes there', repairs[0]?.fixes.map(f => f.kind), ['artifact']);
check('the block is gone from the result', repairs[0]?.after.includes('```'), false);
check('and the frontmatter survives', repairs[0]?.after.includes('type: source'), true);
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
      content: '---\ntype: source\nsources: ["[[00-src/30-dev/30-lisa/00 - Lisa.md]]"]\n---\n# A\n',
    },
  ],
  knownTitles: ['index', 'a', '00-src/30-dev/30-lisa/00 - Lisa'],
});
check('a source written as a bracketed path resolves', traced.untraceable, []);

// --------------------------------------------------------- missing cross-refs
// The wiki-check fixture is too small to exercise the detection: three pages
// and a handful of name words. This miniature is built for it.
const mini = [
  {
    path: 'index.md',
    content: '# i\n',
  },
  {
    path: '01-lisa/modelo-lisa.md',
    content: [
      '---',
      'sources: ["[[00 - Lisa]]"]',
      '---',
      '# Modelo Lisa',
      '',
      'Vuelve a [[pipeline-de-datos]].',
    ].join('\n'),
  },
  {
    path: '01-lisa/pipeline-de-datos.md',
    content: [
      '---',
      'sources: ["[[modelo-lisa]]"]',
      '---',
      '# Pipeline de datos',
      '',
      'Todo el pipeline pasa por Lisa, la prueba de Lisa también,',
      'y la interfaz de Lisa cierra el bucle. Lisa arriba, Lisa abajo.',
    ].join('\n'),
  },
  {
    path: '01-lisa/plasma-en-lisa.md',
    content: '# Plasma en Lisa\n\nLisa aquí.\n',
  },
  {
    path: '02-plasma/sbbclock.md',
    content: [
      '---',
      'sources: ["[[00 - Lisa]]"]',
      '---',
      '# sbbclock',
      '',
      'El pipeline de datos entra en el reloj; el pipeline de datos lo mide;',
      'y el pipeline de datos cierra el ciclo. Pipeline, pipeline, pipeline.',
    ].join('\n'),
  },
];
const found = checkWiki({
  pages: mini,
  knownTitles: ['index', 'modelo-lisa', 'pipeline-de-datos', 'sbbclock', '00 - Lisa'],
});

check(
  'a page naming another subject without linking it is suggested',
  found.missingLinks,
  [{ from: '02-plasma/sbbclock.md', to: '01-lisa/pipeline-de-datos.md', term: 'pipeline', mentions: 4 }],
);
check(
  'the same wiki, measured for nothing else, is unchanged',
  [found.brokenLinks.length, found.orphans.length, found.pages],
  [0, 2, 4],
);

const linked = checkWiki({
  pages: [
    { path: 'index.md', content: '# i\n' },
    { path: 'a/capacitor.md', content: '# Capacitor\n\nnota\n' },
    {
      path: 'b/tuner.md',
      content: '# Tuner\n\nEl capacitor aparece, el capacitor manda, el capacitor cierra.\n',
    },
  ],
  knownTitles: ['index', 'capacitor', 'tuner'],
});
check('without a link the suggestion stands', linked.missingLinks.length, 1);

const nowLinked = checkWiki({
  pages: [
    { path: 'index.md', content: '# i\n' },
    { path: 'a/capacitor.md', content: '# Capacitor\n\nnota\n' },
    {
      path: 'b/tuner.md',
      content: '# Tuner\n\nEl [[capacitor]] aparece, el capacitor manda, el capacitor cierra.\n',
    },
  ],
  knownTitles: ['index', 'capacitor', 'tuner'],
});
check('a link already carried suppresses the suggestion', nowLinked.missingLinks, []);

const sharedWord = checkWiki({
  pages: [
    { path: 'index.md', content: '# i\n' },
    { path: 'a/pipeline-data.md', content: '# Pipeline data\n\nnota\n' },
    { path: 'a/pipeline-view.md', content: '# Pipeline view\n\nnota\n' },
    {
      path: 'b/tuner.md',
      content: '# Tuner\n\nEl pipeline aparece, el pipeline manda, el pipeline cierra.\n',
    },
  ],
  knownTitles: ['index', 'pipeline-data', 'pipeline-view', 'tuner'],
});
check('a word two pages share is nobody\'s subject', sharedWord.missingLinks, []);

const declaredSource = checkWiki({
  pages: [
    { path: 'index.md', content: '# i\n' },
    { path: 'a/capacitor.md', content: '# Capacitor\n\nnota\n' },
    {
      path: 'b/tuner.md',
      content: '---\nsources: ["[[capacitor]]"]\n---\n# Tuner\n\nEl capacitor aparece, el capacitor manda, el capacitor cierra.\n',
    },
  ],
  knownTitles: ['index', 'capacitor', 'tuner'],
});
check('the normal sources pattern is not a missing link', declaredSource.missingLinks, []);

const fewMentions = checkWiki({
  pages: [
    { path: 'index.md', content: '# i\n' },
    { path: 'a/capacitor.md', content: '# Capacitor\n\nnota\n' },
    { path: 'b/tuner.md', content: '# Tuner\n\nEl capacitor aparece una vez y el capacitor se va.\n' },
  ],
  knownTitles: ['index', 'capacitor', 'tuner'],
});
check('two mentions do not reach the strong tier', fewMentions.missingLinks, []);
check(
  'and they are offered as weak evidence',
  fewMentions.weakMissingLinks,
  [{ from: 'b/tuner.md', to: 'a/capacitor.md', term: 'capacitor', mentions: 2 }],
);

// The weak tier is capped so a large wiki still reads its report at a glance.
// Each subject has to be a word only its own page claims, hence one distinct
// word per page — and more than ten of them, to see the cap bite.
const letters = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta', 'theta', 'iota', 'kappa', 'lambda', 'omicron'];
const weakTier = checkWiki({
  pages: [
    { path: 'index.md', content: '# i\n' },
    ...letters.map(letter => ({
      path: `a/${letter}-part.md`,
      content: `# ${letter} part\n\nnota\n`,
    })),
    {
      path: 'b/tuner.md',
      content: `# Tuner\n\n${letters.map(letter => `The ${letter} part hums, the ${letter} part sings.`).join(' ')}\n`,
    },
  ],
  knownTitles: ['index', 'tuner', ...letters.map(letter => `${letter}-part`)],
});
check('nothing weak is strong', weakTier.missingLinks, []);
check('the weak tier is capped at ten rows', weakTier.weakMissingLinks.length, 10);
check('the cap keeps the first rows in report order', weakTier.weakMissingLinks[9]?.to, 'a/theta-part.md');

if (failed > 0) {
  console.error(`\n${failed} wiki check test(s) failed.`);
  process.exit(1);
}
console.log('\nwiki check tests passed.');
