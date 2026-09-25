/**
 * Normalisation of paths returned by the model.
 *
 * Models sometimes reply with a path that already includes the target folder
 * (e.g. `20-wiki/02-tamazight/foo.md` while writing inside `20-wiki`), which
 * used to create nested duplicates such as `20-wiki/20-wiki/...`. Every writer
 * goes through here so all of them agree on the result.
 */

export interface NormalizeOptions {
  /** Folder the path is expected to live under; a repeated prefix is stripped. */
  baseDir?: string;
  /** Append `.md` when the path carries no extension. Default: false. */
  ensureMd?: boolean;
}

/**
 * Cleans a raw path and returns it relative to the vault root, or `null` when
 * it is empty or tries to escape (any `..` segment is rejected).
 */
export function normalizeVaultPath(raw: string, opts: NormalizeOptions = {}): string | null {
  if (!raw) return null;

  let p = raw.trim();
  // Models decorate paths: [path], "path", `path`, <path>
  p = p.replace(/^[\["'`<]+/, '').replace(/[\]"'`>]+$/, '').trim();
  if (!p) return null;

  p = p.replace(/\\/g, '/');
  p = p.replace(/^\/+/, '');
  p = p.replace(/^(?:\.\/)+/, '');
  p = p.replace(/\/{2,}/g, '/');

  const segments: string[] = [];
  for (const segment of p.split('/')) {
    const s = segment.trim();
    if (!s || s === '.') continue;
    if (s === '..') return null; // never allow escaping the target folder
    segments.push(s);
  }

  let out = segments.join('/');
  if (!out) return null;

  const base = (opts.baseDir ?? '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  if (base) {
    // Strip the base as many times as the model repeated it.
    while (out.startsWith(`${base}/`)) out = out.slice(base.length + 1);
    if (!out || out === base) return null;
  }

  if (opts.ensureMd && !/\.[a-z0-9]+$/i.test(out)) out += '.md';
  return out;
}
