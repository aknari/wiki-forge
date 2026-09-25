/**
 * Reset-planning tests. Run with: npm test
 *
 * This is the one command in the plugin that deletes pages, so the cases here
 * are the two ways a reset goes wrong. Deleting too much takes the saved answers
 * with it, and an answer cannot be regenerated without asking the question again.
 * Deleting too little is worse in a quieter way: the state is cleared anyway, so
 * the wiki reports being up to date over pages it never rebuilt.
 *
 * The planning is pure precisely so these can be exercised without a vault.
 */
import assert from 'node:assert/strict';
import { planReset, type ResetOptions } from '../src/wiki-reset';

const MAINTAINED = ['index.md', 'log.md'];

const PAGES = [
  'index.md',
  'log.md',
  'queries/2026-09-16-1007.md',
  'queries/2026-09-17-1122.md',
  '04-lisa/lisa-architecture-overview.md',
  '04-lisa/lisa-csrs-modelling.md',
  '03-plasma/i18n-workflow.md',
];

const KNOWLEDGE = [
  '03-plasma/i18n-workflow.md',
  '04-lisa/lisa-architecture-overview.md',
  '04-lisa/lisa-csrs-modelling.md',
];

const ANSWERS = ['queries/2026-09-16-1007.md', 'queries/2026-09-17-1122.md'];

interface Case {
  label: string;
  pages?: string[];
  options: ResetOptions;
  remove: string[];
  keep: string[];
}

const cases: Case[] = [
  {
    label: 'keeps the saved answers and the pages the plugin maintains',
    options: { maintained: MAINTAINED, answersFolder: 'queries' },
    remove: KNOWLEDGE,
    keep: ['index.md', 'log.md', ...ANSWERS],
  },
  {
    label: 'a null answers folder means the answers go too',
    options: { maintained: MAINTAINED, answersFolder: null },
    remove: [...ANSWERS, ...KNOWLEDGE].sort(),
    keep: ['index.md', 'log.md'],
  },
  {
    // The empty string is "no answers folder inside the wiki" everywhere else in
    // the plugin. Read as a folder name it would match nothing, and read as a
    // prefix it would match every page — so it is refused instead of guessed at.
    label: 'an empty answers folder does not protect the whole wiki',
    options: { maintained: MAINTAINED, answersFolder: '' },
    remove: [...ANSWERS, ...KNOWLEDGE].sort(),
    keep: ['index.md', 'log.md'],
  },
  {
    label: 'a nested answers folder is kept whole',
    pages: ['a/queries/x.md', 'a/queries/deep/y.md', 'b/z.md'],
    options: { maintained: MAINTAINED, answersFolder: 'a/queries' },
    remove: ['b/z.md'],
    keep: ['a/queries/deep/y.md', 'a/queries/x.md'],
  },
  {
    label: 'a page whose name merely starts with the folder name is not an answer',
    pages: ['queries-old.md', 'queries/real.md'],
    options: { maintained: MAINTAINED, answersFolder: 'queries' },
    remove: ['queries-old.md'],
    keep: ['queries/real.md'],
  },
  {
    label: 'a same-named folder elsewhere is not the answers folder',
    pages: ['queries/a.md', 'sub/queries/b.md'],
    options: { maintained: MAINTAINED, answersFolder: 'queries' },
    remove: ['sub/queries/b.md'],
    keep: ['queries/a.md'],
  },
  {
    label: 'paths are normalised before they are compared',
    pages: ['/04-lisa\\overview.md', './index.md'],
    options: { maintained: MAINTAINED, answersFolder: null },
    remove: ['04-lisa/overview.md'],
    keep: ['index.md'],
  },
  {
    label: 'an empty folder plans nothing at all',
    pages: [],
    options: { maintained: MAINTAINED, answersFolder: 'queries' },
    remove: [],
    keep: [],
  },
  {
    label: 'empty and root-only paths are skipped instead of deleted',
    pages: ['', '/', '04-lisa/real.md'],
    options: { maintained: MAINTAINED, answersFolder: null },
    remove: ['04-lisa/real.md'],
    keep: [],
  },
];

let failed = 0;
for (const c of cases) {
  const plan = planReset(c.pages ?? PAGES, c.options);
  const remove = [...plan.remove].sort();
  const keep = plan.keep.map(entry => entry.path).sort();
  try {
    assert.deepStrictEqual(remove, [...c.remove].sort());
    assert.deepStrictEqual(keep, [...c.keep].sort());
    console.log(`  ok   ${c.label}`);
  } catch (e) {
    failed++;
    console.error(`  FAIL ${c.label} — ${e instanceof Error ? e.message : String(e)}`);
    console.error(`        removed ${JSON.stringify(remove)}`);
    console.error(`        kept    ${JSON.stringify(keep)}`);
  }
}

// The reasons travel with the kept paths: the modal says which is which, and
// "the plugin rewrites this anyway" reads very differently from "this is yours".
const withBoth = planReset(PAGES, { maintained: MAINTAINED, answersFolder: 'queries' });
const reasonOf = (path: string): string | undefined =>
  withBoth.keep.find(entry => entry.path === path)?.reason;

try {
  assert.strictEqual(reasonOf('index.md'), 'maintained');
  assert.strictEqual(reasonOf('queries/2026-09-16-1007.md'), 'answers');
  assert.strictEqual(reasonOf('04-lisa/lisa-csrs-modelling.md'), undefined);
  console.log('  ok   kept pages carry the reason they were kept for');
} catch (e) {
  failed++;
  console.error(`  FAIL kept pages carry the reason they were kept for — ${e instanceof Error ? e.message : String(e)}`);
}

if (failed > 0) {
  console.error(`\n${failed} of ${cases.length + 1} reset checks failed.`);
  process.exit(1);
}
console.log(`\n${cases.length + 1}/${cases.length + 1} reset checks passed.`);
