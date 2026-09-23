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

import type { TitleCard } from '../shared/types.js';

/** A row with one item is noise, not a category. */
export const MIN_ROW = 2;

export type Row = { title: string; titleIds: string[] };

/** Everything row assembly reads. Narrow on purpose, so the tests can be small. */
export type RowCard = Pick<
  TitleCard,
  'id' | 'type' | 'title' | 'genres' | 'collection' | 'year' | 'addedAt'
>;

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
  if (continueIds.length) rows.push({ title: 'Continue Watching', titleIds: continueIds });

  const listIds = known(ctx.myListIds);
  if (listIds.length) rows.push({ title: 'My List', titleIds: listIds });

  const recent = [...cards].sort((a, b) => (b.addedAt ?? '').localeCompare(a.addedAt ?? ''));
  if (recent.length) rows.push({ title: 'Recently Added', titleIds: recent.map((c) => c.id) });

  /*
   * Shows get a shelf of their own near the top. In a library that is mostly films, a
   * handful of series would otherwise only appear scattered through the genre rows,
   * and nothing on the page would say the library holds TV at all. Genre rows still
   * mix both, the way Netflix's do.
   */
  const shows = recent.filter((c) => c.type === 'show');
  if (shows.length >= MIN_ROW) rows.push({ title: 'TV Shows', titleIds: shows.map((c) => c.id) });

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
    rows.push({ title: genre, titleIds: list.map((c) => c.id) });
  }

  return rows;
}
