import { requestUrl } from 'obsidian';
import {
  describeError,
  describeProviderBody,
  describeRequest,
  isDailyQuota,
  isOverloaded,
  retryDelayMs,
  retryWaitMs,
  uniformAttemptSeconds,
} from './llm-errors';
import { isChatCapable } from './models';
import { chatCompletionBody, geminiGenerationConfig } from './sampling';
import type { WikiForgeSettings } from './settings';

interface LlmResponse {
  status: number;
  json: any;
  text: string;
}

/**
 * A refusal from the provider, carrying the wait it asked for when it named one.
 * The wait has to survive the throw: by the time the caller decides how long to
 * pause, the response body is long gone.
 */
class ProviderError extends Error {
  constructor(
    message: string,
    readonly retryAfterMs: number | null = null,
  ) {
    super(message);
  }
}

/**
 * Turns a non-2xx answer into an error that repeats what the provider said.
 *
 * The model list doubles as the check behind "Save & test", so swallowing the
 * status here used to report a rejected key as a plugin with zero models —
 * which looks like success and hides a 401. And on a 429 the body is the only
 * place that says *which* quota ran out, so it is read rather than discarded.
 */
function httpError(res: LlmResponse, what: string): ProviderError {
  const body = res.json as { error?: { message?: string }; message?: string } | null;
  const detail = describeProviderBody(res.json) || String(res.text ?? '').slice(0, 300).trim();
  return new ProviderError(
    `${what} failed (HTTP ${res.status})${detail ? `: ${detail}` : ''}`,
    retryDelayMs(res.json),
  );
}

/**
 * What to do about a per-day quota: nothing, for a day — but another model works
 * at once, and that is the part nobody can be expected to read out of a quota id
 * like `GenerateRequestsPerDayPerProjectPerModel-FreeTier`.
 */
/**
 * What to do when the model itself is the crowded one. Waiting is what the plugin
 * already did, three times; the answer is a different model, and which ones are
 * crowded is not something the error says.
 */
const OVERLOADED_HINT =
  'the model is the crowded one, not your setup — a different model from the list answers at ' +
  'once (the newest and the “preview” ones are the busiest), or a local server, which is never busy';

/**
 * What to do about a per-day quota: nothing, for a day — but another model works
 * at once, and that is the part nobody can be expected to read out of a quota id
 * like `GenerateRequestsPerDayPerProjectPerModel-FreeTier`.
 */
const DAILY_QUOTA_HINT =
  'this is a per-day allowance, so waiting does not bring it back — each model has its own, ' +
  'so another free-tier model answers right now (or a local server)';

/**
 * The most attempts any single call may take: the first one, plus the three
 * pauses an overloaded provider is worth (`retryWaitMs`).
 */
const MAX_ATTEMPTS = 4;

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Calls the configured provider (google = Gemini REST; openai = any
 * OpenAI-compatible API).
 *
 * How patient to be is decided per failure by `retryWaitMs` — an overloaded model
 * gets three attempts, a per-day quota gets none — instead of the single fixed
 * five-second retry the original Python scripts used, which was both too little
 * for a busy provider and spent for nothing on a 401.
 */
/**
 * One model call. `system` carries the instructions and `prompt` the material to
 * work on, and the split is not cosmetic: everything in a single message made the
 * model treat the whole thing as a configuration document and answer "understood,
 * please provide the content" — measured, repeatedly, with the note sitting right
 * there in the prompt. Instructions in one channel and material in the other is
 * what makes it process the material it was given.
 */
