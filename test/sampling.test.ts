/**
 * Sampling tests. Run with: npm test
 *
 * What is checked here is the *wire format* of a model call, which is why the
 * bodies live in `src/sampling.ts` instead of inline in `llm.ts`: nothing else in
 * this plugin can be verified without a provider, and this is the part that was
 * silently wrong — no temperature was sent at all, so the provider's own default
 * decided, and a local model paraphrasing three wiki pages came back with
 * `Dispotcher`, `pora` and `sintencia` in it. The content was right; the sampler
 * was improvising.
 *
 * The exact value matters less than the three things around it: that it *is*
 * sent, that it is low, and that both routes send the same one — a fix applied to
 * the local path only would leave Gemini improvising identically.
 */
import assert from 'node:assert/strict';
import {
  SAMPLING_TEMPERATURE,
  chatCompletionBody,
  geminiGenerationConfig,
} from '../src/sampling';

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

// --- the value itself -------------------------------------------------------
// A ratio, not a string: `"0.2"` in a JSON body is a 400 from most servers, and
// an easy typo to make in a field nobody was sending before.
check('the temperature is a number', typeof SAMPLING_TEMPERATURE, 'number');
check('it is low enough to keep the model on the notes', SAMPLING_TEMPERATURE <= 0.4, true);
check(
  'and it stays a legal value',
  SAMPLING_TEMPERATURE >= 0 && SAMPLING_TEMPERATURE < 1,
  true,
);

// --- OpenAI-compatible: chat/completions ------------------------------------
const withSystem = chatCompletionBody('gemma-4-26b-a4b-it', 'MATERIAL', 'RULES');
check('the model is the one configured', withSystem.model, 'gemma-4-26b-a4b-it');
check('the temperature travels', withSystem.temperature, SAMPLING_TEMPERATURE);
check('and nothing else is smuggled in', Object.keys(withSystem).sort(), [
  'messages',
  'model',
  'temperature',
]);
check(
  'the instructions come first and the material second',
  (withSystem.messages as Array<{ role: string; content: string }>).map(m => m.role),
  ['system', 'user'],
);
check(
  'each in its own channel, unaltered',
  withSystem.messages,
  [
    { role: 'system', content: 'RULES' },
    { role: 'user', content: 'MATERIAL' },
  ],
);

// The split is not cosmetic: everything in one message made the model treat the
// prompt as a configuration document and ask for the content it already had. So
// no system channel means *no system message*, not an empty one.
const withoutSystem = chatCompletionBody('m', 'MATERIAL');
check(
  'with no instructions there is no empty system message',
  (withoutSystem.messages as Array<{ role: string }>).map(m => m.role),
  ['user'],
);
check('and the temperature is still sent', withoutSystem.temperature, SAMPLING_TEMPERATURE);

// --- Gemini: generateContent ------------------------------------------------
const gemini = geminiGenerationConfig();
check('Gemini gets it too, in generationConfig', gemini.temperature, SAMPLING_TEMPERATURE);
check(
  'the same value on both routes',
  gemini.temperature,
  chatCompletionBody('m', 'p').temperature,
);

if (failed > 0) {
  console.error(`\n${failed} of ${total} sampling checks failed.`);
  process.exit(1);
}
console.log('\nsampling checks passed.');
