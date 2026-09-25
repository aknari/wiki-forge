export type Provider = 'google' | 'openai';

/**
 * Model list fetched from the provider, cached so the Model dropdown still has
 * its options after a restart. It carries the provider and base URL it was
 * fetched from, so switching either of them invalidates it instead of offering
 * models that belong to another API.
 */
export interface ModelCache {
  provider: Provider;
  baseUrl: string;
  models: string[];
}

export interface WikiForgeSettings {
  /** google = Gemini directly (REST); openai = any OpenAI-compatible API (OpenRouter, LM Studio, Ollama, NVIDIA NIM...) */
  provider: Provider;
  /** e.g. "gemini-2.5-flash", "qwen/qwen-2.5-72b-instruct" */
  model: string;
  /** Only used with provider "openai". Default: https://openrouter.ai/api/v1 */
  baseUrl: string;
  /** Cached model list for the Model dropdown (`null` until something is fetched). */
  modelCache: ModelCache | null;

  /** Every folder whose notes are distilled into the wiki (one root each). */
  srcDirs: string[];
  journalDir: string;
  wikiDir: string;
  supportDir: string;
  forgeRulesPath: string;
  queryRulesPath: string;
  indexPath: string;
  logPath: string;
  checkboxDir: string;
  queriesDir: string;
  /** Where "Check wiki" writes its report. A vault note, outside the wiki. */
  reportPath: string;

  /**
   * Name fragments used only to *label* the Model dropdown: a model containing
   * one of them is shown as "free tier". Google does not expose billing tiers
   * through its API, so this is a hint you keep up to date (default: `flash`).
   */
  freeTierPatterns: string[];

  /**
   * Name patterns for models to leave out of the dropdown. Same syntax as
   * `freeTierPatterns` (a line starting with `!` brings a model back), because
   * a guard classifier is text-in/text-out like any chat model and no metadata
   * distinguishes it. The defaults are the families that cannot hold a
   * conversation: Whisper (transcription), Orpheus (speech), embeddings,
   * re-rankers and the prompt-guard/safeguard classifiers.
   */
  hiddenModelPatterns: string[];

  /** Folder names skipped inside *every* source folder (matched on any segment). */
  excludedDirs: string[];
  /** Also ingest 10-journal/ during sync */
  includeJournal: boolean;
  /** Dump the query answer to a note in queriesDir */
  saveAnswersToNote: boolean;
  /**
   * Refresh the wiki check (report only — it writes nothing but the report)
   * after every sync, so the state of the wiki is never a surprise.
   */
  checkAfterSync: boolean;
  /** UI indicator: whether an API key is stored in the system keychain */
  apiKeyConfigured: boolean;
}

export const DEFAULT_SETTINGS: Readonly<WikiForgeSettings> = Object.freeze({
  provider: 'google',
  model: 'gemini-2.5-flash',
  baseUrl: 'https://openrouter.ai/api/v1',
  modelCache: null,
  srcDirs: ['00-src'],
  journalDir: '10-journal',
  wikiDir: '20-wiki',
  supportDir: '80-support',
  forgeRulesPath: '80-support/ai/forge-rules.md',
  queryRulesPath: '80-support/ai/query-rules.md',
  indexPath: '20-wiki/index.md',
  logPath: '20-wiki/log.md',
  checkboxDir: '00-src/10-tasks',
  queriesDir: '10-journal/queries',
  reportPath: '80-support/wiki-forge/informe.md',
  freeTierPatterns: ['flash', '!tts', '!image'],
  hiddenModelPatterns: ['whisper', 'tts', 'orpheus', 'embed', 'rerank', 'guard'],
  excludedDirs: [
    '10-checkbox',
    '11-tasks',
    '40-toolbox',
    '60-sandbox',
    '90-store',
    'copilot-prompts',
    '80-resources',
    '83-additions',
    'attachments',
    '80-test',
    '91-old',
  ],
  includeJournal: false,
  saveAnswersToNote: true,
  checkAfterSync: true,
  apiKeyConfigured: false,
});

/** What an older version stored: a single source folder, not a list. */
interface LegacySettings {
  srcDir?: unknown;
}

/**
 * Reads a `data.json` written by any version. The only key that ever changed
 * shape is the source folder (`srcDir: "00-src"` is now `srcDirs: ["00-src"]`),
 * so an old file is folded into a one-folder list instead of losing the choice;
 * the stale key is dropped here and disappears on the next save.
 */
export function migrateSettings(data: unknown): Partial<WikiForgeSettings> {
  // Always returns a usable source list, so a caller that merges it into the
  // defaults and a caller that reads it alone agree on what the roots are.
  if (data === null || typeof data !== 'object') return { srcDirs: [...DEFAULT_SETTINGS.srcDirs] };
  const { srcDir, ...rest } = data as Partial<WikiForgeSettings> & LegacySettings;
  const dirs = Array.isArray(rest.srcDirs)
    ? rest.srcDirs.filter((dir): dir is string => typeof dir === 'string' && dir.trim() !== '')
    : [];
  if (dirs.length > 0) return { ...rest, srcDirs: dirs };
  if (typeof srcDir === 'string' && srcDir.trim() !== '') return { ...rest, srcDirs: [srcDir.trim()] };
  return { ...rest, srcDirs: [...DEFAULT_SETTINGS.srcDirs] };
}