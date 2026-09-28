import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ARTWORK_VERSION, DERIVE_VERSION, enrichTitle, needsEnrichment } from './enrich.js';
import type { TmdbClient } from './tmdb.js';
import { MetaStore } from '../store/meta-store.js';
import type { MediaFile, Title } from '../schema/index.js';

/**
 * Sharper billboards on big screens, without touching anything else.
 *
 * Backdrops were fetched at w1280 and stretched 2× across a 27" 2560 monitor. The fix
 * fetches TMDB's original, and titles already in the library upgrade on the next pass:
 * the backdrop only, from the cached response, with no search and no re-match.
 */

const file = (): MediaFile =>
  ({
    contentId: 'c-interstellar',
    probeVersion: 1,
    sightings: [],
    releaseName: 'Interstellar.2014.2160p',
    releaseAttributes: [],
    container: 'matroska',
    videoCodec: 'hevc',
    resolution: '2160p',
    hdr: 'HDR10',
    bitrateMbps: 55,
    sizeBytes: 1,
    durationSec: 10140,
    audio: [],
    subtitles: [],
    chapters: [],
  }) as MediaFile;

function interstellar(over: Partial<Title> = {}): Title {
  return {
    id: 'interstellar-2014',
    type: 'movie',
    title: 'Interstellar',
    sortTitle: 'Interstellar',
    year: 2014,
    overview: 'The adventures of a group of explorers.',
    genres: [],
    contentTags: [],
    cast: [],
    directors: [],
    creators: [],
    seasonInfo: [],
    episodeInfo: [],
    externalIds: { tmdbId: 157336 },
    artwork: { poster: '/old/poster.jpg', backdrop: '/old/backdrop.jpg', logo: '/old/logo.png' },
    media: [file()],
    similarIds: [],
    matchState: 'auto',
    matchConfidence: 0.97,
    matchWarnings: [],
    searchTitles: ['Interstellar'],
    derivedVersion: DERIVE_VERSION,
    artworkVersion: 1,
    addedAt: '2026-01-01',
    updatedAt: '2026-01-01',
    ...over,
  } as Title;
}

/** TMDB from its cache: details only. A search would mean a re-match — never. */
function cachedTmdb() {
  const calls = { searches: 0, details: 0 };
  const refuse = async () => {
    calls.searches += 1;
    throw new Error('a settled title must never be searched again');
  };
  const client = {
    searchMovie: refuse,
    findByImdb: refuse,
    async movieDetails() {
      calls.details += 1;
      return {
        id: 157336,
        title: 'Interstellar',
        release_date: '2014-11-05',
        images: {
          backdrops: [
            { file_path: '/with-title.jpg', iso_639_1: 'en', vote_average: 6, width: 3840, height: 2160 },
            { file_path: '/textless.jpg', iso_639_1: null, vote_average: 5, width: 3840, height: 2160 },
          ],
          posters: [{ file_path: '/poster.jpg', iso_639_1: 'en', vote_average: 5, width: 2000, height: 3000 }],
          logos: [],
        },
      };
    },
  };
  return { client: client as unknown as TmdbClient, calls };
}

const realFetch = globalThis.fetch;
let fetched: string[] = [];
function network(ok: boolean) {
  fetched = [];
  globalThis.fetch = (async (url: string | URL) => {
    fetched.push(String(url));
    return ok ? new Response(Buffer.from('a 3840-wide backdrop')) : new Response('gone', { status: 503 });
  }) as typeof fetch;
}
afterEach(() => {
  globalThis.fetch = realFetch;
});

