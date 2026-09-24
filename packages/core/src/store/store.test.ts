import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MetaStore, makeSlug, makeSortTitle } from './meta-store.js';
import { StateStore } from './state-store.js';
import { MediaResolver } from '../library/resolver.js';
import type { Title, MediaFile } from '../schema/index.js';

function media(over: Partial<MediaFile> = {}): MediaFile {
  return {
    contentId: 'c1-film',
    sightings: [{ volumeId: 'vol-1', relPath: 'Film/film.mkv', fingerprint: 'fp', lastSeen: '2026-01-01T00:00:00Z' }],
    probeVersion: 0,
    releaseName: 'Film.2020.2160p',
    releaseAttributes: [],
    container: 'matroska',
    videoCodec: 'hevc',
    resolution: '2160p',
    hdr: 'HDR10',
    bitrateMbps: 60,
    sizeBytes: 60_000_000_000,
    durationSec: 7200,
    audio: [],
    subtitles: [],
    chapters: [],
    ...over,
  };
}

function title(over: Partial<Title> = {}): Title {
  const now = new Date().toISOString();
  return {
    id: 'film-2020',
    type: 'movie',
    title: 'Film',
    sortTitle: 'Film',
    year: 2020,
    overview: '',
    genres: [],
    contentTags: [],
    cast: [],
    directors: [],
    episodesAsFilms: false,
    externalIds: {},
    artwork: {},
    media: [media()],
    similarIds: [],
    derivedVersion: 0,
    creators: [],
    seasonInfo: [],
    episodeInfo: [],
    matchState: 'unmatched',
    matchConfidence: 0,
    matchWarnings: [],
    searchTitles: [],
    addedAt: now,
    updatedAt: now,
    ...over,
  };
}

describe('makeSlug', () => {
  test('includes the year so remakes cannot collide', () => {
    // Without the year these two films share an id and silently merge into one record.
    assert.notEqual(makeSlug('The Thing', 1982), makeSlug('The Thing', 2011));
    assert.equal(makeSlug('The Thing', 1982), 'the-thing-1982');
  });

  test('is filesystem-safe and strips punctuation and accents', () => {
    assert.equal(makeSlug('Terminator 2: Judgment Day', 1991), 'terminator-2-judgment-day-1991');
    assert.equal(makeSlug('Amélie', 2001), 'amelie-2001');
    assert.equal(makeSlug("Ocean's Eleven", 2001), 'oceans-eleven-2001');
  });
});

describe('makeSortTitle', () => {
  test('moves leading articles so browsing sorts like a shelf', () => {
    assert.equal(makeSortTitle('The Dark Knight'), 'Dark Knight');
    assert.equal(makeSortTitle('A Few Good Men'), 'Few Good Men');
    assert.equal(makeSortTitle('Blade Runner'), 'Blade Runner');
  });
});

