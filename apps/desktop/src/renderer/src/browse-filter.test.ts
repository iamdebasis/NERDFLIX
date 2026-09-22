import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  activeCount,
  applyFilters,
  DEFAULT_SORT,
  facets,
  isNarrowed,
  NO_FILTERS,
  sortCards,
  toggleValue,
  type Filters,
} from './browse-filter.js';
import type { TitleCard } from '../../shared/types';

function card(over: Partial<TitleCard> = {}): TitleCard {
  return {
    id: over.title ?? 'x',
    title: 'Film',
    sortTitle: 'Film',
    overview: '',
    genres: [],
    cast: [],
    directors: [],
    poster: null,
    backdrop: null,
    logo: null,
    resolution: '2160p',
    hdr: 'SDR',
    audio: null,
    sizeBytes: 0,
    bitrateMbps: 0,
    available: true,
    offlineOn: null,
    editions: [],
    resumeSec: null,
    resumePct: null,
    watched: false,
    inMyList: false,
    addedAt: '2024-01-01T00:00:00Z',
    ...over,
  } as TitleCard;
}

const f = (over: Partial<Filters> = {}): Filters => ({ ...NO_FILTERS, ...over });
const ids = (cards: TitleCard[]) => cards.map((c) => c.id);

describe('filtering', () => {
  test('genres are OR within the facet', () => {
    const cards = [
      card({ id: 'a', genres: ['Action'] }),
      card({ id: 'c', genres: ['Comedy'] }),
      card({ id: 'd', genres: ['Drama'] }),
    ];
    assert.deepEqual(ids(applyFilters(cards, f({ genres: ['Action', 'Comedy'] }))), ['a', 'c']);
  });

  test('but AND across facets', () => {
    const cards = [
      card({ id: 'both', genres: ['Action'], resolution: '2160p' }),
      card({ id: 'genre-only', genres: ['Action'], resolution: '1080p' }),
      card({ id: 'res-only', genres: ['Drama'], resolution: '2160p' }),
    ];
    const out = applyFilters(cards, f({ genres: ['Action'], resolutions: ['2160p'] }));
    assert.deepEqual(ids(out), ['both']);
  });

  test('HDR means anything that is not SDR, Dolby Vision included', () => {
    const cards = [
      card({ id: 'dv', hdr: 'DV P7' }),
      card({ id: 'hdr10', hdr: 'HDR10' }),
      card({ id: 'sdr', hdr: 'SDR' }),
    ];
    assert.deepEqual(ids(applyFilters(cards, f({ hdr: true }))), ['dv', 'hdr10']);
  });

  test('unwatched keeps a part-watched film — it has not been finished', () => {
    const cards = [
      card({ id: 'fresh' }),
      card({ id: 'part', resumePct: 40 }),
      card({ id: 'done', watched: true }),
    ];
    assert.deepEqual(ids(applyFilters(cards, f({ unwatched: true }))), ['fresh', 'part']);
  });

  test('available hides a film whose drive is unplugged', () => {
    const cards = [card({ id: 'here' }), card({ id: 'away', available: false, offlineOn: 'MOVIEX' })];
    assert.deepEqual(ids(applyFilters(cards, f({ available: true }))), ['here']);
  });

  test('no filters is everything, in the order given', () => {
    const cards = [card({ id: 'b' }), card({ id: 'a' })];
    assert.deepEqual(ids(applyFilters(cards, NO_FILTERS)), ['b', 'a']);
  });
});

describe('narrowing', () => {
  test('the default sort with no filters is not a narrowed view', () => {
    assert.equal(isNarrowed(NO_FILTERS, DEFAULT_SORT), false);
  });

  test('a sort alone narrows: asking for title order must not return genre rows', () => {
    assert.equal(isNarrowed(NO_FILTERS, 'title'), true);
  });

  test('a filter alone narrows', () => {
    assert.equal(isNarrowed(f({ hdr: true }), DEFAULT_SORT), true);
  });

  test('the badge counts facets, not values', () => {
    assert.equal(activeCount(f({ genres: ['Action', 'Drama', 'Comedy'] })), 1);
    assert.equal(activeCount(f({ genres: ['Action'], hdr: true, unwatched: true })), 3);
    assert.equal(activeCount(NO_FILTERS), 0);
  });
});

