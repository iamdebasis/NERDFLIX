/**
 * Episode numbering. See ARCHITECTURE.md §5.3 and §7.3.
 *
 * Which file is S02E05 can only be read from its name or the folders around it — ffprobe
 * cannot know, and TMDB can only describe an episode once we have said which one it is.
 * So numbering is the one structural fact the filename owns for TV, alongside edition,
 * source and group. Everything technical still comes from ffprobe, and every episode's
 * name, synopsis and still come from TMDB. The title parsed here is a fallback only.
 *
 * This deliberately does NOT use `@ctrl/video-filename-parser`'s TV mode. Given the
 * names in a real library it:
 *   - reads `Star.Wars.Episode.4.A.New.Hope.1977` as episode 4 of a show called "Star Wars"
 *   - reads a `Season 01` folder as episode 1 of a show called "Season"
 *   - misses double episodes (`S08E01E02`) and season-pack folders entirely
 *   - drops the series year, which is what tells The Office (2001) from The Office (2005)
 * A film misfiled as an episode disappears from the film shelves, so the gate here is
 * strict: an explicit SxxEyy, or NxNN with a series name, or a numbered file directly
 * inside a folder that says which season it is. Nothing else.
 */

export type EpisodeRef = {
  /** "Breaking Bad". Empty when nothing names the series — ingest skips those. */
  series: string;
  /** Where the series name came from. A file names its own series more reliably. */
  seriesSource: 'name' | 'folder' | 'none';
  seriesYear?: number;
  /**
   * TMDB `origin_country` code from a scene suffix: `The.Office.US` → 'US',
   * `The.Office.UK` → 'GB'. The one reliable way to split a remake from its original
   * when the name carries no year.
   */
  country?: string;
  season: number;
  episode: number;
  /** Last episode of a multi-episode file: `S08E01E02` → episode 1, episodeEnd 2. */
  episodeEnd?: number;
  /** From the filename. Fallback only — TMDB's episode name wins when there is one. */
  episodeTitle?: string;
};

const MAX_SEASON = 99;
const MAX_EPISODE = 999;

/**
 * A season number: one or two digits, or a YEAR.
 *
 * Some series are numbered by year rather than from 1 — the classic Tom and Jerry
 * shorts ship as `Tom and Jerry - S1940E01 - Puss Gets The Boot`, in a folder called
 * `Season 1940`. Reading `S1940` as nothing turned 46 cartoons into 46 unmatched
 * "films". Years are accepted only where the context is explicit — an `SxxxxEyy`
 * marker, a folder named exactly for the season, a season-pack folder — and NOT in the
 * looser "does this look like TV" check in parse.ts, where `Open.Season.2006` is a film.
 *
 * Years first in the alternation, so `S1940` is never read as `S19` plus junk.
 */
const SEASON = String.raw`(?:19|20)\d{2}|\d{1,2}`;
const MARKER = new RegExp(String.raw`\bS(${SEASON})[\s._-]?E(\d{1,3})(?!\d)`, 'i');

/** Is this season number a year (`S1940`) rather than a count? */
export function isYearSeason(season: number): boolean {
  return season >= 1900 && season <= 2099;
}

function plausibleSeason(n: number): boolean {
  return n <= MAX_SEASON || isYearSeason(n);
}
/** A file spanning more episodes than this is a misread, not a real multi-episode file. */
const MAX_EPISODE_SPAN = 10;

/** Scene suffix → TMDB origin_country. UK is "GB" there, which is the one surprise. */
const COUNTRY_SUFFIX: Record<string, string> = { US: 'US', UK: 'GB', AU: 'AU', NZ: 'NZ', CA: 'CA' };

/**
 * Where a technical token begins, the episode title has ended.
 * Kept to tokens that never appear in a real episode title.
 */
const TECH_START =
  /(^|[\s._-])(\d{3,4}p|4k|uhd|blu-?ray|bdrip|brrip|web-?dl|web-?rip|web|hdtv|remux|hdr10?\+?|hdr|dv|dovi|dolby|x26[45]|h[\s._]?26[45]|hevc|avc|xvid|dd[p+]?\d|ddp|eac3|ac3|aac|dts|truehd|atmos|flac|10-?bit|proper|repack|internal|amzn|nf|atvp|dsnp|hmax|max|hulu|pcok|pmtp|stan|itunes|complete)(?=$|[\s._-])/i;

/** Folders that organise a library rather than name a show. Never a series name. */
const GENERIC_FOLDER =
  /^(tv|tv[\s._-]?shows?|shows?|series|television|tv[\s._-]?series|media|videos?|movies?|films?|library|downloads?|complete)$/i;

