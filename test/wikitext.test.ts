/**
 * Wiki-text tests. Run with: npm test
 *
 * These cover the rules the checker and the cleaner are built on: how a link is
 * read (alias and heading kept), when two names are "the same thing", and what
 * counts as a leftover of the model's own process. A mistake here is a wrong
 * report or an automatic repair that rewrites text it should not touch.
 */
import assert from 'node:assert/strict';
import {
  closestTitle,
  detectArtifacts,
  editDistance,
  firstHeading,
  firstSentence,
  frontmatterList,
  hoistFencedFrontmatter,
  humanTitle,
  linkTarget,
  mapWikilinks,
  splitFrontmatter,
  stripArtifacts,
  titleKey,
  wikilinkTargets,
} from '../src/wikitext';

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

// ------------------------------------------------------------------ frontmatter
const withFrontmatter = splitFrontmatter('---\ntipo: concepto\ntags: [a, b]\nfuentes: ["[[00 - Lisa]]"]\n---\n# Título\n\ncuerpo\n');
check('frontmatter is separated from the body', withFrontmatter.body.trim(), '# Título\n\ncuerpo');
check('keys are read', withFrontmatter.keys['tipo'], 'concepto');
check('an inline list is read', frontmatterList(withFrontmatter, 'tags'), ['a', 'b']);
check('a quoted wikilink keeps its brackets', frontmatterList(withFrontmatter, 'fuentes'), ['[[00 - Lisa]]']);
check('a missing key is an empty list', frontmatterList(withFrontmatter, 'nope'), []);

const noFrontmatter = splitFrontmatter('# Solo cuerpo\n');
check('a file without frontmatter is all body', [noFrontmatter.frontmatter, noFrontmatter.body], [null, '# Solo cuerpo\n']);

const midFile = splitFrontmatter('texto\n\n---\n\ntipo: concepto\n');
check('a `---` further down is a rule, not frontmatter', midFile.frontmatter, null);

const unterminated = splitFrontmatter('---\ntipo: concepto\n');
check('an unclosed block is not frontmatter', unterminated.frontmatter, null);

const blockList = splitFrontmatter('---\nfuentes:\n  - "[[a]]"\n  - "[[b]]"\n---\ncuerpo\n');
check('a `- item` block is read too', frontmatterList(blockList, 'fuentes'), ['[[a]]', '[[b]]']);

// --------------------------------------------------------------------- links
check('a plain link', wikilinkTargets('ver [[modelo-lisa]]'), ['modelo-lisa']);
check('an alias is not part of the target', wikilinkTargets('ver [[modelo-lisa|Modelo Lisa]]'), ['modelo-lisa']);
check('a heading is not part of the target', wikilinkTargets('ver [[modelo-lisa#Parte]]'), ['modelo-lisa']);
check('nor when both are present', wikilinkTargets('ver [[modelo-lisa#Parte|alias]]'), ['modelo-lisa']);
check('every link is returned, duplicates included', wikilinkTargets('[[a]] y [[a]] y [[b]]'), ['a', 'a', 'b']);
check('an empty link is ignored', wikilinkTargets('[[]] y [[a]]'), ['a']);

check('retargeting keeps the alias', mapWikilinks('ver [[viejo|El Viejo]]', () => 'nuevo'), 'ver [[nuevo|El Viejo]]');
check('retargeting keeps the heading', mapWikilinks('ver [[viejo#Parte]]', () => 'nuevo'), 'ver [[nuevo#Parte]]');
check('retargeting keeps heading and alias', mapWikilinks('ver [[viejo#Parte|alias]]', () => 'nuevo'), 'ver [[nuevo#Parte|alias]]');
check('returning null leaves the link alone', mapWikilinks('ver [[viejo]]', () => null), 'ver [[viejo]]');
check('links the callback ignores are untouched', mapWikilinks('[[a]] y [[b]]', t => (t === 'b' ? 'c' : null)), '[[a]] y [[c]]');

// ------------------------------------------------------------------ comparing
check('accents, case and separators stop mattering', titleKey('Metodología de Verificación'), titleKey('metodologia-de-verificacion'));
check('the extension is dropped', titleKey('modelo-lisa.md'), titleKey('modelo-lisa'));
check('different names stay different', titleKey('pipeline') === titleKey('pipeline-datos'), false);
check('the first heading of a body', firstHeading('texto\n\n## Parte\n'), 'Parte');
check('a file name becomes readable', humanTitle('01-lisa/modelo-lisa.md'), 'modelo lisa');

check('a short distance', editDistance('plasma', 'plasma6', 2), 1);
check('a distance beyond the limit is not measured further', editDistance('pipeline', 'pipelinededatos', 2), 3);

