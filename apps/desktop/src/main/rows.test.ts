import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { buildRows, type Row, type RowCard } from './rows.js';

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
  return { id, title: id, genres: [], year: 2000, addedAt: '2024-01-01T00:00:00Z', ...over };
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

  test('an empty library has no rows', () => {
    assert.deepEqual(buildRows([], EMPTY), []);
  });
});