function tidy(s: string): string {
  return s
    .replace(/[._]+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[\s\-–—:]+|[\s\-–—:]+$/g, '')
    .trim();
}

/**
 * Split a raw series string into name, year and country.
 *
 * Only strips a trailing year when something is left: `1923` is a series name, and
 * `Doctor.Who.2005` is Doctor Who first aired in 2005.
 */
export function cleanSeriesName(raw: string): { name: string; year?: number; country?: string } {
  let name = tidy(raw);
  let year: number | undefined;
  let country: string | undefined;

  const takeCountry = () => {
    const m = name.match(/^(.*\S)\s+\(?(US|UK|AU|NZ|CA)\)?$/);
    if (m && m[1].trim().length > 0) {
      name = m[1].trim();
      country = COUNTRY_SUFFIX[m[2]];
    }
  };
  const takeYear = () => {
    const m = name.match(/^(.*\S)\s+\(?((?:19|20)\d{2})\)?$/);
    if (m && m[1].trim().length > 0) {
      name = m[1].trim();
      year = Number(m[2]);
    }
  };

  // Either order occurs: `The.Office.US.2005` and `Doctor Who (2005) UK`.
  takeCountry();
  takeYear();
  takeCountry();

  return { name: tidy(name), year, country };
}

/** `Season 01` → 1, `S2` → 2, `Specials` → 0. Null when the folder says nothing about seasons. */
export function seasonFromFolder(folder: string): number | null {
  const f = folder.trim();
  if (/^specials?$/i.test(f)) return 0;
  const m =
    f.match(new RegExp(String.raw`^(?:season|series|staffel|saison|temporada|stagione)[\s._-]*(${SEASON})$`, 'i')) ??
    f.match(new RegExp(String.raw`^s(${SEASON})$`, 'i'));
  if (!m) return null;
  const n = Number(m[1]);
  return plausibleSeason(n) ? n : null;
}

/**
 * A season-pack folder: `Breaking.Bad.S01.2160p.WEB-DL-GRP`, `Chernobyl.S01.COMPLETE`,
 * `The Wire Season 3`. Returns the series part, so a loose episode inside can be named
 * even when its own filename is just `S01E01.mkv`.
 */
export function parseSeasonPack(folder: string): { series: string; season: number } | null {
  const m =
    folder.match(new RegExp(String.raw`^(.+?)[\s._-]+S(${SEASON})(?![\dE])(?=$|[\s._-])`, 'i')) ??
    folder.match(new RegExp(String.raw`^(.+?)[\s._-]+season[\s._-]*(${SEASON})(?=$|[\s._-])`, 'i'));
  if (!m) return null;
  const season = Number(m[2]);
  const series = tidy(m[1]);
  if (!series || !plausibleSeason(season)) return null;
  return { series, season };
}

/** The series named by the folders around a file, nearest first. */
export function seriesFromFolders(
  folders: readonly string[],
): { name: string; year?: number; country?: string } | null {
  for (let i = folders.length - 1; i >= 0; i -= 1) {
    const folder = folders[i];
    if (seasonFromFolder(folder) !== null) continue;
    if (GENERIC_FOLDER.test(folder.trim())) continue;

    const pack = parseSeasonPack(folder);
    const raw = pack ? pack.series : folder;
    // A per-episode release folder names its series before the marker.
    const marked = raw.match(/^(.+?)[\s._-]+S\d{1,2}[\s._-]?E\d{1,3}/i);
    const cleaned = cleanSeriesName(marked ? marked[1] : raw);
    if (cleaned.name) return cleaned;
  }
  return null;
}

/** Text after the marker, up to the first technical token. */
function readEpisodeTitle(rest: string): string | undefined {
  const cut = rest.search(TECH_START);
  let head = cut >= 0 ? rest.slice(0, cut) : rest;
  /*
   * A release group only sits directly after the title when NO technical token follows
   * (`Pilot-GRP`); otherwise it trails the tech tokens and is already gone. Stripping a
   * trailing `-Word` unconditionally cut "Seven Thirty-Seven" down to "Seven Thirty".
   * Groups are short and capitalised; words in a title are not.
   */
  if (cut < 0) head = head.replace(/-[A-Z0-9]{2,}$/, '');
  const title = tidy(head);
  return title.length >= 2 ? title : undefined;
}

/**
 * Further episodes after the first: `E02`, `-E02`, `-02`.
 *
 * `S01E01.2160p` must not become episodes 1–216, so a continuation needs a hyphen or an
 * `E`, may not run into more digits or a `p`, and must stay within a plausible span.
 */
