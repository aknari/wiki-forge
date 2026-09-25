/**
 * Source-search tests. Run with: npm test
 *
 * The fixtures are the real notes this module was written against, with the real
 * ranking they produce. The case that matters is the one that failed in practice:
 * `00 - Desarrollo de Lisa.md` states what Lisa is, and it sits at position 44 of
 * 101 by date — outside the old recency window and therefore never offered. Here
 * it has to come first, and that is what the name weighting is for.
 *
 * The Tifinagh case is not decoration either: this vault holds notes in
 * Tifinagh, and a word split written for ASCII turns a query in that script into
 * zero terms, which then looks exactly like "the wiki has no answer".
 */
import assert from 'node:assert/strict';
import { fold, queryTerms, rankSources, recencyCandidates, type SourceDoc } from '../src/search';

let failed = 0;
const check = (label: string, run: () => void): void => {
  try {
    run();
    console.log(`  ok   ${label}`);
  } catch (e) {
    failed++;
    console.error(`  FAIL ${label} — ${e instanceof Error ? e.message : String(e)}`);
  }
};

// --- the terms of a question ---

const TERMS: Array<[string, string[]]> = [
  ['¿Qué es Lisa?', ['lisa']],
  ['¿Cómo se gestionan los traps y las interrupciones en Lisa?', ['gestionan', 'traps', 'interrupciones', 'lisa']],
  ['internacionalización de plasmoids', ['internacionalizacion', 'plasmoids']],
  ['lisa lisa LISA', ['lisa']],
  ['¿qué es?', []],
  ['de la y o', []],
  ['RV32I y C++', ['rv32i', 'c++']],
  ['amawal ⵜⴰⵎⴰⵣⵉⵖⵜ', ['amawal', 'ⵜⴰⵎⴰⵣⵉⵖⵜ']],
];

for (const [question, expected] of TERMS) {
  check(`terms of ${JSON.stringify(question)}`, () => {
    assert.deepStrictEqual(queryTerms(question), expected);
  });
}

check('folding removes accents but keeps other scripts', () => {
  assert.strictEqual(fold('Internacionalización'), 'internacionalizacion');
  assert.strictEqual(fold('Tifinaɣ'), 'tifinaɣ');
  assert.strictEqual(fold('ⵜⴰⵎⴰⵣⵉⵖⵜ'), 'ⵜⴰⵎⴰⵣⵉⵖⵜ');
});

// --- the ranking ---

const day = 24 * 60 * 60 * 1000;
const docs: SourceDoc[] = [
  {
    path: '00-src/30-dev/30-lisa/00 - Desarrollo de Lisa.md',
    text:
      'Lisa es un modelo de procesador RISC-V desarrollado en C++ con la intención de servir como una ' +
      'descripción de hardware compatible con HLS. El modelo Lisa se organiza en capas y Lisa busca ' +
      'que Lisa sea sintetizable.',
    mtime: 100 * day,
  },
  {
    path: '00-src/30-dev/30-lisa/Apuntes de desarrollo.md',
    text: 'El juego de instrucciones actualizado se encuentra en el manual de RISC-V. Aquí se anotan ideas sobre Lisa y sus CSRs.',
    mtime: 90 * day,
  },
  {
    path: '00-src/30-dev/30-lisa/Comments and ideas concerning Lisa.md',
    text: 'The organisation of the Lisa model... Lisa is a RISC-V model, and Lisa has been conceived as RV32I.',
    mtime: 300 * day,
  },
  {
    path: '00-src/30-dev/30-lisa/Notas sobre Lisa.md',
    text: 'Lisa y la gestión de memoria lenta. Lisa usa una memoria principal única.',
    mtime: 200 * day,
  },
  {
    path: '00-src/10-operon/projects/Otros.md',
    text: 'Tareas esporádicas que no encajan en la estructura habitual.',
    mtime: 999 * day,
  },
  {
    path: '00-src/60-reference/20-tafukt.md',
    text: 'Notas sobre el sol y el verano en tamazight.',
    mtime: 999 * day,
  },
];

check('the notes named after the subject take the top places', () => {
  // The regression this guards: `00 - Desarrollo de Lisa.md` is the note that says
  // what Lisa is, and with the old recency window it was never even offered. Being
  // *named* after the subject is what has to put it in front of the model.
  const hits = rankSources('¿Qué es Lisa?', docs);
  const top = hits.slice(0, 3).map(hit => hit.path);
  assert.deepStrictEqual(top.sort(), [
    '00-src/30-dev/30-lisa/00 - Desarrollo de Lisa.md',
    '00-src/30-dev/30-lisa/Comments and ideas concerning Lisa.md',
    '00-src/30-dev/30-lisa/Notas sobre Lisa.md',
  ]);
});

