/**
 * How much freedom every model call gets — and the shape of the request that
 * carries it.
 *
 * The plugin used to send no temperature at all, which hands the decision to
 * whatever default the provider has, and a local server has one. On a model
 * served by TurboFieldfare that showed up as letter-level noise in a paraphrased
 * answer: `Dispotcher` for *Dispatcher*, `monejo` for *manejo*, `pora` for
 * *para*, `sintencia` for *síntesis*, `Lo arquitectura` for *La arquitectura*,
 * and a source cited as `lisa-rchitecture-overview.md`. The content was right in
 * every case — the model had read the pages — so this is sampling noise, not a
 * reading problem. The same model's *distillation* of those same pages came out
 * clean, which is why the fix belongs here and not in the prompt.
 *
 * The bodies live here instead of inline in `llm.ts` for one reason: so the wire
 * format can be checked without a provider. See `test/sampling.test.ts`.
 */

/**
 * Low on purpose. Every call this plugin makes is a reading task — distil these
 * notes, which pages hold the answer, answer from these pages — and none of them
 * wants invention. 0.2 keeps the model on the wording of the notes.
 */
export const SAMPLING_TEMPERATURE = 0.2;

/**
 * Body of an OpenAI-compatible `chat/completions` request. Instructions in their
 * own channel, material in the user message — why, see `askLlm`.
 */
export function chatCompletionBody(
  model: string,
  prompt: string,
  system?: string,
): Record<string, unknown> {
  return {
    model,
    temperature: SAMPLING_TEMPERATURE,
    messages: [
      ...(system === undefined ? [] : [{ role: 'system', content: system }]),
      { role: 'user', content: prompt },
    ],
  };
}

/** Gemini keeps the sampling knobs in `generationConfig`, not at the top level. */
export function geminiGenerationConfig(): Record<string, unknown> {
  return { temperature: SAMPLING_TEMPERATURE };
}
