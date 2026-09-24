/**
 * Scene-name parsing. See ARCHITECTURE.md §7.3.
 *
 * We only take title / year / edition / source / group from the filename.
 * HDR, codecs, and audio come from ffprobe — filenames lie, and we have the file.
 */

import { filenameParse, type ParsedMovie, type ParsedShow } from '@ctrl/video-filename-parser';
import { parseEpisode, type EpisodeRef } from './episode.js';

export type ParseWarning =
  | 'embedded-year'
  | 'dangling-article'
  | 'no-year'
  | 'empty-title'
  | 'title-too-short'
  | 'technical-token-in-title'
  | 'dual-year'
  /**
   * Named like TV — a season pack, a "Season 2" — but with no episode that can be
   * placed. Ingest skips these rather than inventing a film called "Show S01".
   */
  | 'tv-without-episode';

export type ParsedRelease = {
  title: string;
  /** Punctuation-stripped, lowercased — used for fuzzy matching against TMDB. */
  normalizedTitle: string;
  year?: number;
  /**
   * An earlier year found in the release name, when it carries two.
   * Re-cuts and restorations reference the original film:
   *   Caligula.1979.The.Ultimate.Cut.2023.Release  → year 2023, originalYear 1979
   * TMDB may list such a title under either, so the matcher should try both.
   */
  originalYear?: number;
  edition?: string;
  /** Technical provenance: Hybrid, Proper, Repack. NOT a different cut. */
  releaseAttributes: string[];
  source?: string;
  releaseGroup?: string;
  isShow: boolean;
  seasons?: number[];
  episodes?: number[];
  /** Which episode this is, when it is one. See scan/episode.ts. */
  episode?: EpisodeRef;
  /** Candidate strings to try against TMDB, most likely first. */
  searchTitles: string[];
  /** Specific things that went wrong, for the review queue UI. */
  warnings: ParseWarning[];
  /** True when any warning fires — routes to manual review. */
  lowConfidence: boolean;
};

/**
 * Tracker/uploader tags that contaminate release-group extraction.
 * e.g. "...-GHD[TGx]" must become "...-GHD" or the group parses as "GHD[TGx]".
 */
const TRACKER_TAGS =
  /\s*[\[\(](TGx|rartv|rarbg|ettv|eztv|YTS(\.\w+)?|1337x|GalaxyRG|NoGRP|Silence)[\]\)]\s*/gi;

export function cleanReleaseName(raw: string): string {
  return raw.replace(TRACKER_TAGS, '').replace(/\s+/g, ' ').trim();
}

/** Strip punctuation and articles for fuzzy comparison. Scene naming eats colons. */
export function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Named like TV, but not placeable as an episode: `Show.S01.COMPLETE`, `Season 2`.
 *
 * Deliberately narrower than it looks. The old gate also accepted a bare "Episode 4",
 * which read `Star.Wars.Episode.4.A.New.Hope.1977` as television and took a film off
 * the shelves. Deciding what IS an episode now belongs to scan/episode.ts; this only
 * spots the leftovers that should be reported rather than turned into films.
 */
const UNPLACED_TV = [
  /\bS\d{1,2}[\s._-]+(complete|pack|\d{3,4}p|blu-?ray|web(-?dl|-?rip)?|uhd|remux|hdtv)\b/i,
  /\bseason[\s._-]?\d{1,2}\b/i,
];

function looksLikeUnplacedTv(name: string): boolean {
  return UNPLACED_TV.some((re) => re.test(name));
}

/**
 * Literal edition phrases, read straight from the release name.
 *
 * Preferred over the parser's flag bag because the bag is lossy: it reports
 * `Caligula...The.Ultimate.Cut...` as `{ extended: true }`, which is both wrong and
 * unhelpful when the UI has to label two different cuts of the same film.
 */
const EDITION_PHRASE =
  /\b(ultimate|final|theatrical|extended|director'?s|special|collector'?s|international|unrated|uncut|remastered|redux|assembly|integral|complete|anniversary)[\s._-]+(cut|edition|version|release)\b/i;

/**
 * Standalone EDITION words — these denote a different cut or presentation of the film,
 * and belong in the version selector.
 */
const EXTRA_EDITIONS: Array<[RegExp, string]> = [
  [/\bopen\W?matte\b/i, 'Open Matte'],
  [/\bdespecialized\b/i, 'Despecialized'],
  [/\bfan\W?edit\b/i, 'Fan Edit'],
  [/\bimax\b/i, 'IMAX'],
  [/\b(4k\W?)?restoration\b/i, 'Restoration'],
];

