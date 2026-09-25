/**
 * The wiki check: what is wrong with the wiki folder, in numbers.
 *
 * Pure on purpose — no Obsidian import — so the rules that decide what counts
 * as a broken link, a page the index forgot or a leftover of the model's own
 * process are the ones covered by tests. Everything here *reads*: nothing in
 * this module writes a vault file.
 *
 * Two definitions are worth stating, because they are choices:
 *
 * - Links are read from the whole file, frontmatter included: `fuentes:` holds
 *   real links, and a source that does not resolve is a real problem.
 * - A link counts as resolved when its target matches the name *or* the path of
 *   some note in the vault (that is how Obsidian resolves it), and a link to a
 *   note outside the wiki is not broken: it works, it is just not a wiki page.
 * - An orphan is a page no *other page* links to. The index is left out of that
 *   count on purpose: the index is generated from the folder, so it lists
 *   everything and would hide every orphan there is.
 */
import {
  closestTitle,
  detectArtifacts,
  frontmatterList,
  linkTarget,
  splitFrontmatter,
  titleKey,
  wikilinkTargets,
  type Artifact,
} from './wikitext';

export interface WikiPage {
  /** Path relative to the wiki folder, e.g. `01-lisa/modelo-lisa.md`. */
  path: string;
  content: string;
}

export interface WikiCheckInput {
  /** Every `.md` under the wiki folder, the index and the log included. */
  pages: WikiPage[];
  /**
   * Every note name that exists in the vault — bare names (`modelo-lisa`) and
   * paths without the extension (`00-src/.../Sobre plasmoids`) — so a link
   * written either way is understood.
   */
  knownTitles: string[];
  /** Frontmatter key holding the sources of a page. Default: `fuentes`. */
  sourcesKey?: string;
  indexName?: string;
  logName?: string;
}

export interface BrokenLink {
  target: string;
  /** How many links point there (a page may link it twice). */
  count: number;
  /** The pages holding them, sorted. */
  sources: string[];
  /** The one existing name it most likely meant, or `null` when unclear. */
  suggestion: string | null;
}

export interface WikiReport {
  pages: number;
  links: number;
  brokenLinks: BrokenLink[];
  /** Pages on disk that the index does not list, so a query never reaches them. */
  missingFromIndex: string[];
  /** Index entries pointing at nothing that exists anywhere. */
  staleIndexEntries: string[];
  /** Index entries pointing at a note that exists outside the wiki. */
  foreignIndexEntries: string[];
  /** Pages no other page links to (the index does not count). */
  orphans: string[];
  artifacts: Array<{ path: string; artifact: Artifact }>;
  /** Pages whose `fuentes` is empty or names nothing that exists. */
  untraceable: string[];
  /** How many of the problems above the mechanical cleaner can settle. */
  fixableLinks: number;
  fixableArtifacts: number;
}

export function checkWiki(input: WikiCheckInput): WikiReport {
  const indexName = input.indexName ?? 'index.md';
  const logName = input.logName ?? 'log.md';
  const sourcesKey = input.sourcesKey ?? 'fuentes';

  const index = input.pages.find(page => page.path === indexName) ?? null;
  const entries = input.pages.filter(page => page.path !== indexName && page.path !== logName);

  // Two sets: what exists anywhere in the vault (a working link) and what lives
  // in the wiki (a link the index should be able to offer).
  const knownKeys = new Set(input.knownTitles.map(titleKey).filter(Boolean));
  const bareNames = input.knownTitles.filter(name => !name.includes('/'));
  const wikiKeys = new Set(input.pages.map(page => titleKey(page.path.split('/').pop() ?? page.path)));
  const entryKeys = new Map(entries.map(page => [titleKey(page.path.split('/').pop() ?? page.path), page.path]));

  const resolves = (target: string): boolean =>
    knownKeys.has(titleKey(target)) || knownKeys.has(titleKey(target.split('/').pop() ?? target));

  const found = new Map<string, { count: number; sources: Set<string> }>();
  let links = 0;
  for (const page of input.pages) {
    for (const target of wikilinkTargets(page.content)) {
      links++;
      if (resolves(target)) continue;
      const row = found.get(target) ?? { count: 0, sources: new Set<string>() };
      row.count++;
      row.sources.add(page.path);
      found.set(target, row);
    }
  }

  const brokenLinks: BrokenLink[] = [...found.entries()]
    .map(([target, row]) => ({
      target,
      count: row.count,
      sources: [...row.sources].sort(),
      suggestion: resolves(target) ? null : closestTitle(target, bareNames),
    }))
    .sort((a, b) => b.count - a.count || a.target.localeCompare(b.target));

  // --- the index -----------------------------------------------------------
  const indexTargets = index === null ? [] : wikilinkTargets(index.content);
  const listedKeys = new Set(indexTargets.flatMap(target => [
    titleKey(target.split('/').pop() ?? target),
    titleKey(target),
  ]));

  const missingFromIndex = entries
    .filter(page => !listedKeys.has(titleKey(page.path.split('/').pop() ?? page.path)))
    .map(page => page.path)
    .sort();

  const staleIndexEntries: string[] = [];
  const foreignIndexEntries: string[] = [];
  for (const target of indexTargets) {
    const key = titleKey(target.split('/').pop() ?? target);
    if (wikiKeys.has(key)) continue;
    if (!resolves(target)) staleIndexEntries.push(target);
    else foreignIndexEntries.push(target);
  }

  // --- connectivity, leftovers and sources ---------------------------------
  const inbound = new Map<string, number>();
  for (const page of entries) {
    for (const target of wikilinkTargets(page.content)) {
      const key = titleKey(target.split('/').pop() ?? target);
      if (key === '' || key === titleKey(page.path.split('/').pop() ?? page.path)) continue;
      // A tolerant match still counts: the index linked `metodologia-de-…` to a
      // page named `metodologia-…`, and that link does reach it in Obsidian.
      for (const candidate of entryKeys.keys()) {
        if (candidate === key || (key.length > 6 && candidate.length > 6 && closestTitle(key, [candidate]) === candidate)) {
          inbound.set(candidate, (inbound.get(candidate) ?? 0) + 1);
        }
      }
    }
  }
  const orphans = entries
    .filter(page => (inbound.get(titleKey(page.path.split('/').pop() ?? page.path)) ?? 0) === 0)
    .map(page => page.path)
    .sort();

  const artifacts: Array<{ path: string; artifact: Artifact }> = [];
  for (const page of input.pages) {
    for (const artifact of detectArtifacts(page.content)) artifacts.push({ path: page.path, artifact });
  }

  const untraceable: string[] = [];
  for (const page of entries) {
    const split = splitFrontmatter(page.content);
    // Declared sources are written as wikilinks (`"[[00 - Lisa]]"`), so the
    // brackets have to come off before asking whether that note exists.
    const declared = frontmatterList(split, sourcesKey);
    if (declared.length === 0 || !declared.some(source => resolves(linkTarget(source)))) {
      untraceable.push(page.path);
    }
  }
  untraceable.sort();

  return {
    pages: entries.length,
    links,
    brokenLinks,
    missingFromIndex,
    staleIndexEntries: [...new Set(staleIndexEntries)].sort(),
    foreignIndexEntries: [...new Set(foreignIndexEntries)].sort(),
    orphans,
    artifacts,
    untraceable,
    fixableLinks: brokenLinks.filter(link => link.suggestion !== null).length,
    fixableArtifacts: artifacts.filter(item => item.artifact.fixable).length,
  };
}

