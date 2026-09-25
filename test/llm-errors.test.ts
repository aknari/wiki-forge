/**
 * Error-description tests. Run with: npm test
 *
 * The reason these are worth testing is the failure they were written for: an
 * ingest died with `net::ERR_CONNECTION_CLOSED`, which named neither the size of
 * the request nor the model, so the cause could only be guessed at. The checks
 * below pin down what the message has to carry, and — just as important — that a
 * *provider* refusal (401, 404, quota) is left alone instead of being dressed up
 * as a network problem and sending someone to check the wrong thing.
 */
import assert from 'node:assert/strict';
import {
  describeError,
  describeProviderBody,
  describeRequest,
  isDailyQuota,
  isOverloaded,
  isQuotaError,
  isTransportError,
  retryDelayMs,
  retryWaitMs,
  uniformAttemptSeconds,
} from '../src/llm-errors';

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

// --- the facts of the request ---------------------------------------------
check(
  'a request reports its size, its wait and the model',
  describeRequest('x'.repeat(53 * 1024), 31_400, 'gemini-2.5-flash'),
  'request: 53 KB, waited 31s, model gemini-2.5-flash',
);
check('a small request is not rounded up to nothing', describeRequest('hola', 900, 'gemini-2.5-flash'), 'request: 0 KB, waited 1s, model gemini-2.5-flash');

// --- what counts as a transport failure ------------------------------------
check('Chromium closing the connection is one', isTransportError('net::ERR_CONNECTION_CLOSED'), true);
check('a reset connection is one', isTransportError('net::ERR_CONNECTION_RESET'), true);
check('so is a timeout', isTransportError('net::ERR_TIMED_OUT'), true);
check('a 401 is not', isTransportError('listing the Gemini models failed (HTTP 401): API key not valid'), false);
check('neither is a quota refusal', isTransportError('Google API failed: 429 RESOURCE_EXHAUSTED'), false);
check('nor a bad model', isTransportError('Google API failed: 404 model not found'), false);

// --- the message itself ----------------------------------------------------
const transport = describeError(new Error('net::ERR_CONNECTION_CLOSED'));
check('a transport error keeps what was said', transport.startsWith('net::ERR_CONNECTION_CLOSED'), true);
check('and names what usually cuts the connection', transport.includes('AdGuard'), true);
check('and says nothing reached the model', transport.includes('nothing here reached the model'), true);

check(
  'a plain error is passed through untouched',
  describeError(new Error('Google API failed: 429 RESOURCE_EXHAUSTED')),
  'Google API failed: 429 RESOURCE_EXHAUSTED',
);
check('a string error is handled like an Error', describeError('boom'), 'boom');

// --- reading what a provider actually said ---------------------------------
// The body Gemini returns for a 429, trimmed to what matters: without the quota
// id, "status 429" cannot be told apart from a per-day limit.
const quota429 = {
  error: {
    code: 429,
    message: 'You exceeded your current quota, please check your plan and billing details.',
    status: 'RESOURCE_EXHAUSTED',
    details: [
      {
        '@type': 'type.googleapis.com/google.rpc.QuotaFailure',
        violations: [
          {
            quotaMetric: 'generate_content_free_tier_requests',
            quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier',
            quotaValue: '250',
          },
        ],
      },
      { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '31s' },
    ],
  },
};
check(
  'a 429 says which quota ran out and when to come back',
  describeProviderBody(quota429),
  'You exceeded your current quota, please check your plan and billing details. — ' +
    'quota: GenerateRequestsPerDayPerProjectPerModel-FreeTier — retry in 31s',
);
check(
  'an OpenAI-style body is understood too',
  describeProviderBody({ error: { message: 'Invalid API key', type: 'invalid_request_error' } }),
  'Invalid API key',
);
check('a body with no error object says nothing', describeProviderBody({}), '');
check('neither does a null body', describeProviderBody(null), '');
check('nor an error that is not an object', describeProviderBody({ error: 'boom' }), '');
check(
  'a missing quota id falls back to the metric',
  describeProviderBody({ error: { details: [{ violations: [{ quotaMetric: 'requests_per_minute' }] }] } }),
  'quota: requests_per_minute',
);

