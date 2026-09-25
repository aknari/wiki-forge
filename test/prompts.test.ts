/**
 * Prompt tests. Run with: npm test
 *
 * Two jobs here, and they answer two different failures.
 *
 * The fingerprint ones pin the *algorithm*: a stored fingerprint is compared
 * against a freshly computed one, so changing how it is computed would make every
 * existing wiki look as if the rules had changed. The expected values are written
 * out for that reason — they are the contract, not an implementation detail.
 *
 * The rule ones pin the *wording* that was measured missing. The identity rule
 * was in the rules file and still produced nothing, because the merge contract
 * that follows it asked only to extend; the query rules never asked the answer to
 * say what the subject is at all. Both are one line each and both are easy to
 * lose again in a rewrite.
 */
import assert from 'node:assert/strict';
import {
  DEFAULT_FORGE_RULES,
  DEFAULT_QUERY_RULES,
  MERGE_OUTPUT_CONTRACT,
  rulesFingerprint,
} from '../src/prompts';

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

// --- the fingerprint ---

const FINGERPRINTS: Array<[string, string]> = [
  ['', '1505'],
  ['a', '2b606'],
  ['abc', 'b885c8b'],
  ['RISC-V', 'cc7dabb9'],
];

for (const [text, expected] of FINGERPRINTS) {
  check(`fingerprint of ${JSON.stringify(text)} is ${expected}`, () => {
    assert.strictEqual(rulesFingerprint(text), expected);
  });
}

check('the same text always fingerprints the same', () => {
  assert.strictEqual(rulesFingerprint(DEFAULT_FORGE_RULES), rulesFingerprint(DEFAULT_FORGE_RULES));
});

check('a trailing space is a different fingerprint', () => {
  assert.notStrictEqual(rulesFingerprint('abc'), rulesFingerprint('abc '));
});

check('one letter is a different fingerprint', () => {
  assert.notStrictEqual(rulesFingerprint('abc'), rulesFingerprint('abd'));
});

check('the fingerprint is unsigned hex, never a minus sign', () => {
  for (const text of ['', 'a', 'abc', 'RISC-V', 'the rules', '\u{1F600}'.repeat(20)]) {
    assert.match(rulesFingerprint(text), /^[0-9a-f]+$/);
  }
});

// --- the rules that were measured missing ---

check('the forge rules state the subject as mandatory', () => {
  assert.match(DEFAULT_FORGE_RULES, /State the subject \(MANDATORY\)/);
});

check('the subject rule covers updating a page, not only creating one', () => {
  assert.match(DEFAULT_FORGE_RULES, /holds for a page you are updating/);
});

check('the merge contract does not let "nothing new" excuse an opening with no subject', () => {
  assert.match(MERGE_OUTPUT_CONTRACT, /not an option/);
  assert.match(MERGE_OUTPUT_CONTRACT, /does not start by saying what its subject is/);
});

check('the query rules ask the answer to say what the subject is', () => {
  assert.match(DEFAULT_QUERY_RULES, /first sentence of the answer must say what it is/);
});

check('the query rules take the fact from any page, not only the one named after it', () => {
  assert.match(DEFAULT_QUERY_RULES, /not only from the page that carries its name/);
});

if (failed > 0) {
  console.error(`\n${failed} of ${FINGERPRINTS.length + 10} prompt checks failed.`);
  process.exit(1);
}
console.log(`\n${FINGERPRINTS.length + 10}/${FINGERPRINTS.length + 10} prompt checks passed.`);
