/**
 * Candidate scoring. See ARCHITECTURE.md §7.4.
 *
 * Pure functions, no network — this is the part that can be quietly wrong, so it is
 * the part that gets tested. A wrong auto-match is worse than a flagged one, because
 * you never find out: the film just has someone else's plot summary forever.
 */

import type { ParsedRelease } from '../scan/parse.js';
import type { TmdbShowCandidate } from './tmdb.js';

export type TmdbCandidate = {
  id: number;
  title: string;
  original_title?: string;
  release_date?: string;
  popularity?: number;
  vote_count?: number;
};

export type MatchScore = {
  candidate: TmdbCandidate;
  score: number;
  /** Human-readable reasons, surfaced in the review queue. */
  reasons: string[];
  titleScore: number;
  yearScore: number;
  runtimeScore: number | null;
};

/** Levenshtein distance. Small enough not to warrant a dependency. */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  const curr = new Array<number>(b.length + 1);

  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    prev = [...curr];
  }
  return prev[b.length];
}

/** Punctuation-insensitive: scene naming eats colons, so "Terminator 2 Judgment Day". */
export function normalize(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export function titleSimilarity(a: string, b: string): number {
  const x = normalize(a);
  const y = normalize(b);
  if (!x || !y) return 0;
  if (x === y) return 1;

  const distance = levenshtein(x, y);
  const ratio = 1 - distance / Math.max(x.length, y.length);

  // A release name often keeps a subtitle TMDB drops, or vice versa. Treat a clean
  // prefix match generously rather than penalising the extra words linearly.
  if (x.startsWith(y) || y.startsWith(x)) return Math.max(ratio, 0.9);
  return Math.max(0, ratio);
}

/**
 * Runtime corroboration, which the filename cannot give us.
 *
 * Underused and free: we already know the real duration from ffprobe. It separates
 * remakes with identical titles, and a large mismatch against an otherwise good match
 * usually means a different cut — exactly what the `edition` field is for.
 */
export function runtimeSimilarity(fileSeconds: number, tmdbMinutes?: number): number | null {
  if (!tmdbMinutes || tmdbMinutes <= 0 || fileSeconds <= 0) return null;
  const fileMinutes = fileSeconds / 60;
  const diff = Math.abs(fileMinutes - tmdbMinutes);
  if (diff <= 2) return 1;
  if (diff <= 5) return 0.85;
  if (diff <= 12) return 0.6;
  if (diff <= 25) return 0.3;
  return 0;
}

function yearOf(candidate: TmdbCandidate): number | undefined {
  const y = Number((candidate.release_date ?? '').slice(0, 4));
  return Number.isFinite(y) && y > 1880 ? y : undefined;
}

export function scoreCandidate(
  parsed: Pick<ParsedRelease, 'title' | 'year' | 'originalYear' | 'searchTitles'>,
  candidate: TmdbCandidate,
  fileSeconds: number,
  tmdbRuntimeMinutes?: number,
): MatchScore {
  const reasons: string[] = [];

  // Try every candidate string the parser produced, keep the best.
  const names = [candidate.title, candidate.original_title].filter(Boolean) as string[];
  const probes = parsed.searchTitles.length ? parsed.searchTitles : [parsed.title];
  let titleScore = 0;
  for (const p of probes) {
    for (const n of names) titleScore = Math.max(titleScore, titleSimilarity(p, n));
  }
  if (titleScore >= 0.95) reasons.push('title matches');
  else if (titleScore >= 0.8) reasons.push('title close');
  else reasons.push('title differs');

  const cYear = yearOf(candidate);
  let yearScore = 0.5; // unknown year is neutral, not damning
  if (parsed.year && cYear) {
    const delta = Math.abs(parsed.year - cYear);
    // A re-cut references the original film's year; accept either.
    const altDelta = parsed.originalYear ? Math.abs(parsed.originalYear - cYear) : Infinity;
    const best = Math.min(delta, altDelta);
    if (best === 0) {
      yearScore = 1;
      reasons.push('year matches');
    } else if (best === 1) {
      yearScore = 0.8;
      reasons.push('year off by one');
    } else {
      yearScore = 0;
      reasons.push(`year off by ${best}`);
    }
  }

  const runtimeScore = runtimeSimilarity(fileSeconds, tmdbRuntimeMinutes);
  if (runtimeScore !== null) {
    if (runtimeScore >= 0.85) reasons.push('runtime matches');
    else if (runtimeScore <= 0.3) reasons.push('runtime differs — possibly another cut');
  }

  // Title and year carry the decision; runtime confirms rather than decides, because
  // a legitimately different edition would otherwise be scored as a wrong film.
  const base = titleScore * 0.6 + yearScore * 0.4;
  const score = runtimeScore === null ? base : base * 0.85 + runtimeScore * 0.15;

  return { candidate, score, reasons, titleScore, yearScore, runtimeScore };
}

export type MatchDecision = {
  best: MatchScore | null;
  runnersUp: MatchScore[];
  /** 'auto' is safe to apply unattended; 'review' needs a human. */
  verdict: 'auto' | 'review' | 'none';
};

/** Auto-accept only when title AND year are both convincing. */
export function decide(scores: MatchScore[]): MatchDecision {
  if (scores.length === 0) return { best: null, runnersUp: [], verdict: 'none' };

  const sorted = [...scores].sort((a, b) => b.score - a.score);
  const best = sorted[0];
  const second = sorted[1];

  const confident =
    best.titleScore >= 0.9 &&
    best.yearScore >= 0.8 &&
    best.score >= 0.85 &&
    // A near-tie means two plausible films — a remake, usually. Ask.
    (!second || best.score - second.score > 0.08);

  return {
    best,
    runnersUp: sorted.slice(1, 4),
    verdict: confident ? 'auto' : 'review',
  };
}

// --- TV ------------------------------------------------------------------------


export type ShowQuery = {
  series: string;
  year?: number;
  /** TMDB origin_country code, from a scene suffix like `The.Office.US`. */
  country?: string;
  searchTitles?: readonly string[];
};

export type ShowScore = {
  candidate: TmdbShowCandidate;
  score: number;
  reasons: string[];
  titleScore: number;
  yearScore: number;
  /** null when the file gave no country to compare against. */
  countryMatch: boolean | null;
};

function firstAirYear(c: TmdbShowCandidate): number | undefined {
  const y = Number((c.first_air_date ?? '').slice(0, 4));
  return Number.isFinite(y) && y > 1880 ? y : undefined;
}

/**
 * Could this series have the seasons on disk? One whose seasons are numbered by year
 * cannot have first aired after its earliest season.
 *
 * Not a score — an exclusion, like every year rule here. Without it `Tom and Jerry -
 * S1940E01` meets TMDB's only series named exactly "Tom and Jerry", which began in
 * 2023, with a perfect name, no year to object and no rival: an automatic match of 46
 * 1940s cartoons to the wrong show. A year off either way is allowed for data slop.
 */
export function couldHaveSeasons(c: TmdbShowCandidate, earliestYearSeason?: number): boolean {
  if (earliestYearSeason === undefined) return true;
  const y = firstAirYear(c);
  return y === undefined || y <= earliestYearSeason + 1;
}

export function scoreShowCandidate(q: ShowQuery, candidate: TmdbShowCandidate): ShowScore {
  const reasons: string[] = [];
  const names = [candidate.name, candidate.original_name].filter(Boolean) as string[];
  const probes = q.searchTitles?.length ? q.searchTitles : [q.series];

  let titleScore = 0;
  for (const p of probes) for (const n of names) titleScore = Math.max(titleScore, titleSimilarity(p, n));
  if (titleScore >= 0.95) reasons.push('name matches');
  else if (titleScore >= 0.8) reasons.push('name close');
  else reasons.push('name differs');

  let yearScore = 0.5; // unknown is neutral — most episode names carry no year
  const cYear = firstAirYear(candidate);
  if (q.year && cYear) {
    const delta = Math.abs(q.year - cYear);
    yearScore = delta === 0 ? 1 : delta === 1 ? 0.8 : 0;
    reasons.push(delta === 0 ? 'first aired that year' : `first aired ${delta} year(s) apart`);
  }

  let countryMatch: boolean | null = null;
  if (q.country) {
    countryMatch = (candidate.origin_country ?? []).includes(q.country);
    reasons.push(countryMatch ? `made in ${q.country}` : `not from ${q.country}`);
  }

  let score = titleScore * 0.6 + yearScore * 0.4;
  if (countryMatch === true) score = Math.min(1, score + 0.1);
  if (countryMatch === false) score *= 0.5;

  return { candidate, score, reasons, titleScore, yearScore, countryMatch };
}

export type ShowDecision = {
  best: ShowScore | null;
  runnersUp: ShowScore[];
  verdict: 'auto' | 'review' | 'none';
};

/**
 * Auto-accept a show only when nothing else could be it.
 *
 * Films require the year to agree, but most episode names carry no year, so that rule
 * would send every show to review. The TV rule instead asks whether the NAME is
 * ambiguous: "Breaking Bad" names one series and is safe; "The Office" names at least
 * three (US, UK, and others) and is not — unless the file's year or country rules the
 * others out. Popularity is never the tie-breaker: that is precisely how a wrong match
 * gets applied silently, and a wrong show is worse than a flagged one because nobody
 * finds out.
 */
export function decideShow(scores: ShowScore[]): ShowDecision {
  if (scores.length === 0) return { best: null, runnersUp: [], verdict: 'none' };

  const sorted = [...scores].sort((a, b) => b.score - a.score);
  const best = sorted[0];
  const others = sorted.slice(1);

  /*
   * Near-exact names only. The film matcher scores a prefix match 0.9, because a release
   * often keeps a subtitle TMDB drops — but TV spin-offs share prefixes ("Star Wars" /
   * "Star Wars: The Clone Wars"), so for a show a prefix match is neither enough to
   * accept nor enough to count as a rival to an exact one.
   */
  const NEAR_EXACT = 0.95;

  // A rival is another show with the same name that the file does not rule out.
  const rivals = others.filter(
    (o) =>
      o.titleScore >= NEAR_EXACT &&
      o.countryMatch !== false &&
      (best.yearScore < 1 || o.yearScore >= 0.8),
  );

  const confident =
    best.titleScore >= NEAR_EXACT &&
    best.countryMatch !== false &&
    best.yearScore !== 0 &&
    rivals.length === 0;

  return { best, runnersUp: others.slice(0, 3), verdict: confident ? 'auto' : 'review' };
}
