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
 * - A missing cross-reference is a page that talks *about* another page without
 *   linking to it: it names the other page's subject often enough in its own
 *   prose, carries no link of any spelling to it, and the pair is not the
 *   ordinary parent-and-child pattern (a page always names its own sources).
 *   This is the one finding here that is a suggestion rather than a fault —
 *   spelled out in the report, applied by no automatic step.
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
import { fold, STOPWORDS } from './search';

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

/**
 * A page that should probably link to another and does not.
 *
 * `mentions` counts the word starts of the subject in the *body prose* —
 * frontmatter, headings and fenced code do not count. Repeats stop counting at
 * `mentionCap`, so the number on screen means *present, several times*, not a
 * contest of volume.
 */
export interface MissingLink {
  /** The page holding the prose. */
  from: string;
  /** The page that should be linked, path inside the wiki. */
  to: string;
  /** The subject word the detection matched on (already folded). */
  term: string;
  /** Word starts of the term in the prose, capped. */
  mentions: number;
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
  /**
   * Pages that name another page's subject again and again without linking to
   * it. Suggestions, not faults: the decision to link belongs to you. The
   * strong tier; the weaker evidence sits in `weakMissingLinks`.
   */
  missingLinks: MissingLink[];
  /**
   * The pairs one mention short of the strong tier (exactly the minimum). Shown
   * apart and capped, so a large wiki still reads its report at a glance.
   */
  weakMissingLinks: MissingLink[];
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

  // --- missing cross-references --------------------------------------------
  // A page that keeps naming another page's subject without linking to it. The
  // decision to link belongs to the author; this only says where one is
  // probably missing, so it is a suggestion and lives apart from the faults.
  const missingLinks = findMissingLinks(entries, sourcesKey);
  // The weak tier is the pairs exactly one mention short of the strong one, so
  // it takes its own pass at the lower minimum; `findMissingLinks` itself keeps
  // its published semantics (strong tier only).
  const weakMissingLinks = findMissingLinks(entries, sourcesKey, MIN_MENTIONS - 1)
    .filter(link => link.mentions === MIN_MENTIONS - 1)
    .slice(0, WEAK_LIMIT);

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
    missingLinks,
    weakMissingLinks,
    fixableLinks: brokenLinks.filter(link => link.suggestion !== null).length,
    fixableArtifacts: artifacts.filter(item => item.artifact.fixable).length,
  };
}

const isWordChar = (char: string): boolean => /[\p{L}\p{N}]/u.test(char);

/**
 * Fenced code and headings are furniture, not speech: neither counts as prose.
 * A fence holds code or quoted metadata, and a heading names things
 * structurally — the same page always titles its own sections.
 */
function stripFences(text: string): string {
  return text.replace(/```[\s\S]*?```/g, ' ');
}

