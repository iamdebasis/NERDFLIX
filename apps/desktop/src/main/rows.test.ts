import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { buildRows, type Row, type RowCard } from './rows.js';
import type { SeasonCard } from '../shared/types.js';

/**
 * What ends up on each shelf, and in what order.
 *
 * Ordering is the whole substance of row assembly and none of it is visible in a
 * screenshot, so it is pinned here rather than eyeballed. The tie-break cases exist
 * because the previous inline version relied on sort stability and therefore on the
 * order `readdir` happened to return.
 */

const SW = { id: 10, name: 'Star Wars Collection' };
const POTC = { id: 295, name: 'Pirates of the Caribbean Collection' };

function card(id: string, over: Partial<RowCard> = {}): RowCard {
  return { id, type: 'movie', title: id, genres: [], year: 2000, addedAt: '2024-01-01T00:00:00Z', ...over };
}

const EMPTY = { continueIds: [], myListIds: [] };

const row = (rows: Row[], title: string) => rows.find((r) => r.title === title);

describe('row assembly', () => {
  test('the fixed rows come first, then franchises, then genres', () => {
    const cards = [
      card('a', { genres: ['Action'], collection: SW, year: 1977 }),
      card('b', { genres: ['Action'], collection: SW, year: 1980 }),
    ];
    const rows = buildRows(cards, { continueIds: ['a'], myListIds: ['b'] });

    assert.deepEqual(rows.map((r) => r.title), [
      'Continue Watching',
      'My List',
      'Recently Added',
      'Star Wars Collection',
      'Action',
    ]);
  });

  test('a franchise is in release order, not the order it was scanned', () => {
    const cards = [
      card('jedi', { collection: SW, year: 1983 }),
      card('newhope', { collection: SW, year: 1977 }),
      card('empire', { collection: SW, year: 1980 }),
    ];
    const rows = buildRows(cards, EMPTY);
    assert.deepEqual(row(rows, 'Star Wars Collection')?.titleIds, ['newhope', 'empire', 'jedi']);
  });

  test('one owned member is not a collection', () => {
    const cards = [
      card('cars', { collection: { id: 87118, name: 'Cars Collection' } }),
      card('sw1', { collection: SW }),
      card('sw2', { collection: SW }),
    ];
    const titles = buildRows(cards, EMPTY).map((r) => r.title);
    assert.ok(titles.includes('Star Wars Collection'));
    assert.ok(!titles.includes('Cars Collection'));
  });

  test('collections are ordered by how much of each you own', () => {
    const cards = [
      card('p1', { collection: POTC }),
      card('p2', { collection: POTC }),
      card('s1', { collection: SW }),
      card('s2', { collection: SW }),
      card('s3', { collection: SW }),
    ];
    const titles = buildRows(cards, EMPTY).map((r) => r.title);
    assert.ok(
      titles.indexOf('Star Wars Collection') < titles.indexOf('Pirates of the Caribbean Collection'),
    );
  });

  test('a film stays in its genre rows as well as its collection', () => {
    const cards = [
      card('a', { genres: ['Action', 'Science Fiction'], collection: SW }),
      card('b', { genres: ['Action', 'Science Fiction'], collection: SW }),
    ];
    const rows = buildRows(cards, EMPTY);
    assert.deepEqual(row(rows, 'Star Wars Collection')?.titleIds, ['a', 'b']);
    assert.deepEqual(row(rows, 'Action')?.titleIds, ['a', 'b']);
    assert.deepEqual(row(rows, 'Science Fiction')?.titleIds, ['a', 'b']);
  });

  test('ids outside the scoped library are dropped', () => {
    // Continue Watching and My List are global; browsing one drive must not surface a
    // film that lives on another.
    const rows = buildRows([card('here')], {
      continueIds: ['here', 'elsewhere'],
      myListIds: ['elsewhere'],
    });
    assert.deepEqual(row(rows, 'Continue Watching')?.titleIds, ['here']);
    assert.equal(row(rows, 'My List'), undefined);
  });

  test('Continue Watching keeps the order it was given', () => {
    const rows = buildRows([card('a'), card('b'), card('c')], {
      continueIds: ['c', 'a'],
      myListIds: [],
    });
    assert.deepEqual(row(rows, 'Continue Watching')?.titleIds, ['c', 'a']);
  });

  test('Recently Added is newest first', () => {
    const cards = [
      card('old', { addedAt: '2024-01-01T00:00:00Z' }),
      card('new', { addedAt: '2025-06-01T00:00:00Z' }),
      card('mid', { addedAt: '2024-09-01T00:00:00Z' }),
    ];
    assert.deepEqual(row(buildRows(cards, EMPTY), 'Recently Added')?.titleIds, [
      'new',
      'mid',
      'old',
    ]);
  });

  test('equal-sized genres do not reshuffle between two reads of the same library', () => {
    const cards = [
      card('a', { genres: ['Thriller', 'Action'] }),
      card('b', { genres: ['Thriller', 'Action'] }),
    ];
    const first = buildRows(cards, EMPTY).map((r) => r.title);
    const second = buildRows([...cards].reverse(), EMPTY).map((r) => r.title);
    assert.deepEqual(first, second);
    assert.ok(first.indexOf('Action') < first.indexOf('Thriller'));
  });

  test('equal-sized collections do not reshuffle either', () => {
    const cards = [
      card('p1', { collection: POTC }),
      card('p2', { collection: POTC }),
      card('s1', { collection: SW }),
      card('s2', { collection: SW }),
    ];
    const first = buildRows(cards, EMPTY).map((r) => r.title);
    const second = buildRows([...cards].reverse(), EMPTY).map((r) => r.title);
    assert.deepEqual(first, second);
  });

  test('films and shows arrive in separate rows, each newest first', () => {
    const cards = [
      card('film-old', { addedAt: '2026-01-01' }),
      card('wire', { type: 'show', addedAt: '2026-01-15' }),
      card('film-new', { addedAt: '2026-03-01' }),
      card('chernobyl', { type: 'show', addedAt: '2026-02-01' }),
    ];
    const rows = buildRows(cards, EMPTY);
    assert.deepEqual(rows.map((r) => r.title).slice(0, 2), ['Recently Added Movies', 'Recently Added TV Shows']);
    assert.deepEqual(row(rows, 'Recently Added Movies')?.titleIds, ['film-new', 'film-old']);
    assert.deepEqual(row(rows, 'Recently Added TV Shows')?.titleIds, ['chernobyl', 'wire']);
    assert.equal(row(rows, 'Recently Added'), undefined, 'the two kinds were combined again');
    assert.equal(row(rows, 'TV Shows'), undefined, 'the old TV Shows row duplicates Recently Added TV Shows');
  });

  test('a library of one kind keeps the plain name — there is nothing to separate', () => {
    assert.deepEqual(buildRows([card('a'), card('b')], EMPTY).map((r) => r.title), ['Recently Added']);
    const shows = [card('x', { type: 'show' }), card('y', { type: 'show' })];
    assert.deepEqual(buildRows(shows, EMPTY).map((r) => r.title), ['Recently Added']);
  });

  test('every row says what kind it is, so the renderer never keys on a title', () => {
    const rows = buildRows(
      [card('a', { genres: ['Action'], collection: SW }), card('b', { genres: ['Action'], collection: SW })],
      { continueIds: ['a'], myListIds: ['b'] },
    );
    assert.deepEqual(rows.map((r) => r.kind), ['continue', 'my-list', 'recent', 'collection', 'genre']);
  });

  test('genre rows mix films and shows', () => {
    const cards = [card('film', { genres: ['Drama'] }), card('wire', { type: 'show', genres: ['Drama'] })];
    assert.deepEqual(row(buildRows(cards, EMPTY), 'Drama')?.titleIds, ['film', 'wire']);
  });

  test('an empty library has no rows', () => {
    assert.deepEqual(buildRows([], EMPTY), []);
  });
});

