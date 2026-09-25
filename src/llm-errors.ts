/**
 * How a failed model call is described to the person waiting for it.
 *
 * Pure on purpose — no Obsidian import — because these strings are load-bearing:
 * they are what decides whether a failure can be diagnosed at all. `net::
 * ERR_CONNECTION_CLOSED` on its own says nothing, and the first version of this
 * plugin printed exactly that: a wall of text that named neither the size of the
 * request, nor how long it waited, nor which model, and blamed nothing, so the
 * only way forward was to guess. Tests live in `test/llm-errors.test.ts`.
 */

/** How big the request was, how long it waited and which model — the facts. */
export function describeRequest(prompt: string, elapsedMs: number, model: string): string {
  return `request: ${Math.round(prompt.length / 1024)} KB, waited ${Math.round(elapsedMs / 1000)}s, model ${model}`;
}

/**
 * Chromium's names for "the connection died before an answer". They are the ones
 * that look like the plugin's fault and almost never are, because whatever cut
 * the connection sits between Obsidian and the provider.
 */
const TRANSPORT = /ERR_CONNECTION_CLOSED|ERR_CONNECTION_RESET|ERR_CONNECTION_REFUSED|ERR_EMPTY_RESPONSE|ERR_TIMED_OUT|ERR_NETWORK_CHANGED|socket hang up/i;

/** Whether an error is a transport failure rather than a refusal by the provider. */
export function isTransportError(message: string): boolean {
  return TRANSPORT.test(message);
}

/**
 * What an error body says, in a form worth reading.
 *
 * A 429 is the case this exists for. "Request failed, status 429" does not say
 * whether the quota that ran out is per minute (wait a moment) or per day (come
 * back tomorrow), and the difference decides what the person does next. Google
 * does say it — in `error.details`, as a quota id and a `retryDelay` — so it is
 * read out here instead of being thrown away. The OpenAI-style `error.message`
 * shape is understood too, because the same helper reports OpenRouter, Groq and
 * the local servers.
 */
export function describeProviderBody(body: unknown): string {
  const error = (body as { error?: unknown } | null)?.error;
  if (error === null || typeof error !== 'object') return '';
  const { message, details } = error as { message?: unknown; details?: unknown };
  const parts: string[] = [];
  if (typeof message === 'string' && message.trim() !== '') parts.push(message.trim().slice(0, 200));

  for (const detail of Array.isArray(details) ? details : []) {
    if (detail === null || typeof detail !== 'object') continue;
    const violations = (detail as { violations?: unknown }).violations;
    for (const violation of Array.isArray(violations) ? violations : []) {
      if (violation === null || typeof violation !== 'object') continue;
      const { quotaId, quotaMetric } = violation as { quotaId?: unknown; quotaMetric?: unknown };
      const quota = typeof quotaId === 'string' ? quotaId : quotaMetric;
      if (typeof quota === 'string') parts.push(`quota: ${quota}`);
    }
    const delay = (detail as { retryDelay?: unknown }).retryDelay;
    if (typeof delay === 'string') parts.push(`retry in ${delay}`);
  }
  return parts.join(' — ');
}

/**
 * The wait a provider asked for, in milliseconds, or `null` when it did not say.
 * Google writes it as a duration string (`"31s"`).
 */
export function retryDelayMs(body: unknown): number | null {
  const error = (body as { error?: unknown } | null)?.error;
  const details = (error as { details?: unknown } | null)?.details;
  for (const detail of Array.isArray(details) ? details : []) {
    if (detail === null || typeof detail !== 'object') continue;
    const delay = (detail as { retryDelay?: unknown }).retryDelay;
    if (typeof delay !== 'string') continue;
    const seconds = Number.parseFloat(delay.replace(/s$/, ''));
    if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  }
  return null;
}

/**
 * Whether a refusal is the provider saying "not now".
 *
 * Worth telling apart, because it is the one failure that is not about the note
 * being processed: every note after it would be refused the same way, each after
 * a wait, so a sync has to stop instead of walking the whole folder and looking
 * hung. Covers Google (`RESOURCE_EXHAUSTED`), the OpenAI-style `429`/"too many
 * requests", and our own wording.
 */
