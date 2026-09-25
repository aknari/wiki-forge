import { Modal } from 'obsidian';

export class SyncProgressModal extends Modal {
  cancelled = false;
  private statusEl!: HTMLElement;
  private fillEl!: HTMLElement;

  onOpen(): void {
    this.titleEl.setText('WikiForge — Sync wiki');
    this.contentEl.empty();
    this.contentEl.createEl('p', { text: 'Processing notes…' });
    const track = this.contentEl.createEl('div', { cls: 'wf-progress-track' });
    this.fillEl = track.createEl('div', { cls: 'wf-progress-fill' });
    this.statusEl = this.contentEl.createEl('p', { cls: 'wf-progress-status' });
    const cancel = this.contentEl.createEl('button', { text: 'Cancel' });
    cancel.addEventListener('click', () => {
      this.cancelled = true;
      this.close();
    });
  }

  onClose(): void {
    // nothing to clean up
  }

  update(done: number, total: number, label: string): void {
    this.statusEl.setText(label || `${done}/${total}`);
    this.fillEl.style.width = total > 0 ? `${Math.round((done / total) * 100)}%` : '100%';
  }
}