// --- what stops a sync -----------------------------------------------------
check('a quota refusal is recognised', isQuotaError('Google failed (HTTP 429): You exceeded your current quota'), true);
check('so is an OpenAI-style 429', isQuotaError('LLM API error: 429 — rate limit reached'), true);
check('and a bare too-many-requests', isQuotaError('Too Many Requests'), true);
check('a rejected key is not a quota problem', isQuotaError('Google failed (HTTP 401): API key not valid'), false);
check('nor is a bad model', isQuotaError('Google failed (HTTP 404): model not found'), false);
check('nor a cut connection', isQuotaError('net::ERR_CONNECTION_CLOSED'), false);
check('nor a note that happens to be 429 KB', isQuotaError('note is 429 KB and one distillation carries at most 200 KB'), false);

// --- the quota a retry cannot fix ------------------------------------------
const dailyMessage =
  'Google failed (HTTP 429): You exceeded your current quota — quota: ' +
  'GenerateRequestsPerDayPerProjectPerModel-FreeTier — retry in 59s';
check('the per-day allowance is told apart', isDailyQuota(dailyMessage), true);
check('so a per-day wording is', isDailyQuota('3 requests per day reached'), true);
check('a per-minute one is not', isDailyQuota('quota: GenerateRequestsPerMinutePerProjectPerModel-FreeTier'), false);
check('nor is a plain quota refusal', isQuotaError(dailyMessage) && isDailyQuota('quota exceeded'), false);

check('the wait the provider asked for is read', retryDelayMs(quota429), 31_000);
check('a fractional wait is kept', retryDelayMs({ error: { details: [{ retryDelay: '0.5s' }] } }), 500);
check('with no retry info there is no wait', retryDelayMs({ error: { message: 'nope' } }), null);
check('and an unreadable one is ignored', retryDelayMs({ error: { details: [{ retryDelay: 'soon' }] } }), null);

// --- how patient to be, per failure ----------------------------------------
const busy503 =
  'Google failed (HTTP 503): This model is currently experiencing high demand. ' +
  'Spikes in demand are usually temporary. Please try again later.';
check('an overloaded model is retried patiently', retryWaitMs(busy503, 0), 5_000);
check('and then less so, but still', retryWaitMs(busy503, 1), 20_000);
check('and once more', retryWaitMs(busy503, 2), 45_000);
check('until the attempts run out', retryWaitMs(busy503, 3), null);

check('a per-day quota is never retried', retryWaitMs(dailyMessage, 0), null);
check(
  'a per-minute quota waits longer than a moment',
  retryWaitMs('Google failed (HTTP 429): quota: GenerateRequestsPerMinutePerProjectPerModel', 0),
  20_000,
);
check('but only once', retryWaitMs('Google failed (HTTP 429): quota exceeded per minute', 1), null);

check('the wait the provider asks for is used as it is', retryWaitMs('HTTP 429 quota', 0, 31_000), 31_000);
check('and is capped when it is unreasonable', retryWaitMs('HTTP 429 quota', 0, 600_000), 60_000);
check('and is ignored from the second attempt on', retryWaitMs('HTTP 429 quota', 1, 31_000), null);

check('a rejected key is not retried at all', retryWaitMs('Google failed (HTTP 401): API key not valid', 0), null);
check('nor is a model that does not exist', retryWaitMs('Google failed (HTTP 404): model not found', 0), null);
check('a cut connection gets one more try', retryWaitMs('net::ERR_CONNECTION_CLOSED', 0), 5_000);
check('and no more', retryWaitMs('net::ERR_CONNECTION_CLOSED', 1), null);
check('an unexplained failure is treated like a cut connection', retryWaitMs('boom', 0), 5_000);

// --- telling a timeout apart from a refusal ---------------------------------
check('two attempts cut after the same span is a timeout', uniformAttemptSeconds([30_000, 31_000]), 30);
check('and the seconds are reported, not the milliseconds', uniformAttemptSeconds([61_000, 62_000]), 61);
check('one attempt says nothing', uniformAttemptSeconds([30_000]), null);
check('spans that share nothing say nothing either', uniformAttemptSeconds([900, 40_000]), null);
check('a fast failure is not a timeout', uniformAttemptSeconds([1_200, 1_300]), null);

// --- the crowded model -----------------------------------------------------
check('high demand is recognised as an overloaded model', isOverloaded(busy503), true);
check('so is a bare 503', isOverloaded('Google failed (HTTP 503)'), true);
check('a crowded model is also worth retrying', retryWaitMs(busy503, 0) !== null, true);
check('a quota refusal is not an overload', isOverloaded('Google failed (HTTP 429): quota exceeded'), false);
check('nor is a rejected key', isOverloaded('Google failed (HTTP 401): API key not valid'), false);

if (failed > 0) {
  console.error(`\n${failed} of ${total} llm-error checks failed.`);
  process.exit(1);
}
console.log('\nllm-error checks passed.');
