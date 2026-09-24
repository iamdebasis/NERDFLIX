import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { pickByMakers, runtimeAgrees, seriesMakers, shortCandidates } from './shorts.js';
import { couldHaveSeasons } from './match.js';
import { applyShortsDetails, enrichTitle, needsEnrichment, DERIVE_VERSION } from './enrich.js';
import type { TmdbClient, TmdbMovie, TmdbShowCandidate } from './tmdb.js';
import { MetaStore } from '../store/meta-store.js';
import type { MediaFile, Title } from '../schema/index.js';

/**
 * Fixtures are shaped like the real TMDB responses for the real Tom and Jerry pack —
 * ids, dates, runtimes and directors as TMDB has them, including both traps: the
 * 2023 series that is the only TV entry named exactly "Tom and Jerry", and two shorts
 * called "The Night Before Christmas" in the same decade.
 */
const HB = [{ name: 'William Hanna', job: 'Director' }, { name: 'Joseph Barbera', job: 'Director' }];
const film = (id: number, title: string, date: string, runtime: number, crew = HB, extra: Partial<TmdbMovie> = {}): TmdbMovie => ({
  id,
  title,
  release_date: date,
  runtime,
  overview: `${title} synopsis`,
  genres: [{ id: 16, name: 'Animation' }, { id: 35, name: 'Comedy' }],
  credits: { crew },
  images: { posters: [], backdrops: [] },
  ...extra,
});

const FILMS: Record<number, TmdbMovie> = {
  40372: film(40372, 'Puss Gets the Boot', '1940-02-10', 9),
  40234: film(40234, 'The Midnight Snack', '1941-07-19', 9),
  39894: film(39894, 'The Night Before Christmas', '1941-12-06', 9),
  374408: film(374408, 'The Night Before Christmas', '1946-12-24', 8, []),
  928961: film(928961, 'The Night Before Christmas', '2013-12-01', 85, []),
  40472: film(40472, 'Fraidy Cat', '1942-01-17', 7),
  40164: film(40164, 'Quiet Please!', '1945-12-22', 7),
  36611: film(36611, 'Quiet Please, Murder', '1943-03-19', 70, [{ name: 'John Francis Larkin', job: 'Director' }]),
};
const asCandidate = (f: TmdbMovie) => ({ id: f.id, title: f.title, release_date: f.release_date });

describe('which film an episode is', () => {
  test('a near-exact title in the season span: Quiet Please, Murder is not Quiet Please!', () => {
    const got = shortCandidates('Quiet Please!', 1940, [FILMS[40164], FILMS[36611]].map(asCandidate));
    assert.deepEqual(got.map((c) => c.id), [40164]);
  });

  test('outside the span is out: 2013 is not a 1940s cartoon, 1946 still could be', () => {
    const got = shortCandidates(
      'The Night Before Christmas',
      1940,
      [FILMS[39894], FILMS[374408], FILMS[928961]].map(asCandidate),
    );
    assert.deepEqual(got.map((c) => c.id).sort((a, b) => a - b), [39894, 374408]);
  });

  test('runtime: a seven-minute file is never a seventy-minute feature', () => {
    assert.equal(runtimeAgrees(7 * 60, 70), false);
    assert.equal(runtimeAgrees(9 * 60, 8), true);
    assert.equal(runtimeAgrees(9 * 60, undefined), true, 'an unknown runtime cannot disagree');
  });

  test('the makers settle a tie — and only once there are enough films to say who they are', () => {
    const matched = [FILMS[40372], FILMS[40234], FILMS[40472]];
    const makers = seriesMakers(matched);
    assert.deepEqual([...makers].sort(), ['Joseph Barbera', 'William Hanna']);
    assert.equal(pickByMakers([FILMS[39894], FILMS[374408]], makers)?.id, 39894);
    assert.deepEqual(seriesMakers(matched.slice(0, 2)), [], 'two films are not a consensus');
    assert.equal(pickByMakers([FILMS[39894], FILMS[374408]], []), null);
  });
});

describe('the TV year guard', () => {
  const tv = (first: string): TmdbShowCandidate => ({ id: 1, name: 'Tom and Jerry', first_air_date: first });
  test('a series that began in 2023 cannot have a season numbered 1940', () => {
    assert.equal(couldHaveSeasons(tv('2023-10-21'), 1940), false);
    assert.equal(couldHaveSeasons(tv('1940-02-10'), 1940), true);
    assert.equal(couldHaveSeasons(tv(''), 1940), true, 'an unknown date cannot exclude');
    assert.equal(couldHaveSeasons(tv('2023-10-21'), undefined), true, 'no year seasons, no guard');
  });
});

