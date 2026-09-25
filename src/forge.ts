import { App, Notice, TFile } from 'obsidian';
import type { WikiForgeSettings } from './settings';
import { askLlm } from './llm';
import { loadState, saveState, writeFileSafe } from './state';
import { normalizeVaultPath } from './paths';
import {
  dropIndexSection,
  evidencePages,
  isAnswerNote,
  queriesFolderWithinWiki,
} from './query-note';
import { isSourcePath } from './sources';
import { isQuotaError } from './llm-errors';
import { classifyEmptyAnswer, parseFileBlocks, type EmptyAnswerReason } from './protocol';
import {
  DEFAULT_FORGE_RULES,
  DRAFT_OUTPUT_CONTRACT,
  FORMAT_OUTPUT_CONTRACT,
  MERGE_OUTPUT_CONTRACT,
  rulesFingerprint,
} from './prompts';
import { rebuildWikiIndex } from './wiki-vault';
import { addedStatements } from './page-change';
import { hoistFencedFrontmatter } from './wikitext';

/**
 * Collects .md sources from every configured source folder (minus the excluded
 * names) plus, optionally, the journal folder. The rules themselves live in
 * `sources.ts`, where they are tested.
 */
export function collectSourceFiles(
  app: App,
  settings: WikiForgeSettings,
  includeJournal: boolean,
): TFile[] {
  return app.vault
    .getMarkdownFiles()
    .filter(f => isSourcePath(f.path, settings, includeJournal))
    .sort((a, b) => a.path.localeCompare(b.path));
}

async function readRules(app: App, settings: WikiForgeSettings): Promise<string> {
  const file = app.vault.getAbstractFileByPath(settings.forgeRulesPath);
  if (file instanceof TFile) return app.vault.read(file);
  return DEFAULT_FORGE_RULES;
}

/**
 * Every page of the wiki, except the two the plugin maintains itself. Both
 * passes are shown this map, which is what keeps a note from creating a second
 * page beside the one it belongs to.
 */
export function wikiPagePaths(app: App, settings: WikiForgeSettings): string[] {
  const maintained = new Set([settings.indexPath, settings.logPath]);
  return app.vault
    .getMarkdownFiles()
    .filter(f => f.path.startsWith(settings.wikiDir + '/') && !maintained.has(f.path))
    .map(f => f.path.slice(settings.wikiDir.length + 1))
    .sort();
}

/**
 * The map the prompts carry: the index, which lists every page with its title
 * and `tipo`, or the bare paths before an index exists. Tens of bytes per page,
 * so it is always affordable — unlike the whole wiki, which is not.
 */
async function readWikiMap(app: App, settings: WikiForgeSettings): Promise<string> {
  const answers = queriesFolderWithinWiki(settings.wikiDir, settings.queriesDir);
  const index = app.vault.getAbstractFileByPath(settings.indexPath);
  if (index instanceof TFile) return dropIndexSection(await app.vault.read(index), answers);
  return JSON.stringify(evidencePages(answers, wikiPagePaths(app, settings)));
}

/**
 * A note, distilled. Returns the answer to write and the pages that were read to
 * merge into, so the caller can say what happened.
 */
export interface Distillation {
  /** The FILE:/CONTENT:/---END--- answer whose blocks are to be written. */
  answer: string;
  /** Existing wiki pages that were read as CONTEXT for the second pass. */
  mergedInto: string[];
}

/**
 * Two passes, and the second one only runs when it has something to merge into.
 *
 * The first pass writes the note out as a page and, in doing so, names the pages
 * it belongs to. If none of those names exists yet — the usual case for a note
 * nobody has distilled — that answer is the page and nothing else is asked: one
 * model call, where the old analysis-then-merge pipeline always spent two.
 *
 * If they do exist, their content is read and a second pass merges the note into
 * them with that content in front of it. This is what makes the wiki accumulate.
 * The step used to be decided by asking the model which existing pages the note
 * belonged to, and it answered `[]` (measured with the file list, with the index
 * in front, and with the question reworded), so the merge never saw the page it
 * was about to overwrite and every pass rewrote it from scratch.
 */
