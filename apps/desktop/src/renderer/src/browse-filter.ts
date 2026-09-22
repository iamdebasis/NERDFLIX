/**
 * Sorting and filtering the library.
 *
 * Pure and React-free for the same reason `trailer-store.ts` is: what belongs in the
 * result set, and in what order, is decided by rules that no screenshot can check.
 * `browse-filter.test.ts` holds them still.
 *
 * The facets are DERIVED FROM THE LIBRARY, never hardcoded. A shelf with nothing in
 * 1080p must not offer a 1080p filter that returns an empty grid — same principle as
 * the chip table in CLAUDE.md rule 4: measure what is actually there.
 */

import type { TitleCard } from '../../shared/types';

export type SortKey = 'added' | 'title' | 'year' | 'runtime' | 'size';

/** The order the buttons appear in, and their labels. */
export const SORTS: Array<{ key: SortKey; label: string }> = [
  { key: 'added', label: 'Recently added' },
  { key: 'title', label: 'Title A–Z' },
  { key: 'year', label: 'Release year' },
  { key: 'runtime', label: 'Runtime' },
  { key: 'size', label: 'File size' },
];

/** `added` is what the shelf already does, so it is the one that means "no sort". */
export const DEFAULT_SORT: SortKey = 'added';

export type Filters = {
  /** OR within the facet: Action OR Comedy. */
  genres: string[];
  resolutions: string[];
  /** Anything that is not SDR. */
  hdr: boolean;
  unwatched: boolean;
  /** Hide films whose drive is not plugged in. */
  available: boolean;
};

export const NO_FILTERS: Filters = {
  genres: [],
  resolutions: [],
  hdr: false,
  unwatched: false,
  available: false,
};

/** How many facets are switched on — the badge on the Filters button. */
export function activeCount(f: Filters): number {
  return (
    (f.genres.length ? 1 : 0) +
    (f.resolutions.length ? 1 : 0) +
    (f.hdr ? 1 : 0) +
    (f.unwatched ? 1 : 0) +
    (f.available ? 1 : 0)
  );
}

/**
 * Whether the shelf collapses into a single result set.
 *
 * A non-default sort counts, not just a filter: asking for the library in title order
 * and then getting genre rows each internally sorted is not what was asked for. Same
 * reasoning as search — one ordered set, not the same film under three headings.
 */
export function isNarrowed(f: Filters, sort: SortKey): boolean {
  return activeCount(f) > 0 || sort !== DEFAULT_SORT;
}

export function isHdr(card: Pick<TitleCard, 'hdr'>): boolean {
  return Boolean(card.hdr) && card.hdr !== 'SDR';
}

export function applyFilters(cards: readonly TitleCard[], f: Filters): TitleCard[] {
  return cards.filter((c) => {
    if (f.genres.length && !c.genres.some((g) => f.genres.includes(g))) return false;
    if (f.resolutions.length && !f.resolutions.includes(c.resolution)) return false;
    if (f.hdr && !isHdr(c)) return false;
    if (f.unwatched && c.watched) return false;
    if (f.available && !c.available) return false;
    return true;
  });
}

/** Descending for everything measurable; ties fall back to the title so it is stable. */
export function sortCards(cards: readonly TitleCard[], key: SortKey): TitleCard[] {
  const byTitle = (a: TitleCard, b: TitleCard) => a.sortTitle.localeCompare(b.sortTitle);

  return [...cards].sort((a, b) => {
    switch (key) {
      case 'title':
        return byTitle(a, b);
      case 'year':
        return (b.year ?? 0) - (a.year ?? 0) || byTitle(a, b);
      case 'runtime':
        return (b.runtimeMinutes ?? 0) - (a.runtimeMinutes ?? 0) || byTitle(a, b);
      case 'size':
        return b.sizeBytes - a.sizeBytes || byTitle(a, b);
      case 'added':
      default:
        return (b.addedAt ?? '').localeCompare(a.addedAt ?? '') || byTitle(a, b);
    }
  });
}

export type Facets = {
  genres: string[];
  resolutions: string[];
  hdr: boolean;
  unwatched: boolean;
  availability: boolean;
};

/**
 * Whether a predicate actually divides the library.
 *
 * One rule behind every facet: a control that matches everything, or nothing, cannot
 * change what you see. An all-4K shelf must not offer a "4K" pill, and a library with
 * every drive plugged in must not offer "On a connected drive" — both look like the
 * filter is broken when nothing moves.
 */
function splits<T>(cards: readonly T[], pred: (c: T) => boolean): boolean {
  let yes = false;
  let no = false;
  for (const c of cards) {
    if (pred(c)) yes = true;
    else no = true;
    if (yes && no) return true;
  }
  return false;
}

/**
 * What this library can actually be filtered by.
 *
 * Genres are ordered by how common they are, so the useful ones are not below the
 * fold; resolutions by height, descending, because 4K is what people reach for.
 */
export function facets(cards: readonly TitleCard[]): Facets {
  const genreCount = new Map<string, number>();
  for (const c of cards) {
    for (const g of c.genres) genreCount.set(g, (genreCount.get(g) ?? 0) + 1);
  }

  const genres = [...genreCount.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([g]) => g)
    .filter((g) => splits(cards, (c) => c.genres.includes(g)));

  const resolutions = [...new Set(cards.map((c) => c.resolution).filter(Boolean))]
    .sort((a, b) => (parseInt(b, 10) || 0) - (parseInt(a, 10) || 0) || a.localeCompare(b))
    .filter((r) => splits(cards, (c) => c.resolution === r));

  return {
    genres,
    resolutions,
    hdr: splits(cards, isHdr),
    unwatched: splits(cards, (c) => c.watched),
    availability: splits(cards, (c) => c.available),
  };
}

/** Toggle one value of a multi-select facet, keeping the array a set. */
export function toggleValue(values: readonly string[], value: string): string[] {
  return values.includes(value) ? values.filter((v) => v !== value) : [...values, value];
}
