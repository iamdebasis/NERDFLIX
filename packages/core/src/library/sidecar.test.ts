import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  SIDECAR_DIR,
  isWritable,
  mergeTitles,
  readTitlesFromDrive,
  readVolumeIdentity,
  writeTitleToDrive,
  writeVolumeIdentity,
} from './sidecar.js';
import type { MediaFile, Title } from '../schema/index.js';

function media(over: Partial<MediaFile> = {}): MediaFile {
  return {
    contentId: 'c1-filmmkv',
    sightings: [{ volumeId: 'vol-a', relPath: 'film.mkv', fingerprint: 'fp', lastSeen: '2026-01-01T00:00:00Z' }],
    probeVersion: 0,
    releaseName: 'Film.2020',
    releaseAttributes: [],
    container: 'matroska',
    videoCodec: 'hevc',
    resolution: '2160p',
    hdr: 'HDR10',
    bitrateMbps: 60,
    sizeBytes: 60e9,
    durationSec: 7200,
    audio: [],
    subtitles: [],
    chapters: [],
    ...over,
  };
}

function title(over: Partial<Title> = {}): Title {
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
    externalIds: {},
    artwork: {},
    media: [media()],
    similarIds: [],
    derivedVersion: 0,
    creators: [],
    seasonInfo: [],
    episodeInfo: [],
    matchState: 'auto',
    matchConfidence: 1,
    matchWarnings: [],
    searchTitles: [],
    addedAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...over,
  };
}

async function withDrive(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'nfl-drive-'));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe('drive sidecar', () => {
  test('volume identity round-trips, which is what makes a scan portable', async () => {
    await withDrive(async (dir) => {
      assert.equal(await readVolumeIdentity(dir), null);
      const ok = await writeVolumeIdentity(dir, {
        version: 1,
        id: 'vol-portable',
        label: 'Movies SSD',
        createdAt: '2026-01-01T00:00:00Z',
      });
      assert.equal(ok, true);

      // A second machine pairing the same drive must reuse this id — otherwise every
      // media.volumeId points at a volume it has never heard of and the whole library
      // resolves as "missing".
      const back = await readVolumeIdentity(dir);
      assert.equal(back?.id, 'vol-portable');
      assert.equal(back?.label, 'Movies SSD');
    });
  });

  test('only the media that live on THIS drive are written to it', async () => {
    await withDrive(async (dir) => {
      const t = title({
        media: [
          media({ contentId: 'c1-amkv', sightings: [{ volumeId: 'vol-a', relPath: 'a.mkv', fingerprint: 'fp', lastSeen: '2026-01-01T00:00:00Z' }], edition: 'Theatrical' }),
          media({ contentId: 'c1-bmkv', sightings: [{ volumeId: 'vol-b', relPath: 'b.mkv', fingerprint: 'fp', lastSeen: '2026-01-01T00:00:00Z' }], edition: 'Extended' }),
        ],
      });
      await writeTitleToDrive(dir, 'vol-a', t);

      const [onDrive] = await readTitlesFromDrive(dir);
      assert.equal(onDrive.media.length, 1);
      assert.equal(onDrive.media[0].edition, 'Theatrical');
    });
  });

  test('a title with nothing on this drive is not written at all', async () => {
    await withDrive(async (dir) => {
      const written = await writeTitleToDrive(dir, 'vol-elsewhere', title());
      assert.equal(written, false);
      assert.deepEqual(await readTitlesFromDrive(dir), []);
    });
  });

  test('never writes watch history to the drive', async () => {
    await withDrive(async (dir) => {
      await writeVolumeIdentity(dir, {
        version: 1,
        id: 'vol-a',
        label: 'SSD',
        createdAt: '2026-01-01T00:00:00Z',
      });
      await writeTitleToDrive(dir, 'vol-a', title());

      // Handing someone a drive must not hand over your viewing history, and their
      // resume points must not land in your Continue Watching.
      const entries = await readdir(join(dir, SIDECAR_DIR));
      assert.deepEqual(entries.sort(), ['titles', 'volume.json']);
    });
  });

  test('a corrupt sidecar file is skipped, not fatal', async () => {
    await withDrive(async (dir) => {
      await writeTitleToDrive(dir, 'vol-a', title());
      await mkdir(join(dir, SIDECAR_DIR, 'titles'), { recursive: true });
      await writeFile(join(dir, SIDECAR_DIR, 'titles', 'broken.json'), '{ not json');

      const titles = await readTitlesFromDrive(dir);
      assert.equal(titles.length, 1, 'the good title still loads');
    });
  });

  test('reports writability so read-only drives degrade instead of failing', async () => {
    await withDrive(async (dir) => {
      assert.equal(await isWritable(dir), true);
    });
    assert.equal(await isWritable('/definitely/not/a/path'), false);
  });
});

describe('mergeTitles', () => {
  test('unions media across drives rather than replacing', () => {
    const mine = title({ media: [media({ contentId: 'c1-amkv', sightings: [{ volumeId: 'vol-a', relPath: 'a.mkv', fingerprint: 'fp', lastSeen: '2026-01-01T00:00:00Z' }] })] });
    const theirs = title({ media: [media({ contentId: 'c1-bmkv', sightings: [{ volumeId: 'vol-b', relPath: 'b.mkv', fingerprint: 'fp', lastSeen: '2026-01-01T00:00:00Z' }] })] });
    const merged = mergeTitles(mine, theirs);
    assert.equal(merged.media.length, 2);
  });

  test('a confirmed match survives a stale sidecar from another machine', () => {
    const mine = title({ matchState: 'confirmed', title: 'Corrected Title' });
    const theirs = title({ matchState: 'auto', title: 'Wrong Title', updatedAt: '2030-01-01T00:00:00Z' });
    const merged = mergeTitles(mine, theirs);
    assert.equal(merged.matchState, 'confirmed');
    assert.equal(merged.title, 'Corrected Title');
  });

  test('newer descriptive data wins when neither side is confirmed', () => {
    const mine = title({ overview: 'old', updatedAt: '2026-01-01T00:00:00Z' });
    const theirs = title({ overview: 'new', updatedAt: '2026-06-01T00:00:00Z' });
    assert.equal(mergeTitles(mine, theirs).overview, 'new');
  });

  test('a title the mirror has never seen is taken wholesale', () => {
    const theirs = title();
    assert.deepEqual(mergeTitles(null, theirs), theirs);
  });
});
