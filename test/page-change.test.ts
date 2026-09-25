/**
 * Page-change tests. Run with: npm test
 *
 * The three cases below are the real merges of `20-wiki/04-lisa`, copied from the
 * vault's git history: the ingest that came back with the page untouched, the one
 * that only fixed a typo, and the sentence the wiki was missing. They are the
 * reason the threshold is where it is, so they are the tests that matter.
 */
import assert from 'node:assert/strict';
import {
  addedStatements,
  pageChange,
  statementResemblance,
  statementSimilarity,
  statementsOf,
  statementTokens,
} from '../src/page-change';

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

// ------------------------------------------------------------------- splitting
check(
  'the frontmatter is not a statement',
  statementsOf('---\ntipo: concepto\nupdated: 2026-09-17T23:37\n---\n# Título\n\nEl modelo Lisa es un procesador.\n'),
  ['El modelo Lisa es un procesador.'],
);
check(
  'a code fence is skipped, fence markers included',
  statementsOf('# T\n\n```c++\nint x = 1;\n```\n\nLos CSRs se modelan con máscaras.\n'),
  ['Los CSRs se modelan con máscaras.'],
);
check(
  'a bullet is one statement',
  statementsOf('- Decidir qué instrucción debe ejecutarse a continuación.\n'),
  ['- Decidir qué instrucción debe ejecutarse a continuación.'],
);

// ------------------------------------------------------------------- similarity
check('a word repeated is not a statement', statementTokens('lisa lisa LISA'), ['lisa']);
check('`C++` survives as one word', statementTokens('se compila con C++ y gcc'), ['compila', 'con', 'c++', 'gcc']);
check('identical statements score 1', statementSimilarity(['lisa', 'procesador'], ['lisa', 'procesador']), 1);
check('disjoint statements score 0', statementSimilarity(['lisa', 'procesador'], ['plasmoides', 'kde']), 0);

// -------------------------------------------------- case 1: the page as it was
// `lisa-architecture-overview.md` came back byte for byte from the 23:37 merge.
const architecture = [
  '# Arquitectura de Lisa',
  '',
  'El modelo Lisa es una arquitectura de procesador basada en bloques genéricos que representan la estructura de un procesador, diferenciándose de los esquemas tradicionales de dos bloques (*Datapath* y *Control Unit*).',
  '',
  'La organización de Lisa introduce un elemento crítico: **Instructions Control & Dispatcher**.',
].join('\n');
check('a page that came back as it was adds nothing', addedStatements(architecture, architecture), []);
check(
  'and a re-stamped frontmatter still counts as nothing',
  addedStatements(architecture, `---\nupdated: 2026-09-18T00:10\n---\n${architecture}`),
  [],
);

// ------------------------------------------------- case 2: the typo-only merge
// `lisa-trap-management.md`: the two lines the model edited, and nothing else.
const trapBefore = 'En el contexto de RISC-V, la habilitación de interrupciones depende del modo de privilegio actual:\n- **Habilitación individual**:\n    dove-mode M: `MIE`.\n';
const trapAfter = 'En el contexto RISC-V, la habilitación de interrupciones depende del modo de privilegio actual:\n- **Habilitación individual**:\n    - Modo M: `MIE`.\n';
check('fixing a wording is not adding a statement', addedStatements(trapBefore, trapAfter), []);

// ------------------------------------------- case 3: the statement that mattered
// The sentence the source note carries and the page did not.
const missing = 'Lisa es un modelo de procesador RISC-V desarrollado en C++ con la intención de servir como una descripción de hardware que pueda ser compatible con herramientas de síntesis de alto nivel (HLS), además de funcionar como un simulador.';
const added = addedStatements(architecture, `${architecture}\n\n${missing}`);
check('the statement the wiki was missing is reported', added, [missing]);

// ------------------------------------------------------ the threshold, measured
// The three real pairs, on both scales, which is what puts the threshold at 0.7.
const opening = architecture.split('\n')[2] ?? '';
// `dove-mode M: MIE.` → `- Modo M: MIE.`: 0.80 on letters, 0.40 on words.
check(
  'a re-rendered line is the same statement',
  statementResemblance(trapBefore.split('\n')[2] ?? '', trapAfter.split('\n')[2] ?? '') >= 0.7,
  true,
);
check(
  'and words alone would have called it new content',
  statementSimilarity(
    statementTokens(trapBefore.split('\n')[2] ?? ''),
    statementTokens(trapAfter.split('\n')[2] ?? ''),
  ) < 0.7,
  true,
);
// `…contexto de RISC-V…` → `…contexto RISC-V…`: 1.00 on both.
check(
  'a fixed wording is the same statement',
  statementResemblance(trapBefore.split('\n')[0] ?? '', trapAfter.split('\n')[0] ?? '') >= 0.7,
  true,
);
check(
  'the missing fact is not, on either scale',
  statementResemblance(missing, opening) < 0.7 && statementSimilarity(statementTokens(missing), statementTokens(opening)) < 0.7,
  true,
);

// ------------------------------------------------------------- created pages
check('a created page is flagged as created', pageChange(null, architecture).created, true);
check('and its text is not listed as added', pageChange(null, architecture).added, []);

if (failed > 0) {
  console.error(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log('\npage-change: all checks passed');
