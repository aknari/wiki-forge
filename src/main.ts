import { Notice, Plugin, TFile } from 'obsidian';
import { DEFAULT_SETTINGS, migrateSettings, type WikiForgeSettings } from './settings';
import { isLocalEndpoint } from './endpoints';
import { clearApiKeys, readApiKey, writeApiKey, type SecretStore } from './secrets';
import { appendLog, collectSourceFiles, syncWiki, processCurrentNote } from './forge';
import { searchSources } from './query';
import { forgetFile, loadState, resetState } from './state';
import { queriesFolderWithinWiki } from './query-note';
import { planReset } from './wiki-reset';
import { ResetWikiModal } from './ui/reset-modal';
import { DEFAULT_FORGE_RULES, DEFAULT_QUERY_RULES } from './prompts';
import {
  applyWikiRepairs,
  gatherWikiCheck,
  planWikiRepairs,
  readWikiPages,
  rebuildWikiIndex,
  wikiRelative,
  writeWikiReport,
} from './wiki-vault';
import type { PageRepair } from './wiki-clean';
import { QueryModal, type IngestOutcome } from './ui/query-modal';
import { startTicker } from './ui/ticker';

/** The one wording for "this needs a key and there is none". */
const NO_KEY_NOTICE =
  'WikiForge: no API key configured — add one in Settings → WikiForge. A model served on this machine needs none.';