function stripHeadings(text: string): string {
  return text.replace(/^#{1,6}\s+.*$/gm, ' ');
}

/**
 * The word starts of `term` in `prose`, counted no further than `cap`.
 *
 * `term` arrives already folded and `prose` is folded by the caller; counting
 * word starts keeps `lisa` away from `analisa` the same way the source search
 * does. The cap exists so the displayed count means *present, several times*
 * instead of rewarding the page that repeats the word most.
 */
function cappedWordStarts(prose: string, term: string, cap: number): number {
  let count = 0;
  let from = 0;
  for (;;) {
    const at = prose.indexOf(term, from);
    if (at === -1) return count;
    const before = prose[at - 1];
    if ((before === undefined || !isWordChar(before)) && count < cap) count++;
    from = at + 1;
  }
}

/** Distinct word starts a page needs before a link is suggested. */
const MIN_MENTIONS = 3;
/**
 * How many weak rows the report shows. The weak tier keeps the silence problem
 * away — the reader is never left wondering whether the detector is mute or
 * merely not confident — without promoting a two-mention pair to a suggestion.
 */
const WEAK_LIMIT = 10;
/** Repeats stop counting here; the count is a presence, not a volume. */
const MENTION_CAP = 4;

/**
 * Cross-references that are probably missing: pages that name another page's
 * subject again and again without linking to it.
 *
 * The detection is deliberately narrow, because every relaxation would be paid
 * in false suggestions:
 *
 * - **The subject is a word of the page's own name.** A page is suggested when
 *   one of its name's words appears as word starts in the prose of another
 *   page. The word must be four letters or more, carry a letter, and be no
 *   stopword — and it must belong to this page alone: when three pages are
 *   named `lisa-*`, the word `lisa` is nobody's subject, because a suggestion
 *   could not say which page it means.
 * - **In the prose, not the furniture.** Frontmatter, headings and fenced code
 *   are stripped first: `fuentes:` and `## Modelo Lisa` name things
 *   structurally, and a fence is code or quoted metadata, not speech.
 * - **Often enough.** At least `MIN_MENTIONS` word starts, repeats capped at
 *   `MENTION_CAP`.
 * - **No link of any spelling.** The candidate words are checked against the
 *   links the page already carries: `[[modelo-lisa]]`,
 *   `[[01-lisa/modelo-lisa]]` and `[[Modelo Lisa]]` all count as linked.
 * - **Not the ordinary parent-and-child pattern.** A page always names its own
 *   sources in `fuentes`, and the notes distilled into it name the page they
 *   wrote; both directions are the normal shape of the wiki, so a pair whose
 *   target sits in the source's own `fuentes` is skipped.
 *
 * The strongest suggestions come first; ties break by page and then target, so
 * the report is stable across runs.
 */
export function findMissingLinks(
  entries: readonly WikiPage[],
  sourcesKey = 'fuentes',
  minMentions: number = MIN_MENTIONS,
): MissingLink[] {
  // The folded words of each page's name worth matching on, and how many pages
  // claim each one. A word two pages share cannot be a subject.
  const candidatesOf = new Map<string, string[]>();
  const owners = new Map<string, number>();
  for (const page of entries) {
    const name = page.path.split('/').pop() ?? page.path;
    const words = [...new Set(fold(name.replace(/\.md$/i, '')).split(/[^\p{L}\p{N}]+/u))].filter(
      word => word.length >= 4 && /[\p{L}]/u.test(word) && !STOPWORDS.has(word),
    );
    candidatesOf.set(page.path, words);
    for (const word of words) owners.set(word, (owners.get(word) ?? 0) + 1);
  }
  const uniqueTermsOf = new Map<string, string[]>();
  for (const [path, words] of candidatesOf) {
    uniqueTermsOf.set(path, words.filter(word => owners.get(word) === 1));
  }

  const proseOf = new Map<string, string>();
  for (const page of entries) {
    const split = splitFrontmatter(page.content);
    proseOf.set(page.path, stripFences(stripHeadings(split.body)));
  }

  const out: MissingLink[] = [];
  for (const from of entries) {
    const fromKey = titleKey(from.path.split('/').pop() ?? from.path);
    const fromSplit = splitFrontmatter(from.content);
    const declared = frontmatterList(fromSplit, sourcesKey)
      .map(linkTarget)
      .map(target => titleKey(target.split('/').pop() ?? target));
    const carried = wikilinkTargets(from.content)
      .map(target => titleKey(target.split('/').pop() ?? target));
    const prose = proseOf.get(from.path) ?? '';

    for (const to of entries) {
      const toKey = titleKey(to.path.split('/').pop() ?? to.path);
      if (toKey === fromKey) continue;
      if (declared.includes(toKey)) continue;
      const terms = uniqueTermsOf.get(to.path) ?? [];
      if (terms.length === 0) continue;
      // Any spelling of the target already carried counts as linked.
      if (carried.some(key => terms.some(term => key.includes(term)))) continue;

      let best: { term: string; mentions: number } | null = null;
      for (const term of terms) {
        const mentions = cappedWordStarts(prose, term, MENTION_CAP);
        if (mentions < minMentions) continue;
        if (
          best === null ||
          mentions > best.mentions ||
          (mentions === best.mentions &&
            (term.length > best.term.length || (term.length === best.term.length && term < best.term)))
        ) {
          best = { term, mentions };
        }
      }
      if (best === null) continue;
      out.push({ from: from.path, to: to.path, term: best.term, mentions: best.mentions });
    }
  }
  return out.sort(
    (a, b) => b.mentions - a.mentions || a.from.localeCompare(b.from) || a.to.localeCompare(b.to),
  );
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
  lines.push(`| Missing cross-references (suggested) | ${report.missingLinks.length} |`);
  lines.push(`| Weak evidence (2 mentions) | ${report.weakMissingLinks.length} |`);
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

  lines.push(`## Missing cross-references (${report.missingLinks.length})`);
  lines.push('');
  if (report.missingLinks.length === 0) {
    lines.push('_None._');
  } else {
    lines.push('A page naming another page\'s subject again and again without linking to it. A suggestion, not a fault: nothing is linked automatically.');
    lines.push('');
    lines.push('| Page | Probably links to | Mentions |');
    lines.push('| --- | --- | --- |');
    for (const link of report.missingLinks) {
      lines.push(`| \`${link.from}\` | \`${link.to}\` | ${link.mentions} × «${link.term}» |`);
    }
  }
  lines.push('');

  lines.push(`## Weak evidence (2 mentions) (${report.weakMissingLinks.length})`);
  lines.push('');
  if (report.weakMissingLinks.length === 0) {
    lines.push('_None. A pair mentioned twice belongs here, not among the suggestions above._');
  } else {
    lines.push(`One mention short of the suggestions above, shown here capped at ${WEAK_LIMIT} rows. A pair that shows up check after check is worth a look; a pair that appears once usually is not.`);
    lines.push('');
    lines.push('| Page | Probably links to | Mentions |');
    lines.push('| --- | --- | --- |');
    for (const link of report.weakMissingLinks) {
      lines.push(`| \`${link.from}\` | \`${link.to}\` | ${link.mentions} × «${link.term}» |`);
    }
  }
  lines.push('');

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