/**
 * RELEASE ATTRIBUTES — technical provenance, not a different cut.
 *
 * "HYBRID" on a FraMeSToR remux means the release was assembled from more than one
 * source (e.g. the Dolby Vision layer from the UHD disc grafted onto another encode).
 * The film is identical. Treating it as an edition would label all three Nolan Batman
 * films "Hybrid" in the version selector, implying alternate cuts that do not exist.
 */
const RELEASE_ATTRIBUTES: Array<[RegExp, string]> = [
  [/\bhybrid\b/i, 'Hybrid'],
  [/\bproper\b/i, 'Proper'],
  [/\brepack\b/i, 'Repack'],
  [/\bremastered\W?scan\b/i, 'Remastered Scan'],
];

function readReleaseAttributes(raw: string): string[] {
  return RELEASE_ATTRIBUTES.filter(([re]) => re.test(raw)).map(([, label]) => label);
}

/**
 * Keys in the parser's edition bag that are genuinely editions.
 * The bag also carries quality/HDR flags (`uhd`, `dolbyVision`, `hdr`) which are
 * ffprobe's business, not the filename's — see ARCHITECTURE.md §5.3.
 */
const REAL_EDITION_KEYS = new Set([
  'theatrical',
  'extended',
  'unrated',
  'directors',
  'special',
  'limited',
  'remastered',
  'uncut',
  'imax',
  'ultimate',
  'criterion',
  'fanEdit',
  'anniversary',
  'collectors',
  'redux',
  'final',
  'diamond',
  'despecialized',
]);

function titleCase(s: string): string {
  return s
    .split(/\s+/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(' ');
}

/** Turn a camelCase flag key into a display label: `directors` → `Director's Cut`. */
function editionLabel(key: string): string {
  if (key === 'directors') return "Director's Cut";
  if (key === 'collectors') return "Collector's Edition";
  if (key === 'theatrical') return 'Theatrical Cut';
  if (key === 'imax') return 'IMAX';
  return key.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase()).trim();
}