describe('sorting', () => {
  test('title order uses sortTitle, so "The Dark Knight" files under D', () => {
    const cards = [
      card({ id: 'tdk', title: 'The Dark Knight', sortTitle: 'Dark Knight, The' }),
      card({ id: 'cars', title: 'Cars', sortTitle: 'Cars' }),
      card({ id: 'empire', title: 'The Empire Strikes Back', sortTitle: 'Empire Strikes Back, The' }),
    ];
    assert.deepEqual(ids(sortCards(cards, 'title')), ['cars', 'tdk', 'empire']);
  });

  test('year, runtime and size are all largest first', () => {
    const cards = [card({ id: 'lo', year: 1980, runtimeMinutes: 90, sizeBytes: 10 }),
                   card({ id: 'hi', year: 2020, runtimeMinutes: 180, sizeBytes: 99 })];
    assert.deepEqual(ids(sortCards(cards, 'year')), ['hi', 'lo']);
    assert.deepEqual(ids(sortCards(cards, 'runtime')), ['hi', 'lo']);
    assert.deepEqual(ids(sortCards(cards, 'size')), ['hi', 'lo']);
  });

  test('a title with no year or runtime sorts last rather than first', () => {
    // `undefined` compared numerically is NaN, which makes a sort silently incoherent.
    const cards = [card({ id: 'unknown' }), card({ id: 'known', year: 1999, runtimeMinutes: 120 })];
    assert.deepEqual(ids(sortCards(cards, 'year')), ['known', 'unknown']);
    assert.deepEqual(ids(sortCards(cards, 'runtime')), ['known', 'unknown']);
  });

  test('ties break by title, so the grid does not reshuffle between renders', () => {
    const cards = [
      card({ id: 'z', year: 2000, sortTitle: 'Zulu' }),
      card({ id: 'a', year: 2000, sortTitle: 'Alien' }),
    ];
    assert.deepEqual(ids(sortCards(cards, 'year')), ['a', 'z']);
    assert.deepEqual(ids(sortCards([...cards].reverse(), 'year')), ['a', 'z']);
  });

  test('sorting does not mutate the input', () => {
    const cards = [card({ id: 'b', sortTitle: 'B' }), card({ id: 'a', sortTitle: 'A' })];
    sortCards(cards, 'title');
    assert.deepEqual(ids(cards), ['b', 'a']);
  });
});

describe('facets', () => {
  test('are derived from the library, so a filter can never return nothing', () => {
    const cards = [
      card({ genres: ['Action'], resolution: '2160p', hdr: 'HDR10' }),
      card({ genres: ['Action', 'Drama'], resolution: '1080p', hdr: 'SDR' }),
    ];
    const got = facets(cards);
    assert.deepEqual(got.resolutions, ['2160p', '1080p']);
    assert.equal(got.genres.includes('Comedy'), false);
    assert.equal(got.hdr, true);
  });

  test('a facet that matches every film is not offered — it cannot narrow anything', () => {
    // An all-4K shelf offering a "4K" pill looks like a broken filter: you press it
    // and nothing moves.
    const cards = [
      card({ genres: ['Action', 'Drama'], resolution: '2160p', hdr: 'DV P7' }),
      card({ genres: ['Action'], resolution: '2160p', hdr: 'HDR10' }),
    ];
    const got = facets(cards);
    assert.deepEqual(got.resolutions, []);
    assert.equal(got.hdr, false);
    assert.deepEqual(got.genres, ['Drama']);
  });

  test('unwatched and availability are offered only once the library is mixed', () => {
    const allFresh = [card({ watched: false }), card({ watched: false })];
    assert.equal(facets(allFresh).unwatched, false);
    assert.equal(facets([card({ watched: true }), card({ watched: false })]).unwatched, true);

    const allHere = [card({ available: true }), card({ available: true })];
    assert.equal(facets(allHere).availability, false);
    assert.equal(facets([card({ available: false }), card({ available: true })]).availability, true);
  });

  test('genres are ordered by how common they are', () => {
    const cards = [
      card({ genres: ['Drama'] }),
      card({ genres: ['Action', 'Drama'] }),
      card({ genres: ['Action', 'Drama', 'Comedy'] }),
      card({ genres: [] }),
    ];
    assert.deepEqual(facets(cards).genres, ['Drama', 'Action', 'Comedy']);
  });

  test('resolutions are ordered by height, not alphabetically', () => {
    // '1080p' < '2160p' as strings but '720p' > both — sorting as text puts SD first.
    const cards = [card({ resolution: '720p' }), card({ resolution: '2160p' }), card({ resolution: '1080p' })];
    assert.deepEqual(facets(cards).resolutions, ['2160p', '1080p', '720p']);
  });

  test('an empty library has no facets at all', () => {
    assert.deepEqual(facets([]), {
      genres: [],
      resolutions: [],
      hdr: false,
      unwatched: false,
      availability: false,
    });
  });
});

describe('toggleValue', () => {
  test('adds, removes, and keeps the array a set', () => {
    assert.deepEqual(toggleValue([], 'a'), ['a']);
    assert.deepEqual(toggleValue(['a'], 'a'), []);
    assert.deepEqual(toggleValue(['a'], 'b'), ['a', 'b']);
    assert.deepEqual(toggleValue(['a', 'b'], 'a'), ['b']);
  });
});
