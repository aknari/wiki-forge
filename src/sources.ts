/**
 * Which vault files count as WikiForge sources.
 *
 * Pure on purpose — no Obsidian import — so the rules that decide the source
 * set are covered by tests (test/sources.test.ts) instead of being buried in
 * the sync loop. That matters because this set is the *input* of everything
 * else: fetch a file here that should not be there and the model distils
 * rubbish into the wiki.
 *
 * With several source folders configured, each one is a root: a note is a
 * source when it sits inside any of them, and the exclusion list is applied to
 * its path *relative to its own root*, so an excluded name never matches by
 * accident because of a folder further up.
 */
import type { WikiForgeSettings } from './settings';

/** Settings the source rules depend on. */
export type SourceRules = Pick<WikiForgeSettings, 'srcDirs' | 'journalDir' | 'excludedDirs'>;

/** A configured root without its trailing slash, or `null` when it is empty. */
function cleanRoot(root: string): string | null {
  const trimmed = root.trim().replace(/\/+$/, '');
  return trimmed === '' ? null : trimmed;
}

/** Whether `path` sits inside `root` (and not merely starts with its name). */
function isUnder(path: string, root: string): boolean {
  const cleaned = cleanRoot(root);
  return cleaned !== null && path.startsWith(cleaned + '/');
}

/**
 * The path of a file relative to the source root that contains it, or `null`
 * when the file is outside every configured root. Roots are checked in order,
 * so with nested roots (`00-src` and `00-src/50-sandbox`) the first match wins;
 * tests are run against the relative path, so nesting cannot make a file be
 * considered twice.
 */
export function sourceRelativePath(path: string, srcDirs: string[]): string | null {
  for (const dir of srcDirs) {
    const root = cleanRoot(dir);
    if (root === null) continue;
    if (path.startsWith(root + '/')) return path.slice(root.length + 1);
  }
  return null;
}

/** Whether any path segment matches the exclusion list. */
export function isExcluded(pathParts: string[], excluded: string[]): boolean {
  return pathParts.some(part => excluded.includes(part));
}

/**
 * The whole decision: is this vault path a WikiForge source? Exclusions apply
 * to the source folders only — the journal, when enabled, is ingested whole,
 * which is what the setting says it does.
 */
export function isSourcePath(path: string, settings: SourceRules, includeJournal: boolean): boolean {
  const relative = sourceRelativePath(path, settings.srcDirs);
  if (relative !== null) {
    return !isExcluded(relative.split('/').filter(Boolean), settings.excludedDirs);
  }
  return includeJournal && isUnder(path, settings.journalDir);
}