function readEdition(parsed: ParsedMovie | ParsedShow, raw: string): string | undefined {
  // 1. Literal phrase from the filename — most accurate.
  const phrase = raw.match(EDITION_PHRASE);
  if (phrase) {
    const word = phrase[1].replace(/'?s$/i, "'s");
    const noun = phrase[2].toLowerCase() === 'release' ? 'Cut' : titleCase(phrase[2]);
    return `${titleCase(word).replace(/'S$/, "'s")} ${noun}`;
  }

  // 2. Standalone edition words.
  for (const [re, label] of EXTRA_EDITIONS) {
    if (re.test(raw)) return label;
  }

  // 3. Parser flag bag — coarse, last resort.
  const bag = (parsed as ParsedMovie).edition as Record<string, unknown> | undefined;
  if (bag) {
    for (const [key, value] of Object.entries(bag)) {
      if (value === true && REAL_EDITION_KEYS.has(key)) return editionLabel(key);
    }
  }
  return undefined;
}

/** Rebuild a human source string: "UHD BluRay REMUX", "WEB-DL". */
function readSource(parsed: ParsedMovie | ParsedShow, raw: string): string | undefined {
  const sources = (parsed.sources ?? []) as string[];
  if (sources.length === 0) return undefined;
  const base = sources[0].replace(/_/g, ' ');
  const isRemux = /\bremux\b/i.test(raw);
  const isUhd = /\b(uhd|2160p)\b/i.test(raw);
  const parts = [isUhd ? 'UHD' : null, base, isRemux ? 'REMUX' : null].filter(Boolean);
  return parts.join(' ');
}

/** Technical tokens that should never survive into a title. */
const TECHNICAL_TOKEN =
  /\b(1080p|2160p|720p|480p|x26[45]|h\.?26[45]|hevc|avc|bluray|webrip|web-?dl|hdtv|remux|dvdrip|xvid|aac|ac3|dts|truehd|atmos|hdr10?|dolby|vision|proper|repack)\b/i;

/** Dangling articles left behind when the parser truncates a title mid-phrase. */
const DANGLING_ARTICLE = /\s+(the|a|an|of|and|in|on|to)$/i;

/**
 * Clean up a parsed title and report what was wrong with it.
 *
 * The motivating case is real:
 *   "Caligula.1979.The.Ultimate.Cut.2023.Release..."
 * parses to title "Caligula 1979 The" with year 2023. Both the stray 1979 and the
 * dangling "The" would poison a TMDB search, and the old confidence check — which only
 * asked whether a title and year existed — waved it straight through as clean.
 */
function sanitizeTitle(
  rawTitle: string,
  year: number | undefined,
): { title: string; originalYear?: number; warnings: ParseWarning[] } {
  const warnings: ParseWarning[] = [];
  let title = rawTitle.trim();
  let originalYear: number | undefined;

  // A 4-digit year sitting inside the title is always parser spill.
  const embedded = title.match(/\b(18|19|20)\d{2}\b/);
  if (embedded) {
    const found = Number(embedded[0]);
    if (found !== year) originalYear = found;
    title = title.replace(embedded[0], ' ').replace(/\s+/g, ' ').trim();
    warnings.push('embedded-year');
  }

  if (TECHNICAL_TOKEN.test(title)) {
    title = title.replace(new RegExp(TECHNICAL_TOKEN.source, 'gi'), ' ').replace(/\s+/g, ' ').trim();
    warnings.push('technical-token-in-title');
  }

  // Strip trailing articles repeatedly: "Caligula 1979 The" → "Caligula".
  while (DANGLING_ARTICLE.test(title)) {
    title = title.replace(DANGLING_ARTICLE, '');
    if (!warnings.includes('dangling-article')) warnings.push('dangling-article');
  }

  return { title: title.trim(), originalYear, warnings };
}

/**
 * Parse a release name.
 *
 * `folders` are the directories containing the file, from the library root down. Films
 * ignore them; an episode needs them when its own name does not say which show it is.
 */
export function parseRelease(rawName: string, folders: readonly string[] = []): ParsedRelease {
  /*
   * Names off a disk can be DECOMPOSED Unicode — "é" stored as "e" plus a combining
   * accent, which is how macOS often writes them. It looks identical and is not: TMDB's
   * search finds nothing for it (Touché, Pussy Cat! and Tom And Chérie matched nothing
   * until this), and a show folder and its files could disagree about their own name.
   * Everything read from a name is composed first.
   */
  const cleaned = cleanReleaseName(rawName.normalize('NFC'));
  const episode = parseEpisode(cleaned, folders) ?? undefined;
  const isShow = episode !== undefined;

  const parsed = filenameParse(cleaned, isShow) as ParsedMovie & Partial<ParsedShow>;
  const yearRaw = isShow ? episode.seriesYear : parsed.year ? Number(parsed.year) : undefined;
  const year = yearRaw && yearRaw > 1880 && yearRaw < 2100 ? yearRaw : undefined;

  /*
   * A series name comes out of scan/episode.ts already clean, and must NOT go through
   * the film sanitiser: that strips years embedded in a title, which would turn the
   * series "1923" into an empty string.
   */
  const { title, originalYear, warnings } = isShow
    ? { title: episode.series, originalYear: undefined, warnings: [] as ParseWarning[] }
    : sanitizeTitle(parsed.title ?? '', year);
  if (!isShow && looksLikeUnplacedTv(cleaned)) warnings.push('tv-without-episode');
  const edition = readEdition(parsed, cleaned);
  const releaseAttributes = readReleaseAttributes(cleaned);

  // A second year anywhere in the raw name means a re-cut or restoration. Films only:
  // an episode's air date in its name is not a second cut of anything.
  const allYears = isShow
    ? []
    : [...cleaned.matchAll(/\b(18|19|20)\d{2}\b/g)].map((m) => Number(m[0]));
  const distinctYears = [...new Set(allYears)];
  if (distinctYears.length > 1 && !warnings.includes('dual-year')) warnings.push('dual-year');

  if (title.length === 0) warnings.push('empty-title');
  else if (title.length < 3) warnings.push('title-too-short');
  if (!year && !isShow) warnings.push('no-year');

  // Most likely first. Edition-qualified variants help for re-cuts that TMDB lists
  // as separate entries ("Caligula: The Ultimate Cut").
  const searchTitles = [
    title,
    edition ? `${title} ${edition}` : null,
    edition ? `${title} ${edition.replace(/\s+(Cut|Edition|Version)$/i, '')}` : null,
  ].filter((t): t is string => Boolean(t && t.length > 0));

  return {
    title,
    normalizedTitle: normalizeTitle(title),
    year,
    originalYear: originalYear ?? (distinctYears.length > 1 ? Math.min(...distinctYears) : undefined),
    edition,
    releaseAttributes,
    source: readSource(parsed, cleaned),
    releaseGroup: parsed.group ?? undefined,
    isShow,
    seasons: isShow ? [episode.season] : undefined,
    episodes: isShow
      ? Array.from(
          { length: (episode.episodeEnd ?? episode.episode) - episode.episode + 1 },
          (_, i) => episode.episode + i,
        )
      : undefined,
    episode,
    searchTitles: [...new Set(searchTitles)],
    warnings,
    lowConfidence: warnings.length > 0,
  };
}