export async function askLlm(
  settings: WikiForgeSettings,
  apiKey: string,
  prompt: string,
  purpose = 'task',
  system?: string,
): Promise<string> {
  if (settings.provider === 'google') {
    const started = Date.now();
    let lastError: unknown;
    let tries = 0;
    const attemptMs: number[] = [];
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const attemptStart = Date.now();
      try {
        const url =
          `https://generativelanguage.googleapis.com/v1beta/models/` +
          `${encodeURIComponent(settings.model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
        // `throw: false` on purpose: a refused request still has a body worth
        // reading (the 429 detail), and requestUrl's own error throws it away.
        const res = await requestUrl({
          url,
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            ...(system === undefined ? {} : { systemInstruction: { parts: [{ text: system }] } }),
            contents: [{ role: 'user', parts: [{ text: prompt }] }],
            generationConfig: geminiGenerationConfig(),
          }),
          throw: false,
        });
        if (res.status < 200 || res.status >= 300) throw httpError(res, 'Google');
        const parts = res.json?.candidates?.[0]?.content?.parts;
        const text = Array.isArray(parts)
          ? (parts as Array<{ text?: string }>).map(p => p.text ?? '').join('')
          : '';
        if (!text) throw new Error('Empty response from Gemini');
        return text;
      } catch (e) {
        lastError = e;
        tries = attempt + 1;
        attemptMs.push(Date.now() - attemptStart);
        const message = e instanceof Error ? e.message : String(e);
        const asked = e instanceof ProviderError ? e.retryAfterMs : null;
        const wait = retryWaitMs(message, attempt, asked);
        if (wait === null) break;
        console.error(`WikiForge: Google error (${purpose}), retrying in ${Math.round(wait / 1000)}s...`, e);
        await sleep(wait);
      }
    }
    const last = lastError instanceof Error ? lastError.message : String(lastError);
    const uniform = uniformAttemptSeconds(attemptMs);
    throw new Error(
      `Google API failed${tries > 1 ? ` after ${tries} attempts` : ''}: ${describeError(lastError)} ` +
        `(${describeRequest(prompt, Date.now() - started, settings.model)})` +
        (uniform === null
          ? ''
          : ` — every attempt died after about ${uniform}s with no answer, which is a timeout in ` +
            'something between Obsidian and the provider, not a refusal: it never reached the model') +
        (isDailyQuota(last) ? ` — ${DAILY_QUOTA_HINT}` : '') +
        (isOverloaded(last) ? ` — ${OVERLOADED_HINT}` : ''),
    );
  }

  // OpenAI-compatible endpoint (OpenRouter, LM Studio, Ollama, NVIDIA NIM...)
  const base = settings.baseUrl.replace(/\/+$/, '');
  const started = Date.now();
  const elapsed = (): number => Date.now() - started;
  let res: LlmResponse;
  try {
    res = await requestUrl({
      url: `${base}/chat/completions`,
      method: 'POST',
    headers: {
      // No key means no header: a local server ignores it, and sending an empty
      // one is a request to be refused by any gateway in between.
      ...(apiKey !== '' ? { Authorization: `Bearer ${apiKey}` } : {}),
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://obsidian-wiki.local',
    },
      body: JSON.stringify(chatCompletionBody(settings.model, prompt, system)),
    });
  } catch (e) {
    // A transport failure here is the same story as Google's: say what it was.
    throw new Error(`${describeError(e)} (${describeRequest(prompt, elapsed(), settings.model)})`);
  }
  if (res.status !== 200) {
    throw new Error(
      `LLM API error: ${res.status} — ${res.text.slice(0, 300)} ` +
        `(${describeRequest(prompt, elapsed(), settings.model)})`,
    );
  }
  const content = res.json?.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || !content) {
    throw new Error(`Empty response from LLM API (${describeRequest(prompt, elapsed(), settings.model)})`);
  }
  return content;
}

/**
 * Lists the models the provider offers for chatting, for the Model dropdown.
 *
 * Google returns everything it serves — embeddings, image, speech — and only
 * the `generateContent` ones can answer a prompt, so the rest is dropped: the
 * dropdown should offer what you can actually use. Those names arrive as
 * `models/<id>`, and the prefix is stripped because the request is built from
 * the bare id (keeping it would ask for `models/models/…`).
 */
export async function listModels(
  settings: WikiForgeSettings,
  apiKey: string,
): Promise<string[]> {
  if (settings.provider === 'google') {
    const res: LlmResponse = await requestUrl({
      url: `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}`,
      method: 'GET',
      throw: false,
    });
    if (res.status < 200 || res.status >= 300) throw httpError(res, 'listing the Gemini models');
    const models: Array<{ name?: string; supportedGenerationMethods?: string[] }> = res.json?.models ?? [];
    return models
      .filter(m => (m.supportedGenerationMethods ?? []).includes('generateContent'))
      .map(m => (m.name ?? '').replace(/^models\//, ''))
      .filter(Boolean);
  }
  const base = settings.baseUrl.replace(/\/+$/, '');
  const res: LlmResponse = await requestUrl({
    url: `${base}/models`,
    method: 'GET',
    headers: apiKey !== '' ? { Authorization: `Bearer ${apiKey}` } : {},
    throw: false,
  });
  if (res.status < 200 || res.status >= 300) throw httpError(res, `listing the models at ${base}`);
  // Groq (and a few gateways) go beyond the OpenAI spec and declare
  // `output_modalities`, which is what tells a speech or transcription model
  // apart from a chat model. Providers that declare nothing are kept as they
  // come — only the *preference* filter (`hiddenModelPatterns`) is applied when
  // the list is drawn, so editing it does not need a new request.
  const entries: Array<{ id?: string; output_modalities?: unknown }> = res.json?.data ?? [];
  return entries.filter(isChatCapable).map(entry => entry.id ?? '').filter(Boolean);
}