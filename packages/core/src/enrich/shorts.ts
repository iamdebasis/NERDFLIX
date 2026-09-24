/**
 * Series that TMDB lists as FILMS, one per episode. See ARCHITECTURE.md §7.4.
 *
 * The classic Tom and Jerry cartoons ship as a series (`S1940E01`), but TMDB has no
 * series for them: every "Tom and Jerry" TV entry there is a later show, and the only
 * one named exactly that is a 2023 series. Each 1940s cartoon IS on TMDB — as a film,
 * with a poster, a backdrop, a synopsis and its directors.
 *
 * So such a show is described episode by episode, and these are the rules for which
 * film an episode is. Pure, because a wrong match here is silent: the episode simply
 * shows another cartoon's picture and plot, and nobody finds out.
 *
 * Only for YEAR-numbered seasons. The year is what makes a title search safe: an
 * episode called "Pilot" matched against every film called "Pilot" would be wrong
 * nearly every time, but "The Midnight Snack" released in the 1940s is one film.
 */

import { titleSimilarity } from './match.js';
import type { TmdbCandidate } from './match.js';
import type { TmdbMovie } from './tmdb.js';

/** Titles must agree this closely — the same bar a show's own name has to clear. */
const NEAR_EXACT = 0.95;

/**
 * How far past its season's year a film may be released. A year-numbered season may
 * be one year (a single-year pack) or a decade: the real `Season 1940` of Tom and
 * Jerry runs from 1940's Puss Gets the Boot to 1949's Tennis Chumps.
 */
export const SEASON_SPAN_YEARS = 9;

/** A series needs this many matched films before "the people who made most of them" means anything. */
const MIN_FOR_CONSENSUS = 3;

export function releaseYear(film: { release_date?: string }): number | undefined {
  const y = Number((film.release_date ?? '').slice(0, 4));
  return Number.isFinite(y) && y > 1880 ? y : undefined;
}

/**
 * The films an episode could be: a near-exact title, released within its season's
 * span. Best title first. `Quiet Please!` keeps the 1945 cartoon and drops 1943's
 * "Quiet Please, Murder" on the title alone.
 */
export function shortCandidates(
  episodeTitle: string,
  season: number,
  results: readonly TmdbCandidate[],
): TmdbCandidate[] {
  return results
    .map((c) => ({
      c,
      sim: Math.max(
        titleSimilarity(episodeTitle, c.title),
        c.original_title ? titleSimilarity(episodeTitle, c.original_title) : 0,
      ),
      year: releaseYear(c),
    }))
    .filter(({ sim, year }) => sim >= NEAR_EXACT && year !== undefined && year >= season && year <= season + SEASON_SPAN_YEARS)
    .sort((a, b) => b.sim - a.sim)
    .map(({ c }) => c);
}

/**
 * Does TMDB's runtime agree with the file? An unknown runtime cannot disagree. A
 * seven-minute cartoon is never a seventy-minute feature, and a few minutes either way
 * is only a different transfer.
 */
export function runtimeAgrees(fileSec: number, runtimeMinutes?: number | null): boolean {
  if (!runtimeMinutes || runtimeMinutes <= 0 || !(fileSec > 0)) return true;
  const fileMinutes = fileSec / 60;
  return Math.abs(fileMinutes - runtimeMinutes) <= Math.max(3, fileMinutes * 0.3);
}

export function directorsOf(film: TmdbMovie): string[] {
  return (film.credits?.crew ?? []).filter((c) => c.job === 'Director').map((c) => c.name);
}

/**
 * Who made this series: directors credited on at least half of its matched films,
 * most often credited first. Empty until there are enough films to call it a
 * consensus rather than a coincidence.
 */
export function seriesMakers(films: readonly TmdbMovie[]): string[] {
  if (films.length < MIN_FOR_CONSENSUS) return [];
  const count = new Map<string, number>();
  for (const f of films) for (const d of new Set(directorsOf(f))) count.set(d, (count.get(d) ?? 0) + 1);
  return [...count.entries()]
    .filter(([, n]) => n * 2 >= films.length)
    .sort((a, b) => b[1] - a[1])
    .map(([name]) => name);
}

/**
 * Two films of the same name in the same decade, both the right length — the real
 * "The Night Before Christmas" of 1941 and a different 1946 short. The one made by the
 * people who made the rest of the series is the episode; if that still does not
 * single one out, neither is chosen.
 */
export function pickByMakers(options: readonly TmdbMovie[], makers: readonly string[]): TmdbMovie | null {
  if (makers.length === 0) return null;
  const made = options.filter((f) => directorsOf(f).some((d) => makers.includes(d)));
  return made.length === 1 ? made[0] : null;
}