async function withStore(fn: (store: MetaStore, cache: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), 'nfl-artwork-'));
  try {
    const store = new MetaStore(join(dir, 'db'));
    await store.init();
    await fn(store, join(dir, 'cache'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe('backdrops upgrade to full size, and nothing else changes', () => {
  test('a title with a small backdrop needs a pass; one already upgraded, or with none, does not', () => {
    assert.equal(needsEnrichment(interstellar(), { withArtwork: true }), true);
    assert.equal(needsEnrichment(interstellar({ artworkVersion: ARTWORK_VERSION }), { withArtwork: true }), false);
    assert.equal(
      needsEnrichment(interstellar({ artwork: { poster: '/old/poster.jpg' } }), { withArtwork: true }),
      false,
      'no backdrop at all: there is nothing to upgrade',
    );
  });

  test('the backdrop is fetched at original size from the cached details — no search, poster and logo untouched', async () => {
    await withStore(async (store, cache) => {
      await store.save(interstellar());
      const { client, calls } = cachedTmdb();
      network(true);
      const out = await enrichTitle(interstellar(), client, store, cache, 'US');
      assert.equal(out.status, 'rederived', out.error);
      assert.equal(calls.searches, 0);
      // The textless backdrop, as the first pass chose, at TMDB's original size.
      assert.deepEqual(fetched, ['https://image.tmdb.org/t/p/original/textless.jpg']);

      const saved = (await store.get('interstellar-2014'))!;
      assert.equal(saved.artworkVersion, ARTWORK_VERSION);
      assert.equal(saved.artwork.backdrop, join(cache, 'art', 'interstellar-2014', 'backdrop.jpg'));
      assert.equal(await readFile(saved.artwork.backdrop!, 'utf8'), 'a 3840-wide backdrop');
      assert.equal(saved.artwork.poster, '/old/poster.jpg');
      assert.equal(saved.artwork.logo, '/old/logo.png');
      assert.equal(saved.matchState, 'auto');
      assert.equal(saved.matchConfidence, 0.97);

      // Done once: the next pass has nothing to do.
      assert.equal(needsEnrichment(saved, { withArtwork: true }), false);
      network(true);
      assert.equal((await enrichTitle(saved, client, store, cache, 'US')).status, 'skipped');
      assert.deepEqual(fetched, []);
    });
  });

  test('written over the old file in its own folder — browse serves a title from ONE folder', async () => {
    await withStore(async (store, cache) => {
      // Where the app keeps a title: cache/artwork/art/<id>, not this call's cache/art/<id>.
      const own = join(cache, 'artwork', 'art', 'interstellar-2014');
      await mkdir(own, { recursive: true });
      await writeFile(join(own, 'backdrop.jpg'), 'a 1280-wide backdrop');
      const title = interstellar({
        artwork: { poster: join(own, 'poster.jpg'), backdrop: join(own, 'backdrop.jpg') },
      });
      await store.save(title);
      const { client } = cachedTmdb();
      network(true);
      await enrichTitle(title, client, store, cache, 'US');
      const saved = (await store.get('interstellar-2014'))!;
      assert.equal(saved.artwork.backdrop, join(own, 'backdrop.jpg'), 'moved out of the folder browse serves from');
      assert.equal(await readFile(join(own, 'backdrop.jpg'), 'utf8'), 'a 3840-wide backdrop');
    });
  });

  test('a record pointing somewhere else is never written through — the new file goes to the cache', async () => {
    await withStore(async (store, cache) => {
      const elsewhere = join(cache, '..', 'not-artwork.jpg');
      await writeFile(elsewhere, 'precious');
      const title = interstellar({ artwork: { poster: '/old/poster.jpg', backdrop: elsewhere } });
      await store.save(title);
      const { client } = cachedTmdb();
      network(true);
      await enrichTitle(title, client, store, cache, 'US');
      assert.equal(await readFile(elsewhere, 'utf8'), 'precious');
      assert.equal((await store.get('interstellar-2014'))!.artwork.backdrop, join(cache, 'art', 'interstellar-2014', 'backdrop.jpg'));
    });
  });

  test('offline: the old backdrop stays, and so does the old stamp, so the next pass tries again', async () => {
    await withStore(async (store, cache) => {
      await store.save(interstellar());
      const { client } = cachedTmdb();
      network(false);
      await enrichTitle(interstellar(), client, store, cache, 'US');
      const saved = (await store.get('interstellar-2014'))!;
      assert.equal(saved.artwork.backdrop, '/old/backdrop.jpg', 'a title must never lose its picture');
      assert.equal(saved.artworkVersion, 1);
      assert.equal(needsEnrichment(saved, { withArtwork: true }), true);
    });
  });

  test('a first match fetches the full-size backdrop straight away', async () => {
    await withStore(async (store, cache) => {
      const { client } = cachedTmdb();
      network(true);
      // Unmatched, with an .nfo id so no search is needed to find it.
      const fresh = interstellar({
        matchState: 'unmatched',
        overview: '',
        artwork: {},
        externalIds: { imdbId: 'tt0816692' },
      });
      (client as unknown as { findByImdb: () => Promise<{ id: number }> }).findByImdb = async () => ({ id: 157336 });
      await enrichTitle(fresh, client, store, cache, 'US');
      const saved = (await store.get('interstellar-2014'))!;
      assert.equal(saved.artworkVersion, ARTWORK_VERSION);
      assert.ok(fetched.includes('https://image.tmdb.org/t/p/original/textless.jpg'));
      assert.ok(fetched.includes('https://image.tmdb.org/t/p/w500/poster.jpg'), 'posters stay at w500');
    });
  });
});