describe("a show's own shelf of seasons", () => {
  const season = (n: number, over: Partial<SeasonCard> = {}): SeasonCard => ({
    season: n,
    name: `Season ${n}`,
    episodeCount: 10,
    poster: null,
    watchedCount: 0,
    upNext: false,
    available: true,
    offlineOn: null,
    ...over,
  });
  const tomAndJerry = card('show-tom-and-jerry', {
    type: 'show',
    title: 'Tom and Jerry',
    addedAt: '2026-02-01',
    show: {
      seasonCount: 2,
      seasonsLabel: '2 Seasons',
      episodeCount: 114,
      yearLabel: '1940–1958',
      seasons: [season(1940, { episodeCount: 46 }), season(1950, { episodeCount: 68 })],
    },
  });

  test('a show with two seasons gets a shelf named for it, with what it holds beside the name', () => {
    const rows = buildRows([card('film'), tomAndJerry], EMPTY);
    const shelf = rows.find((r) => r.kind === 'seasons');
    assert.deepEqual(
      [shelf?.title, shelf?.subtitle, shelf?.titleIds],
      ['Tom and Jerry', '2 Seasons · 114 Episodes · 1940–1958', ['show-tom-and-jerry']],
    );
  });

  test('it sits right after Recently Added, above franchises and genres', () => {
    const rows = buildRows(
      [card('a', { collection: SW, genres: ['Action'] }), card('b', { collection: SW, genres: ['Action'] }), tomAndJerry],
      EMPTY,
    );
    assert.deepEqual(rows.map((r) => r.kind), ['recent', 'recent', 'seasons', 'collection', 'genre']);
  });

  test('how far through you are is part of the line, once you have started', () => {
    const watching = {
      ...tomAndJerry,
      show: { ...tomAndJerry.show!, seasons: [season(1940, { watchedCount: 7 }), season(1950, { watchedCount: 5 })] },
    };
    assert.equal(buildRows([watching], EMPTY).find((r) => r.kind === 'seasons')?.subtitle, '2 Seasons · 114 Episodes · 1940–1958 · 12 watched');
  });

  test('one season is not a shelf — its episodes are one click away already', () => {
    const one = card('show-chernobyl', {
      type: 'show',
      show: { seasonCount: 1, seasonsLabel: 'Limited Series', episodeCount: 5, seasons: [season(1)] },
    });
    assert.equal(buildRows([one], EMPTY).some((r) => r.kind === 'seasons'), false);
  });
});
