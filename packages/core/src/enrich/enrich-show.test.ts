import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { applyShowDetails, ARTWORK_VERSION, DERIVE_VERSION, enrichTitle, needsEnrichment, showGenres } from './enrich.js';
import type { TmdbClient, TmdbSeason, TmdbShow } from './tmdb.js';
import { MetaStore } from '../store/meta-store.js';
import type { MediaFile, Title } from '../schema/index.js';

function ep(season: number, episode: number): MediaFile {
  return {
    contentId: `c-${season}-${episode}`,
    probeVersion: 1,
    sightings: [],
    releaseName: `Show.S${season}E${episode}`,
    releaseAttributes: [],
    container: 'matroska',
    videoCodec: 'hevc',
    resolution: '2160p',
    hdr: 'SDR',
    bitrateMbps: 40,
    sizeBytes: 1,
    durationSec: 2700,
    audio: [],
    subtitles: [],
    chapters: [],
    season,
    episode,
  } as MediaFile;
}

function show(over: Partial<Title> = {}): Title {
  return {
    id: 'show-chernobyl',
    type: 'show',
    title: 'Chernobyl',
    sortTitle: 'Chernobyl',
    overview: '',
    genres: [],
    contentTags: [],
    cast: [],
    directors: [],
    creators: [],
    seasonInfo: [],
    episodeInfo: [],
    externalIds: {},
    artwork: {},
    media: [ep(1, 1), ep(1, 2)],
    similarIds: [],
    matchState: 'unmatched',
    matchConfidence: 0,
    matchWarnings: [],
    searchTitles: ['Chernobyl'],
    derivedVersion: 0,
    runtimeMinutes: 45,
    addedAt: '2026-01-01',
    updatedAt: '2026-01-01',
    ...over,
  } as Title;
}

/** Shaped like /tv/87108 with append_to_response. */
const CHERNOBYL: TmdbShow = {
  id: 87108,
  name: 'Chernobyl',
  first_air_date: '2019-05-06',
  last_air_date: '2019-06-03',
  status: 'Ended',
  overview: 'The true story of one of the worst man-made catastrophes in history.',
  genres: [{ id: 18, name: 'Drama' }, { id: 10768, name: 'War & Politics' }],
  origin_country: ['GB', 'US'],
  created_by: [{ name: 'Craig Mazin' }],
  networks: [{ name: 'HBO' }],
  seasons: [
    { season_number: 1, name: 'Miniseries', episode_count: 5, air_date: '2019-05-06' },
    { season_number: 2, name: 'Season 2', episode_count: 8 },
  ],
  aggregate_credits: {
    cast: [
      { name: 'Stellan Skarsgård', order: 1, roles: [{ character: 'Boris Shcherbina' }] },
      { name: 'Jared Harris', order: 0, roles: [{ character: 'Valery Legasov' }] },
    ],
  },
  content_ratings: { results: [{ iso_3166_1: 'US', rating: 'TV-MA' }] },
  external_ids: { imdb_id: 'tt7366338' },
  videos: {
    results: [
      { key: 'teaser1', site: 'YouTube', type: 'Teaser', official: true },
      { key: 'trailer1', site: 'YouTube', type: 'Trailer', official: true },
    ],
  },
};

const SEASON_1: TmdbSeason = {
  season_number: 1,
  name: 'Miniseries',
  episodes: [
    { season_number: 1, episode_number: 1, name: '1:23:45', runtime: 60, air_date: '2019-05-06', still_path: '/a.jpg' },
    { season_number: 1, episode_number: 2, name: 'Please Remain Calm', runtime: 65 },
    { season_number: 1, episode_number: 3, name: 'Open Wide, O Earth', runtime: 65 },
  ],
};

describe('applying a TMDB series', () => {
  const t = applyShowDetails(show(), CHERNOBYL, [SEASON_1], 'US');

  test('series-level facts', () => {
    assert.equal(t.title, 'Chernobyl');
    assert.equal(t.year, 2019);
    assert.equal(t.endYear, 2019, 'an ended show carries its last year');
    assert.deepEqual(t.creators, ['Craig Mazin']);
    assert.equal(t.studio, 'HBO');
    assert.equal(t.certification, 'TV-MA');
    assert.equal(t.externalIds.tmdbId, 87108);
  });

  test('series-wide cast, in billing order, with characters', () => {
    assert.deepEqual(t.cast.map((c) => c.name), ['Jared Harris', 'Stellan Skarsgård']);
    assert.equal(t.cast[0].character, 'Valery Legasov');
  });

  test('a full trailer is preferred over a teaser', () => {
    assert.match(t.trailer?.url ?? '', /trailer1/);
  });

  test('only OWNED seasons and episodes are described', () => {
    assert.deepEqual(t.seasonInfo.map((s) => s.season), [1], 'season 2 is not owned');
    assert.deepEqual(t.episodeInfo.map((e) => e.episode), [1, 2], 'episode 3 is not owned');
    assert.equal(t.episodeInfo[0].name, '1:23:45');
    assert.equal(t.seasonInfo[0].episodeCount, 5);
  });

  test('a running show has no end year', () => {
    const running = applyShowDetails(show(), { ...CHERNOBYL, status: 'Returning Series' }, [], 'US');
    assert.equal(running.endYear, undefined);
  });

  test("a season poster already downloaded survives a re-derive — it is not fetched every pass", () => {
    const before = show({ seasonInfo: [{ season: 1, name: 'Miniseries', poster: '/cache/season-s01.jpg' }] });
    const after = applyShowDetails(before, CHERNOBYL, [SEASON_1], 'US');
    assert.equal(after.seasonInfo[0].poster, '/cache/season-s01.jpg');
  });

  test('stills already downloaded survive a refresh', () => {
    const before = show({ episodeInfo: [{ season: 1, episode: 1, name: 'x', still: '/cache/still.jpg' }] });
    const after = applyShowDetails(before, CHERNOBYL, [SEASON_1], 'US');
    assert.equal(after.episodeInfo[0].still, '/cache/still.jpg');
  });
});

