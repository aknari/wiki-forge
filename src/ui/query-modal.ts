import { App, MarkdownRenderer, Modal, Notice, TFile } from 'obsidian';
import type { WikiForgeSettings } from '../settings';
import {
  askWiki,
  saveAnswerToNote,
  type QueryResult,
  type RawSearch,
  type SourceSearch,
} from '../query';
import { queryTerms } from '../search';
import { isSourcePath } from '../sources';
import { emptyAnswerMessage, type EmptyAnswerReason } from '../protocol';
import { startTicker } from './ticker';

export interface QueryContext {
  app: App;
  settings: WikiForgeSettings;
  getApiKey: () => Promise<string | null>;
  /** Distils one note into the wiki. What the suggestions list offers as a second step. */
  ingest: (file: TFile) => Promise<IngestOutcome>;
  /**
   * Ranks the source notes against a question. Local and deterministic — no
   * model, so it needs no key and it answers while a model would still be
   * connecting.
   */
  searchSources: (question: string) => Promise<SourceSearch>;
}

/** What an ingest did, so the panel can say it instead of guessing. */
export interface IngestOutcome {
  ok: boolean;
  /** How many wiki pages the note changed. */
  updated: number;
  /** Why it failed, in the provider's own words. `null` when it worked. */
  error: string | null;
  /**
   * When nothing was written, why: the model ignored the protocol, or it tried
   * and the block was unusable. `null` whenever a page came out, and on the
   * paths that never got as far as a model answer.
   */
  empty: EmptyAnswerReason | null;
  /**
   * Statements the merge added to pages that already existed. Zero on a merge
   * that copied the pages back — the run worked and the wiki learned nothing,
   * which are two different things and used to read the same on screen.
   */
  added: number;
  /** Whether any page was created, in which case everything on it is new. */
  created: boolean;
}

/**
 * What the fallback looked at, in words.
 *
 * "No answer found in the wiki." is true and misleading at once, because the
 * sentence that ought to follow depends entirely on how much was searched. One
 * number is the difference between "your notes do not say this" and "this looked
 * in a fifth of your notes" — and with the old recency window the second was the
 * usual case while the panel said the first.
 */
function describeSearch(search: RawSearch): string {
  if (search.mode === 'recency') {
    return (
      `No word of the question could be searched for, so the ${search.considered} newest of the ` +
      `${search.available} source notes were checked instead. Phrase it with a distinctive word — a ` +
      'name, a technology — and it becomes a search.'
    );
  }
  const share = search.available > 0 ? Math.round((search.considered / search.available) * 100) : 0;
  return (
    `${search.matched} of the ${search.available} source notes mention “${search.terms.join(', ')}”; ` +
    `the ${search.considered} best were offered to the model (${share}% of the sources). ` +
    '“Search the sources” ranks them locally, with no model.'
  );
}

export class QueryModal extends Modal {
  private question = '';
  private result: QueryResult | null = null;
  private resultEl!: HTMLElement;
  private sourcesEl!: HTMLElement;
  private saveBtn!: HTMLElement;

  constructor(private readonly ctx: QueryContext) {
    super(ctx.app);
  }

  onOpen(): void {
    this.titleEl.setText('WikiForge — Ask the wiki…');
    this.contentEl.empty();

    const input = this.contentEl.createEl('textarea', { cls: 'wf-query-textarea' }) as HTMLTextAreaElement;
    input.placeholder = 'Your question about the wiki…';
    input.addEventListener('input', () => {
      this.question = input.value;
    });

    // Ask and Save share one row, above the answer. Save used to be the last
    // element of the panel — after the answer, which ends with its own "Fuentes"
    // section (the query rules ask for one) and therefore makes the panel look
    // finished right there. The button existed, and this is why nobody ever saw
    // it. The Save end of the row is pushed right by `wf-query-save`.
    const actions = this.contentEl.createEl('div', { cls: 'wf-query-actions' });
    const askBtn = actions.createEl('button', { text: 'Ask', cls: 'mod-cta' });
    askBtn.addEventListener('click', () => {
      if (this.question.trim()) void this.run(this.question.trim());
    });

    input.addEventListener('keydown', ev => {
      if (ev.key === 'Enter' && (ev.metaKey || ev.ctrlKey)) {
        ev.preventDefault();
        if (this.question.trim()) void this.run(this.question.trim());
      }
    });

    // Next to Ask on purpose: it answers the other half of the question. "Is this
    // in the wiki?" is Ask; "where in my notes is this at all?" is this, and the
    // second one is what you need when the first says no.
    const searchBtn = actions.createEl('button', { text: 'Search the sources' });
    searchBtn.addEventListener('click', () => void this.runSourceSearch());

    this.saveBtn = actions.createEl('button', {
      text: 'Save to note',
      cls: 'mod-cta wf-query-save',
    });
    this.saveBtn.style.display = 'none';
    this.saveBtn.addEventListener('click', () => void this.save());

    this.resultEl = this.contentEl.createEl('div', { cls: 'wf-query-result' });
    this.sourcesEl = this.contentEl.createEl('div', { cls: 'wf-query-sources' });
  }

