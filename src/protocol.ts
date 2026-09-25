/**
 * The contract between WikiForge and the model: it answers with `FILE: <path>` /
 * `CONTENT: <text>` blocks, each closed by `---END---`.
 *
 * Two failures look identical from outside — "nothing was written" — and they
 * are not the same thing at all:
 *
 *  - **No markers at all** (`no-markers`): the answer came back as prose, so the
 *    model ignored the protocol. This is what a small local model does, and what
 *    a prompt cut short by the context window produces: the rules sit at the top
 *    of the prompt, so truncation shows up here first. Nothing is wrong with the
 *    note, and nothing is wrong with the transport.
 *  - **Markers, but no usable block** (`unusable-block`): it tried and got the
 *    shape wrong — no `CONTENT:`, an empty body, a path that makes no sense.
 *
 * Neither one means "the note added nothing new", which is why the wording
 * lives here in one place instead of being guessed at the call site. Pure on
 * purpose (no Obsidian import), so it is covered by tests.
 */

export type EmptyAnswerReason = 'no-markers' | 'unusable-block';

export interface FileBlock {
  /** The path as the model wrote it, decoration left to `normalizeVaultPath`. */
  path: string;
  /** The page body, trimmed. */
  text: string;
}

/**
 * One block starts at a `FILE:` line that holds a path and nothing else.
 *
 * The two halves of that rule were both measured against a real answer. A model
 * that *describes* the protocol writes "…bajo el formato:\n`FILE:
 * [ruta/al/archivo.md] CONTENT: [texto] ---END---`" — mid-line there, so
 * anchoring the pattern to the start of a line already leaves it out; and if a
 * model puts the whole template on its own line, the line carries `CONTENT:`,
 * which is not a path. That answer used to be read as a real block, and since
 * `normalizeVaultPath` is deliberately forgiving with `[brackets]`, it produced
 * a page called `ruta/al/archivo.md` holding the word `[texto]`.
 *
 * Spaces are allowed in the path on purpose: a stray space is worth a page the
 * rules ask for, and losing the page is not worth a naming convention.
 */
const FILE_LINE = /^[ \t]*FILE:[ \t]*(.+?)[ \t]*$/gm;

/** What a path may never contain: the rest of the protocol's own template. */
const NOT_A_PATH = /CONTENT:|---END---/;

/**
 * Reads the `FILE:`/`CONTENT:`/`---END---` blocks out of an answer.
 *
 * A block is dropped, never guessed at, when the shape is wrong (no `CONTENT:`
 * line, no path, empty body): a page that cannot be read is not worth a page
 * that blanks a good one. A missing `---END---` is tolerated on the last block,
 * and between blocks the next `FILE:` line is the boundary either way.
 */
export function parseFileBlocks(output: string): FileBlock[] {
  const starts: Array<{ path: string; at: number; after: number }> = [];
  FILE_LINE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = FILE_LINE.exec(output)) !== null) {
    if (NOT_A_PATH.test(match[1])) continue;
    starts.push({ path: match[1], at: match.index, after: match.index + match[0].length });
  }

  const blocks: FileBlock[] = [];
  for (let i = 0; i < starts.length; i++) {
    const until = i + 1 < starts.length ? starts[i + 1].at : output.length;
    const lines = output.slice(starts[i].after, until).split(/\r?\n/);

    let cursor = 0;
    while (cursor < lines.length && lines[cursor].trim() === '') cursor++;
    if (lines[cursor]?.trim() !== 'CONTENT:') continue;

    const text = lines.slice(cursor + 1).join('\n').split('---END---')[0].trim();
    if (text === '') continue;
    blocks.push({ path: starts[i].path, text });
  }
  return blocks;
}



/**
 * Why an answer that produced no page produced no page.
 *
 * The check is deliberately the same one `processOutput` uses to bail out
 * (`FILE:`, no trailing space): a model that writes `FILE:note.md` has a marker
 * but no block, and calling that "the protocol was followed" would send you
 * looking in the wrong place.
 */
export function classifyEmptyAnswer(output: string): EmptyAnswerReason {
  return output.includes('FILE:') ? 'unusable-block' : 'no-markers';
}

/** What the panel says when an ingest wrote nothing, and what it implies. */
export function emptyAnswerMessage(reason: EmptyAnswerReason): string {
  return reason === 'no-markers'
    ? 'Nothing was written: the answer had no FILE: markers, so the model did not follow the protocol. ' +
        'The note is not marked as done and the next sync will try it again. The usual causes are a small ' +
        'model, or a prompt cut short by the context window.'
    : 'Nothing was written: the answer had markers but no usable page (an empty body, or a path that ' +
        'makes no sense). The note is not marked as done, so the next sync will try it again.';
}
