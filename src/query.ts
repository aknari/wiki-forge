import { App, TFile } from 'obsidian';
import type { WikiForgeSettings } from './settings';
import { askLlm } from './llm';
import { writeFileSafe } from './state';
import { DEFAULT_QUERY_RULES } from './prompts';
import {
  answerNotePath,
  evidencePages,
  queriesFolderWithinWiki,
  renderAnswerNote,
} from './query-note';
import { reconcileAnswerSources } from './answer-sources';
import {
  queryTerms,
  rankSources,
  recencyCandidates,
  type SourceDoc,
  type SourceHit,
} from './search';
import { isSourcePath } from './sources';
import { parsePageNames, resolveCandidates } from './suggestions';
import { rebuildWikiIndex } from './wiki-vault';
import { wikiPagePaths } from './forge';

export interface QueryResult {
  answer: string;
  /** The pages the answer was actually built from, as vault paths. */
  sources: string[];
  suggestions: string[];
  /**
   * Names the answer cites in its *Fuentes* section that match no page that
   * exists, left in the text as written. Reported so the panel can say it
   * instead of letting a link that leads nowhere read as a citation.
   */
  unresolved: string[];
  /**
   * How many wiki pages were read to build the answer, and how many there were.
   *
   * The selection phase is a model call at temperature 0.2, and measured on this
   * vault it is a draw: with the same question and the same index, three runs
   * returned five pages, five pages and **two** — and the two-page run is the
   * one that answered that the wiki did not know what Lisa was, because the page
   * it left out is the one that says RISC-V. A page not read cannot be answered
   * from, so the extent of the reading travels with the answer.
   */
  pagesRead: number;
  pagesAvailable: number;
  /**
   * What the fallback looked at, when the wiki had no answer. `null` when the
   * wiki answered.
   *
   * It travels to the panel because "no answer found" is only honest with its own
   * extent attached: a search over 20 of 179 notes and a search that came up empty
   * over all of them look identical on screen, and they mean opposite things.
   */
  search: RawSearch | null;
}

/** How the candidate notes were chosen, and how much of the vault that covered. */
export interface RawSearch {
  /** `keywords`: the question's terms. `recency`: no usable term, so the newest. */
  mode: 'keywords' | 'recency';
  /** The terms the question was reduced to. Empty means "nothing to search for". */
  terms: string[];
  /** Notes that matched the terms, before the limit on how many are shown. */
  matched: number;
  /** Notes in the pool that was searched. */
  available: number;
  /** Notes actually handed to the model. */
  considered: number;
}

/** How many source notes the fallback will hand the model to choose from. */
const FALLBACK_LIMIT = 20;
/**
 * How many wiki pages the local keyword pass may add to the model's selection.
 *
 * A cap and not a target: the point is to close the gap the draw leaves, not to
 * read the whole wiki on every question — which would undo the reason the index
 * is the entry point at all.
 */
const WIKI_KEYWORD_LIMIT = 3;
/** Notes per configured area in the recency fallback (the pre-keyword behaviour). */
const RECENCY_PER_AREA = 15;

/** What a local source search found: the ranked hits, and the size of the pool. */
export interface SourceSearch {
  hits: SourceHit[];
  /** Notes that matched, before the limit on how many are shown. */
  matched: number;
  /** Notes that were searched at all. */
  available: number;
}

async function readTextFile(app: App, path: string): Promise<string | null> {
  const f = app.vault.getAbstractFileByPath(path);
  if (f instanceof TFile) return app.vault.read(f);
  return null;
}

/**
 * Which existing pages the model says answer the question.
 *
 * The answer is *resolved against the pages that are really there*, never taken
 * as a file name. It has to be: the index the model is shown lists pages as
 * wikilinks (`[[lisa-architecture-overview|Arquitectura de Lisa]]`) and the query
 * rules ask in so many words for "the pages (`[[wikilinks]]`)", so it answers
 * `[[lisa-architecture-overview]]`. Comparing that against a file name — brackets
 * and all — matched nothing, the context came out empty, and every question fell
 * through to the raw-note fallback even with the answer already in the wiki.
 */
async function getRelevantPages(
  settings: WikiForgeSettings,
  apiKey: string,
  question: string,
  indexContent: string,
  rules: string,
  pages: readonly string[],
): Promise<string[]> {
  const prompt =
    `${rules}\nQUESTION:\n${question}\nINDEX:\n${indexContent}\n` +
    `Reply with ONLY the JSON list of relevant wiki files.`;
  const ans = await askLlm(settings, apiKey, prompt, 'selection');
  return resolveCandidates(parsePageNames(ans), pages);
}

