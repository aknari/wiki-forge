import { App, Modal, Setting } from 'obsidian';
import { planReset } from '../wiki-reset';

export interface ResetWikiRequest {
  /** Wiki-relative paths of every page in the folder. */
  pages: string[];
  /** Wiki-relative paths the plugin maintains itself (index, log). */
  maintained: string[];
  /** Wiki-relative answers folder, or `null` when there is none inside the wiki. */
  answersRel: string | null;
  /** Notes the sync state counts as ingested. */
  ingested: number;
  /** Notes a sync will have to distil from scratch once the state is cleared. */
  sourceCount: number;
  /** Called with the answers decision, only if the user confirms. */
  onConfirm: (keepAnswers: boolean) => void;
}

/**
 * The confirmation before anything is deleted, and the only place the real cost
 * of a reset is stated.
 *
 * The cost is the reason this modal exists. A reset makes every source note
 * pending again, so the sync that follows distils the whole folder at two model
 * calls a note — minutes on a model served on this machine, and the run looks
 * hung rather than expensive. Saying the number beforehand is what turns that
 * from a surprise into a decision, and the list of pages is what turns
 * "start from scratch" from a hope into something you can check first.
 */
export class ResetWikiModal extends Modal {
  private keepAnswers = true;
  private planEl!: HTMLElement;

  constructor(
    app: App,
    private readonly request: ResetWikiRequest,
  ) {
    super(app);
  }

  onOpen(): void {
    this.titleEl.setText('WikiForge — Reset the wiki');
    this.contentEl.empty();

    this.contentEl.createEl('p', {
      text:
        'A reset deletes the distilled pages and clears the sync state. Both halves are needed: ' +
        'the state is what decides whether a sync has anything to distil, so pages deleted with ' +
        'the state intact never come back and the plugin keeps reporting the wiki as up to date.',
    });

    if (this.request.answersRel !== null) {
      new Setting(this.contentEl)
        .setName('Keep the saved answers')
        .setDesc(
          `Pages under ${this.request.answersRel}/ are answers given to earlier questions, not knowledge ` +
            'distilled from your notes. They go too if you turn this off.',
        )
        .addToggle(toggle =>
          toggle.setValue(true).onChange(value => {
            this.keepAnswers = value;
            this.renderPlan();
          }),
        );
    } else {
      this.contentEl.createEl('p', {
        cls: 'wf-report-note',
        text: 'No answers folder is configured inside the wiki folder, so there is nothing of that kind to keep.',
      });
    }

    this.planEl = this.contentEl.createEl('div');
    this.renderPlan();

    this.contentEl.createEl('p', {
      cls: 'wf-report-note',
      text:
        `The state counts ${this.request.ingested} note(s) as done. Afterwards, "Sync wiki" (or distilling ` +
        `note by note) has ${this.request.sourceCount} note(s) to work through, two model calls each — ` +
        'so on a model served on this machine this is a job to start deliberately, not to glance at.',
    });
    this.contentEl.createEl('p', {
      cls: 'wf-report-note',
      text: 'The pages go to your Obsidian trash, so nothing is lost by accident.',
    });

    const buttons = this.contentEl.createEl('div', { cls: 'wf-report-buttons' });
    const reset = buttons.createEl('button', { text: 'Reset the wiki', cls: 'mod-warning' });
    reset.addEventListener('click', () => {
      this.close();
      this.request.onConfirm(this.keepAnswers);
    });
    const cancel = buttons.createEl('button', { text: 'Cancel' });
    cancel.addEventListener('click', () => this.close());
  }

  /** The plan for the current answers decision, shown before it is carried out. */
  private renderPlan(): void {
    const el = this.planEl;
    el.empty();
    const plan = planReset(this.request.pages, {
      maintained: this.request.maintained,
      answersFolder: this.keepAnswers ? this.request.answersRel : null,
    });

    if (plan.remove.length === 0) {
      el.createEl('p', {
        text: 'Nothing would be deleted: the wiki folder holds no pages of its own. The state is still cleared.',
      });
    } else {
      el.createEl('p', { text: `${plan.remove.length} page(s) will be deleted:` });
      const list = el.createEl('div', { cls: 'wf-fix-list' });
      for (const path of plan.remove) list.createEl('div', { text: path, cls: 'wf-fix-path' });
    }

    if (plan.keep.length > 0) {
      const keptAnswers = plan.keep.filter(entry => entry.reason === 'answers').length;
      const keptMaintained = plan.keep.length - keptAnswers;
      const parts: string[] = [];
      if (keptAnswers > 0) parts.push(`${keptAnswers} saved answer(s)`);
      if (keptMaintained > 0) parts.push(`${keptMaintained} maintained by the plugin`);
      el.createEl('p', { text: `${plan.keep.length} page(s) kept: ${parts.join(', ')}.` });
    }
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