  onClose(): void {
    // nothing to clean up
  }

  private async run(question: string): Promise<void> {
    // `null` means "one is needed and there is none": an empty string is how a
    // local server runs, and it is not a problem to report.
    const apiKey = await this.ctx.getApiKey();
    if (apiKey === null) {
      new Notice(
        'WikiForge: no API key configured — add one in Settings → WikiForge. A model served on this machine needs none.',
      );
      return;
    }
    this.resultEl.empty();
    this.sourcesEl.empty();
    this.saveBtn.style.display = 'none';
    const stop = startTicker(seconds => this.resultEl.setText(`Thinking… ${seconds}s`));
    try {
      this.result = await askWiki(this.ctx.app, this.ctx.settings, apiKey, question);
    } catch (e) {
      this.resultEl.empty();
      this.resultEl.setText(`Error: ${e instanceof Error ? e.message : String(e)}`);
      return;
    } finally {
      // Stopped *before* anything is drawn, and the order matters: the counter
      // writes into the very element the answer goes in, so a tick landing after
      // the answer arrived would replace it with "Thinking… 12s".
      stop();
    }
    // Awaited, and that is the fix for a button nobody could see: a failure
    // inside `renderResult` used to become an unhandled rejection — the panel
    // kept whatever had already been painted and reported nothing.
    await this.renderResult();
  }

  private async renderResult(): Promise<void> {
    this.resultEl.empty();
    if (!this.result) return;
    if (this.result.answer) {
      // The way to keep the answer is set up *before* the markdown is rendered,
      // and the order is the whole point: `MarkdownRenderer.render` appends the
      // content to the DOM first and returns a promise (embeds, post-processors)
      // that can fail or never settle. With this line after that await, a failing
      // render took it with it — an unhandled rejection, since `run()` did not
      // await this method — and the panel showed the answer and no button, which
      // is how a save button that worked came to look like one that was not
      // there.
      //
      // The pages used to be listed here too, under a "Sources" heading. The
      // query rules already require the answer itself to end with a *Fuentes*
      // section, so the panel was repeating the same information, and only one of
      // the two copies was clickable (the answer's are wikilinks) while the other
      // was plain text. The list still travels with the answer into the saved
      // note (`fuentes` frontmatter) and into the log.
      this.sourcesEl.empty();
      if (this.ctx.settings.saveAnswersToNote) {
        this.saveBtn.style.display = '';
      }
      try {
        await MarkdownRenderer.render(
          this.ctx.app,
          this.result.answer,
          this.resultEl,
          // A real path, not `''`: a post-processor from another plugin looks the
          // note up by `ctx.sourcePath`, and an empty string is not a note.
          this.ctx.settings.indexPath,
          this,
        );
      } catch (e) {
        // This render is not ours to fail: Obsidian appends the content first
        // and returns a promise that covers *every* plugin's post-processor, so
        // a rejection here can mean another plugin crashed, with the answer
        // already drawn. Falling back to plain text is only right when nothing
        // was drawn at all — doing it unconditionally threw away a render that
        // had worked, links and all. The reason stays in the console.
        console.error('WikiForge: the markdown render reported a failure', e);
        if (!this.resultEl.textContent?.trim()) this.resultEl.setText(this.result.answer);
      }
      // A citation the plugin could not resolve is the one thing about this
      // answer the text itself will not show: it looks like every other link.
      // Said here, before it is saved, instead of only turning up later in the
      // page `Check wiki` reports.
      // How much of the wiki answered from. The selection is a model call, and
      // measured on this vault it is a draw: the same question read five pages
      // on one run and two on the next, and the two-page run is the one that
      // reported the wiki did not know what Lisa was. A page not read cannot be
      // cited, so a short read is said instead of passing as a full answer.
      if (this.result.pagesRead < this.result.pagesAvailable) {
        this.sourcesEl.createEl('p', {
          cls: 'wf-query-hint',
          text:
            `This answer was built from ${this.result.pagesRead} of the ` +
            `${this.result.pagesAvailable} wiki pages, chosen from the index. Ask again for another look — ` +
            'the selection is the model’s, and the same question does not always read the same pages.',
        });
      }
      if (this.result.unresolved.length > 0) {
        this.sourcesEl.createEl('p', {
          cls: 'wf-query-warn',
          text:
            `This answer cites ${this.result.unresolved.length} name(s) that match no page in the wiki: ` +
            `${this.result.unresolved.join(', ')}. They stay in the text as written, and Check wiki ` +
            'keeps reporting them in the saved page.',
        });
      }
    } else {
      this.resultEl.createEl('p', { text: 'No answer found in the wiki.' });
      if (this.result.search) {
        this.sourcesEl.createEl('p', { cls: 'wf-query-hint', text: describeSearch(this.result.search) });
      }
      if (this.result.suggestions.length > 0) {
        this.sourcesEl.empty();
        this.sourcesEl.createEl('h4', { text: 'Suggestions (not ingested yet)' });
        // The fallback returns notes, not answers: the wiki cannot answer from a
        // note it has never distilled. So the list is not an answer to read, it
        // is a step to take — and saying so is the difference between a panel
        // that looks broken and one that explains itself.
        this.sourcesEl.createEl('p', {
          cls: 'wf-query-hint',
          text:
            'These notes are not in the wiki yet, so it cannot answer from them. ' +
            'Open one to read it, or ingest it to distil it into the wiki and ask again.',
        });
        for (const sug of this.result.suggestions) this.renderSuggestion(sug);
      }
    }
  }