describe('TV genres use the film names', () => {
  test('compound TV genres split onto film genres', () => {
    assert.deepEqual(showGenres(['Sci-Fi & Fantasy', 'Action & Adventure', 'Drama']), [
      'Science Fiction',
      'Fantasy',
      'Action',
      'Adventure',
      'Drama',
    ]);
  });

  test('no duplicates when two map onto the same name', () => {
    assert.deepEqual(showGenres(['Action & Adventure', 'Adventure']), ['Action', 'Adventure']);
  });
});

describe('a matched show still needs enrichment when new episodes arrive', () => {
  const matched = applyShowDetails(
    show({ matchState: 'auto' }),
    CHERNOBYL,
    [SEASON_1],
    'US',
  );

  test('fully described: nothing to do', () => {
    assert.equal(needsEnrichment({ ...matched, matchState: 'auto' }), false);
  });

  test('a new season on disk: needs it', () => {
    const grown = { ...matched, matchState: 'auto' as const, media: [...matched.media, ep(2, 1)] };
    assert.equal(needsEnrichment(grown), true);
  });

  test('a new episode in a described season: needs it', () => {
    const grown = { ...matched, matchState: 'auto' as const, media: [...matched.media, ep(1, 3)] };
    assert.equal(needsEnrichment(grown), true);
  });
});

describe('a matched series gets the full-size backdrop too', () => {
  test('re-fetched at original size from the cached details: no search, poster and match untouched', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'nfl-show-art-'));
    const realFetch = globalThis.fetch;
    try {
      const store = new MetaStore(join(dir, 'db'));
      await store.init();
      const described = show({
        matchState: 'auto',
        matchConfidence: 0.99,
        overview: CHERNOBYL.overview!,
        externalIds: { tmdbId: 87108 },
        derivedVersion: DERIVE_VERSION,
        artwork: { poster: '/old/poster.jpg', backdrop: '/old/backdrop.jpg' },
        artworkVersion: 1,
        seasonInfo: [{ season: 1, name: 'Miniseries', poster: '/old/season.jpg' }],
        episodeInfo: [
          { season: 1, episode: 1, name: '1:23:45', still: '/old/s1e1.jpg' },
          { season: 1, episode: 2, name: 'Please Remain Calm', still: '/old/s1e2.jpg' },
        ],
      });
      await store.save(described);
      assert.equal(needsEnrichment(described, { withArtwork: true }), true);

      let searches = 0;
      const client = {
        async searchTv() {
          searches += 1;
          throw new Error('a matched show is never searched again');
        },
        async tvDetails() {
          return {
            ...CHERNOBYL,
            images: { backdrops: [{ file_path: '/chernobyl.jpg', iso_639_1: null, vote_average: 5, width: 3840, height: 2160 }], posters: [], logos: [] },
          };
        },
        async tvSeason() {
          return SEASON_1;
        },
      } as unknown as TmdbClient;
      const fetched: string[] = [];
      globalThis.fetch = (async (url: string | URL) => {
        fetched.push(String(url));
        return new Response(Buffer.from('jpeg'));
      }) as typeof fetch;

      await enrichTitle(described, client, store, join(dir, 'cache'), 'US');

      assert.equal(searches, 0);
      assert.deepEqual(fetched, ['https://image.tmdb.org/t/p/original/chernobyl.jpg']);
      const saved = (await store.get(described.id))!;
      assert.equal(saved.artworkVersion, ARTWORK_VERSION);
      assert.notEqual(saved.artwork.backdrop, '/old/backdrop.jpg');
      assert.equal(saved.artwork.poster, '/old/poster.jpg');
      assert.equal(saved.matchState, 'auto');
      assert.equal(needsEnrichment(saved, { withArtwork: true }), false);
    } finally {
      globalThis.fetch = realFetch;
      await rm(dir, { recursive: true, force: true });
    }
  });
});