describe('MetaStore', () => {
  test('round-trips a title', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'nfl-meta-'));
    try {
      const store = new MetaStore(dir);
      await store.init();
      await store.save(title());
      const loaded = await store.get('film-2020');
      assert.equal(loaded?.title, 'Film');
      assert.equal(loaded?.media[0].bitrateMbps, 60);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('a malformed record is reported, not thrown — one bad file must not empty the library', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'nfl-meta-'));
    try {
      const store = new MetaStore(dir);
      await store.init();
      await store.save(title());
      await mkdir(join(dir, 'movies'), { recursive: true });
      await writeFile(join(dir, 'movies', 'broken.json'), '{"id":"broken"}');

      const { titles, issues } = await store.loadAll();
      assert.equal(titles.length, 1, 'the good title still loads');
      assert.equal(issues.length, 1);
      assert.match(issues[0].file, /broken\.json$/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('StateStore', () => {
  test('ignores a title barely sampled, so Continue Watching stays clean', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'nfl-state-'));
    try {
      const s = new StateStore(join(dir, 'progress.json'));
      await s.setProgress('film-2020', 45, 7200); // 45 seconds in
      await s.settle();
      assert.equal(await s.getProgress('film-2020'), null);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('marks watched near the end rather than offering to resume the credits', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'nfl-state-'));
    try {
      const s = new StateStore(join(dir, 'progress.json'));
      await s.setProgress('film-2020', 7100, 7200); // 98.6%
      await s.settle();
      const p = await s.getProgress('film-2020');
      assert.equal(p?.watched, true);
      assert.equal(p?.positionSec, 0);
      assert.deepEqual(await s.continueWatching(), []);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('keeps a genuine mid-film position', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'nfl-state-'));
    try {
      const s = new StateStore(join(dir, 'progress.json'));
      await s.setProgress('film-2020', 3600, 7200);
      await s.settle();
      const cw = await s.continueWatching();
      assert.equal(cw.length, 1);
      assert.equal(cw[0].progress.positionSec, 3600);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('corrupt state falls back to empty instead of blocking playback', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'nfl-state-'));
    try {
      const path = join(dir, 'progress.json');
      await writeFile(path, 'not json at all');
      const s = new StateStore(path);
      assert.deepEqual(await s.getMyList(), []);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('MediaResolver — availability (§8.5)', () => {
  const online = {
  root: {
    borrowed: false,
    readOnly: false, id: 'vol-1', label: 'Plex SSD', kind: 'removable' as const, path: '/Volumes/Plex', addedAt: '' },
    status: 'online' as const,
    resolvedPath: '/Volumes/Plex',
    probeMs: 3,
  };
  const offline = { ...online, status: 'offline' as const, resolvedPath: undefined };

  test('resolves an absolute path when the drive is attached', () => {
    const r = new MediaResolver([online]);
    const a = r.resolve(title());
    assert.equal(a.status, 'available');
    if (a.status === 'available') assert.equal(a.absolutePath, '/Volumes/Plex/Film/film.mkv');
  });

  test('offline titles still resolve their metadata and name the drive', () => {
    // Netflix has no equivalent state, so this is the one place we design fresh:
    // the tile stays, only Play changes.
    const r = new MediaResolver([offline]);
    const a = r.resolve(title());
    assert.equal(a.status, 'offline');
    if (a.status === 'offline') assert.equal(a.volumeLabel, 'Plex SSD');
    assert.equal((r.resolve(title()) as { volumeLabel?: string }).volumeLabel, 'Plex SSD');
    assert.equal((r.resolve(title()).status === 'available'), false);
  });

  test('a relocated drive is still available at its new path', () => {
    // The payoff of storing a volume UUID: remounting under a different name is
    // invisible to the user.
    const moved = { ...online, status: 'relocated' as const, resolvedPath: '/Volumes/Plex 1' };
    const a = new MediaResolver([moved]).resolve(title());
    assert.equal(a.status, 'available');
    if (a.status === 'available') assert.equal(a.absolutePath, '/Volumes/Plex 1/Film/film.mkv');
  });

  test('prefers an available edition over an offline higher-bitrate one', () => {
    const t = title({
      media: [
        media({
          contentId: 'c1-extended',
          sightings: [{ volumeId: 'vol-2', relPath: 'ext.mkv', fingerprint: 'fp', lastSeen: '2026-01-01T00:00:00Z' }],
          bitrateMbps: 90,
          edition: 'Extended',
        }),
        media({
          contentId: 'c1-theatrical',
          sightings: [{ volumeId: 'vol-1', relPath: 'thea.mkv', fingerprint: 'fp', lastSeen: '2026-01-01T00:00:00Z' }],
          bitrateMbps: 60,
          edition: 'Theatrical',
        }),
      ],
    });
    const r = new MediaResolver([online]); // vol-2 is not paired at all
    const a = r.resolve(t);
    assert.equal(a.status, 'available');
    if (a.status === 'available') assert.equal(a.media.edition, 'Theatrical');
  });

  test('an unknown volume is missing, not offline', () => {
    const a = new MediaResolver([]).resolve(title());
    assert.equal(a.status, 'missing');
  });

  test('summary counts each title exactly once', () => {
    const r = new MediaResolver([online, { ...offline, root: { ...offline.root, id: 'vol-2' } }]);
    const s = r.summary([title(), title({ id: 'b', media: [media({
            contentId: 'c1-b',
            sightings: [{ volumeId: 'vol-2', relPath: 'b.mkv', fingerprint: 'fp', lastSeen: '2026-01-01T00:00:00Z' }],
          })] })]);
    assert.deepEqual(s, { available: 1, offline: 1, missing: 0 });
  });
});
