/**
 * Suggestion-resolution tests. Run with: npm test
 *
 * The case these exist for is the one that was reported from the panel: the
 * model answered `Comments and ideas concerning Lisa.md` when the note it meant
 * was `00-src/30-dev/30-lisa/Comments and ideas concerning Lisa.md`, and the row
 * that came out was unopenable, uningestable and explained itself with a reason
 * that made no sense. The list of candidates was known all along; these checks
 * pin down that the answer is resolved against it, and that a name matching
 * nothing is dropped instead of being shown as a dead row.
 */
import assert from 'node:assert/strict';
import { parsePageNames, resolveCandidate, resolveCandidates } from '../src/suggestions';

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

const candidates = [
  '00-src/30-dev/30-lisa/Comments and ideas concerning Lisa.md',
  '00-src/30-dev/30-lisa/Notas sobre Lisa.md',
  '00-src/60-reference/20-tafukt.md',
  '10-journal/daily notes/2026-09-15.md',
];

// --- the reported bug -------------------------------------------------------
check(
  'a bare file name is resolved to the note it means',
  resolveCandidate('Comments and ideas concerning Lisa.md', candidates),
  '00-src/30-dev/30-lisa/Comments and ideas concerning Lisa.md',
);
check(
  'and so a short list of them, in order',
  resolveCandidates(['Comments and ideas concerning Lisa.md', 'Notas sobre Lisa.md'], candidates),
  ['00-src/30-dev/30-lisa/Comments and ideas concerning Lisa.md', '00-src/30-dev/30-lisa/Notas sobre Lisa.md'],
);

// --- how a model actually answers -------------------------------------------
check('a list bullet is ignored', resolveCandidate('- 20-tafukt.md', candidates), '00-src/60-reference/20-tafukt.md');
check('a number is ignored', resolveCandidate('1. 20-tafukt.md', candidates), '00-src/60-reference/20-tafukt.md');
check('quotes are ignored', resolveCandidate('"20-tafukt.md"', candidates), '00-src/60-reference/20-tafukt.md');
check('brackets are ignored', resolveCandidate('[20-tafukt.md]', candidates), '00-src/60-reference/20-tafukt.md');
check('the extension is optional', resolveCandidate('20-tafukt', candidates), '00-src/60-reference/20-tafukt.md');
check('a partial path is enough', resolveCandidate('30-lisa/Notas sobre Lisa.md', candidates), '00-src/30-dev/30-lisa/Notas sobre Lisa.md');
check('a whole path is taken as it is', resolveCandidate('00-src/60-reference/20-tafukt.md', candidates), '00-src/60-reference/20-tafukt.md');
check('case is not the point', resolveCandidate('notas sobre lisa.md', candidates), '00-src/30-dev/30-lisa/Notas sobre Lisa.md');
check('angle brackets are ignored', resolveCandidate('<20-tafukt.md>', candidates), '00-src/60-reference/20-tafukt.md');
check('emphasis is ignored', resolveCandidate('*20-tafukt.md*', candidates), '00-src/60-reference/20-tafukt.md');
check('a comma left from a list is ignored', resolveCandidate('"20-tafukt.md",', candidates), '00-src/60-reference/20-tafukt.md');
check(
  'a name with spaces and accents matches as it was offered',
  resolveCandidate('Notas sobre Lisa.md', candidates),
  '00-src/30-dev/30-lisa/Notas sobre Lisa.md',
);

// --- the shape the query's selection phase gets back ------------------------
//
// The index lists wiki pages as wikilinks and the query rules ask for them in
// that shape, so this is what the model answers with. Taken literally it named a
// file that did not exist, the wiki page was never read, and every question
// ended in the raw-note fallback however much the wiki already held.
const wikiPages = [
  '00-meta/indice-de-materia.md',
  '03-plasma/i18n-workflow.md',
  '04-lisa/lisa-architecture-overview.md',
  '04-lisa/lisa-trap-management.md',
  '04-lisa/lisa-csrs-modelling.md',
];

