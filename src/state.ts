import { App, TFile } from 'obsidian';
import type { WikiForgeSettings } from './settings';
import { normalizeVaultPath } from './paths';

export interface SyncState {
  lastSync: string | null;
  files: Record<string, number>;
  /**
   * Fingerprint of the distillation rules, as of the last save (see
   * `rulesFingerprint` in `prompts`).
   *
   * Optional, and absent from every state written before this existed: an
   * absent value must mean "nothing recorded", never "the rules changed", or
   * the first run after updating the plugin would announce a false alarm.
   */
  rulesHash?: string;
}

/**
 * The sync state lives in a dot-file (the path the Python version used), and the
 * vault API cannot see those: `getAbstractFileByPath` answers `null` for a file
 * that is sitting right there, because the index leaves dot-files out.
 *
 * That is why this goes through `vault.adapter`, the filesystem layer underneath
 * the index. The loud half of the bug was the error "File already exists" at the
 * end of every ingest — `writeFileSafe` saw no file, called `create`, and the
 * file was there. The quiet half was worse: every sync began from an empty state
 * and re-processed the whole folder, forever, at two model calls per note.
 */
const statePath = (settings: WikiForgeSettings): string => `${settings.supportDir}/.wiki-sync-state.json`;

/** Loads the sync state, or a fresh one when there is none to read. */
export async function loadState(app: App, settings: WikiForgeSettings): Promise<SyncState> {
  const path = statePath(settings);
  try {
    if (!(await app.vault.adapter.exists(path))) return { lastSync: null, files: {} };
    const parsed = JSON.parse(await app.vault.adapter.read(path));
    if (parsed && typeof parsed === 'object' && typeof parsed.files === 'object') {
      return parsed as SyncState;
    }
  } catch {
    // unreadable or corrupted state — start fresh
  }
  return { lastSync: null, files: {} };
}

/** Persists the sync state, creating the folder if this is the first save. */
export async function saveState(
  app: App,
  settings: WikiForgeSettings,
  state: SyncState,
): Promise<void> {
  state.lastSync = new Date().toISOString();
  const adapter = app.vault.adapter;
  if (!(await adapter.exists(settings.supportDir))) await adapter.mkdir(settings.supportDir);
  await adapter.write(statePath(settings), JSON.stringify(state, null, 2));
}

/**
 * Drops one note from the state, so the next sync distils it again.
 *
 * The counterpart of deleting a page: the page is gone, but the state still
 * counted the note as done, so a sync would never bring it back and the note
 * would be missing from the wiki with nothing saying why. Returns whether there
 * was anything to forget.
 */
export async function forgetFile(
  app: App,
  settings: WikiForgeSettings,
  path: string,
): Promise<boolean> {
  const state = await loadState(app, settings);
  if (!(path in state.files)) return false;
  delete state.files[path];
  await saveState(app, settings, state);
  return true;
}

/**
 * Empties the state: every source note becomes pending again.
 *
 * This is the half of a reset that is easy to forget. Deleting the pages is the
 * visible part, but the state is what decides whether a sync has anything to do
 * — so pages deleted with the state intact never come back, and the wiki stays
 * empty with a plugin that reports being up to date. Returns how many notes were
 * forgotten.
 */
export async function resetState(app: App, settings: WikiForgeSettings): Promise<number> {
  const state = await loadState(app, settings);
  const forgotten = Object.keys(state.files).length;
  state.files = {};
  // The fingerprint goes with the notes it described: the next ingest is a fresh
  // start, and keeping the hash would make the following sync stay silent about
  // rules the wiki was rebuilt under from scratch.
  delete state.rulesHash;
  await saveState(app, settings, state);
  return forgotten;
}

/**
 * Creates/overwrites a vault file, creating parent folders as needed.
 * The path is normalised first: no `..`, no duplicated slashes, no stray
 * leading folder. An unsafe path throws instead of writing something odd.
 */
export async function writeFileSafe(app: App, path: string, content: string): Promise<void> {
  const safe = normalizeVaultPath(path);
  if (!safe) throw new Error(`WikiForge: refusing to write an unsafe path: "${path}"`);
  const existing = app.vault.getAbstractFileByPath(safe);
  if (existing instanceof TFile) {
    await app.vault.modify(existing, content);
    return;
  }
  const parent = safe.substring(0, safe.lastIndexOf('/'));
  if (parent && !app.vault.getAbstractFileByPath(parent)) {
    await app.vault.createFolder(parent);
  }
  await app.vault.create(safe, content);
}