async function distill(
  app: App,
  settings: WikiForgeSettings,
  apiKey: string,
  chunk: string,
  rules: string,
  onStep?: (step: string) => void,
): Promise<Distillation> {
  const map = await readWikiMap(app, settings);
  const instructions = (contract: string): string =>
    `${rules}\nWIKI INDEX (the pages that already exist):\n${map}\n${contract}`;

  if (onStep) onStep(STEP_DRAFT);
  const draft = await ensureBlocks(
    settings,
    apiKey,
    await askLlm(settings, apiKey, chunk, 'draft', instructions(DRAFT_OUTPUT_CONTRACT)),
    rules,
    onStep,
  );

  const named = new Set(
    parseFileBlocks(draft)
      .map(block => normalizeVaultPath(block.path, { baseDir: settings.wikiDir, ensureMd: true }))
      .filter((path): path is string => path !== null),
  );
  // A note distils into distilled pages: never into an earlier answer, which is
  // derived from them and would be rewritten from the note wholesale.
  const answers = queriesFolderWithinWiki(settings.wikiDir, settings.queriesDir);
  const existing = evidencePages(answers, wikiPagePaths(app, settings)).filter(path =>
    named.has(path),
  );
  if (existing.length === 0) return { answer: draft, mergedInto: [] };

  let ctx = '';
  for (const rel of existing) {
    const file = app.vault.getAbstractFileByPath(`${settings.wikiDir}/${rel}`);
    if (file instanceof TFile) ctx += `\n--- ${rel} ---\n${await app.vault.read(file)}\n`;
  }

  if (onStep) onStep(STEP_MERGE);
  const mergePrompt = `EXISTING PAGES TO MERGE INTO:\n${ctx}\nSOURCE NOTE:\n${chunk}`;
  const merged = await askLlm(settings, apiKey, mergePrompt, 'merge', instructions(MERGE_OUTPUT_CONTRACT));
  return { answer: await ensureBlocks(settings, apiKey, merged, rules, onStep), mergedInto: existing };
}

/**
 * How big a note may be before one distillation refuses it.
 *
 * The merge prompt carries the note **whole** — that is how the page is written
 * from it — and a source note far above this (a pasted chat, a bulk import) is
 * either sent and lost to a transport failure or billed as an enormous request.
 * Refusing with the size in the message is deliberate: silently truncating would
 * distil a note that is not the one in the vault, and a wiki built from parts of
 * notes is worse than a note that says it was skipped.
 */
const MAX_NOTE_BYTES = 200 * 1024;

/**
 * Names the two model calls, so a caller can show which one is running. One note
 * is minutes long with a model served on this machine, and "which half?" is the
 * difference between a progress line and a decoration.
 */
const STEP_DRAFT = 'drafting';
const STEP_MERGE = 'merging';
const STEP_FORMAT = 'reformatting';

/**
 * The answer, made readable — asking once for a reformat when the model answered
 * as a document instead of in blocks. See `FORMAT_OUTPUT_CONTRACT`.
 *
 * It costs a call, so it only runs when there is nothing to parse, and it runs
 * once: an answer that comes back with no blocks twice is reported as such
 * rather than retried forever.
 */
async function ensureBlocks(
  settings: WikiForgeSettings,
  apiKey: string,
  answer: string,
  rules: string,
  onStep?: (step: string) => void,
): Promise<string> {
  if (parseFileBlocks(answer).length > 0) return answer;
  if (onStep) onStep(STEP_FORMAT);
  return askLlm(settings, apiKey, `THE PAGE YOU WROTE:\n${answer}`, 'format', `${rules}\n${FORMAT_OUTPUT_CONTRACT}`);
}

/**
 * Refuses a note too big to distil in one go, before any model call is made.
 *
 * The prompt carries the note **whole** — that is how the page is written from
 * it — and a source note far above this (a pasted chat, a bulk import) is either
 * sent and lost to a transport failure or billed as an enormous request.
 * Refusing with the size in the message is deliberate: silently truncating would
 * distil a note that is not the one in the vault, and a wiki built from parts of
 * notes is worse than a note that says it was skipped.
 */