check(
  'a wikilink is the page it points at',
  resolveCandidate('[[lisa-architecture-overview]]', wikiPages),
  '04-lisa/lisa-architecture-overview.md',
);
check(
  'the alias of a wikilink is not part of the name',
  resolveCandidate('[[lisa-architecture-overview|Arquitectura de Lisa]]', wikiPages),
  '04-lisa/lisa-architecture-overview.md',
);
check(
  'nor is the heading',
  resolveCandidate('[[lisa-trap-management#excepciones|las excepciones]]', wikiPages),
  '04-lisa/lisa-trap-management.md',
);
check(
  'the measured answer, brackets and all, resolves in order',
  resolveCandidates(
    ['[[lisa-architecture-overview]]', '[[lisa-trap-management]]', '[[lisa-csrs-modelling]]'],
    wikiPages,
  ),
  [
    '04-lisa/lisa-architecture-overview.md',
    '04-lisa/lisa-trap-management.md',
    '04-lisa/lisa-csrs-modelling.md',
  ],
);
check(
  'a page named with its folder still resolves',
  resolveCandidate('04-lisa/lisa-csrs-modelling.md', wikiPages),
  '04-lisa/lisa-csrs-modelling.md',
);
// Measured against the local model, with the wiki pages present and the index
// listing all three: the pool names pages relative to the wiki folder and the
// model answered with the wiki folder in front. That matched nothing, the
// context came out empty, and the panel said the wiki had no answer — the same
// report as the wikilinks, from a different dressing.
check(
  'the wiki folder in front of the name does not matter',
  resolveCandidate('20-wiki/04-lisa/lisa-csrs-modelling.md', wikiPages),
  '04-lisa/lisa-csrs-modelling.md',
);
check(
  'so the measured answer, prefixed, resolves in order',
  resolveCandidates(
    [
      '20-wiki/04-lisa/lisa-architecture-overview.md',
      '20-wiki/04-lisa/lisa-trap-management.md',
      '20-wiki/04-lisa/lisa-csrs-modelling.md',
    ],
    wikiPages,
  ),
  [
    '04-lisa/lisa-architecture-overview.md',
    '04-lisa/lisa-trap-management.md',
    '04-lisa/lisa-csrs-modelling.md',
  ],
);
check(
  'a wikilink to a page that is not there is dropped',
  resolveCandidate('[[lisa-verification-methodology]]', wikiPages),
  null,
);

// --- reading the shape of the answer ----------------------------------------
// The selection phase asks for a JSON list and does not always get one. Every
// shape below is safe to read, because what comes out is resolved against the
// pages that exist: a line that names nothing is dropped, so being generous
// here costs a lookup — while refusing to look cost the whole answer.
check('a JSON list is read as it is', parsePageNames('["20-tafukt.md"]'), ['20-tafukt.md']);
check(
  'a JSON list inside a code fence is read',
  parsePageNames('```json\n["20-tafukt.md"]\n```'),
  ['20-tafukt.md'],
);
check(
  'a JSON list inside a sentence is read',
  parsePageNames('These pages: ["20-tafukt.md"] — that is all.'),
  ['20-tafukt.md'],
);
check(
  'with no list at all the lines are taken',
  parsePageNames('- 20-tafukt.md\n- Notas sobre Lisa.md'),
  ['- 20-tafukt.md', '- Notas sobre Lisa.md'],
);
check(
  'so a reply in another shape is answered from, not refused',
  resolveCandidates(parsePageNames('The answer is in:\n* 20-tafukt.md\n'), candidates),
  ['00-src/60-reference/20-tafukt.md'],
);
check('an empty answer parses to nothing', parsePageNames('   '), []);

// --- what is refused --------------------------------------------------------
check('a name that is on no list is dropped', resolveCandidate('invented-note.md', candidates), null);
check('an empty answer is dropped', resolveCandidate('   ', candidates), null);
check('prose about a name is not a name', resolveCandidate('I think it is in the Lisa folder', candidates), null);
check('repeats are listed once', resolveCandidates(['20-tafukt.md', '- 20-tafukt.md'], candidates), ['00-src/60-reference/20-tafukt.md']);
check('and the unusable answers vanish from the list', resolveCandidates(['invented.md', '20-tafukt.md'], candidates), ['00-src/60-reference/20-tafukt.md']);

if (failed > 0) {
  console.error(`\n${failed} of ${total} suggestion checks failed.`);
  process.exit(1);
}
console.log('\nsuggestion checks passed.');