export interface ReportMeta {
  /** The wiki folder, so the report says which one was measured. */
  wikiDir: string;
  /** ISO timestamp of the run. */
  generatedAt: string;
  /** Path of the report itself, to name it in the footer. */
  reportPath?: string;
}

/** The report as Markdown, ready to write to a note. */
export function renderWikiReport(report: WikiReport, meta: ReportMeta): string {
  const lines: string[] = [];
  const fixes = report.fixableLinks + report.fixableArtifacts;

  lines.push('---');
  lines.push(`generated: ${meta.generatedAt}`);
  lines.push('generated_by: WikiForge — wiki check');
  lines.push('---');
  lines.push('# Wiki check');
  lines.push('');
  lines.push(`Report on \`${meta.wikiDir}\`. Generated automatically: editing this note changes nothing.`);
  lines.push('');
  lines.push('| Measure | Value |');
  lines.push('| --- | --- |');
  lines.push(`| Pages | ${report.pages} |`);
  lines.push(`| Links | ${report.links} |`);
  lines.push(`| Broken links (missing target) | ${report.brokenLinks.length} |`);
  lines.push(`| Pages the index does not list | ${report.missingFromIndex.length} |`);
  lines.push(`| Index entries pointing nowhere | ${report.staleIndexEntries.length} |`);
  lines.push(`| Orphan pages (no link from another page) | ${report.orphans.length} |`);
  lines.push(`| Leftover blocks / markers | ${report.artifacts.length} |`);
  lines.push(`| Pages with a source that does not resolve | ${report.untraceable.length} |`);
  lines.push(`| Mechanical fixes available | ${fixes} |`);
  lines.push('');

  lines.push(`## Broken links (${report.brokenLinks.length})`);
  lines.push('');
  if (report.brokenLinks.length === 0) {
    lines.push('_None._');
  } else {
    lines.push('| Target | Links | Suggested | Found in |');
    lines.push('| --- | --- | --- | --- |');
    for (const link of report.brokenLinks) {
      lines.push(
        `| \`${link.target}\` | ${link.count} | ${link.suggestion === null ? '_unclear_' : `\`${link.suggestion}\``} | ${link.sources.slice(0, 3).join(', ')}${link.sources.length > 3 ? ', …' : ''} |`,
      );
    }
  }
  lines.push('');

  const list = (title: string, items: string[]): void => {
    lines.push(`## ${title} (${items.length})`);
    lines.push('');
    if (items.length === 0) lines.push('_None._');
    else for (const item of items) lines.push(`- ${item}`);
    lines.push('');
  };
  list('Pages the index does not list', report.missingFromIndex);
  list('Index entries pointing nowhere', report.staleIndexEntries);
  list('Index entries pointing outside the wiki', report.foreignIndexEntries);
  list('Orphan pages', report.orphans);
  list('Pages with a source that does not resolve', report.untraceable);

  lines.push(`## Leftovers (${report.artifacts.length})`);
  lines.push('');
  if (report.artifacts.length === 0) {
    lines.push('_None._');
  } else {
    for (const item of report.artifacts) {
      lines.push(`- \`${item.path}\` — ${item.artifact.detail}${item.artifact.fixable ? '' : ' **(kept: decide by hand)**'}`);
    }
  }
  lines.push('');
  if (meta.reportPath !== undefined) lines.push(`_Report written to \`${meta.reportPath}\`._`);
  return `${lines.join('\n').replace(/\n+$/, '')}\n`;
}
