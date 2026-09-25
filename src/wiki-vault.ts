/**
 * Vault glue for the wiki check and the mechanical cleanup: reads the folder,
 * writes the report, rebuilds the index and applies the repairs.
 *
 * The decisions live in the pure modules (`wiki-check`, `wiki-index`,
 * `wiki-clean`); this file only moves text between them and the vault.
 */
import { App } from 'obsidian';
import type { WikiForgeSettings } from './settings';
import { writeFileSafe } from './state';
import { buildWikiIndex, indexableEntries } from './wiki-index';
import { checkWiki, renderWikiReport, type WikiReport } from './wiki-check';
import { planRepairs, type PageRepair, type RepairInput } from './wiki-clean';

const clean = (value: string): string => value.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');

/** A vault path expressed inside the wiki folder: `20-wiki/index.md` → `index.md`. */
export function wikiRelative(path: string, wikiDir: string): string {
  const wiki = clean(wikiDir);
  const target = clean(path);
  return wiki !== '' && target.startsWith(`${wiki}/`) ? target.slice(wiki.length + 1) : target;
}

/** Every `.md` in the wiki folder, path relative to it, index and log included. */
export async function readWikiPages(app: App, settings: WikiForgeSettings): Promise<RepairInput[]> {
  const root = `${clean(settings.wikiDir)}/`;
  const files = app.vault
    .getMarkdownFiles()
    .filter(file => file.path.startsWith(root))
    .sort((a, b) => a.path.localeCompare(b.path));
  const pages: RepairInput[] = [];
  for (const file of files) {
    pages.push({ path: file.path.slice(root.length), content: await app.vault.read(file) });
  }
  return pages;
}

/**
 * Every note name in the vault, as a bare name and as a path without the
 * extension — the two ways Obsidian resolves a `[[link]]`.
 */
export function vaultTitles(app: App): string[] {
  const titles: string[] = [];
  for (const file of app.vault.getMarkdownFiles()) {
    const base = file.path.split('/').pop() ?? file.path;
    titles.push(base.replace(/\.md$/i, ''));
    titles.push(file.path.replace(/\.md$/i, ''));
  }
  return titles;
}

export interface WikiCheckBundle {
  report: WikiReport;
  pages: RepairInput[];
}

/** Reads the folder and measures it. Writes nothing. */
export async function gatherWikiCheck(app: App, settings: WikiForgeSettings): Promise<WikiCheckBundle> {
  const pages = await readWikiPages(app, settings);
  const report = checkWiki({
    pages,
    knownTitles: vaultTitles(app),
    indexName: wikiRelative(settings.indexPath, settings.wikiDir),
    logName: wikiRelative(settings.logPath, settings.wikiDir),
  });
  return { report, pages };
}

/** Writes the report where the settings say. */
export async function writeWikiReport(
  app: App,
  settings: WikiForgeSettings,
  report: WikiReport,
): Promise<void> {
  const content = renderWikiReport(report, {
    wikiDir: settings.wikiDir,
    generatedAt: new Date().toISOString(),
    reportPath: settings.reportPath,
  });
  await writeFileSafe(app, settings.reportPath, content);
}

/**
 * Rewrites the index from the folder. Unlike the version it replaces, this one
 * *creates* the file when it is missing: the old one returned in silence, so a
 * deleted index never came back.
 */
export async function rebuildWikiIndex(app: App, settings: WikiForgeSettings): Promise<string> {
  const pages = await readWikiPages(app, settings);
  const names = {
    indexName: wikiRelative(settings.indexPath, settings.wikiDir),
    logName: wikiRelative(settings.logPath, settings.wikiDir),
  };
  const content = buildWikiIndex(indexableEntries(pages, names), {
    wikiDir: settings.wikiDir,
    ...names,
    generatedAt: new Date().toISOString(),
  });
  await writeFileSafe(app, settings.indexPath, content);
  return content;
}

/** The repairs the cleaner would make. Reads only, so it can be previewed. */
export async function planWikiRepairs(
  app: App,
  settings: WikiForgeSettings,
): Promise<PageRepair[]> {
  const pages = await readWikiPages(app, settings);
  const names = {
    indexName: wikiRelative(settings.indexPath, settings.wikiDir),
    logName: wikiRelative(settings.logPath, settings.wikiDir),
  };
  // The index is rebuilt from the folder, so repairing it would be wasted work.
  return planRepairs(indexableEntries(pages, names), vaultTitles(app));
}

/** Writes the repaired pages. Returns how many files actually changed. */
export async function applyWikiRepairs(
  app: App,
  settings: WikiForgeSettings,
  repairs: readonly PageRepair[],
): Promise<number> {
  const root = clean(settings.wikiDir);
  let written = 0;
  for (const repair of repairs) {
    if (repair.after === repair.before) continue;
    await writeFileSafe(app, `${root}/${repair.path}`, repair.after);
    written++;
  }
  return written;
}