// --- the show, end to end --------------------------------------------------------

function ep(episode: number, episodeTitle: string, minutes = 8): MediaFile {
  return {
    contentId: `c-${episode}`,
    probeVersion: 1,
    sightings: [{ volumeId: 'vol', relPath: `Tom and Jerry - S1940E${episode}.mkv`, fingerprint: '', lastSeen: '' }],
    releaseName: `Tom and Jerry - S1940E${episode} - ${episodeTitle}`,
    releaseAttributes: [],
    container: 'matroska',
    videoCodec: 'h264',
    resolution: '1080p',
    hdr: 'SDR',
    bitrateMbps: 5,
    sizeBytes: 1,
    durationSec: minutes * 60,
    audio: [],
    subtitles: [],
    chapters: [],
    season: 1940,
    episode,
    episodeTitle,
  } as MediaFile;
}

function tomAndJerry(over: Partial<Title> = {}): Title {
  return {
    id: 'show-tom-and-jerry',
    type: 'show',
    title: 'Tom and Jerry',
    sortTitle: 'Tom and Jerry',
    overview: '',
    genres: [],
    contentTags: [],
    cast: [],
    directors: [],
    creators: [],
    seasonInfo: [],
    episodeInfo: [],
    episodesAsFilms: false,
    externalIds: {},
    artwork: {},
    media: [
      ep(1, 'Puss Gets The Boot', 9),
      ep(2, 'The Midnight Snack', 9),
      ep(3, 'The Night Before Christmas', 9),
      ep(4, 'Fraidy Cat', 7),
      ep(22, 'Quiet Please!', 7),
      ep(46, 'A Cartoon TMDB Does Not Have', 7),
    ],
    similarIds: [],
    matchState: 'unmatched',
    matchConfidence: 0,
    matchWarnings: [],
    searchTitles: ['Tom and Jerry'],
    derivedVersion: 0,
    addedAt: '2026-01-01',
    updatedAt: '2026-01-01',
    ...over,
  } as Title;
}

/** A stand-in TMDB: the real search behaviour, counted, with no network. */
function fakeTmdb() {
  const calls = { searchTv: 0, searchMovie: 0, movieDetails: 0 };
  const client = {
    async searchTv() {
      calls.searchTv += 1;
      // TMDB's real answer: later shows, the only exact name being the 2023 one.
      return [
        { id: 217288, name: 'Tom and Jerry', first_air_date: '2023-10-21' },
        { id: 47480, name: 'The Tom and Jerry Show', first_air_date: '2014-04-09' },
      ];
    },
    async tvDetails() {
      throw new Error('the 2023 series must never be fetched');
    },
    async tvSeason() {
      throw new Error('no season should be fetched');
    },
    async searchMovie(q: string) {
      calls.searchMovie += 1;
      const n = q.toLowerCase().replace(/[^a-z]/g, '');
      return Object.values(FILMS)
        .filter((f) => f.title.toLowerCase().replace(/[^a-z]/g, '').startsWith(n.slice(0, 10)))
        .map(asCandidate);
    },
    async movieDetails(id: number) {
      calls.movieDetails += 1;
      return FILMS[id];
    },
  };
  return { client: client as unknown as TmdbClient, calls };
}