check('a typo is matched', closestTitle('metodologia-de-verificacion', ['metodologia-verificacion']), 'metodologia-verificacion');
check('an exact name is not a candidate for itself', closestTitle('modelo-lisa', ['modelo-lisa']), null);
check('two equally close names mean no suggestion', closestTitle('plasma', ['plasma5', 'plasma6']), null);
check('nothing close means no suggestion', closestTitle('soporte', ['modelo-lisa', 'sbbclock']), null);
check('a path target is compared as written, so it gets no suggestion', closestTitle('02-tamazight/verbo', ['verbo-ili']), null);
// The over-eager repair this rule exists to stop: two edits between a wiki name
// and an unrelated file that happens to live in a sandbox folder.
check('a short name is not stretched into a different one', closestTitle('plasmoids', ['20-plasmoids']), null);

// ------------------------------------------------------------------ artefacts
const preamble = [
  '# Índice',
  '',
  '```',
  'created: 2026-04-13T16:54',
  'updated: 2026-09-01T15:45 --> 2026-09-01T16:00 (or current datetime)',
  '```',
  '',
  '## Sección',
].join('\n');
const preambleArtifacts = detectArtifacts(preamble);
check('a top block holding a duplicated frontmatter is one leftover', preambleArtifacts.length, 1);
check('and it is fixable', [preambleArtifacts[0]?.kind, preambleArtifacts[0]?.fixable], ['preamble-block', true]);
const preambleStripped = stripArtifacts(preamble);
check('stripping removes the block', preambleStripped.content.includes('```'), false);
check('and keeps the rest', preambleStripped.content, '# Índice\n\n## Sección\n');

// The marker a model leaves is the tail of an instruction, not any `-->`:
// a bare one is ordinary text and must be left alone.
const dangling = '# Nota\n\nUn texto.\n\n--> 2026-09-01\n\nMás texto.\n';
check('a dangling marker is found', detectArtifacts(dangling).map(a => a.kind), ['dangling-marker']);
check('and removed', stripArtifacts(dangling).content, '# Nota\n\nUn texto.\n\nMás texto.\n');
check('a bare `-->` is ordinary text', detectArtifacts('# Nota\n\n-->\n').length, 0);
check('a real comment marker is not a leftover', detectArtifacts('# Nota\n\n<!-- tc:start -->\n\nTareas\n').length, 0);
check('a task-consolidator marker survives stripping', stripArtifacts('<!-- tc:start -->\n\n- [ ] algo\n').content, '<!-- tc:start -->\n\n- [ ] algo\n');

const empty = detectArtifacts('---\ntipo: concepto\n---\n');
check('an empty page is reported', empty.map(a => a.kind), ['empty-page']);
check('but it is not fixed automatically', empty[0]?.fixable, false);

const duplicated = detectArtifacts('---\ntipo: concepto\n---\n---\ncreated: 2026-01-01\n---\n# Nota\n');
check('a second frontmatter block is reported', duplicated.map(a => a.kind), ['duplicate-frontmatter']);
check('and left for a human, not removed', duplicated[0]?.fixable, false);

// Frontmatter that ended up inside a code block is the only copy of those keys:
// it is reported, never removed.
const fencedMetadata = [
  '---',
  'created: 2026-04-15T10:10',
  'updated: 2026-04-15T10:29',
  '---',
  '```yaml',
  'tipo: metodo',
  'fuentes: ["[[90-support]]"]',
  '```',
  '# Sargantana',
].join('\n');
const fencedFound = detectArtifacts(fencedMetadata);
check('metadata inside a code block is reported as such', fencedFound.map(a => a.kind), ['fenced-metadata']);
check('and not marked as fixable', fencedFound[0]?.fixable, false);
check('so stripping leaves it alone', stripArtifacts(fencedMetadata).content, fencedMetadata);

// A fence that runs to the end of the page is the page wrapped in a block, not a
// leftover: cutting it out would delete the page.
const wrapped = ['# Índice', '', '```', '- [[a]]', '- [[b]]', '```'].join('\n');
check('a block wrapping the page is not treated as a leftover', detectArtifacts(wrapped).map(a => a.kind), []);

// ------------------------------------------- metadata that arrived in a fence
//
// The reformatting pass asks the model to rewrite its own document, and it keeps
// the ```yaml fence it wrote it in. The page then reads well and the wiki cannot
// see a single key of it — no `tipo` in the index, no `fuentes` for the checker.
const fencedPage = [
  '```yaml',
  'tags: [lisa, arquitectura]',
  'tipo: concepto',
  'fuentes: ["[[Comments and ideas concerning Lisa]]"]',
  '```',
  '',
  '# Arquitectura de Lisa',
  '',
  'El modelo se organiza en bloques.',
].join('\n');
check(
  'metadata inside a fence becomes real frontmatter',
  hoistFencedFrontmatter(fencedPage),
  [
    '---',
    'tags: [lisa, arquitectura]',
    'tipo: concepto',
    'fuentes: ["[[Comments and ideas concerning Lisa]]"]',
    '---',
    '# Arquitectura de Lisa',
    '',
    'El modelo se organiza en bloques.',
    '',
  ].join('\n'),
);

