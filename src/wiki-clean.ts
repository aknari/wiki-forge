/**
 * The mechanical part of the cleanup: the repairs that need no judgement.
 *
 * Two things only, and both are provable from the folder itself:
 *
 * 1. A leftover block or a dangling marker, which `stripArtifacts` removes.
 * 2. A link pointing at nothing when exactly one existing name is close enough,
 *    which is retargeted keeping the author's alias.
 *
 * Anything else — a duplicated page, an empty page, an unclear link — is left
 * for the report to show, because acting on it means deciding about content.
 *
 * Pure on purpose: the caller passes the pages in and gets the new text out, so
 * what the cleaner is allowed to do is covered by tests.
 */
import { closestTitle, mapWikilinks, stripArtifacts, titleKey, type ArtifactKind } from './wikitext';

export interface RepairInput {
  /** Path relative to the wiki folder. */
  path: string;
  content: string;
}

export interface PlannedFix {
  path: string;
  kind: 'link' | 'artifact';
  detail: string;
}

export interface PageRepair {
  path: string;
  before: string;
  after: string;
  fixes: PlannedFix[];
}

const ARTIFACT_LABEL: Record<ArtifactKind, string> = {
  'preamble-block': 'removed a code block holding a duplicated frontmatter or a leftover instruction',
  'dangling-marker': 'removed a dangling comment marker',
  'fenced-metadata': 'frontmatter written inside a code block',
  'empty-page': 'empty page',
  'duplicate-frontmatter': 'duplicated frontmatter',
};

const UNFIXABLE: ReadonlySet<ArtifactKind> = new Set<ArtifactKind>([
  'fenced-metadata',
  'empty-page',
  'duplicate-frontmatter',
]);

/** Every name that resolves: bare names and paths without the extension. */
function makeResolver(knownTitles: readonly string[]): (target: string) => boolean {
  const keys = new Set(knownTitles.map(titleKey).filter(Boolean));
  return (target: string) =>
    keys.has(titleKey(target)) || keys.has(titleKey(target.split('/').pop() ?? target));
}

/**
 * The repaired text of one page, plus what was done to it. A page with nothing
 * to repair comes back unchanged with an empty `fixes` list, so the result can
 * be shown as a preview before anything is written.
 *
 * The index is not a candidate: it is rebuilt from the folder, so repairing it
 * would be wasted work.
 */
export function repairPage(page: RepairInput, knownTitles: readonly string[]): PageRepair {
  const fixes: PlannedFix[] = [];
  let content = page.content;

  const stripped = stripArtifacts(content);
  if (stripped.removed.length > 0) {
    content = stripped.content;
    for (const kind of stripped.removed) {
      if (UNFIXABLE.has(kind)) continue;
      fixes.push({ path: page.path, kind: 'artifact', detail: ARTIFACT_LABEL[kind] });
    }
  }

  const resolves = makeResolver(knownTitles);
  const bareNames = knownTitles.filter(name => !name.includes('/'));
  content = mapWikilinks(content, target => {
    if (resolves(target)) return null;
    const suggestion = closestTitle(target, bareNames);
    if (suggestion === null) return null;
    fixes.push({ path: page.path, kind: 'link', detail: `[[${target}]] → [[${suggestion}]]` });
    return suggestion;
  });

  return { path: page.path, before: page.content, after: content, fixes };
}

/** Only the pages that would actually change, which is what a preview needs. */
export function planRepairs(pages: readonly RepairInput[], knownTitles: readonly string[]): PageRepair[] {
  return pages.map(page => repairPage(page, knownTitles)).filter(repair => repair.fixes.length > 0);
}

export interface RepairSummary {
  pages: number;
  links: number;
  artifacts: number;
}

/** Counts the work, once per distinct change rather than once per occurrence. */
export function summarizeRepairs(repairs: readonly PageRepair[]): RepairSummary {
  const seen = new Set<string>();
  let links = 0;
  let artifacts = 0;
  for (const repair of repairs) {
    for (const fix of repair.fixes) {
      const key = `${fix.path}\u0000${fix.detail}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (fix.kind === 'link') links++;
      else artifacts++;
    }
  }
  return { pages: repairs.length, links, artifacts };
}