/**
 * The pool the fallback searches: every note the sync would distil, plus the
 * journal whether or not the journal setting includes it.
 *
 * The journal is in on purpose. A suggestion is a note the panel may *point at*,
 * and a journal note answers a question as well as any other; when the row cannot
 * be ingested it says why, instead of offering a dead button.
 */
async function readSourceDocs(app: App, settings: WikiForgeSettings): Promise<SourceDoc[]> {
  const docs: SourceDoc[] = [];
  for (const file of app.vault.getMarkdownFiles()) {
    if (!isSourcePath(file.path, settings, true)) continue;
    // `cachedRead`, not `read`: the text is already in memory for every open or
    // recently indexed note, and scoring the *whole* source set per question is
    // only affordable because of it. The first query pays for the rest.
    docs.push({ path: file.path, text: await app.vault.cachedRead(file), mtime: file.stat.mtime });
  }
  return docs;
}

/**
 * The ranked source notes for a question: local, deterministic, no model call.
 *
 * This is what "search the sources" means, and it is the path that still works
 * when the model does not: a machine with no key, a quota that ran out, a local
 * server that closed the connection mid-answer. All three have been seen here.
 */
export async function searchSources(
  app: App,
  settings: WikiForgeSettings,
  question: string,
): Promise<SourceSearch> {
  const docs = await readSourceDocs(app, settings);
  const hits = rankSources(question, docs);
  return { hits: hits.slice(0, FALLBACK_LIMIT), matched: hits.length, available: docs.length };
}

/**
 * The fallback for a question the wiki cannot answer: which *source* notes might
 * hold it.
 *
 * Two stages, and the order is the point. The candidates are chosen **locally, by
 * the question's own words**, over the whole source set; only then is the model
 * asked which of those twenty holds the answer. It used to be the other way
 * round — the model chose from the fifteen newest notes of each area — and the
 * measured cost was that the note identifying the subject of the question sat at
 * position 44 of 101, never offered, with the wiki reporting that it had no
 * answer. Chasing recency is not searching.
 */
async function searchRawFallback(
  app: App,
  settings: WikiForgeSettings,
  apiKey: string,
  question: string,
): Promise<{ paths: string[]; search: RawSearch }> {
  const docs = await readSourceDocs(app, settings);
  const terms = queryTerms(question);
  const hits = rankSources(question, docs);
  const mode: RawSearch['mode'] = hits.length > 0 ? 'keywords' : 'recency';
  const candidates =
    hits.length > 0
      ? hits.slice(0, FALLBACK_LIMIT).map(hit => hit.path)
      : recencyCandidates(
          docs,
          [settings.checkboxDir, settings.journalDir, ...settings.srcDirs],
          RECENCY_PER_AREA,
        );
  const search: RawSearch = {
    mode,
    terms,
    matched: hits.length,
    available: docs.length,
    considered: candidates.length,
  };
  if (!candidates.length) return { paths: [], search };

  const prompt =
    `Search: ${question}\nFiles:\n${JSON.stringify(candidates)}\n` +
    `Which one contains the answer? Answer with the exact path, copied from the list, one per line. ` +
    `Nothing else.`;
  const ans = await askLlm(settings, apiKey, prompt, 'fallback');
  // The lines are resolved against the candidates that were sent: a model that
  // answers with the bare file name (which is most of the time) used to produce
  // a "path" that exists nowhere, and the panel could neither open nor ingest it.
  const answers = ans
    .split('\n')
    .map(l => l.trim())
    .filter(l => l.includes('.md'));
  return { paths: resolveCandidates(answers, candidates), search };
}

