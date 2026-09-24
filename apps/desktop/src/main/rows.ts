/**
 * Row assembly.
 *
 * Netflix builds rows from viewing behaviour we do not have, so these are derived from
 * what a personal library actually knows: what you started, what you saved, what
 * arrived recently, which franchise a film belongs to, and genre.
 *
 * Pure and separate from `browse.ts` because the ordering rules are worth pinning —
 * `rows.test.ts` holds them still.
 */

import type { BrowseRow, TitleCard } from '../shared/types.js';

/** A row with one item is noise, not a category. */
export const MIN_ROW = 2;

export type Row = BrowseRow;

/** Everything row assembly reads. Narrow on purpose, so the tests can be small. */
export type RowCard = Pick<
  TitleCard,
  'id' | 'type' | 'title' | 'genres' | 'collection' | 'year' | 'addedAt'
> & {
  /** Only what a show's own shelf needs to describe itself. */
  show?: Pick<NonNullable<TitleCard['show']>, 'seasonCount' | 'seasonsLabel' | 'episodeCount' | 'yearLabel' | 'seasons'>;
};

/**
 * The line beside a show's shelf: what it holds, then how far through you are.
 * "2 Seasons · 114 Episodes · 1940–1958 · 12 watched".
 */
export function showShelfSubtitle(show: NonNullable<RowCard['show']>): string {
  const watched = show.seasons.reduce((n, s) => n + s.watchedCount, 0);
  return [
    show.seasonsLabel,
    `${show.episodeCount} ${show.episodeCount === 1 ? 'Episode' : 'Episodes'}`,
    show.yearLabel,
    watched > 0 ? `${watched} watched` : null,
  ]
    .filter(Boolean)
    .join(' · ');
}

export type RowContext = {
  /** Most recently watched first — the store's order, not ours to re-sort. */
  continueIds: readonly string[];
  /** The order the user added them in. */
  myListIds: readonly string[];
};

/**
 * Release order within a franchise, because that is how a series is watched. Ties fall
 * back to the title so a row cannot reshuffle between two reads of the same library.
 */
function byRelease(a: RowCard, b: RowCard): number {
  return (a.year ?? 0) - (b.year ?? 0) || a.title.localeCompare(b.title);
}

export function buildRows(cards: readonly RowCard[], ctx: RowContext): Row[] {
  const byId = new Map(cards.map((c) => [c.id, c]));
  const rows: Row[] = [];

  const known = (ids: readonly string[]): string[] => ids.filter((id) => byId.has(id));

  const continueIds = known(ctx.continueIds);
  if (continueIds.length) rows.push({ kind: 'continue', title: 'Continue Watching', titleIds: continueIds });

  const listIds = known(ctx.myListIds);
  if (listIds.length) rows.push({ kind: 'my-list', title: 'My List', titleIds: listIds });

  const recent = [...cards].sort((a, b) => (b.addedAt ?? '').localeCompare(a.addedAt ?? ''));
  const films = recent.filter((c) => c.type === 'movie');
  const shows = recent.filter((c) => c.type === 'show');

  /*
   * Films and shows arrive separately. One "Recently Added" mixing them put a cartoon
   * collection between a Batman film and a Star Wars film — two different questions
   * ("what can I watch tonight", "which series did I add") answered in one strip. When
   * the library holds only one kind there is nothing to separate, and the plain name is
   * the honest one. "Recently Added TV Shows" also replaces the old "TV Shows" row,
   * which was the same list under another name.
   */
  if (films.length && shows.length) {
    rows.push({ kind: 'recent', title: 'Recently Added Movies', titleIds: films.map((c) => c.id) });
    rows.push({ kind: 'recent', title: 'Recently Added TV Shows', titleIds: shows.map((c) => c.id) });
  } else if (recent.length) {
    rows.push({ kind: 'recent', title: 'Recently Added', titleIds: recent.map((c) => c.id) });
  }

  /*
   * A show with several seasons gets a shelf of its own, one card per season, the way a
   * franchise gets a collection row: "Tom and Jerry" says more about what is on the
   * drive than a single poster in a genre row. One season is not a shelf (MIN_ROW) —
   * its episodes are one click away in the detail view already.
   */
  for (const show of shows) {
    if (!show.show || show.show.seasonCount < MIN_ROW) continue;
    rows.push({ kind: 'seasons', title: show.title, subtitle: showShelfSubtitle(show.show), titleIds: [show.id] });
  }

  // Franchises sit above genres: "Star Wars Collection" says more about a shelf than
  // "Science Fiction" does. TMDB's name is used verbatim — it is the one people know.
  const byCollection = new Map<number, { name: string; members: RowCard[] }>();
  for (const c of cards) {
    if (!c.collection) continue;
    const entry = byCollection.get(c.collection.id) ?? { name: c.collection.name, members: [] };
    entry.members.push(c);
    byCollection.set(c.collection.id, entry);
  }

  const collections = [...byCollection.values()]
    .filter((e) => e.members.length >= MIN_ROW)
    .sort((a, b) => b.members.length - a.members.length || a.name.localeCompare(b.name));

  for (const entry of collections) {
    rows.push({
      kind: 'collection',
      title: entry.name,
      titleIds: [...entry.members].sort(byRelease).map((c) => c.id),
    });
  }

  const byGenre = new Map<string, RowCard[]>();
  for (const c of cards) {
    for (const g of c.genres) {
      const list = byGenre.get(g) ?? [];
      list.push(c);
      byGenre.set(g, list);
    }
  }

  const genres = [...byGenre.entries()]
    .filter(([, list]) => list.length >= MIN_ROW)
    .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));

  for (const [genre, list] of genres) {
    rows.push({ kind: 'genre', title: genre, titleIds: list.map((c) => c.id) });
  }

  return rows;
}
