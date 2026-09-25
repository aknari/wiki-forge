/**
 * Source-selection tests. Run with: npm test
 *
 * These cover the rules that decide the *input* of the sync: several source
 * folders, the exclusion list applied inside each of them, and the optional
 * journal. A file that slips in here is a file the model will distil, so the
 * cases below are the ones that keep the wiki clean.
 */
import assert from 'node:assert/strict';
import { DEFAULT_SETTINGS, migrateSettings } from '../src/settings';
import { isSourcePath, sourceRelativePath } from '../src/sources';

const rules = (srcDirs: string[], excludedDirs: string[] = DEFAULT_SETTINGS.excludedDirs) => ({
  srcDirs,
  journalDir: '10-journal',
  excludedDirs,
});

const cases: Array<[string, string, boolean, object, boolean]> = [
  // [descripción, ruta, includeJournal, ajustes, ¿es fuente?]
  ['a note inside the single source folder', '00-src/40-work/nota.md', false, rules(['00-src']), true],
  ['a note in a second source folder', '01-inbox/idea.md', false, rules(['00-src', '01-inbox']), true],
  ['the second folder is not a source when it is not configured', '01-inbox/idea.md', false, rules(['00-src']), false],
  ['a folder that only starts with the root name is not inside it', '00-src-other/nota.md', false, rules(['00-src']), false],
  ['the root itself is not a file', '00-src', false, rules(['00-src']), false],
  ['a trailing slash in the setting is harmless', '00-src/a.md', false, rules(['00-src/']), true],
  ['an empty line in the list is ignored', '01-inbox/a.md', false, rules(['', '  ', '01-inbox']), true],
  ['an excluded segment is skipped in the only root', '00-src/90-store/viejo.md', false, rules(['00-src']), false],
  ['the same excluded segment is skipped in the second root', '01-inbox/90-store/viejo.md', false, rules(['00-src', '01-inbox']), false],
  ['an excluded name is only excluded as a whole segment', '00-src/90-store-old/ok.md', false, rules(['00-src']), true],
  ['the journal is out unless it is enabled', '10-journal/daily notes/2026-09-10.md', false, rules(['00-src']), false],
  ['the journal is in when enabled', '10-journal/daily notes/2026-09-10.md', true, rules(['00-src']), true],
  ['the journal is not filtered by the source exclusions', '10-journal/90-store/nota.md', true, rules(['00-src']), true],
  ['nested roots still count once', '00-src/50-sandbox/x.md', false, rules(['00-src', '00-src/50-sandbox']), true],
  ['an empty source list ingests nothing', '00-src/a.md', false, rules([]), false],
  ['another plugin folder is untouched', '80-support/operon/docs/a.md', true, rules(['00-src']), false],
];

let failed = 0;
for (const [desc, path, includeJournal, settings, expected] of cases) {
  const got = isSourcePath(path, settings as never, includeJournal);
  try {
    assert.strictEqual(got, expected);
    console.log(`  ok   ${desc}`);
  } catch {
    failed += 1;
    console.error(`  FAIL ${desc}\n       ${path} -> ${got} (expected ${expected})`);
  }
}

// The relative path is what the exclusion list is matched against, so it must
// be relative to *the root that contains the file*, not to the first one.
const relatives: Array<[string, string, string[]]> = [
  ['relative to the matching root', '01-inbox/90-store/a.md', ['00-src', '01-inbox']],
  ['and only when it is inside one', '20-wiki/a.md', ['00-src', '01-inbox']],
];
for (const [desc, path, srcDirs] of relatives) {
  const got = sourceRelativePath(path, srcDirs);
  const expected = path.startsWith('20-wiki/') ? null : '90-store/a.md';
  try {
    assert.strictEqual(got, expected);
    console.log(`  ok   ${desc}`);
  } catch {
    failed += 1;
    console.error(`  FAIL ${desc}\n       ${path} -> ${JSON.stringify(got)}`);
  }
}

// data.json written by the previous version (a single `srcDir`) must keep its
// folder, and a modern one must be left alone.
const migrated = migrateSettings({ srcDir: '01-inbox', wikiDir: '20-wiki' });
const modern = migrateSettings({ srcDirs: ['00-src', '01-inbox'] });
const broken = migrateSettings({ srcDirs: [] });
const empty = migrateSettings(null);
const migrations: Array<[string, unknown, unknown]> = [
  ['an old srcDir becomes a one-folder list', migrated.srcDirs, ['01-inbox']],
  ['the stale key is dropped', (migrated as Record<string, unknown>).srcDir, undefined],
  ['a modern list is respected as it is', modern.srcDirs, ['00-src', '01-inbox']],
  ['an empty list falls back to the default', broken.srcDirs, ['00-src']],
  ['no data at all falls back to the default', empty.srcDirs, ['00-src']],
];
for (const [desc, got, expected] of migrations) {
  try {
    assert.deepStrictEqual(got, expected);
    console.log(`  ok   ${desc}`);
  } catch {
    failed += 1;
    console.error(`  FAIL ${desc}\n       got ${JSON.stringify(got)} (expected ${JSON.stringify(expected)})`);
  }
}

const total = cases.length + relatives.length + migrations.length;
if (failed > 0) {
  console.error(`\n${failed} of ${total} source checks failed.`);
  process.exit(1);
}
console.log(`\n${total}/${total} source checks passed.`);
