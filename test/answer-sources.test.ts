/**
 * Answer-source reconciliation tests. Run with: npm test
 *
 * The fixture is the answer actually saved from the panel: it ends with the
 * `Fuentes:` list the query rules ask for, written from memory by the model.
 * Those names are the ones a reader trusts, so these checks are about what may
 * and may not be done to them:
 *
 *  - a name that means an existing page is pointed at it, alias untouched;
 *  - a link written with folders, with its `.md`, or with a typo, is resolved the
 *    way the checker's own resolver reads it;
 *  - a name that means nothing stays exactly as written and is reported — never
 *    invented, never dropped in silence;
 *  - nothing outside the closing source list is touched.
 */
import assert from 'node:assert/strict';
import { reconcileAnswerSources } from '../src/answer-sources';

const WIKI = [
  '20-wiki/00-meta/indice-de-materia.md',
  '20-wiki/03-plasma/i18n-workflow.md',
  '20-wiki/04-lisa/lisa-architecture-overview.md',
  '20-wiki/04-lisa/lisa-csrs-modelling.md',
  '20-wiki/04-lisa/lisa-trap-management.md',
];

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

const answer = (...lines: string[]): string => lines.join('\n');
const list = (...items: string[]): string => answer('Answer.', '', 'Fuentes:', ...items);
const tail = (text: string, count: number): string[] => text.split('\n').slice(-count);

// --- the answer that was really saved --------------------------------------
const REAL = answer(
  'Lisa es una arquitectura de procesador organizada en bloques genéricos.',
  '',
  'Fuentes:',
  '* [[lisa-architecture-overview.md]]',
  '* [[lisa-trap-management.md]]',
  '* [[lisa-csrs-modelling.md]]',
);

check(
  'the real answer keeps its words and gains targets that exist',
  tail(reconcileAnswerSources(REAL, WIKI).answer, 4),
  [
    'Fuentes:',
    '* [[20-wiki/04-lisa/lisa-architecture-overview]]',
    '* [[20-wiki/04-lisa/lisa-trap-management]]',
    '* [[20-wiki/04-lisa/lisa-csrs-modelling]]',
  ],
);
check(
  'nothing is reported when every name resolves',
  reconcileAnswerSources(REAL, WIKI).unresolved,
  [],
);

// --- how a name may be written ---------------------------------------------
check(
  'a bare name without the extension resolves',
  tail(reconcileAnswerSources(list('* [[lisa-trap-management]]'), WIKI).answer, 1),
  ['* [[20-wiki/04-lisa/lisa-trap-management]]'],
);
check(
  'a name with the wiki folder in front resolves',
  tail(reconcileAnswerSources(list('* [[20-wiki/04-lisa/lisa-csrs-modelling.md]]'), WIKI).answer, 1),
  ['* [[20-wiki/04-lisa/lisa-csrs-modelling]]'],
);
check(
  'one wrong letter is repaired, the way the checker would suggest it',
  tail(reconcileAnswerSources(list('* [[lisa-rchitecture-overview.md]]'), WIKI).answer, 1),
  ['* [[20-wiki/04-lisa/lisa-architecture-overview]]'],
);
check(
  "an alias is the author's wording and survives the repair",
  tail(reconcileAnswerSources(list('* [[lisa-trap-management|Gestión de Traps]]'), WIKI).answer, 1),
  ['* [[20-wiki/04-lisa/lisa-trap-management|Gestión de Traps]]'],
);
check(
  'a line that is only a file name becomes the link it was trying to be',
  tail(reconcileAnswerSources(list('* lisa-architecture-overview.md'), WIKI).answer, 1),
  ['* [[20-wiki/04-lisa/lisa-architecture-overview|lisa-architecture-overview.md]]'],
);

