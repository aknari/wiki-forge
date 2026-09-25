/**
 * Protocol tests. Run with: npm test
 *
 * Two things live here: reading the pages out of an answer, and telling apart the
 * two ways an answer produces no page at all. Every case is a shape a model
 * actually produced — including the ones that must NOT be mistaken for a page,
 * which is how a file called `ruta/al/archivo.md` holding the word `[texto]` was
 * once written into a wiki.
 */
import assert from 'node:assert/strict';
import { classifyEmptyAnswer, emptyAnswerMessage, parseFileBlocks } from '../src/protocol';

let failed = 0;
const check = (desc: string, got: unknown, expected: unknown): void => {
  try {
    assert.deepStrictEqual(got, expected);
    console.log(`  ok   ${desc}`);
  } catch {
    failed += 1;
    console.error(`  FAIL ${desc}\n       got ${JSON.stringify(got)} (expected ${JSON.stringify(expected)})`);
  }
};

// --- an answer that is prose -----------------------------------------------------
check(
  'prose with no markers is the model ignoring the protocol',
  classifyEmptyAnswer('Lo siento, no puedo generar el contenido que pides.'),
  'no-markers',
);
check('an empty answer is the same case', classifyEmptyAnswer(''), 'no-markers');
check(
  'a markdown code fence around prose does not count as markers',
  classifyEmptyAnswer('```\nHe resumido la nota así: Lisa es un procesador.\n```'),
  'no-markers',
);

// --- an answer that tried and missed ---------------------------------------------
check(
  'a marker with no space is not a block either',
  classifyEmptyAnswer('FILE:notas-de-lisa.md\nCONTENIDO: ...'),
  'unusable-block',
);
// The one line that separates the two reasons: `processOutput` looks for
// `FILE: ` with the space, so this answer produces nothing AND had a marker.
check(
  'one marker is enough to call it a protocol attempt',
  classifyEmptyAnswer('FILE: 00-Desarrollo.md\nCONTENT:\n\n---END---'),
  'unusable-block',
);
check(
  'a marker buried in the middle still counts',
  classifyEmptyAnswer('Aquí tienes:\n\nFILE: x.md\nCONTENT: hola\n---END---\n\nEspero que sirva.'),
  'unusable-block',
);

// --- the wording -----------------------------------------------------------------
// The panel says this where it used to claim "the note added nothing new", which
// was never true of this case: `processOutput` writes any parsed page whether or
// not its text differs, so a zero count always means nothing was parsed.
check(
  'the no-marker message names the protocol and the note stays pending',
  emptyAnswerMessage('no-markers').includes('did not follow the protocol') &&
    emptyAnswerMessage('no-markers').includes('not marked as done'),
  true,
);
check(
  'it also names the two usual causes, both of them actionable',
  emptyAnswerMessage('no-markers').includes('small') && emptyAnswerMessage('no-markers').includes('context window'),
  true,
);
check(
  'the malformed message does not blame the model',
  emptyAnswerMessage('unusable-block').includes('did not follow the protocol'),
  false,
);
check(
  'and both say the note stays pending, which is what the state now does',
  emptyAnswerMessage('no-markers').includes('next sync') && emptyAnswerMessage('unusable-block').includes('next sync'),
  true,
);

// --- reading the pages out of an answer ------------------------------------------
// The answer a local model gave, verbatim, once the output contract was in the
// prompt. The `20-wiki/` prefix stays: stripping it is `normalizeVaultPath`'s job.
const GOOD_ANSWER =
  'FILE: 20-wiki/00-indice/indice-teoria-practica.md\nCONTENT:\n---\ntipo: concepto\n---\n# Teoría\n# Prácticas\n---END---';
check('a real answer is one page', parseFileBlocks(GOOD_ANSWER), [
  { path: '20-wiki/00-indice/indice-teoria-practica.md', text: '---\ntipo: concepto\n---\n# Teoría\n# Prácticas' },
]);
// The old reader split on `FILE: ` and took everything up to the end, so the
// second page ended up glued to the first.
check(
  'two pages stay two, and the first does not swallow the second',
  parseFileBlocks('FILE: a.md\nCONTENT:\nprimera\n---END---\nFILE: b.md\nCONTENT:\nsegunda\n---END---'),
  [
    { path: 'a.md', text: 'primera' },
    { path: 'b.md', text: 'segunda' },
  ],
);
check(
  'the format quoted back is not a page',
  parseFileBlocks(
    'Quedo a la espera de que proporciones el contenido bajo el formato:\n`FILE: [ruta/al/archivo.md] CONTENT: [texto] ---END---`',
  ),
  [],
);
check(
  'nor is the whole template on a line of its own',
  parseFileBlocks('FILE: [ruta/al/archivo.md] CONTENT: [texto] ---END---'),
  [],
);
check(
  'a code fence around the answer is fine',
  parseFileBlocks('```\nFILE: a.md\nCONTENT:\ncontenido\n---END---\n```'),
  [{ path: 'a.md', text: 'contenido' }],
);
check('a block with no CONTENT: line is dropped, not guessed at', parseFileBlocks('FILE: a.md\ncontenido suelto\n---END---'), []);
check('an empty body never blanks a page', parseFileBlocks('FILE: a.md\nCONTENT:\n\n---END---'), []);
check('the last page may go without ---END---', parseFileBlocks('FILE: a.md\nCONTENT:\ncontenido'), [
  { path: 'a.md', text: 'contenido' },
]);
check(
  'prose after ---END--- is not part of the page',
  parseFileBlocks('FILE: a.md\nCONTENT:\ncontenido\n---END---\nHe hecho lo que pedías.'),
  [{ path: 'a.md', text: 'contenido' }],
);
check(
  'blank lines between the path and CONTENT: are tolerated',
  parseFileBlocks('FILE: a.md\n\nCONTENT:\ncontenido\n---END---'),
  [{ path: 'a.md', text: 'contenido' }],
);
check(
  'a path with a space is still a page: losing it would be worse',
  parseFileBlocks('FILE: 02-lisa/concepto lisa.md\nCONTENT:\nx\n---END---'),
  [{ path: '02-lisa/concepto lisa.md', text: 'x' }],
);

// --- the paths a draft names, which decide whether there is a merge to do ---------
// The second pass only runs for the pages named here that already exist, so this
// is the reading that keeps the wiki accumulating instead of being overwritten.
check(
  'the paths of a draft are the pages it wrote',
  parseFileBlocks(GOOD_ANSWER).map(block => block.path),
  ['20-wiki/00-indice/indice-teoria-practica.md'],
);
check('an answer with no page names nothing, so nothing is merged', parseFileBlocks('Lo siento, no puedo.'), []);
check(
  'and the quoted format names nothing either',
  parseFileBlocks('FILE: [ruta/al/archivo.md] CONTENT: [texto] ---END---'),
  [],
);

if (failed > 0) {
  console.error(`\n${failed} protocol check(s) failed.`);
  process.exit(1);
}
console.log('\nAll protocol checks passed.');