  /**
   * One suggestion: the note as a link, and the way to ingest it when that is
   * allowed. A note that cannot be ingested says why instead of leaving a dead
   * button — the journal is deliberately out of the sources, and a note inside
   * an excluded folder is skipped on purpose.
   */
  private renderSuggestion(path: string, detail?: string): void {
    const s = this.ctx.settings;
    // A block per suggestion, because a result line has to land under its own
    // note: appended to the list, it would show up under whichever row is last.
    const block = this.sourcesEl.createEl('div', { cls: 'wf-suggestion-block' });
    const row = block.createEl('div', { cls: 'wf-suggestion-row' });
    const file = this.ctx.app.vault.getAbstractFileByPath(path);

    const open = row.createEl('button', { text: path, cls: 'wf-suggestion' }) as HTMLButtonElement;
    if (file instanceof TFile) {
      open.addEventListener('click', () => {
        // A modal blocks the workspace, so it has to close before the note can
        // be read — otherwise the note opens behind a panel the user cannot see past.
        this.close();
        void this.ctx.app.workspace.openLinkText(path, '');
      });
    } else {
      open.disabled = true;
    }

    if (file instanceof TFile && isSourcePath(path, s, s.includeJournal)) {
      const ingest = row.createEl('button', { text: 'Ingest', cls: 'wf-suggestion-ingest' }) as HTMLButtonElement;
      ingest.addEventListener('click', () => void this.ingestOne(file, ingest, block));
    } else {
      row.createEl('span', { text: this.whyNotIngested(path), cls: 'wf-suggestion-why' });
    }

    if (detail !== undefined && detail !== '') {
      block.createEl('div', { text: detail, cls: 'wf-suggestion-terms' });
    }
  }

  private whyNotIngested(path: string): string {
    const s = this.ctx.settings;
    return isSourcePath(path, s, true)
      ? 'in the journal, and “Include journal in sync” is off'
      : 'outside the sources folder, so it is not distilled';
  }

