import { App, Modal } from 'obsidian';
import type { WikiReport } from '../wiki-check';
import { summarizeRepairs, type PageRepair } from '../wiki-clean';

/** The summary of a check, with the way in to the repairs it found. */
export class WikiReportModal extends Modal {
  constructor(
    app: App,
    private readonly report: WikiReport,
    private readonly reportPath: string,
    private readonly onReviewFixes: () => void,
  ) {
    super(app);
  }

  onOpen(): void {
    this.titleEl.setText('WikiForge — Wiki check');
    this.contentEl.empty();
    const r = this.report;

    if (r.pages === 0) {
      this.contentEl.createEl('p', { text: 'The wiki folder holds no pages yet, so there is nothing to check.' });
      return;
    }

    const rows: Array<[string, number]> = [
      ['Pages', r.pages],
      ['Links', r.links],
      ['Broken links (missing target)', r.brokenLinks.length],
      ['Pages the index does not list', r.missingFromIndex.length],
      ['Index entries pointing nowhere', r.staleIndexEntries.length],
      ['Orphan pages (no link from another page)', r.orphans.length],
      ['Leftover blocks / markers', r.artifacts.length],
      ['Pages with a source that does not resolve', r.untraceable.length],
    ];
    const table = this.contentEl.createEl('table', { cls: 'wf-report-table' });
    for (const [label, value] of rows) {
      const tr = table.createEl('tr');
      tr.createEl('td', { text: label });
      tr.createEl('td', { text: String(value), cls: value > 0 ? 'wf-report-warn' : 'wf-report-ok' });
    }

    const missing = r.missingFromIndex.length;
    if (missing > 0) {
      // This is the finding that matters most: the index is the entry point of
      // every query, so a page missing from it cannot be reached or answered from.
      this.contentEl.createEl('p', {
        cls: 'wf-report-note',
        text:
          `${missing} page(s) are not in the index. The index is the entry point of every query, ` +
          'so those pages are invisible to "Ask the wiki" until it is rebuilt.',
      });
    }

    this.contentEl.createEl('p', {
      text: `Full report: ${this.reportPath}`,
    });

    const fixes = r.fixableLinks + r.fixableArtifacts;
    const buttons = this.contentEl.createEl('div', { cls: 'wf-report-buttons' });
    const review = buttons.createEl('button', {
      text: fixes > 0 ? `Review ${fixes} mechanical fix(es)…` : 'Rebuild the index…',
      cls: 'mod-cta',
    });
    review.addEventListener('click', () => {
      this.close();
      this.onReviewFixes();
    });
    const close = buttons.createEl('button', { text: 'Close' });
    close.addEventListener('click', () => this.close());
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

/**
 * The preview before anything is written: what will change, page by page.
 * Applying also rebuilds the index, because that is the other half of the
 * mechanical cleanup and it is measured from the folder, not guessed.
 */
export class WikiFixesModal extends Modal {
  constructor(
    app: App,
    private readonly repairs: PageRepair[],
    private readonly onApply: (repairs: PageRepair[]) => void,
    private readonly rebuildLabel: string,
  ) {
    super(app);
  }

  onOpen(): void {
    this.titleEl.setText('WikiForge — Mechanical cleanup');
    this.contentEl.empty();
    const summary = summarizeRepairs(this.repairs);

    if (this.repairs.length === 0) {
      this.contentEl.createEl('p', { text: 'Nothing to repair mechanically. The index will still be rebuilt.' });
    } else {
      this.contentEl.createEl('p', {
        text:
          `${summary.links} broken link(s) and ${summary.artifacts} leftover(s) in ${summary.pages} page(s). ` +
          'The previous text stays in the vault history if you need it back.',
      });
      const list = this.contentEl.createEl('div', { cls: 'wf-fix-list' });
      for (const repair of this.repairs) {
        const block = list.createEl('div', { cls: 'wf-fix-page' });
        block.createEl('div', { text: repair.path, cls: 'wf-fix-path' });
        for (const fix of repair.fixes) {
          const row = block.createEl('div', { cls: 'wf-fix-row' });
          row.createEl('span', { text: fix.kind === 'link' ? 'link' : 'leftover', cls: `wf-fix-kind wf-fix-kind--${fix.kind}` });
          row.createEl('span', { text: fix.detail });
        }
      }
    }

    this.contentEl.createEl('p', { cls: 'wf-report-note', text: this.rebuildLabel });

    const buttons = this.contentEl.createEl('div', { cls: 'wf-report-buttons' });
    const apply = buttons.createEl('button', { text: 'Apply', cls: 'mod-cta' });
    apply.addEventListener('click', () => {
      this.close();
      this.onApply(this.repairs);
    });
    const cancel = buttons.createEl('button', { text: 'Cancel' });
    cancel.addEventListener('click', () => this.close());
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