function assertNoteFits(chunk: string): void {
  if (chunk.length > MAX_NOTE_BYTES) {
    throw new Error(
      `note is ${Math.round(chunk.length / 1024)} KB and one distillation carries at most ` +
        `${MAX_NOTE_BYTES / 1024} KB — split it or leave it out (nothing was written)`,
    );
  }
}

/**
 * A page as it was written, and what the write told us about it.
 *
 * `added` is the answer to the question a successful-looking ingest can leave
 * hanging — *did the page learn anything?* — and it is measured here because
 * here is where the old text is still at hand (see `page-change.ts` for the
 * measurements that made it necessary).
 */
export interface WrittenPage {
  /** Path relative to the wiki folder. */
  path: string;
  /** True when the page did not exist before this write. */
  created: boolean;
  /** Statements the write added to a page that already existed. */
  added: string[];
}

/**
 * Writes the pages in the FILE:/CONTENT:/---END--- answer. Returns what it wrote.
 *
 * The parsing itself lives in `protocol.ts` (pure, and tested with the shapes
 * models actually produce); this only records what a well-formed block means.
 *
 * One correction on the way out: a page whose metadata came back wrapped in a
 * ```yaml fence is written with that metadata as real frontmatter. It is fixed
 * here, at the single door every page goes through, rather than asked for in the
 * prompt — the fence is the model reformatting **its own text**, which it does
 * faithfully, fence included (measured: three pages of `04-lisa` were written
 * that way and the wiki could not see their `tipo`).
 */
export async function processOutput(
  app: App,
  settings: WikiForgeSettings,
  output: string,
): Promise<WrittenPage[]> {
  const written: WrittenPage[] = [];
  const answers = queriesFolderWithinWiki(settings.wikiDir, settings.queriesDir);
  for (const block of parseFileBlocks(output)) {
    const path = normalizeVaultPath(block.path, { baseDir: settings.wikiDir, ensureMd: true });
    if (!path) continue;
    // The write is what would lose the answer, so the refusal is here and not
    // only in the map: a block naming the answers folder is dropped, and said
    // out loud, rather than written over a page a question produced.
    if (isAnswerNote(answers, path)) {
      console.warn(`WikiForge: refusing to distil into the answers folder: ${path}`);
      continue;
    }
    const vaultPath = `${settings.wikiDir}/${path}`;
    const existing = app.vault.getAbstractFileByPath(vaultPath);
    // Read *before* writing: what a merge adds can only be measured against the
    // text it replaced, and that text stops existing with the write below.
    const before = existing instanceof TFile ? await app.vault.read(existing) : null;
    const text = hoistFencedFrontmatter(block.text);
    await writeFileSafe(app, vaultPath, text);
    written.push({ path, created: before === null, added: addedStatements(before, text) });
  }
  return written;
}

/**
 * The index is rebuilt from the folder, not asked of the model.
 *
 * The version this replaces sent the whole index to the model on every sync and
 * asked for it back rewritten. That is where the pages left out of the index and
 * the entries pointing at names that never existed came from, and where the
 * model's leftovers accumulated. Reading the directory cannot drift, cannot
 * invent a name and costs nothing.
 *
 * It is deliberately not conditional on something having changed: a page deleted
 * by hand has to leave the index too, and no LLM call happens here anyway.
 */
async function refreshIndex(app: App, settings: WikiForgeSettings): Promise<void> {
  await rebuildWikiIndex(app, settings);
}

/** Appends a timestamped line to the wiki log. */
export async function appendLog(
  app: App,
  settings: WikiForgeSettings,
  message: string,
): Promise<void> {
  const stamp = new Date().toISOString();
  const line = `- ${stamp} — ${message}\n`;
  const file = app.vault.getAbstractFileByPath(settings.logPath);
  if (file instanceof TFile) {
    const current = await app.vault.read(file);
    await app.vault.modify(file, `${current.replace(/\s*$/, '')}\n${line}`);
  } else {
    await writeFileSafe(app, settings.logPath, `# WikiForge log\n\n${line}`);
  }
}