export function isQuotaError(message: string): boolean {
  return /HTTP 429|status 429|RESOURCE_EXHAUSTED|quota|rate limit|too many requests/i.test(message);
}

/**
 * Whether the provider said it is too busy right now. Worth naming, because the
 * answer is not to wait: another model answers at once, and the busiest ones are
 * the newest and the `-preview` ones.
 */
export function isOverloaded(message: string): boolean {
  return OVERLOADED.test(message);
}

/**
 * Whether the quota that ran out is a **per-day** allowance.
 *
 * It is worth telling apart because it is the one refusal that retrying cannot
 * fix. Google's `retryDelay` for it is nominal (`59s`) while the allowance only
 * comes back at midnight Pacific, so waiting means pausing a minute to report
 * the same thing — and a caller that knows this can stop instead. Google names it
 * in the quota id (`...PerDayPerProjectPerModel-FreeTier`); the wording is
 * checked too, in case a gateway relays it differently.
 */
export function isDailyQuota(message: string): boolean {
  return /PerDay|per day|daily/i.test(message);
}

/** The provider saying "too busy right now", which does clear on its own. */
const OVERLOADED = /HTTP 5\d\d|high demand|overloaded|temporarily unavailable|try again later/i;

/**
 * Refusals that will answer exactly the same thing however long you wait. A 429
 * is one too, but it is handled before this: it has its own meaning (wait).
 */
const WILL_NOT_CHANGE = /HTTP 4\d\d/;

/**
 * Pauses after an overloaded provider: it clears in seconds or minutes, so the
 * retries are worth making and are allowed to take longer each time.
 */
const OVERLOAD_WAITS = [5_000, 20_000, 45_000];

/** No single pause is ever taken past this, provider's advice included. */
export const MAX_RETRY_WAIT_MS = 60_000;

/**
 * How long to pause before trying again, or `null` when trying again is pointless.
 *
 * One fixed pause cannot express what these failures mean, and getting it wrong
 * costs the same thing twice over — time, and on a metered plan, money. An
 * overloaded provider (`503`) is worth three attempts: it clears on its own. A
 * per-minute quota wants the wait the provider names. A per-day quota is not
 * coming back today, and a `401` or a `404` will answer the same way forever, so
 * retrying those only delays the sentence.
 */
export function retryWaitMs(
  message: string,
  attempt: number,
  askedMs: number | null = null,
): number | null {
  if (isDailyQuota(message)) return null;
  if (askedMs !== null && attempt === 0) return Math.min(Math.max(askedMs, 1_000), MAX_RETRY_WAIT_MS);
  if (isOverloaded(message)) return OVERLOAD_WAITS[attempt] ?? null;
  if (isQuotaError(message)) return attempt === 0 ? 20_000 : null;
  if (WILL_NOT_CHANGE.test(message)) return null;
  return attempt === 0 ? 5_000 : null;
}

/**
 * Whether every attempt died after about the same span, and how long that was.
 *
 * It is the one inference worth making automatically, because it separates two
 * situations that look identical in a log: a **timeout** — something in the
 * middle gave up on a connection that stayed silent — and a refusal, where the
 * provider answered. Two attempts cut after roughly equal spans is the former,
 * and the seconds are what make it actionable. A fast failure is not a timeout,
 * and neither is a set of spans that share nothing, so both return `null`.
 */
export function uniformAttemptSeconds(attemptMs: readonly number[]): number | null {
  const first = attemptMs[0];
  if (attemptMs.length < 2 || first === undefined || first < 5_000) return null;
  const spread = Math.max(...attemptMs) - Math.min(...attemptMs);
  if (spread > Math.max(5_000, first * 0.25)) return null;
  return Math.round(first / 1000);
}

/**
 * The error message, with the usual suspects named when it is a transport
 * failure. Naming them is the point: the first thing to check is whatever
 * filters HTTPS on the machine, and the person reading this cannot be expected
 * to know that from a Chromium constant.
 */
export function describeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (!isTransportError(message)) return message;
  return (
    `${message} — the connection was cut before the provider answered, so nothing here reached the model. ` +
    'What usually cuts it: an HTTPS filter or proxy (AdGuard, Little Snitch, a corporate or university proxy), a VPN, then the network itself.'
  );
}