  /**
   * Ingests one suggestion and reports the real outcome next to it.
   *
   * The seconds counter is not decoration: one note is a model call that can
   * take a minute, the rest of the panel does not move while it runs, and the
   * only other signal is a Notice that has already faded. Without it, a slow
   * call and a stuck one look exactly the same — which is how this was first
   * reported. The error is printed in full and the button stays usable, so a
   * bad key does not require reloading the plugin to try again.
   */
  private async ingestOne(file: TFile, button: HTMLButtonElement, block: HTMLElement): Promise<void> {
    button.disabled = true;
    const stop = startTicker(seconds => button.setText(`Ingesting… ${seconds}s`));

    let outcome: IngestOutcome;
    try {
      outcome = await this.ctx.ingest(file);
    } catch (e) {
      outcome = {
        ok: false,
        updated: 0,
        error: e instanceof Error ? e.message : String(e),
        empty: null,
        added: 0,
        created: false,
      };
    }
    stop();

    if (outcome.ok) {
      if (outcome.updated === 0) {
        // The run itself worked; what failed is the answer. Saying "Ingested"
        // here was a lie the button used to tell whatever had happened.
        button.setText('Nothing written — try again');
        block.createEl('div', {
          cls: 'wf-suggestion-error',
          text: emptyAnswerMessage(outcome.empty ?? 'no-markers'),
        });
        return;
      }
      // The run worked and the pages learned nothing. Saying "Ingested" here is
      // true and useless: measured on this vault, `00 - Desarrollo de Lisa.md`
      // was ingested three times into a page that came back byte for byte as it
      // was, and the panel kept offering the same note as a suggestion.
      if (!outcome.created && outcome.added === 0) {
        button.setText('Ingested — nothing new');
        block.createEl('div', {
          cls: 'wf-suggestion-note',
          text:
            'The pages came back saying what they already said: this merge added no statement. ' +
            'Ingesting the same note again will do the same — read the pages, or reset them and ' +
            'distil the note into a clean draft.',
        });
        return;
      }
      button.setText('Ingested — ask again');
      return;
    }

    button.setText('Failed — try again');
    button.disabled = false;
    block.createEl('div', { cls: 'wf-suggestion-error', text: outcome.error ?? 'Unknown error.' });
  }

  /**
   * The local search, on demand. No key, no model, no waiting on a server.
   *
   * The results are notes, ranked by what the question actually says, so the list
   * is worth reading even when the model is unavailable — which is the situation
   * this was written in, between a quota of 429s and a local server closing the
   * connection mid-answer.
   */
  private async runSourceSearch(): Promise<void> {
    const question = this.question.trim();
    if (!question) {
      new Notice('WikiForge: type what you are looking for first.');
      return;
    }
    this.resultEl.empty();
    this.sourcesEl.empty();
    this.saveBtn.style.display = 'none';
    let found: SourceSearch;
    try {
      found = await this.ctx.searchSources(question);
    } catch (e) {
      this.resultEl.setText(`Error: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    this.renderSourceHits(question, found);
  }

  /** The ranked source notes, each one a step to take rather than an answer. */
  private renderSourceHits(question: string, found: SourceSearch): void {
    const terms = queryTerms(question);
    this.sourcesEl.createEl('h4', { text: 'Source notes, best match first' });

    if (terms.length === 0) {
      this.sourcesEl.createEl('p', {
        cls: 'wf-query-hint',
        text:
          'The question has no distinctive word to search for, so there was nothing to rank the ' +
          `notes by. ${found.available} source notes were looked at.`,
      });
      return;
    }

    this.sourcesEl.createEl('p', {
      cls: 'wf-query-hint',
      text:
        found.matched === 0
          ? `None of the ${found.available} source notes mentions “${terms.join(', ')}”.`
          : `${found.matched} of the ${found.available} source notes mention “${terms.join(', ')}”, ` +
            `best ${found.hits.length} first. These are notes, not answers: open one to read it, or ` +
            'ingest it to distil it into the wiki.',
    });

    for (const hit of found.hits) this.renderSuggestion(hit.path, `matches: ${hit.matched.join(', ')}`);
  }

  private async save(): Promise<void> {
    if (!this.result?.answer) return;
    try {
      const path = await saveAnswerToNote(
        this.ctx.app,
        this.ctx.settings,
        this.question,
        this.result.answer,
        this.result.sources,
      );
      new Notice(`WikiForge: saved → ${path}`);
    } catch (e) {
      console.error('WikiForge: failed to save answer', e);
      new Notice('WikiForge: could not save the answer to a note.');
    }
  }
}