export interface SyncSummary {
  total: number;
  pending: number;
  alreadyDone: number;
  updated: string[];
  /**
   * Notes the model answered with no usable page for. They are deliberately
   * *not* recorded as done, so the next sync tries them again instead of
   * quietly leaving them out of the wiki forever.
   */
  noAnswer: number;
  /**
   * Notes that were distilled into pages which learned nothing: every page came
   * back saying what it already said, and no page was created. They *are*
   * recorded as done — the run worked — but a wiki that stops growing while the
   * log says "Processed" is the failure this count exists to make visible.
   */
  noProgress: string[];
  /** Set when the run stopped early because the provider refused for quota. */
  quotaStop: string | null;
  /**
   * How many notes the state had distilled under earlier rules, when the rules
   * changed since the last run. `null` when there is nothing to say — including
   * the first run after this was introduced, where no fingerprint is recorded
   * yet and silence is the honest answer.
   */
  rulesChanged: number | null;
}

/** Processes only new/modified notes, with per-file progress and state saving. */
export async function syncWiki(
  app: App,
  settings: WikiForgeSettings,
  apiKey: string,
  onProgress?: (done: number, total: number, label: string) => void,
  isCancelled?: () => boolean,
): Promise<SyncSummary> {
  const state = await loadState(app, settings);
  const rules = await readRules(app, settings);
  const fingerprint = rulesFingerprint(rules);
  // An *absent* fingerprint means "nothing recorded" (every state written before
  // this existed), never "the rules changed": the first run after the update has
  // to stay quiet, or it cries wolf about rules it was never told about.
  const rulesChanged =
    state.rulesHash !== undefined && state.rulesHash !== fingerprint
      ? Object.keys(state.files).length
      : null;
  if (rulesChanged !== null) {
    // Durable, because the Notice passes and this is the only record that the
    // pages carry an older prompt's work. Measured cost of not having it: the
    // identity rule was added to the rules file and *no* page changed, silently.
    await appendLog(
      app,
      settings,
      `Distillation rules changed since the last ingest: ${rulesChanged} note(s) keep what the earlier ` +
        'rules produced until they are distilled again ("Forget current note" + "Process current note", or a reset).',
    );
  }
  state.rulesHash = fingerprint;
  const sourceFiles = collectSourceFiles(app, settings, settings.includeJournal);
  const total = sourceFiles.length;

  const pending: TFile[] = [];
  let alreadyDone = 0;
  for (const f of sourceFiles) {
    const last = state.files[f.path];
    if (last === undefined || f.stat.mtime > last) pending.push(f);
    else alreadyDone++;
  }

  if (pending.length === 0) {
    // The fingerprint is written even with nothing to distil: skipped, a rules
    // change with no pending notes would be announced again on every later sync
    // until some note happened to be edited.
    if (rulesChanged !== null) await saveState(app, settings, state);
    if (onProgress) onProgress(0, 0, `Up to date — ${total} notes reviewed, none new.`);
    return { total, pending: 0, alreadyDone, updated: [], noAnswer: 0, noProgress: [], quotaStop: null, rulesChanged };
  }

  const updated: string[] = [];
  const noProgress: string[] = [];
  let noAnswer = 0;
  let quotaStop: string | null = null;
  let processed = 0;
  for (let i = 0; i < pending.length; i++) {
    if (isCancelled && isCancelled()) break;
    const f = pending[i];
    if (onProgress) onProgress(i + 1, pending.length, f.path);
    try {
      const txt = await app.vault.read(f);
      assertNoteFits(txt);
      const { answer } = await distill(app, settings, apiKey, txt, rules, next => {
        if (onProgress) onProgress(i + 1, pending.length, `${f.path} — ${next}`);
      });
      const written = await processOutput(app, settings, answer);
      updated.push(...written.map(page => page.path));
      // A page came out, so the note counts as done — *and* this is the place to
      // notice when none of them learned anything: every existing page came back
      // saying what it already said, and nothing new was created. Measured on
      // this vault, that is what three ingests of the note defining Lisa looked
      // like while the log said "Processed" (see `page-change.ts`).
      if (
        written.length > 0 &&
        !written.some(page => page.created) &&
        written.every(page => page.added.length === 0)
      ) {
        noProgress.push(f.path);
      }
      // A note counts as done only once a page came out of it. The answer that
      // produced nothing is prose, not a distillation: recording the note here
      // would hide it from every later sync, which is exactly how a note the
      // model could not handle disappears from the wiki without a word.
      if (written.length > 0) {
        state.files[f.path] = f.stat.mtime;
        await saveState(app, settings, state);
      } else {
        noAnswer++;
        if (onProgress) onProgress(i + 1, pending.length, `${f.path} — nothing written (${classifyEmptyAnswer(answer)})`);
      }
      processed++;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      console.error('WikiForge: error processing', f.path, e);
      new Notice(`WikiForge: error in ${f.name} — ${message}`);
      // A quota refusal is not this note's problem: the rest of the folder would
      // fail the same way, each one after a wait, and the run would look hung
      // rather than out of budget. Stop and say where it stopped; nothing is
      // lost, because the state is only written for notes that finished.
      if (isQuotaError(message)) {
        quotaStop = message;
        await appendLog(app, settings, `Sync stopped at ${f.path}: ${message}`);
        break;
      }
    }
  }

  await refreshIndex(app, settings);
  if (updated.length > 0) {
    await appendLog(
      app,
      settings,
      `Synced ${processed} of ${pending.length} pending note(s); ${updated.length} wiki page(s) updated.`,
    );
  }
  if (noAnswer > 0) {
    await appendLog(
      app,
      settings,
      `${noAnswer} note(s) produced no wiki page: the answer carried no FILE:/CONTENT: block. ` +
        'They stay pending, so the next sync retries them.',
    );
  }
  if (noProgress.length > 0) {
    await appendLog(
      app,
      settings,
      `${noProgress.length} note(s) distilled into pages that learned nothing — the merge added no new ` +
        `statement to any of them: ${noProgress.join(', ')}. The note is recorded as done; read those ` +
        'pages by hand, because a merge that copies is what this looks like from here.',
    );
  }

  return { total, pending: pending.length, alreadyDone, updated, noAnswer, noProgress, quotaStop, rulesChanged };
}