check('a name match outranks a body match', () => {
  const hits = rankSources('¿Qué es Lisa?', docs);
  const order = hits.map(hit => hit.path);
  assert.ok(
    order.indexOf('00-src/30-dev/30-lisa/Notas sobre Lisa.md') <
      order.indexOf('00-src/30-dev/30-lisa/Apuntes de desarrollo.md'),
    `name match should rank first, got ${JSON.stringify(order)}`,
  );
});

check('notes that do not mention the term are not candidates at all', () => {
  const hits = rankSources('¿Qué es Lisa?', docs);
  const paths = hits.map(hit => hit.path);
  assert.ok(!paths.includes('00-src/10-operon/projects/Otros.md'));
  assert.ok(!paths.includes('00-src/60-reference/20-tafukt.md'));
});

check('the hitting terms travel with each note', () => {
  const hits = rankSources('¿Qué es Lisa?', docs);
  assert.deepStrictEqual(hits[0].matched, ['lisa']);
});

check('a term only matches where a word begins', () => {
  const trap: SourceDoc[] = [
    { path: '00-src/a.md', text: 'Una analisa completa del asunto.', mtime: 1 },
    { path: '00-src/b.md', text: 'Reunión con Lisa y el equipo.', mtime: 1 },
  ];
  const hits = rankSources('lisa', trap);
  assert.deepStrictEqual(hits.map(hit => hit.path), ['00-src/b.md']);
});

check('a question with nothing to search for matches nothing', () => {
  assert.deepStrictEqual(rankSources('¿qué es?', docs), []);
});

check('the order is total: same query, same list', () => {
  const once = rankSources('Lisa', docs).map(hit => hit.path);
  const twice = rankSources('Lisa', docs).map(hit => hit.path);
  assert.deepStrictEqual(once, twice);
  // And it is an order, not a set: the tie between name matches is broken by
  // recency, so a screenshot of the panel is worth something later.
  assert.ok(once.length >= 3);
  assert.strictEqual(new Set(once).size, once.length);
});

check('repeats inside one note stop counting at the cap', () => {
  // Two notes, one of them saying it 200 times: past the cap they score the same,
  // so the tie-break decides — a long note cannot bury the list by repeating
  // itself, which is what an uncapped count would let it do.
  const spam: SourceDoc[] = [
    { path: '00-src/verbose.md', text: 'lisa '.repeat(200), mtime: 1 },
    { path: '00-src/five.md', text: 'lisa '.repeat(5), mtime: 1 },
  ];
  const hits = rankSources('lisa', spam);
  assert.deepStrictEqual(
    hits.map(hit => hit.score),
    [hits[0].score, hits[0].score],
    'both should cap at the same score',
  );
  assert.deepStrictEqual(hits.map(hit => hit.path), ['00-src/five.md', '00-src/verbose.md']);
});

// --- the recency fallback, for a question with no usable term ---

check('each area contributes its own newest notes', () => {
  const all: SourceDoc[] = [
    { path: '00-src/a/old.md', text: '', mtime: 1 },
    { path: '00-src/a/new.md', text: '', mtime: 10 },
    { path: '10-journal/2026-01-01.md', text: '', mtime: 5 },
  ];
  assert.deepStrictEqual(recencyCandidates(all, ['00-src', '10-journal'], 1), [
    '00-src/a/new.md',
    '10-journal/2026-01-01.md',
  ]);
});

check('a nested area still gets its own slice, and nothing is repeated', () => {
  const all: SourceDoc[] = [
    { path: '00-src/x.md', text: '', mtime: 10 },
    { path: '00-src/20-tasks/t.md', text: '', mtime: 1 },
  ];
  const got = recencyCandidates(all, ['00-src', '00-src/20-tasks'], 1);
  assert.deepStrictEqual(got, ['00-src/x.md', '00-src/20-tasks/t.md']);
});

check('an empty area name is ignored instead of matching everything', () => {
  const all: SourceDoc[] = [{ path: '00-src/x.md', text: '', mtime: 1 }];
  assert.deepStrictEqual(recencyCandidates(all, ['', '   '], 5), []);
});

if (failed > 0) {
  console.error(`\n${failed} of ${TERMS.length + 12} search checks failed.`);
  process.exit(1);
}
console.log(`\n${TERMS.length + 12}/${TERMS.length + 12} search checks passed.`);