function readContinuation(after: string, first: number): { end?: number; consumed: number } {
  let consumed = 0;
  let end: number | undefined;
  const step = /^(?:[\s._]?E|[\s._]*-[\s._]*E?)(\d{1,3})(?![\dp])/i;
  for (;;) {
    const m = after.slice(consumed).match(step);
    if (!m) break;
    const n = Number(m[1]);
    const floor = end ?? first;
    if (n <= floor || n - first > MAX_EPISODE_SPAN) break;
    end = n;
    consumed += m[0].length;
  }
  return { end, consumed };
}

/**
 * Read which episode a file is.
 *
 * `name` is the release name (a file stem, or a per-episode release folder's name).
 * `folders` are the directories containing the file, from the library root down, and
 * supply the series and season when the name itself does not.
 */
export function parseEpisode(rawName: string, rawFolders: readonly string[] = []): EpisodeRef | null {
  // Composed, as in parse.ts: a decomposed "é" is invisible here and fatal to a search.
  const name = rawName.normalize('NFC');
  const folders = rawFolders.map((f) => f.normalize('NFC'));
  const parent = folders.length ? folders[folders.length - 1] : '';
  const parentSeason = parent ? seasonFromFolder(parent) : null;

  let season: number;
  let episode: number;
  let episodeEnd: number | undefined;
  let before: string;
  let rest: string;
  let allowEmptySeries: boolean;

  const sxe = name.match(MARKER);
  const nxn = sxe ? null : name.match(/\b(\d{1,2})x(\d{2,3})\b/);

  if (sxe && sxe.index !== undefined) {
    season = Number(sxe[1]);
    episode = Number(sxe[2]);
    const after = name.slice(sxe.index + sxe[0].length);
    const cont = readContinuation(after, episode);
    episodeEnd = cont.end;
    before = name.slice(0, sxe.index);
    rest = after.slice(cont.consumed);
    allowEmptySeries = true;
  } else if (nxn && nxn.index !== undefined) {
    season = Number(nxn[1]);
    episode = Number(nxn[2]);
    before = name.slice(0, nxn.index);
    rest = name.slice(nxn.index + nxn[0].length);
    // `10x10` is also the name of a film. Without a series before it, or a season folder
    // around it, NxNN is not evidence of anything.
    allowEmptySeries = parentSeason !== null;
  } else if (parentSeason !== null) {
    /*
     * `Season 01/03 - The Replacements.mkv`. Only DIRECTLY inside a folder that names
     * the season, and only when the name opens with the number — so a featurette two
     * levels down, or a film in some folder called "Season Pass", is never read as one.
     */
    const lead = name.match(/^(?:e|ep|episode)?[\s._-]*(\d{1,3})(?=$|[\s._-])/i);
    if (!lead) return null;
    season = parentSeason;
    episode = Number(lead[1]);
    before = '';
    rest = name.slice(lead[0].length);
    allowEmptySeries = true;
  } else {
    return null;
  }

  if (!plausibleSeason(season) || episode > MAX_EPISODE || episode === 0) return null;

  const fromName = cleanSeriesName(before);
  let series = fromName.name;
  let seriesSource: EpisodeRef['seriesSource'] = series ? 'name' : 'none';
  let seriesYear = fromName.year;
  let country = fromName.country;

  if (!series) {
    if (!allowEmptySeries) return null;
    const fromFolders = seriesFromFolders(folders);
    if (fromFolders) {
      series = fromFolders.name;
      seriesSource = 'folder';
      seriesYear = fromFolders.year;
      country = fromFolders.country;
    }
  } else if (!seriesYear || !country) {
    // The file named the series; a folder like `The Office (2005)` may still say which one.
    const fromFolders = seriesFromFolders(folders);
    if (fromFolders && fromFolders.name.toLowerCase() === series.toLowerCase()) {
      seriesYear ??= fromFolders.year;
      country ??= fromFolders.country;
    }
  }

  return {
    series,
    seriesSource,
    seriesYear,
    country,
    season,
    episode,
    episodeEnd,
    episodeTitle: readEpisodeTitle(rest),
  };
}

/** Does a filename carry an explicit episode marker? Used to relax the feature-size floor. */
export function hasEpisodeMarker(name: string): boolean {
  return MARKER.test(name);
}

/** `S1:E4`, or `S1:E1–E2` for a double episode — Netflix's own short form. */
export function episodeLabel(ref: { season: number; episode: number; episodeEnd?: number }): string {
  const range = ref.episodeEnd ? `E${ref.episode}–E${ref.episodeEnd}` : `E${ref.episode}`;
  return ref.season === 0 ? `Special ${range.slice(1)}` : `S${ref.season}:${range}`;
}
