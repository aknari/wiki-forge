import { App, Modal, Notice, PluginSettingTab, Setting } from 'obsidian';
import type WikiForgePlugin from '../main';
import { isLocalEndpoint } from '../endpoints';
import { listModels } from '../llm';
import { API_KEY_SECRET } from '../secrets';
import { buildModelChoices, modelLabel, modelsForEndpoint } from '../models';
import type { Provider } from '../settings';

/** Sentinel in the model dropdown: ask for a name instead of picking one. */
const CUSTOM_MODEL = '__custom__';

const errorMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * Obsidian has no built-in prompt, and the fetched list may not contain the
 * model you want (a brand-new one, or a local name), so this is the escape
 * hatch behind the dropdown's “Write a model name…” option.
 */
class ModelNameModal extends Modal {
  constructor(
    app: App,
    private readonly current: string,
    private readonly onSubmit: (model: string) => void | Promise<void>,
  ) {
    super(app);
  }

  onOpen(): void {
    this.contentEl.createEl('h3', { text: 'Model name' });
    this.contentEl.createEl('p', {
      text: 'Type it exactly as the provider expects it (e.g. gemini-2.5-flash, qwen/qwen3.8-27b, llama3.2).',
    });
    const input = this.contentEl.createEl('input') as unknown as HTMLInputElement;
    input.type = 'text';
    input.value = this.current;
    input.style.width = '100%';
    const submit = (): void => {
      const value = input.value.trim();
      if (value === '') {
        new Notice('WikiForge: enter a model name.');
        return;
      }
      this.close();
      void this.onSubmit(value);
    };
    input.addEventListener('keydown', event => {
      if (event.key === 'Enter') {
        event.preventDefault();
        submit();
      }
    });
    new Setting(this.contentEl)
      .addButton(btn => btn.setButtonText('Cancel').onClick(() => this.close()))
      .addButton(btn => btn.setButtonText('Use this model').setCta().onClick(submit));
    setTimeout(() => input.focus(), 0);
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

export class WikiForgeSettingsTab extends PluginSettingTab {
  /** Key typed but not saved yet; kept across the re-renders of this tab. */
  private pendingKey = '';

  constructor(
    app: App,
    private readonly plugin: WikiForgePlugin,
  ) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    const s = this.plugin.settings;

    containerEl.createEl('p', {
      text: 'WikiForge distils the notes inside the sources folder into the wiki folder, and then answers questions about them. Only the prompts travel to the model; nothing is uploaded on its own.',
    });

    // --------------------------------------------------------------- provider
    new Setting(containerEl).setName('LLM provider').setHeading();
    new Setting(containerEl)
      .setName('Provider')
      .setDesc('Google Gemini directly, or any OpenAI-compatible API (OpenRouter, Groq, LM Studio, Ollama…).')
      .addDropdown(dd =>
        dd
          .addOption('google', 'Google Gemini')
          .addOption('openai', 'OpenAI-compatible')
          .setValue(s.provider)
          .onChange(async value => {
            s.provider = value as Provider;
            await this.plugin.saveSettings();
            this.display(); // the fetched model list belongs to one provider
          }),
      );
    // Gemini has one fixed address, so this row only exists when it is needed.
    if (s.provider === 'openai') {
      new Setting(containerEl)
        .setName('Base URL')
        .setDesc('Where the OpenAI-compatible API lives. Default: https://openrouter.ai/api/v1 — for a local server, http://localhost:11434/v1 (Ollama) or http://localhost:1234/v1 (LM Studio).')
        .addText(text =>
          text.setPlaceholder('https://openrouter.ai/api/v1').setValue(s.baseUrl).onChange(async value => {
            s.baseUrl = value.trim();
            await this.plugin.saveSettings();
          }),
        );
    }

    // ------------------------------------------------------------------ model
    // The cached list belongs to one endpoint. When it comes from another, its
    // models are not choices here and the saved one is marked as such, instead
    // of being shown as a normal choice of this provider.
    const { models: fetched, foreignCache } = modelsForEndpoint(s.modelCache, s.provider, s.baseUrl);
    const patterns = s.freeTierPatterns;
    const { models: choices, hidden, offered } = buildModelChoices(s.model, fetched, {
      hidePatterns: s.hiddenModelPatterns,
      freePatterns: patterns,
    });
    new Setting(containerEl)
      .setName('Model')
      .setDesc(
        foreignCache
          ? 'The model below was chosen for another provider or base URL. Press “Fetch models” to load the list from this one, then pick a model.'
          : offered > 0
            ? `${offered} chat model(s) offered by the provider${hidden.length > 0 ? `, ${hidden.length} hidden by your patterns` : ''}${s.provider === 'google' ? ', free-tier names first' : ''}. Pick one, or “Write a model name…” if yours is not listed.`
            : 'No model list yet: press “Save & test” on the key below and the list will fill up here.',
      )
      .addDropdown(dd => {
        for (const model of choices) {
          const current = model === s.model;
          dd.addOption(model, modelLabel(model, patterns, current, current && foreignCache));
        }
        dd.addOption(CUSTOM_MODEL, 'Write a model name…');
        dd.setValue(s.model);
        dd.onChange(async value => {
          if (value === CUSTOM_MODEL) {
            new ModelNameModal(this.app, s.model, async model => {
              s.model = model;
              await this.plugin.saveSettings();
              this.display();
            }).open();
            dd.setValue(s.model); // cancelling keeps the current model selected
            return;
          }
          s.model = value;
          await this.plugin.saveSettings();
        });
      })
      .addButton(btn =>
        btn.setButtonText('Fetch models').onClick(async () => {
          // A local server lists its models with no key at all.
          const key = await this.plugin.apiKeyForRun();
          if (key === null) {
            new Notice('WikiForge: no key stored yet — save one below first.');
            return;
          }
          try {
            const count = await this.fetchAndCacheModels(key);
            new Notice(`WikiForge: ${count} model(s) fetched.`);
            this.display();
          } catch (e) {
            new Notice(`WikiForge: could not fetch the model list — ${errorMessage(e)}`);
          }
        }),
      );

    // What the provider's metadata cannot tell you. Groq declares the modality
    // of each model, so its Whisper and Orpheus models are already left out of
    // the list above; a guard classifier is text-in/text-out, though, and no
    // field distinguishes it from a chat model. Hence the patterns.
    new Setting(containerEl)
      .setName('Hide models')
      .setDesc('One pattern per line: a model whose name contains one is left out of the list above. A line starting with `!` overrides that and brings it back (e.g. `!safeguard`). Defaults: whisper, tts, orpheus, embed, rerank, guard — none of those can hold a conversation, and not every provider says so. Empty the list to see everything, then press “Fetch models” to redraw the list with the new patterns.')
      .addTextArea(text =>
        text.setValue(s.hiddenModelPatterns.join('\n')).onChange(async value => {
          s.hiddenModelPatterns = value.split('\n').map(x => x.trim()).filter(Boolean);
          await this.plugin.saveSettings();
        }),
      );

    // Gemini is the provider that needs the hint: for an OpenAI-compatible API
    // the list is whatever your endpoint serves, free or not.
    if (s.provider === 'google') {
      new Setting(containerEl)
        .setName('Free-tier name patterns')
        .setDesc('Only labels the list above: Google does not say which models are free, so a model whose name contains one of these (one per line) is shown as “free tier”. Default: `flash` minus `!tts` and `!image` — the Pro models left the free tier in April 2026, and a line starting with `!` is an exclusion (it wins over the inclusions), so you can drop the speech and image variants that carry `flash` in their name. Empty the list to stop labelling.')
        .addTextArea(text =>
          text.setValue(s.freeTierPatterns.join('\n')).onChange(async value => {
            s.freeTierPatterns = value.split('\n').map(x => x.trim()).filter(Boolean);
            await this.plugin.saveSettings();
          }),
        );
    }

    // -------------------------------------------------------------- API key
    new Setting(containerEl)
      .setName('API key')
      .setDesc(
        s.apiKeyConfigured
          ? `A key is stored in Obsidian's secret storage under “${API_KEY_SECRET}”. Type a new one to replace it, or leave the box empty to test the stored one.`
          : s.provider === 'openai' && isLocalEndpoint(s.baseUrl)
            ? `Not needed: the base URL is on this machine, so requests go out without a key. Store one only if your server asks for it.`
            : `Stored in Obsidian's secret storage (the system keychain, shared by every plugin) under “${API_KEY_SECRET}” — never in data.json nor in any vault file.`,
      )
      .addText(text => {
        // Obsidian's TextComponent has no setType(): its inputEl is a real
        // <input>, so the type is set on the element itself. Calling a method
        // that does not exist here used to break this chain, which is why the
        // buttons of this row (and every row below it) never rendered.
        text.inputEl.type = 'password';
        text.inputEl.autocomplete = 'off';
        text.inputEl.spellcheck = false;
        text
          .setPlaceholder(s.apiKeyConfigured ? 'Stored — type to replace' : 'Enter API key')
          .setValue(this.pendingKey)
          .onChange(value => {
            this.pendingKey = value;
          });
      })
      .addButton(btn =>
        btn.setButtonText('Save & test').setCta().onClick(async () => {
          const typed = this.pendingKey.trim();
          // Saving and testing are reported apart on purpose: "it did not like
          // the key" and "the key could not be stored" are different problems
          // and only one of them is the provider's fault.
          if (typed !== '') {
            try {
              await this.plugin.setApiKey(typed);
            } catch (e) {
              new Notice(`WikiForge: the key could not be stored — ${errorMessage(e)}`);
              this.display();
              return;
            }
          }
          const key = typed !== '' ? typed : await this.plugin.apiKeyForRun();
          if (key === null) {
            new Notice('WikiForge: enter an API key first.');
            return;
          }
          try {
            const count = await this.fetchAndCacheModels(key);
            this.pendingKey = '';
            new Notice(
              typed !== ''
                ? `WikiForge: key saved and working — ${count} model(s) available.`
                : `WikiForge: the stored key works — ${count} model(s) available.`,
            );
          } catch (e) {
            new Notice(
              `WikiForge: the key is stored, but the provider rejected it — ${errorMessage(e)}`,
            );
          }
          this.display();
        }),
      )
      .addButton(btn =>
        btn.setButtonText('Clear').onClick(async () => {
          await this.plugin.clearApiKey();
          this.pendingKey = '';
          new Notice('WikiForge: key cleared.');
          this.display();
        }),
      );

    // -------------------------------------------------------------- folders
    new Setting(containerEl).setName('Folders').setHeading();
    const addPath = (name: string, key: keyof typeof s, desc?: string): void => {
      new Setting(containerEl)
        .setName(name)
        .setDesc(desc ?? '')
        .addText(text =>
          text.setValue(String(s[key])).onChange(async value => {
            (s as unknown as Record<string, unknown>)[key as string] = value.trim();
            await this.plugin.saveSettings();
          }),
        );
    };
    new Setting(containerEl)
      .setName('Sources folders')
      .setDesc('One folder per line. Every .md inside them is distilled into the wiki, and the excluded names below are skipped in each of them.')
      .addTextArea(text =>
        text.setValue(s.srcDirs.join('\n')).onChange(async value => {
          s.srcDirs = value.split('\n').map(x => x.trim()).filter(Boolean);
          await this.plugin.saveSettings();
        }),
      );
    addPath('Journal folder', 'journalDir');
    addPath('Wiki folder', 'wikiDir');
    addPath('Support folder', 'supportDir');
    addPath('Forge rules file', 'forgeRulesPath');
    addPath('Query rules file', 'queryRulesPath');
    addPath(
      'Wiki index file',
      'indexPath',
      'Rebuilt from the wiki folder, so it always lists every page there is and can never point at a name that does not exist. Any manual edit is overwritten.',
    );
    addPath('Wiki log file', 'logPath');
    addPath('Checkbox folder (fallback)', 'checkboxDir');
    addPath('Queries folder (saved answers)', 'queriesDir');
    addPath(
      'Wiki check report file',
      'reportPath',
      'Where “Check wiki” writes its report. Keep it outside the wiki folder, so the report is not itself measured as a wiki page.',
    );

    // ------------------------------------------------------------- scanning
    new Setting(containerEl).setName('Scanning').setHeading();
    new Setting(containerEl)
      .setName('Excluded subdirectories')
      .setDesc('One folder name per line. These are skipped inside the sources folder.')
      .addTextArea(text =>
        text
          .setValue(s.excludedDirs.join('\n'))
          .onChange(async value => {
            s.excludedDirs = value.split('\n').map(x => x.trim()).filter(Boolean);
            await this.plugin.saveSettings();
          }),
      );
    new Setting(containerEl)
      .setName('Include journal in sync')
      .setDesc('Also ingest 10-journal/ during "Sync wiki".')
      .addToggle(toggle =>
        toggle.setValue(s.includeJournal).onChange(async value => {
          s.includeJournal = value;
          await this.plugin.saveSettings();
        }),
      );
    new Setting(containerEl)
      .setName('Save answers to note')
      .setDesc('Offer to save query answers to the queries folder.')
      .addToggle(toggle =>
        toggle.setValue(s.saveAnswersToNote).onChange(async value => {
          s.saveAnswersToNote = value;
          await this.plugin.saveSettings();
        }),
      );

    // ------------------------------------------------------------ wiki check
    new Setting(containerEl).setName('Wiki check').setHeading();
    new Setting(containerEl)
      .setDesc('“Check wiki” measures the wiki folder — broken links, pages the index does not list, orphans, leftovers — and writes the report above. It reads the vault and writes only that report; nothing else in the vault is touched.')
      .addButton(btn =>
        btn.setButtonText('Check now').onClick(() => {
          void this.plugin.runCheck();
        }),
      );
    new Setting(containerEl)
      .setName('Check after sync')
      .setDesc('Refresh the report after every “Sync wiki”. Read-only, so it cannot damage anything.')
      .addToggle(toggle =>
        toggle.setValue(s.checkAfterSync).onChange(async value => {
          s.checkAfterSync = value;
          await this.plugin.saveSettings();
        }),
      );
  }

  /**
   * Fetches the provider's model list with the given key and caches it for the
   * Model dropdown. One call, two callers: the "Fetch models" button and
   * "Save & test", so the list is never fetched from two places with two
   * different ideas of what was fetched.
   */
  private async fetchAndCacheModels(key: string): Promise<number> {
    const models = await listModels(this.plugin.settings, key);
    this.plugin.settings.modelCache = {
      provider: this.plugin.settings.provider,
      baseUrl: this.plugin.settings.baseUrl,
      models,
    };
    await this.plugin.saveSettings();
    return models.length;
  }
}