// --- the shapes a source list really comes in --------------------------------
//
// Measured from the panel: the answer's list arrived as a bare *path without an
// extension*, `20-wiki/04-lisa/lis-rchitecture-overview`, and the plugin said
// nothing at all about it — not repaired, and not reported either. Every form
// below has to come out repaired or reported; a citation that is silently wrong
// is the failure this module exists to catch.
check(
  'a bare path with no extension resolves and becomes a link',
  tail(reconcileAnswerSources(list('* 20-wiki/04-lisa/lisa-csrs-modelling'), WIKI).answer, 1),
  ['* [[20-wiki/04-lisa/lisa-csrs-modelling|20-wiki/04-lisa/lisa-csrs-modelling]]'],
);
check(
  'and nothing is reported for it',
  reconcileAnswerSources(list('* 20-wiki/04-lisa/lisa-csrs-modelling'), WIKI).unresolved,
  [],
);
check(
  'a bare slug two edits away is repaired, as the checker would suggest',
  tail(reconcileAnswerSources(list('* lis-rchitecture-overview'), WIKI).answer, 1),
  ['* [[20-wiki/04-lisa/lisa-architecture-overview|lisa-architecture-overview]]'],
);
check(
  'the same typo behind a folder path is repaired too',
  tail(reconcileAnswerSources(list('* 20-wiki/04-lisa/lis-rchitecture-overview'), WIKI).answer, 1),
  ['* [[20-wiki/04-lisa/lisa-architecture-overview|lisa-architecture-overview]]'],
);
check(
  'a repaired name is shown with the name of the page, not the typo',
  tail(reconcileAnswerSources(list('* 20-wiki/04-lisa/lis-rchitecture-overview'), WIKI).answer, 1)[0]?.includes(
    'lis-rchitecture-overview|',
  ),
  false,
);
check(
  'a path that matches nothing is left as written',
  tail(reconcileAnswerSources(list('* 20-wiki/04-lisa/inventada'), WIKI).answer, 1),
  ['* 20-wiki/04-lisa/inventada'],
);
check(
  'and it is reported instead of passing unnoticed',
  reconcileAnswerSources(list('* 20-wiki/04-lisa/inventada'), WIKI).unresolved,
  ['20-wiki/04-lisa/inventada'],
);

// --- what must not be touched ----------------------------------------------
check(
  'a name that matches nothing is left as written',
  tail(reconcileAnswerSources(list('* [[lisa-bibliografia.md]]'), WIKI).answer, 1),
  ['* [[lisa-bibliografia.md]]'],
);
check(
  'and it is named in the report',
  reconcileAnswerSources(list('* [[lisa-bibliografia.md]]'), WIKI).unresolved,
  ['lisa-bibliografia.md'],
);
check(
  'a repeated bad name is reported once',
  reconcileAnswerSources(list('* [[lisa-bibliografia.md]]', '* [[lisa-bibliografia.md]]'), WIKI).unresolved,
  ['lisa-bibliografia.md'],
);
check(
  'a list before the Fuentes section belongs to the answer, not to the sources',
  reconcileAnswerSources(
    answer('Páginas mencionadas:', '* [[lisa-bibliografia.md]]', '', 'Fuentes:', '* [[lisa-trap-management.md]]'),
    WIKI,
  ).answer.split('\n')[1],
  '* [[lisa-bibliografia.md]]',
);
check('an answer with no source list is returned untouched', reconcileAnswerSources('Solo prosa, sin lista final.', WIKI), {
  answer: 'Solo prosa, sin lista final.',
  unresolved: [],
});
check(
  'a bad bare name becomes no link at all',
  tail(reconcileAnswerSources(list('* lisa-bibliografia.md'), WIKI).answer, 1),
  ['* lisa-bibliografia.md'],
);
check('no pages known: nothing is invented and nothing breaks', reconcileAnswerSources(list('* [[x.md]]'), []).answer, list('* [[x.md]]'));
check(
  'the section is found without a heading, as the model wrote it',
  reconcileAnswerSources(answer('Answer.', '', '**Fuentes:**', '* [[i18n-workflow.md]]'), WIKI).unresolved,
  [],
);
check(
  'a phrase in the list is prose, not a reference: untouched and unreported',
  reconcileAnswerSources(list('* una nota que no existe'), WIKI),
  { answer: list('* una nota que no existe'), unresolved: [] },
);

if (failed > 0) {
  console.error(`\n${failed} of ${total} answer-sources checks failed.`);
  process.exit(1);
}
console.log('\nanswer-sources checks passed.');