import { SyncProgressModal } from './ui/sync-progress';
import { WikiFixesModal, WikiReportModal } from './ui/wiki-report-modal';
import { WikiForgeSettingsTab } from './ui/settings-tab';

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export default class WikiForgePlugin extends Plugin {
  settings: WikiForgeSettings = { ...DEFAULT_SETTINGS };

  async onload(): Promise<void> {
    await this.loadSettings();

    // The UI is registered before anything that can fail. Creating the rule
    // files is a vault write, and doing it first meant that a failure there
    // (or simply a slow one) left the plugin loaded but invisible — no settings
    // tab, no commands — until it was toggled off and on again.
    this.addSettingTab(new WikiForgeSettingsTab(this.app, this));
    this.addRibbonIcon('sparkles', 'WikiForge', () => void this.openQuery());

    this.addCommand({ id: 'sync-wiki', name: 'Sync wiki', callback: () => void this.runSync() });
    this.addCommand({
      id: 'process-current-note',
      name: 'Process current note',
      callback: () => void this.runCurrentNote(),
    });
    this.addCommand({ id: 'ask-wiki', name: 'Ask the wiki…', callback: () => void this.openQuery() });
    this.addCommand({ id: 'check-wiki', name: 'Check wiki (report)', callback: () => void this.runCheck() });
    this.addCommand({
      id: 'clean-wiki',
      name: 'Clean wiki (mechanical fixes)',
      callback: () => void this.runClean(),
    });
    this.addCommand({
      id: 'forget-current-note',
      name: 'Forget current note (re-distil on the next sync)',
      callback: () => void this.forgetCurrentNote(),
    });
    this.addCommand({
      id: 'reset-wiki',
      name: 'Reset the wiki…',
      callback: () => void this.openReset(),
    });

    // Reported, never fatal: the plugin keeps working with the files it finds.
    void this.ensureRuleFiles().catch(e => {
      new Notice(
        `WikiForge: could not create the rule files — ${e instanceof Error ? e.message : String(e)}`,
      );
    });
    // Awaited: fired and forgotten, this key read could resolve *after* the user
    // saved a new key and flip the flag back to false.
    await this.refreshKeyFlag();
  }

  async loadSettings(): Promise<void> {
    // migrateSettings folds an older data.json (single `srcDir`) into the shape
    // this version uses, so an update never silently loses a folder.
    this.settings = { ...this.settings, ...migrateSettings(await this.loadData()) };
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  /**
   * Secret storage abstraction.
   * - Modern Obsidian (1.11.4+): app.secretStorage (synchronous methods).
   * - Older versions: async Plugin.setSecret/getSecret.
   */
  async secretStore(): Promise<SecretStore | null> {
    const appStorage = this.app.secretStorage;
    if (appStorage) {
      return {
        set: async (id, secret) => {
          appStorage.setSecret(id, secret);
        },
        get: async id => appStorage.getSecret(id) ?? null,
        remove: async id => {
          appStorage.deleteSecret(id);
        },
      };
    }
    if (typeof this.setSecret === 'function' && typeof this.getSecret === 'function') {
      return {
        set: async (id, secret) => {
          await (this.setSecret as (id: string, secret: string) => Promise<void>)(id, secret);
        },
        get: async id => (await (this.getSecret as (id: string) => Promise<string | null>)(id)) ?? null,
      };
    }
    return null;
  }

  async getApiKey(): Promise<string | null> {
    const store = await this.secretStore();
    if (!store) return null;
    return readApiKey(store);
  }

  /**
   * The key to run with, or `null` when one is required and missing.
   *
   * An empty string is a valid answer: a model served on this machine needs no
   * key at all (LM Studio, Ollama and llama.cpp ignore the header), so the plugin
   * stops asking for something the server does not have. Only the
   * OpenAI-compatible provider has a configurable address, so this can never
   * loosen anything for Gemini.
   */
  async apiKeyForRun(): Promise<string | null> {
    const stored = (await this.getApiKey()) ?? '';
    if (stored !== '') return stored;
    if (this.settings.provider === 'openai' && isLocalEndpoint(this.settings.baseUrl)) return '';
    return null;
  }

  async setApiKey(value: string): Promise<void> {
    const store = await this.secretStore();
    if (!store) {
      throw new Error('This Obsidian version does not expose a secret-storage API.');
    }
    await writeApiKey(store, value);
    this.settings.apiKeyConfigured = true;
    await this.saveSettings();
  }

  async clearApiKey(): Promise<void> {
    const store = await this.secretStore();
    if (!store) return;
    await clearApiKeys(store);
    this.settings.apiKeyConfigured = false;
    await this.saveSettings();
  }

  async refreshKeyFlag(): Promise<void> {
    const key = await this.getApiKey();
    const configured = key !== null;
    if (configured !== this.settings.apiKeyConfigured) {
      this.settings.apiKeyConfigured = configured;
      await this.saveSettings();
    }
  }

  /** Creates the rule files with their embedded defaults on first load. */
  async ensureRuleFiles(): Promise<void> {
    await this.ensureFile(this.settings.forgeRulesPath, DEFAULT_FORGE_RULES);
    await this.ensureFile(this.settings.queryRulesPath, DEFAULT_QUERY_RULES);
  }

  private async ensureFile(path: string, content: string): Promise<void> {
    const existing = this.app.vault.getAbstractFileByPath(path);
    if (existing instanceof TFile) return;
    const parent = path.substring(0, path.lastIndexOf('/'));
    if (parent && !this.app.vault.getAbstractFileByPath(parent)) {
      await this.app.vault.createFolder(parent);
    }
    await this.app.vault.create(path, content);
  }

  async runSync(): Promise<void> {
    const apiKey = await this.apiKeyForRun();
    if (apiKey === null) {
      new Notice(NO_KEY_NOTICE);
      return;
    }
    const modal = new SyncProgressModal(this.app);
    modal.open();
    try {
      const summary = await syncWiki(
        this.app,
        this.settings,
        apiKey,
        (done, total, label) => modal.update(done, total, label),
        () => modal.cancelled,
      );
      modal.close();
      if (summary.quotaStop !== null) {
        // Reported at length, and kept on screen: this one is not a passing
        // error, it is the reason the run ended, and it names what to do next.
        new Notice(
          `WikiForge: stopped — the provider refused for quota, so the remaining notes were not sent ` +
            `(${summary.updated.length} page(s) updated). ${summary.quotaStop}`,
          15000,
        );
      } else {
        new Notice(
          summary.pending === 0
            ? `WikiForge: up to date — ${summary.total} notes reviewed, none new.`
            : `WikiForge: ${summary.pending} note(s) processed, ${summary.updated.length} page(s) updated.` +
              (summary.noProgress.length > 0
                ? ` ${summary.noProgress.length} of them added no statement to any page (the merge copied): see ` +
                  'the log for which ones.'
                : '') +
              (summary.noAnswer > 0
                ? ` ${summary.noAnswer} produced no page (no FILE:/CONTENT: answer) and stay pending for the next run.`
                : ''),
        );
      }
      if (summary.rulesChanged !== null) {
        // Reported after the sync's own result, and kept on screen: it is not a
        // failure but it is the one thing a run cannot tell you by itself — the
        // pages are the work of rules that are no longer the ones on disk.
        new Notice(
          `WikiForge: the distillation rules changed since the last ingest, so ${summary.rulesChanged} note(s) ` +
            'keep what the earlier rules produced. Re-ingest them ("Forget current note") or reset the wiki to apply the new rules.',
          15000,
        );
      }
      if (this.settings.checkAfterSync) await this.refreshCheck(true);
    } catch (e) {
      modal.close();
      new Notice(`WikiForge: sync failed — ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  async runCurrentNote(): Promise<void> {
    const file = this.app.workspace.getActiveFile();
    if (!file) {
      new Notice('WikiForge: no active note.');
      return;
    }
    await this.ingestFile(file);
  }

  /**
   * Distils one note into the wiki. Shared by the command (the active note) and
   * by the suggestions list in the query panel (a note the wiki cannot answer
   * from yet), because both are the same operation: one note, on demand.
   *
   * It *returns* what happened instead of only announcing it. A Notice fades,
   * so a caller that turns this into a status line needs the outcome, not the
   * side effect — and swallowing the error here is how a failed ingest came to
   * be reported as a successful one.
   */
  async ingestFile(file: TFile): Promise<IngestOutcome> {
    const apiKey = await this.apiKeyForRun();
    if (apiKey === null) {
      new Notice(NO_KEY_NOTICE);
      return {
        ok: false,
        updated: 0,
        error: NO_KEY_NOTICE.replace('WikiForge: ', ''),
        empty: null,
        added: 0,
        created: false,
      };
    }
    // A run is minutes long with a model served on this machine, so the notice
    // is created once and its text rewritten: the seconds tick and the step name
    // says which of the two calls it is on. A message that only appears at the
    // end cannot tell a slow run from a stuck one, which is how this was asked.
    let step = 'starting';
    const progress = new Notice(`WikiForge: ${file.name} — ${step}…`, 0);
    const stop = startTicker(seconds => progress.setMessage(`WikiForge: ${file.name} — ${step}… ${seconds}s`));

    let outcome: IngestOutcome;
    try {
      const result = await processCurrentNote(this.app, this.settings, apiKey, file, next => {
        step = next;
      });
      outcome = {
        ok: true,
        updated: result.pages.length,
        error: null,
        empty: result.empty,
        added: result.added,
        created: result.created,
      };
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
    progress.hide();

    // Pages written and pages *learned from* are not the same success, and saying
    // "2 page(s) updated" for a merge that copied them back is how an ingest that
    // changed nothing reads as one that worked.
    const learnedNothing = outcome.ok && outcome.updated > 0 && !outcome.created && outcome.added === 0;
    new Notice(
      outcome.ok
        ? outcome.updated === 0
          ? 'WikiForge: nothing written — the note stays pending, see the panel.'
          : learnedNothing
            ? `WikiForge: ${outcome.updated} page(s) rewritten, but the merge added no statement — the pages ` +
              'came back saying what they already said. Re-ingesting the same note will not change that.'
            : `WikiForge: ${outcome.updated} page(s) updated.`
        : `WikiForge: error — ${outcome.error}`,
      // An error is worth reading; a result is worth a glance, and a silent merge
      // is the one result worth more than a glance.
      outcome.ok ? (learnedNothing ? 15000 : 5000) : 15000,
    );
    if (outcome.ok && this.settings.checkAfterSync) await this.refreshCheck(false);
    return outcome;
  }

  /**
   * Measures the wiki, writes the report and offers the repairs it found.
   * Read-only apart from the report itself.
   */
  async runCheck(): Promise<void> {
    try {
      const { report } = await gatherWikiCheck(this.app, this.settings);
      await writeWikiReport(this.app, this.settings, report);
      const fixes = report.fixableLinks + report.fixableArtifacts;
      new Notice(
        `WikiForge: ${report.pages} page(s), ${report.brokenLinks.length} broken link(s), ` +
          `${report.missingFromIndex.length} not in the index${fixes > 0 ? `, ${fixes} fix(es) available` : ''}.`,
      );
      new WikiReportModal(this.app, report, this.settings.reportPath, () => void this.runClean()).open();
    } catch (e) {
      new Notice(`WikiForge: the wiki check failed — ${message(e)}`);
    }
  }

  /** Shows what the mechanical cleanup would change, before it changes it. */
  async runClean(): Promise<void> {
    try {
      const repairs = await planWikiRepairs(this.app, this.settings);
      new WikiFixesModal(
        this.app,
        repairs,
        list => void this.applyClean(list),
        'Applying also rebuilds the index from the folder, so every page ends up listed.',
      ).open();
    } catch (e) {
      new Notice(`WikiForge: could not plan the cleanup — ${message(e)}`);
    }
  }

  private async applyClean(repairs: PageRepair[]): Promise<void> {
    try {
      const written = await applyWikiRepairs(this.app, this.settings, repairs);
      await rebuildWikiIndex(this.app, this.settings);
      const { report } = await gatherWikiCheck(this.app, this.settings);
      await writeWikiReport(this.app, this.settings, report);
      await appendLog(
        this.app,
        this.settings,
        `Mechanical cleanup: ${written} page(s) rewritten of ${repairs.length} reviewed, index rebuilt.`,
      );
      new Notice(
        `WikiForge: ${written} page(s) repaired, index rebuilt — ${report.brokenLinks.length} broken link(s) left.`,
      );
    } catch (e) {
      new Notice(`WikiForge: the cleanup failed — ${message(e)}`);
    }
  }

  /**
   * Forgets one note, so the next sync distils it again.
   *
   * The counterpart of deleting a page by hand. "Process current note" always
   * runs, so a lone page comes back without this — but the state keeps counting
   * the note as done, and a note the state counts as done is one a sync will
   * never revisit. This is the way back for a page whose whole topic should be
   * rebuilt through the sync, alongside everything else.
   */
  async forgetCurrentNote(): Promise<void> {
    const file = this.app.workspace.getActiveFile();
    if (!file) {
      new Notice('WikiForge: no active note.');
      return;
    }
    try {
      const forgotten = await forgetFile(this.app, this.settings, file.path);
      new Notice(
        forgotten
          ? `WikiForge: ${file.name} will be distilled again on the next sync.`
          : `WikiForge: ${file.name} was not marked as ingested — nothing to forget.`,
      );
    } catch (e) {
      new Notice(`WikiForge: could not update the sync state — ${message(e)}`);
    }
  }

  /** The three inputs a reset plan is built from, read the same way twice. */
  private async resetPlanInput(): Promise<{
    pages: string[];
    maintained: string[];
    answersRel: string | null;
  }> {
    const pages = await readWikiPages(this.app, this.settings);
    return {
      pages: pages.map(page => page.path),
      maintained: [
        wikiRelative(this.settings.indexPath, this.settings.wikiDir),
        wikiRelative(this.settings.logPath, this.settings.wikiDir),
      ],
      // `''` is "no answers folder inside the wiki" everywhere else in the
      // plugin, and it must not arrive here as a folder name: as a prefix, the
      // empty string matches every page.
      answersRel: queriesFolderWithinWiki(this.settings.wikiDir, this.settings.queriesDir) || null,
    };
  }

  /**
   * Shows what a reset would delete, and what it would cost, before deleting it.
   * Nothing is written here: the modal is the whole point, because a reset makes
   * the entire source folder pending again and that is the surprise worth
   * avoiding.
   */
  async openReset(): Promise<void> {
    try {
      const input = await this.resetPlanInput();
      const state = await loadState(this.app, this.settings);
      new ResetWikiModal(this.app, {
        ...input,
        ingested: Object.keys(state.files).length,
        sourceCount: collectSourceFiles(this.app, this.settings, this.settings.includeJournal).length,
        onConfirm: keep => void this.applyReset(keep),
      }).open();
    } catch (e) {
      new Notice(`WikiForge: could not plan the reset — ${message(e)}`);
    }
  }

  private async applyReset(keepAnswers: boolean): Promise<void> {
    try {
      const input = await this.resetPlanInput();
      const plan = planReset(input.pages, {
        maintained: input.maintained,
        answersFolder: keepAnswers ? input.answersRel : null,
      });

      let deleted = 0;
      for (const rel of plan.remove) {
        const target = this.app.vault.getAbstractFileByPath(`${this.settings.wikiDir}/${rel}`);
        if (target instanceof TFile) {
          // No `force`: deleted files follow the user's own setting, so a reset
          // sends them to the trash rather than obliterating them.
          await this.app.vault.delete(target);
          deleted++;
        }
      }
      // After the pages, and before anything else: the state is what would make
      // the wiki look up to date with nothing in it.
      const forgotten = await resetState(this.app, this.settings);
      await rebuildWikiIndex(this.app, this.settings);
      await appendLog(
        this.app,
        this.settings,
        `Wiki reset: ${deleted} page(s) deleted, ${plan.keep.length} kept${keepAnswers ? ' (saved answers preserved)' : ''}, ` +
          `${forgotten} note(s) forgotten — the next sync distils from the sources again.`,
      );
      new Notice(
        `WikiForge: wiki reset — ${deleted} page(s) deleted, ${forgotten} note(s) pending again. ` +
          'Run "Sync wiki" when you are ready to distil them.',
        15000,
      );
    } catch (e) {
      new Notice(`WikiForge: the reset failed — ${message(e)}`);
    }
  }

  /**
   * Refreshes the report from the sync path. It never throws on purpose: a
   * failure of the *checker* must not be reported as a failure of the sync.
   */
  private async refreshCheck(notify: boolean): Promise<void> {
    try {
      const { report } = await gatherWikiCheck(this.app, this.settings);
      await writeWikiReport(this.app, this.settings, report);
      const fixes = report.fixableLinks + report.fixableArtifacts;
      if (notify && fixes > 0) {
        new Notice(
          `WikiForge: wiki check — ${report.brokenLinks.length} broken link(s), ${fixes} mechanical fix(es) available. ` +
            `Report: ${this.settings.reportPath}`,
        );
      }
    } catch (e) {
      console.error('WikiForge: the wiki check failed', e);
    }
  }

  openQuery(): void {
    new QueryModal({
      app: this.app,
      settings: this.settings,
      getApiKey: () => this.apiKeyForRun(),
      ingest: file => this.ingestFile(file),
      searchSources: question => searchSources(this.app, this.settings, question),
    }).open();
  }
}