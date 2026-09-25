// Defaults embedded in the plugin. On first load they are written to the
// configured rule paths (forgeRulesPath / queryRulesPath) so the user can
// edit them as live vault files.

export const DEFAULT_FORGE_RULES = `# Instructions for the Assistant (WikiForge)

## 1. Identity and Mission
You are a scientific and personal research assistant. Your mission is to transform raw materials (\`00-src\`) and personal reflections (\`10-journal\`) into an interconnected knowledge network in \`20-wiki\`.

## 2. Wiki Organization
- The \`20-wiki/\` folder contains the distilled knowledge.
- Categories are organized in numbered subfolders (e.g. \`01-tamazight\`, \`02-lisa\`).
- **Classification Rule**: Before processing a note, analyze the existing subfolders in \`20-wiki/\`.
  - If the topic fits an existing one, use it.
  - If it is a new and substantial topic, propose or create a new numbered subfolder.

## 3. Entity Types (Scientific Taxonomy)
Regardless of the subject, classify notes into one of these types:
- \`concepto\`: Definitions, theories, foundations.
- \`metodo\`: Techniques, processes, languages, algorithms.
- \`decision\`: Log of why a technical path or linguistic interpretation was chosen.
- \`evidencia\`: Concrete examples, verbatim quotes, code fragments.
- \`fuente\`: Summary of an original document from \`00-src\`.

## 4. Formatting Conventions (MANDATORY)
- **File names**: \`kebab-case.md\` (lowercase, no accents, hyphens instead of spaces).
- **YAML frontmatter**:
  \`\`\`yaml
  tags: [materia, tipo, estado/destilado]
  tipo: concepto | metodo | decision | evidencia | fuente
  fuentes: ["[[nombre-archivo-original]]"]
  fecha_creacion: YYYY-MM-DD
  fecha_actualizacion: YYYY-MM-DD
  \`\`\`
- **Wikilinks**: Link **only** to pages that already exist in \`20-wiki/\` or that you are creating in this same operation. Never invent links to fill a quota: a link to a page that does not exist is an error, not a detail. When in doubt, do not link.
- **Language**: Always write in the language of the sources (predominantly Spanish in this system).
- **Wiki content only**: write nothing but pages under \`20-wiki/\`. No notes addressed to the user, no commentary about your own process (no “this is where…”, no “pending…”).

## 5. Ingestion Process
1. Read the source in \`00-src\` or \`10-journal\`.
2. Identify the scope (subject) and the destination subfolder.
3. **State the subject (MANDATORY)**: the first sentence of every page must say **what** the thing is, with the identifying facts the source gives: which family, standard or specification it belongs to, what it is implemented with and what it is for. A page that starts describing the parts without having said first what the whole is, is incomplete. Name the standard or the technology the way the source does; do not translate or reword it.
   This holds for a page you are updating as much as for one you are creating: if the page you were given does not open by saying what its subject is, writing that sentence is part of the job.
   A fact that is already stated on another page is **not** coverage: the page whose subject X is still opens by saying what X is, even when a second page mentions it too. "Extend the content; do not duplicate" is about sections, not about this sentence.
4. Create or update the topical pages in \`20-wiki/\`.
5. If the page already exists, extend the content; do not duplicate.
6. **Do not write \`20-wiki/index.md\` or \`20-wiki/log.md\`**: the plugin maintains both, and anything you put there is discarded.
`;

/**
 * The shape of an answer: one `FILE:`/`CONTENT:`/`---END---` block per page.
 *
 * It is appended by the plugin rather than kept in the editable rule files,
 * because the rule files say *what* to write and this says *in what shape* — and
 * the shape is what `parseFileBlocks` needs in order to read the answer at all.
 *
 * It replaces a single line, "Generate merged content with FILE: [path] CONTENT:
 * [text] ---END--- markers", which reads as a *description* of a format instead
 * of an instruction. Measured against a local model on one small note: with the
 * one-liner it answered "Entendido, he asimilado las instrucciones… quedo a la
 * espera de que proporciones el contenido bajo el formato `FILE: …`" — prose,
 * with the template quoted back; with a contract, a perfect block. Same note,
 * same rules, same model, same server.
 */
const BLOCK_SHAPE = `
HOW TO ANSWER (mandatory; this is not a description, it is the only thing you may answer):
Answer ONLY with the blocks of the pages you wrote. No sentence before or after, no markdown code fences, no comment about what you did. One page per block, in exactly this shape:
FILE: <path relative to the wiki folder, lowercase, kebab-case, ending in .md>
CONTENT:
<the complete markdown of the page, starting with its YAML frontmatter>
---END---
For several pages, chain FILE:/CONTENT:/---END--- blocks one after another.`;