/** Full query pipeline: index → selection → read → synthesize (with raw fallback). */
export async function askWiki(
  app: App,
  settings: WikiForgeSettings,
  apiKey: string,
  question: string,
): Promise<QueryResult> {
  // The pages are listed before the index is read: they are what the answer is
  // matched against, and they double as the index when there is none (the same
  // fallback `forge.ts` uses), so a missing index is a thinner query and not a
  // query with nothing in its prompt.
  const pages = wikiPagePaths(app, settings);
  // The pool an answer may be built from: the distilled pages only. An earlier
  // answer is a page, and it is listed in the index, but reading one back into a
  // new answer lets a stale answer — an error included — cite itself. It stays
  // in the index (findable, auditable); it is never a source (see isAnswerNote).
  const evidence = evidencePages(
    queriesFolderWithinWiki(settings.wikiDir, settings.queriesDir),
    pages,
  );
  const indexContent = (await readTextFile(app, settings.indexPath)) ?? JSON.stringify(evidence);
  const rules = (await readTextFile(app, settings.queryRulesPath)) ?? DEFAULT_QUERY_RULES;

  const chosen = await getRelevantPages(settings, apiKey, question, indexContent, rules, evidence);
  // The model's judgement first, then the pages its answer left out but whose own
  // text mentions the question's words. Local, deterministic, no key: the model
  // can *add* pages to the answer, and it can no longer take away a page that
  // plainly speaks about what was asked (see `pagesRead`).
  const matched = await keywordPages(app, settings, question, evidence, chosen);
  const targetNames = [...chosen, ...matched];

  const sources: string[] = [];
  let ctx = '';
  for (const name of targetNames) {
    const p = app.vault.getAbstractFileByPath(`${settings.wikiDir}/${name}`);
    if (p instanceof TFile) {
      ctx += `\n--- ${p.name} ---\n${await app.vault.read(p)}\n`;
      sources.push(p.path);
    }
  }

  if (ctx) {
    const answer = await askLlm(
      settings,
      apiKey,
      `${rules}\nDATA:\n${ctx}\nQUESTION:\n${question}`,
      'synthesis',
    );
    // The answer's own `Fuentes` list is pointed at pages that exist before
    // anyone reads it: a name the model got wrong looks like a link and leads
    // nowhere, and that list is the one a reader checks the answer against. What
    // cannot be resolved is left as written and reported (see the module).
    const wikiRoot = settings.wikiDir.replace(/\/+$/u, '');
    const knownPaths = pages.map(page => (wikiRoot === '' ? page : `${wikiRoot}/${page}`));
    const reconciled = reconcileAnswerSources(answer, knownPaths);
    return {
      answer: reconciled.answer,
      sources,
      suggestions: [],
      unresolved: reconciled.unresolved,
      pagesRead: sources.length,
      pagesAvailable: evidence.length,
      search: null,
    };
  }

  const { paths, search } = await searchRawFallback(app, settings, apiKey, question);
  return {
    answer: '',
    sources: [],
    suggestions: paths,
    unresolved: [],
    pagesRead: 0,
    pagesAvailable: evidence.length,
    search,
  };
}

/**
 * The wiki pages that mention the question's words, best first, read locally.
 *
 * The same `rankSources` the source search uses, over the wiki instead of over
 * `00-src`: `Lisa` in a page's title is worth more than a mention in its body and
 * repeats stop counting past a cap, so a long page cannot bury the list by being
 * long. No model, no key, and the same answer twice — which is the whole point,
 * because the selection it complements is a draw.
 */
async function keywordPages(
  app: App,
  settings: WikiForgeSettings,
  question: string,
  pages: readonly string[],
  already: readonly string[],
): Promise<string[]> {
  const docs: SourceDoc[] = [];
  for (const rel of pages) {
    if (already.includes(rel)) continue;
    const file = app.vault.getAbstractFileByPath(`${settings.wikiDir}/${rel}`);
    if (file instanceof TFile) {
      // `cachedRead`: the wiki is small and its text is in memory for any page
      // that has been opened since startup.
      docs.push({ path: rel, text: await app.vault.cachedRead(file), mtime: file.stat.mtime });
    }
  }
  return rankSources(question, docs)
    .slice(0, WIKI_KEYWORD_LIMIT)
    .map(hit => hit.path);
}

/**
 * Saves a query answer to `queriesDir/YYYY-MM-DD-HHMM.md` (format decided in
 * `query-note.ts`) and rebuilds the index.
 *
 * The rebuild is the point when the folder is inside the wiki: a page the index
 * does not list cannot be found by any later query, so without this a saved
 * answer would look like it had done nothing until the next sync. Local work,
 * no model call — and it must not turn a good save into a failure notice, so a
 * rebuild that throws is logged and the save still reports success.
 */
export async function saveAnswerToNote(
  app: App,
  settings: WikiForgeSettings,
  question: string,
  answer: string,
  sources: string[],
): Promise<string> {
  const now = new Date();
  const path = answerNotePath(settings.queriesDir, now);
  await writeFileSafe(app, path, renderAnswerNote(question, answer, sources, now));
  try {
    await rebuildWikiIndex(app, settings);
  } catch (e) {
    console.error('WikiForge: the answer was saved, but the index could not be rebuilt', e);
  }
  return path;
}