async function withStore(fn: (store: MetaStore, dir: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), 'nfl-shorts-'));
  try {
    const store = new MetaStore(join(dir, 'db'));
    await store.init();
    await fn(store, dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe('a year-numbered show TMDB lists as films', () => {
  test('is described from the films, never from the 2023 series', async () => {
    await withStore(async (store, dir) => {
      const { client } = fakeTmdb();
      const out = await enrichTitle(tomAndJerry(), client, store, dir, 'US', { skipArtwork: true });
      assert.equal(out.status, 'matched', out.error);

      const t = (await store.get('show-tom-and-jerry'))!;
      assert.equal(t.episodesAsFilms, true);
      assert.equal(t.externalIds.tmdbId, undefined, 'a series id was attached');
      const byEp = new Map(t.episodeInfo.map((i) => [i.episode, i]));
      assert.equal(byEp.get(1)?.tmdbId, 40372);
      assert.equal(byEp.get(3)?.tmdbId, 39894, 'the 1946 short, or nothing, was chosen over 1941');
      assert.equal(byEp.get(22)?.tmdbId, 40164, 'Quiet Please, Murder was matched');
      assert.deepEqual([byEp.get(46)?.tmdbId, byEp.get(46)?.name], [undefined, ''], 'an unknown cartoon got a name');
    });
  });

  test('the show reads as its films: years, makers, genres, and an honest confidence', async () => {
    await withStore(async (store, dir) => {
      const { client } = fakeTmdb();
      await enrichTitle(tomAndJerry(), client, store, dir, 'US', { skipArtwork: true });
      const t = (await store.get('show-tom-and-jerry'))!;
      assert.deepEqual([t.year, t.endYear], [1940, 1945]);
      assert.deepEqual([...t.creators].sort(), ['Joseph Barbera', 'William Hanna']);
      assert.deepEqual(t.genres, ['Animation', 'Comedy']);
      assert.equal(t.overview, '', 'a series synopsis was invented');
      assert.equal(t.studio, undefined, 'a studio would be printed as a Network');
      assert.deepEqual([t.matchState, t.matchConfidence], ['auto', 0.83]);
      assert.deepEqual(t.seasonInfo.map((s) => [s.season, s.name, s.airYear]), [[1940, 'Season 1940', 1940]]);
    });
  });

  test('a second pass searches nothing: matched episodes re-derive from cache, unfound ones rest', async () => {
    await withStore(async (store, dir) => {
      const first = fakeTmdb();
      await enrichTitle(tomAndJerry(), first.client, store, dir, 'US', { skipArtwork: true });
      const done = (await store.get('show-tom-and-jerry'))!;
      assert.equal(needsEnrichment(done), false, 'a finished show would be enriched on every scan');

      // A new cartoon arrives: only IT is searched, and TV is never asked again.
      const grown = { ...done, media: [...done.media, ep(5, 'Dog Trouble')] };
      const again = fakeTmdb();
      assert.equal(needsEnrichment(grown), true);
      await enrichTitle(grown, again.client, store, dir, 'US', { skipArtwork: true });
      assert.deepEqual([again.calls.searchTv, again.calls.searchMovie], [0, 1]);
    });
  });

  test('an older derivation is refreshed from cache, without a search', async () => {
    await withStore(async (store, dir) => {
      const first = fakeTmdb();
      await enrichTitle(tomAndJerry(), first.client, store, dir, 'US', { skipArtwork: true });
      const stale = { ...(await store.get('show-tom-and-jerry'))!, derivedVersion: DERIVE_VERSION - 1 };
      assert.equal(needsEnrichment(stale), true);
      const again = fakeTmdb();
      await enrichTitle(stale, again.client, store, dir, 'US', { skipArtwork: true });
      assert.deepEqual([again.calls.searchTv, again.calls.searchMovie], [0, 0]);
    });
  });

  test('a still downloaded for an episode survives a refresh only if it is still the same film', () => {
    const before = tomAndJerry({
      episodesAsFilms: true,
      episodeInfo: [
        { season: 1940, episode: 1, name: 'x', still: '/a.jpg', tmdbId: 40372 },
        { season: 1940, episode: 2, name: 'y', still: '/b.jpg', tmdbId: 999 },
      ],
    });
    const after = applyShortsDetails(before, [
      { season: 1940, episode: 1, film: FILMS[40372] },
      { season: 1940, episode: 2, film: FILMS[40234] },
    ]);
    assert.deepEqual(after.episodeInfo.map((i) => i.still), ['/a.jpg', undefined]);
  });

  test("a season poster survives a refresh, like an episode's still", () => {
    const before = tomAndJerry({
      episodesAsFilms: true,
      seasonInfo: [{ season: 1940, name: 'Season 1940', poster: '/season-s1940.jpg' }],
    });
    const after = applyShortsDetails(before, [{ season: 1940, episode: 1, film: FILMS[40372] }]);
    assert.equal(after.seasonInfo[0].poster, '/season-s1940.jpg');
  });

  test('a confirmed show stays confirmed', () => {
    const after = applyShortsDetails(tomAndJerry({ matchState: 'confirmed' }), [
      { season: 1940, episode: 1, film: FILMS[40372] },
    ]);
    assert.equal(after.matchState, 'confirmed');
  });
});