export interface IngestResult {
  /** Relative paths of the wiki pages that were written. */
  pages: string[];
  /** Why nothing was written, when nothing was. `null` as soon as one page was. */
  empty: EmptyAnswerReason | null;
  /**
   * Statements this distillation added to pages that already existed. Zero on a
   * merge that copied — which is not a failure of the run and is not reported as
   * one, but is the one number that says whether the wiki learned anything.
   */
  added: number;
  /** Whether any of the written pages did not exist before. */
  created: boolean;
}

/** Processes a single note (the active one) through the same pipeline. */
export async function processCurrentNote(
  app: App,
  settings: WikiForgeSettings,
  apiKey: string,
  file: TFile,
  onStep?: (step: string) => void,
): Promise<IngestResult> {
  const rules = await readRules(app, settings);
  const txt = await app.vault.read(file);
  assertNoteFits(txt);
  const { answer, mergedInto } = await distill(app, settings, apiKey, txt, rules, onStep);
  const written = await processOutput(app, settings, answer);
  const pages = written.map(page => page.path);
  const added = written.reduce((total, page) => total + page.added.length, 0);
  const created = written.some(page => page.created);
  await refreshIndex(app, settings);
  const empty = pages.length === 0 ? classifyEmptyAnswer(answer) : null;
  if (pages.length > 0) {
    const how =
      mergedInto.length > 0
        ? ` (merged into ${mergedInto.join(', ')})`
        : ' (new page)';
    // The log line records what the run *did*; the tail records the one thing it
    // cannot show by itself, which is whether anything was learned (see
    // `page-change.ts` for why this had to be measured).
    const nothing = created || added > 0
      ? ''
      : ' — no statement added: the pages kept what they already said';
    await appendLog(app, settings, `Processed ${file.path} → ${pages.join(', ')}${how}${nothing}`);
    // Same rule as the sync: only a note that reached the wiki counts as done.
    const state = await loadState(app, settings);
    state.files[file.path] = file.stat.mtime;
    // This note was just written by the rules currently on disk, so the stamp is
    // accurate: a single-note ingest is not the moment to warn about the rules
    // changing, but it is the moment the wiki catches up with them.
    state.rulesHash = rulesFingerprint(rules);
    await saveState(app, settings, state);
  }
  return { pages, empty, added, created };
}