const multiLine = ['```yaml', 'tags:', '  - lisa', '  - csrs', 'tipo: concepto', '```', '# CSRs'].join('\n');
check(
  'an indented list travels with its key',
  hoistFencedFrontmatter(multiLine),
  ['---', 'tags:', '  - lisa', '  - csrs', 'tipo: concepto', '---', '# CSRs', ''].join('\n'),
);

const withCreated = [
  '---',
  'created: 2026-09-15T22:33',
  'tags: [viejo]',
  '---',
  '```yaml',
  'tags: [nuevo]',
  'tipo: concepto',
  '```',
  '# Título',
].join('\n');
check(
  'a key the page already declares keeps its value, and the fence goes',
  hoistFencedFrontmatter(withCreated),
  ['---', 'created: 2026-09-15T22:33', 'tags: [viejo]', 'tipo: concepto', '---', '# Título', ''].join('\n'),
);

// A duplicated fence over an identical frontmatter is only removed.
const fencedDuplicate = ['---', 'tipo: concepto', '---', '```yaml', 'tipo: concepto', '```', '# Título'].join('\n');
check(
  'a purely duplicated fence is dropped, not merged twice',
  hoistFencedFrontmatter(fencedDuplicate),
  ['---', 'tipo: concepto', '---', '# Título', ''].join('\n'),
);

// --- and what must be left exactly as it is ---------------------------------
const correct = ['---', 'tipo: concepto', '---', '# Título', '', 'Cuerpo.'].join('\n');
check('a page that is already right is untouched', hoistFencedFrontmatter(correct), correct);

const codeSample = ['```cpp', 'int main() {', '  return 0;', '}', '```', '', '# Título'].join('\n');
check('a code sample at the top is not frontmatter', hoistFencedFrontmatter(codeSample), codeSample);

const pythonSample = ['```python', 'def f():', '    return 1', '```', '# Título'].join('\n');
check('nor is a Python one', hoistFencedFrontmatter(pythonSample), pythonSample);

const laterFence = ['# Título', '', '```yaml', 'tipo: concepto', '```'].join('\n');
check('a fence further down belongs to the body', hoistFencedFrontmatter(laterFence), laterFence);

const wrappedPage = ['```', '- [[a]]', '- [[b]]', '```'].join('\n');
check(
  'a block wrapping the whole page is not metadata',
  hoistFencedFrontmatter(wrappedPage),
  wrappedPage,
);

// --------------------------------------------------------------- the opening
// What the index shows of each page, so a selection can be made by content and
// not by title alone. The fixture is the real opening of a real page.
const lisaOpening = [
  '---',
  'tipo: concepto',
  '---',
  '# Arquitectura de Lisa',
  '',
  'El modelo Lisa es una arquitectura de procesador basada en bloques genéricos que representan la estructura de un procesador, diferenciándose de los esquemas tradicionales de dos bloques (*Datapath* y *Control Unit*).',
].join('\n');
check(
  'the opening is the first prose line, markdown out',
  firstSentence(splitFrontmatter(lisaOpening).body, 1000),
  'El modelo Lisa es una arquitectura de procesador basada en bloques genéricos que representan la estructura de un procesador, diferenciándose de los esquemas tradicionales de dos bloques (Datapath y Control Unit).',
);
check(
  'a heading is not the opening',
  firstSentence('# Título\n\nLos CSRs se modelan con máscaras.', 1000),
  'Los CSRs se modelan con máscaras.',
);
check(
  'a code block is skipped, not the end of the search',
  firstSentence('```c++\nint x = 1;\n```\n\nEl modelo es una descripción de hardware.', 1000),
  'El modelo es una descripción de hardware.',
);
check(
  'a wikilink is shown by its text',
  firstSentence('Enlaza con [[pipeline-de-datos|el pipeline]].', 1000),
  'Enlaza con el pipeline.',
);
check(
  'a long opening is cut at a word',
  firstSentence(`${'palabra '.repeat(40)}`, 40),
  'palabra palabra palabra palabra palabra…',
);
check('a page with no prose has no opening', firstSentence('# Título\n'), null);

// ------------------------------------------------------------ frontmatter links
check('a bracketed source is unwrapped', linkTarget('[[00 - Lisa]]'), '00 - Lisa');
check('an alias is not part of it', linkTarget('[[verbo-ili|El verbo]]'), 'verbo-ili');
check('nor a heading', linkTarget('[[verbo-ili#Formas]]'), 'verbo-ili');
check('a bare value is left as it is', linkTarget('00 - Lisa'), '00 - Lisa');

if (failed > 0) {
  console.error(`\n${failed} wiki-text check(s) failed.`);
  process.exit(1);
}
console.log('\nwiki-text checks passed.');