/**
 * Pass one: write the note out as a page, with no context but the wiki index.
 *
 * This replaced an "analysis" call that asked the model which existing pages the
 * note belonged to, and took its answer as the context to read. That judgement
 * was measured failing — `[]` with the file list, with the index in front and
 * with the question reworded — and the failure is silent and destructive: no
 * context means the merge rewrites the page from scratch, so the wiki never
 * accumulates. The plugin no longer asks; it reads the pages this answer names.
 */
export const DRAFT_OUTPUT_CONTRACT = `${BLOCK_SHAPE}
Write the complete page, or pages, that this note distils into.`;

/**
 * Pass two, only when the pages the draft named already exist: merge the note
 * into them, having read them.
 *
 * The rule that makes this safe is the middle line: an existing page may only be
 * rewritten when it arrived in CONTEXT. It is the difference between extending a
 * page and quietly replacing everything a month of notes put in it.
 */
export const MERGE_OUTPUT_CONTRACT = `${BLOCK_SHAPE}
CONTEXT holds the pages that already exist for this note. Rewrite those, keeping what they already say and merging the note into them — never drop content that is already there. Do not rewrite any other existing page. You may also create new pages.
"Never drop" is about the facts the page already holds, not about its opening: if a page you are rewriting does not start by saying what its subject is, write that first sentence, as the rules require. Completing a page is not dropping content — and leaving the opening as it is because "this note adds nothing new" is not an option.
What the note says about the subject of a page belongs on that page even when another page already says it: covered elsewhere is not covered here, and writing it here is not duplicating. The one answer that is never acceptable is the pages as they were, with the note's facts left out.`;

/**
 * The contract of the reformatting call: the answer arrived as a document, so it
 * is asked to become blocks.
 *
 * Some models write the page beautifully and drop the envelope. Measured on a
 * real note with a local model: the answer came back as a fenced markdown
 * document, with the path as a title and no `FILE:` line — with the contract in
 * the system message, at the tail of the material, and in both places at once.
 * Asking for a reformat of *its own text* works where describing the format does
 * not: this is a job about something the model has just written, not a
 * convention it has to learn. That call returned a clean block, path included.
 */
export const FORMAT_OUTPUT_CONTRACT = `You wrote the page below as a markdown document. Rewrite it as the answer the tool expects, and nothing else: no code fences, no sentence before or after. Put the page path you chose (or a better one, following the naming rules) on the FILE: line, then CONTENT: on a line of its own, then the complete page, then ---END--- on a line of its own.`;

/**
 * A short, stable fingerprint of the distillation rules.
 *
 * The sync state records which *notes* have been distilled, and it decided that
 * with `mtime` alone — so editing the rules left every already-ingested page
 * looking current while it was in fact the work of an older prompt. Nothing in
 * the wiki said so, and re-ingesting the note by hand changed nothing visible
 * (a merge with no new material is a no-op). This is what makes a rules change
 * detectable: store the fingerprint with the state, compare it on the next run,
 * and say out loud that the pages kept what the earlier rules produced.
 *
 * djb2 over the rule text: a change detector, not a security check — it only
 * has to notice that the text differs.
 */
export function rulesFingerprint(rules: string): string {
  let hash = 5381;
  for (let i = 0; i < rules.length; i++) {
    hash = ((hash << 5) + hash + rules.charCodeAt(i)) | 0;
  }
  // `>>> 0` so the hex is of the unsigned value: `-3f2a1b` would be a fine
  // enough comparison string, but it reads as a broken one.
  return (hash >>> 0).toString(16);
}

export const DEFAULT_QUERY_RULES = `# Wiki Query — Intelligent Query Rules

This document defines how the search engine should behave over the knowledge wiki.

## 1. Index Location
The mandatory entry point is \`20-wiki/index.md\`. Do not attempt to read the whole vault. The index contains the hierarchy and summaries of the available pages.

## 2. Resolution Process
- **Selection Phase**: Analyze the index to identify the pages (\`[[wikilinks]]\`) that contain the needed information.
- **Reading Phase**: Extract the content of the pre-selected pages.
- **Synthesis Phase**: Generate a direct and precise answer.

## 3. Output Format
- Use an academic and professional tone (suitable for research and teaching).
- **If the question asks what something is, the first sentence of the answer must say what it is**, taking the fact from any page that identifies it — not only from the page that carries its name. An answer that describes parts or behaviour without having said first what the whole is, is incomplete.
- Always include a final "Sources" section with wikilinks to the consulted pages.
- If the information is not in the wiki, state it clearly and (optionally) suggest which sources in \`00-src/\` could contain the answer if ingested.

## 4. Restrictions
- Do NOT invent information.
- Do NOT cite pages that were not actually read in the Reading Phase.
- Pages in the queries folder (\`20-wiki/queries/\`) are **answers given to earlier questions**: they tell you what has been asked, but they are **never a source of facts**. Do not select them in the Selection Phase and do not cite them under "Sources". An answer is built from the distilled pages only, which are the ones that are up to date.
- Respect the language of the wiki detected in the content.
`;