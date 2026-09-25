/**
 * Path-normalisation tests. Run with: npm test
 *
 * The first cases are the bug this module exists for: the model returning a
 * path that already contains the wiki folder must not produce
 * `20-wiki/20-wiki/...`.
 */
import assert from 'node:assert/strict';
import { normalizeVaultPath } from '../src/paths';

const WIKI = { baseDir: '20-wiki', ensureMd: true };

const cases: Array<[string, string | null, object]> = [
  // --- the double-prefix bug ---
  ['20-wiki/02-tamazight/foo', '02-tamazight/foo.md', WIKI],
  ['20-wiki/20-wiki/02-lisa/sargantana.md', '02-lisa/sargantana.md', WIKI],
  ['20-wiki/20-wiki/20-wiki/x.md', 'x.md', WIKI],
  // --- model decoration ---
  ['[20-wiki/02-tamazight/foo.md]', '02-tamazight/foo.md', WIKI],
  ['"02-tamazight/foo.md"', '02-tamazight/foo.md', WIKI],
  ['`02-tamazight/foo.md`', '02-tamazight/foo.md', WIKI],
  // --- slashes, dots, spaces ---
  ['/20-wiki/foo.md', 'foo.md', WIKI],
  ['./02-tamazight/foo.md', '02-tamazight/foo.md', WIKI],
  ['20-wiki\\02-tamazight\\foo.md', '02-tamazight/foo.md', WIKI],
  ['20-wiki//02-tamazight//foo.md', '02-tamazight/foo.md', WIKI],
  ['  02-tamazight/foo.md  ', '02-tamazight/foo.md', WIKI],
  // --- extension is only added when asked ---
  ['20-wiki/02-tamazight/foo.md', '02-tamazight/foo.md', WIKI],
  ['02-tamazight/foo', '02-tamazight/foo', {}],
  // --- refusals ---
  ['../outside.md', null, WIKI],
  ['20-wiki/../../outside.md', null, WIKI],
  ['', null, WIKI],
  ['20-wiki', null, WIKI],
  ['20-wiki/', null, WIKI],
];

let failed = 0;
for (const [input, expected, opts] of cases) {
  const got = normalizeVaultPath(input, opts);
  try {
    assert.strictEqual(got, expected);
    console.log(`  ok   ${JSON.stringify(input)} -> ${JSON.stringify(got)}`);
  } catch {
    failed++;
    console.error(`  FAIL ${JSON.stringify(input)} -> ${JSON.stringify(got)} (expected ${JSON.stringify(expected)})`);
  }
}

if (failed > 0) {
  console.error(`\n${failed} of ${cases.length} path checks failed.`);
  process.exit(1);
}
console.log(`\n${cases.length}/${cases.length} path checks passed.`);
