/**
 * Helpers for the Model dropdown: which models to offer, in what order, which
 * ones look free and which ones are left out.
 *
 * Two different kinds of filtering live here, and they are not the same thing:
 *
 *  - **What the provider declares.** Google says what each model can do
 *    (`supportedGenerationMethods`), and Groq — beyond the OpenAI spec —
 *    declares `output_modalities`, where a speech or transcription model says
 *    `['speech']` / `['transcription']` and a chat model says `['text']`. That
 *    is a fact, so it is used as such (`isChatCapable`).
 *  - **What you prefer not to see.** Everywhere else (LM Studio, Ollama, most
 *    gateways) `/models` answers with nothing but an id, so name patterns are
 *    the only signal available. Those are a preference you edit (`isHiddenModel`).
 *
 * Google's API does **not** say what a model costs — it only says what a model
 * can do. So "free tier" here is an honest *hint*: a model is labelled free when
 * its name contains one of the patterns from the settings. The default is
 * `flash`, because the Pro models left the free tier in April 2026. When Google
 * shuffles its catalogue, edit the patterns; an empty list stops the labelling.
 *
 * Pure on purpose (no Obsidian import), so all of this is covered by tests
 * instead of being decided inside a callback.
 */
import type { ModelCache, Provider } from './settings';

/**
 * Whether a name matches any pattern. A pattern starting with `!` is an
 * exclusion and wins over the inclusions — that is how you keep `flash` but drop
 * `gemini-2.5-flash-preview-tts`, which is not a chat model even though its name
 * says flash.
 */
export function matchesNamePatterns(value: string, patterns: string[]): boolean {
  const name = value.toLowerCase();
  const cleaned = patterns.map(pattern => pattern.trim().toLowerCase()).filter(pattern => pattern !== '');
  const matches = (pattern: string): boolean => name.includes(pattern.slice(1));
  if (cleaned.some(pattern => pattern.startsWith('!') && matches(pattern))) return false;
  return cleaned.some(pattern => !pattern.startsWith('!') && matches(pattern));
}

/**
 * Free-tier *label* for the dropdown: same syntax, and here a match means "show
 * it as free".
 */
export const isFreeTierModel = (model: string, patterns: string[]): boolean =>
  matchesNamePatterns(model, patterns);

/**
 * Whether a model is left out of the dropdown: same syntax again, and here a
 * match means "hide it". Used for what the provider's metadata cannot tell you —
 * a guard classifier is text-in/text-out like any chat model, but there is no
 * conversation to be had with it.
 */
export const isHiddenModel = (model: string, patterns: string[]): boolean =>
  matchesNamePatterns(model, patterns);

/**
 * Whether the provider says this model can answer a chat request.
 *
 * Only the providers that declare `output_modalities` are judged on it: Groq
 * answers `['speech']` for its text-to-speech models and `['transcription']`
 * for Whisper. An entry that says nothing is kept, because silence is not
 * evidence that a model cannot chat — LM Studio, Ollama and most gateways
 * declare nothing at all.
 */
/** The fields of one `/models` entry this module looks at. */
export interface ModelEntry {
  id?: string;
  input_modalities?: unknown;
  output_modalities?: unknown;
}

export function isChatCapable(entry: ModelEntry): boolean {
  const modalities = entry.output_modalities;
  if (!Array.isArray(modalities) || modalities.length === 0) return true;
  return modalities.some(modality => String(modality).toLowerCase() === 'text');
}

/**
 * De-duplicates a model list and orders it: the free ones first (that is what
 * you are usually looking for), then alphabetically.
 */
export function orderModels(models: string[], patterns: string[]): string[] {
  return [...new Set(models.filter(model => model !== ''))].sort((a, b) => {
    const freeA = isFreeTierModel(a, patterns);
    const freeB = isFreeTierModel(b, patterns);
    if (freeA !== freeB) return freeA ? -1 : 1;
    return a.localeCompare(b);
  });
}

/**
 * The text of one dropdown option: `model`, plus the marks that apply to it.
 *
 * `foreign` (the model was picked while another provider was selected) replaces
 * the `current` mark instead of joining it: the saved model *is* what the
 * dropdown shows, but calling it "current" here would suggest it is a valid
 * choice for the endpoint you are pointed at now, which is exactly the
 * confusion this mark exists to clear up.
 */
export function modelLabel(model: string, patterns: string[], current: boolean, foreign = false): string {
  const marks: string[] = [];
  if (isFreeTierModel(model, patterns)) marks.push('free tier');
  if (foreign) marks.push('from another provider');
  else if (current) marks.push('current');
  return marks.length === 0 ? model : `${model}  · ${marks.join(' · ')}`;
}

export interface EndpointModels {
  /** Models fetched from *this* endpoint; empty when the cache belongs to another. */
  models: string[];
  /** Whether a list was cached, but for a different provider or base URL. */
  foreignCache: boolean;
}

/**
 * The cached list, but only when it belongs to the endpoint you are pointed at.
 *
 * The cache carries the provider and base URL it came from, so switching either
 * of them leaves it stale: those models live on another API, and offering them
 * as choices is how you end up sending `gemini-2.5-flash` to a server on your
 * own machine. A `null` cache is not a mismatch — the default model may well be
 * the right one before anything has been fetched.
 */
export function modelsForEndpoint(
  cache: ModelCache | null,
  provider: Provider,
  baseUrl: string,
): EndpointModels {
  if (cache === null) return { models: [], foreignCache: false };
  const matches = cache.provider === provider && cache.baseUrl === baseUrl;
  return { models: matches ? cache.models : [], foreignCache: !matches };
}

export interface ModelChoices {
  /** Ordered options for the dropdown. */
  models: string[];
  /** Models the provider offers but your patterns leave out. */
  hidden: string[];
  /** Models the provider offers, before the patterns are applied. */
  offered: number;
}

/**
 * Builds the dropdown's options from the fetched list.
 *
 * The model you already have selected is always offered, even if a pattern
 * matches it: hiding is a filter for choosing, and losing sight of the current
 * choice would be worse than seeing one model you had asked to hide.
 */
export function buildModelChoices(
  current: string,
  fetched: string[],
  options: { hidePatterns: string[]; freePatterns: string[] },
): ModelChoices {
  const hidden = fetched.filter(model => isHiddenModel(model, options.hidePatterns));
  const visible = fetched.filter(model => !isHiddenModel(model, options.hidePatterns));
  return {
    models: orderModels([current, ...visible], options.freePatterns),
    hidden,
    offered: fetched.length,
  };
}
