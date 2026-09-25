/**
 * Planning a wiki reset: which pages go and which stay.
 *
 * Pure, and deliberately so. This is the whole decision behind the one command
 * that deletes wiki pages, so it is the last place that should depend on a vault
 * read nothing can exercise. Everything here works on wiki-relative paths, the
 * same space the rest of the plugin uses for pages (`queries/2026-01-01.md`).
 */

export type KeepReason = 'answers' | 'maintained';

export interface ResetPlan {
  /** Wiki-relative paths to delete. Sorted. */
  remove: string[];
  /** Wiki-relative paths kept, each with why. Sorted. */
  keep: Array<{ path: string; reason: KeepReason }>;
}

export interface ResetOptions {
  /**
   * Wiki-relative paths the plugin maintains itself (index, log). Kept because
   * deleting them achieves nothing: the index is rewritten from the folder right
   * after, and the log is the record of what happened, reset included.
   */
  maintained: readonly string[];
  /**
   * Wiki-relative folder holding saved query answers, or `null` to delete those
   * too. `queriesFolderWithinWiki` answers `''` when there is no such folder
   * inside the wiki, and `''` must be passed on as `null`: treated as a folder
   * name it would match nothing, and the empty string as a prefix would match
   * everything.
   */
  answersFolder: string | null;
}

/**
 * One spelling per path, so a comparison never misses for cosmetic reasons.
 *
 * `./` is stripped because `normalizeVaultPath` strips it elsewhere and two
 * modules disagreeing about what counts as the same page is how a reset comes to
 * leave a file behind it planned to delete. A miss is not destructive here — the
 * caller only deletes a path the vault resolves — but it is silent, and a silent
 * half-reset is the failure this module exists to prevent.
 */
const normalise = (path: string): string => {
  let out = path.replace(/\\/g, '/').replace(/\/+/g, '/');
  while (out.startsWith('./')) out = out.slice(2);
  return out.replace(/^\/+|\/+$/g, '');
};

const under = (path: string, folder: string): boolean =>
  path === folder || path.startsWith(`${folder}/`);

/**
 * Splits the pages of a wiki into what a reset removes and what it keeps.
 *
 * The protected set is the point of the whole thing: "start from scratch" is a
 * legitimate thing to want for the distilled knowledge and a bad thing to want
 * for the answers already given — those are the only copy of a comparison that
 * cannot be regenerated without asking the same questions again.
 */
export function planReset(pages: readonly string[], options: ResetOptions): ResetPlan {
  const maintained = new Set(options.maintained.map(normalise).filter(p => p !== ''));
  const answers = options.answersFolder === null ? null : normalise(options.answersFolder);
  const remove: string[] = [];
  const keep: ResetPlan['keep'] = [];

  for (const page of pages) {
    const rel = normalise(page);
    if (rel === '') continue;
    if (maintained.has(rel)) keep.push({ path: rel, reason: 'maintained' });
    else if (answers !== null && answers !== '' && under(rel, answers)) {
      keep.push({ path: rel, reason: 'answers' });
    } else remove.push(rel);
  }

  remove.sort();
  keep.sort((a, b) => a.path.localeCompare(b.path));
  return { remove, keep };
}
