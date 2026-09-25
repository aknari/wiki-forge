---
created: 2026-09-12T19:57
updated: 2026-09-18T09:54
---
# Installing WikiForge

This plugin is not in Obsidian's community plugin list. Install it manually, from a
release, or with [BRAT](#option-3--brat-auto-updates).

## Requirements

- **Obsidian 1.11.4 or newer**, on desktop.
- **An API key** from Google Gemini, or from any OpenAI-compatible provider (Groq,
  OpenRouter, a local Ollama…). The plugin talks to the provider over the network, so
  some setting — provider, base URL, model and key — has to be filled in before it can
  do anything.
- **A folder to read from**, typically `00-src`, and **a folder to build the wiki in**,
  typically `20-wiki`.

## Option 1 — From a release (recommended)

1. Download these **three** files from the [latest release](../../releases/latest):

   | File | Why |
   |---|---|
   | `main.js` | The plugin itself. |
   | `manifest.json` | Identity, version and minimum Obsidian version. |
   | `styles.css` | Layout of the progress modal and the settings tab. |

2. Create the folder `.obsidian/plugins/wiki-forge/` inside your vault and copy all
   three files into it.
3. In Obsidian: **Settings → Community plugins**, make sure *Restricted mode* is off,
   then enable **WikiForge** in the *Installed* tab.

## Option 2 — From source

```bash
git clone https://github.com/aknari/wiki-forge
cd wiki-forge
npm install
npm run typecheck
npm test
npm run build       # bundles into dist/
npm run deploy      # build, then copy dist/ into a vault's plugin folder
```

`npm run build` writes into `dist/` and touches nothing else, so the build does not depend
on where the repository sits. `npm run deploy` copies `dist/main.js`, `dist/styles.css` and
`manifest.json` into a vault's plugin folder: the `../../.obsidian/plugins/wiki-forge/` of
the vault the source lives in (`<vault>/80-support/wiki-forge/`), or, for a repository kept
anywhere else, wherever `OBSIDIAN_PLUGIN_DIR` points:

```bash
OBSIDIAN_PLUGIN_DIR=~/my-vault/.obsidian/plugins/wiki-forge npm run deploy
```

## Option 3 — BRAT (auto-updates)

Install [BRAT](https://github.com/TfTHacker/obsidian42-brat), then run
**BRAT: Add a beta plugin for testing** and enter `aknari/wiki-forge`.

## Configuration

In **Settings → WikiForge**:

| Setting | What it is |
|---|---|
| Provider / Base URL / Model | Which API to call. *Fetch models* fills the model list from the provider, and *Save & test* stores the key and verifies it. |
| API key | Stored in Obsidian's **secret storage** (your system keychain), shared with other plugins. It is never written to `data.json` nor to any file in the vault. |
| Source folders | The notes to read. Usually `00-src`. |
| Excluded subdirectories | Names of folders *inside* a source folder to skip (matched by folder name, at any depth). |
| Wiki folder | Where the generated pages are written. Default `20-wiki`. |
| Include journal | Whether the daily notes take part as a source. |
| Checkbox folder (fallback) | Only used by the ask-the-wiki feature, when a question is not answered by the wiki: the most recent notes of this folder are searched as a last resort. |

## First run

1. Fill in provider, model and API key, and press *Save & test*: a rejected key is
   reported straight away instead of failing on the first sync.
2. Check the source folders and the wiki folder.
3. Run **WikiForge: Sync wiki** from the command palette. A cancellable progress modal
   shows the current note; only new or modified notes are processed.
4. To redo a single note, open it and run **WikiForge: Process current note**.

## What it writes, and where

| Path | What |
|---|---|
| `<wiki folder>/*.md` | The generated wiki pages, plus `index.md` and `log.md`. |
| `80-support/.wiki-sync-state.json` | Incremental sync state (last run, per-note modification times). |
| `.obsidian/plugins/wiki-forge/data.json` | The plugin's own settings. |
| **Your source notes** | **Nothing.** The plugin reads them and writes elsewhere. |

Applying tags or renaming source notes with other tools changes their modification times,
so WikiForge will process them again on the next sync — expected, and harmless.

## Updating

Replace `main.js` with the one from the new release. With BRAT, updates are automatic.

## Uninstalling

Disable the plugin, then delete `.obsidian/plugins/wiki-forge/`.

- The generated wiki and the sync-state file stay in your vault; delete them by hand if
  you do not want them.
- The API key **stays in your keychain**, because Obsidian's secret storage is shared
  between plugins. Remove it from Obsidian's secret storage if you want it gone.
