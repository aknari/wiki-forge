---
created: 2026-09-10T11:04
updated: 2026-09-18T09:54
---
# Contributing to WikiForge

Thanks for your interest in contributing!

Please be respectful and constructive in all interactions.

- **Open an issue or discussion** before submitting major changes.
- **Fork** the repository and create a feature branch for your work.
- **Submit a pull request** with a clear description of your changes.
- If you have questions, open an issue.

## Development setup

```bash
git clone <repo-url>
cd wiki-forge
npm install
npm run typecheck   # tsc --noEmit
npm run build       # bundles src/main.ts and styles.css into dist/
npm run deploy      # build, then copy dist/ into the vault's .obsidian/plugins/wiki-forge/
```

## Architecture

- `src/main.ts` — plugin entry: commands, ribbon, secret storage, rule-file bootstrap.
- `src/llm.ts` — universal LLM adapter (Google Gemini REST + OpenAI-compatible), `listModels()`.
- `src/forge.ts` — the distiller: source collection, smart synthesis, `FILE:/CONTENT:/---END---` output parsing, index and log updates.
- `src/query.ts` — the querier: index selection, page reading, synthesis, raw fallback, saving answers.
- `src/state.ts` — incremental sync state (mtime per file).
- `src/prompts.ts` — embedded defaults for the rule files.
- `src/ui/` — settings tab, query modal, sync progress modal.

## Testing

There is no automated test suite yet. The pure output-parsing logic (`processOutput`) is the most valuable part to verify — a quick way is to bundle `src/forge.ts` with esbuild and feed it `FILE:/CONTENT:/---END---` fixtures against a mock vault. Full manual testing requires a vault with sources, a configured LLM key, and a `20-wiki/` folder.