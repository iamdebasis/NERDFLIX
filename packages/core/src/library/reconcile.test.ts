import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir, rename, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { scanRoot } from '../scan/scan.js';
import { ingest } from './ingest.js';
import { MetaStore } from '../store/meta-store.js';
import type { LibraryRoot } from '../schema/index.js';

/**
 * These exercise what happens when the contents of a drive change underneath a
 * library that has already been scanned — the everyday case of adding, deleting and
 * renaming films. Driven through the real scanner against real files, because the
 * bugs here are about state accumulating across runs, which a mocked scan cannot show.
 */

const ROOT: LibraryRoot = {
  id: 'vol-test',
  label: 'Test',
  kind: 'local',
  borrowed: false,
  readOnly: false,
  path: '',
  addedAt: '2026-01-01T00:00:00Z',
};

/** Smallest thing ffprobe will read as a video, so the scanner treats it as a film. */
async function makeFilm(dir: string, name: string, seed: number): Promise<void> {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const exec = promisify(execFile);
  await exec('ffmpeg', [
    '-y', '-v', 'error',
    '-f', 'lavfi', '-i', `testsrc2=size=64x64:rate=5:d=${1 + (seed % 3)}`,
    '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '45',
    join(dir, name),
  ]);
}

async function withLibrary(
  fn: (ctx: { drive: string; store: MetaStore; root: LibraryRoot; scan: (prune?: boolean) => Promise<Awaited<ReturnType<typeof ingest>>> }) => Promise<void>,
): Promise<void> {
  const drive = await mkdtemp(join(tmpdir(), 'nfl-drive-'));
  const db = await mkdtemp(join(tmpdir(), 'nfl-db-'));
  try {
    const store = new MetaStore(db);
    await store.init();
    const root = { ...ROOT, path: drive };
    const scan = async (prune = false) => {
      const report = await scanRoot(drive, { minFeatureBytes: 1, concurrency: 2 });
      return ingest(report, root, drive, store, { prune });
    };
    await fn({ drive, store, root, scan });
  } finally {
    await rm(drive, { recursive: true, force: true });
    await rm(db, { recursive: true, force: true });
  }
}

describe('scan reconciliation', () => {
  test('a rescan with no changes creates nothing and duplicates nothing', async () => {
    await withLibrary(async ({ drive, store, scan }) => {
      await makeFilm(drive, 'Alpha.2020.1080p.BluRay.x264-GRP.mkv', 1);
      await makeFilm(drive, 'Bravo.2019.1080p.BluRay.x264-GRP.mkv', 2);

      const first = await scan();
      assert.equal(first.created, 2);

      const second = await scan();
      assert.equal(second.created, 0, 'a second scan must not re-create titles');
      assert.equal(second.unchanged, 2);
      assert.equal(second.relocated, 0);
      assert.deepEqual(second.missing, []);

      // The bug this pins: a media entry appearing twice on the same title.
      const { titles } = await store.loadAll();
      for (const t of titles) {
        const paths = t.media.flatMap((m) => m.sightings.map((sg) => sg.relPath));
        assert.equal(new Set(paths).size, paths.length, `${t.title} has duplicate media`);
      }
    });
  });

  test('a renamed file updates the existing record instead of duplicating it', async () => {
    await withLibrary(async ({ drive, store, scan }) => {
      await makeFilm(drive, 'Alpha.2020.1080p.BluRay.x264-GRP.mkv', 1);
      await scan();

      await rename(
        join(drive, 'Alpha.2020.1080p.BluRay.x264-GRP.mkv'),
        join(drive, 'Alpha (2020) Remastered.mkv'),
      );

      const after = await scan();
      assert.equal(after.relocated, 1);
      assert.equal(after.created, 0, 'a move must not create a second title');
      assert.deepEqual(after.missing, [], 'the old path must not be reported as missing');

      const { titles } = await store.loadAll();
      assert.equal(titles.length, 1);
      assert.equal(titles[0].media.length, 1, 'exactly one file, at the new path');
      assert.equal(titles[0].media[0].sightings[0].relPath, 'Alpha (2020) Remastered.mkv');
    });
  });

  test('renaming twice still leaves one record with one file', async () => {
    await withLibrary(async ({ drive, store, scan }) => {
      await makeFilm(drive, 'Alpha.2020.1080p.BluRay.x264-GRP.mkv', 1);
      await scan();

      await rename(join(drive, 'Alpha.2020.1080p.BluRay.x264-GRP.mkv'), join(drive, 'Alpha v2.mkv'));
      await scan();
      await rename(join(drive, 'Alpha v2.mkv'), join(drive, 'Alpha v3.mkv'));
      const after = await scan();

      const { titles } = await store.loadAll();
      assert.equal(titles.length, 1);
      assert.equal(titles[0].media.length, 1);
      assert.equal(titles[0].media[0].sightings[0].relPath, 'Alpha v3.mkv');
      assert.deepEqual(after.missing, []);
    });
  });

  test('a deleted file is reported but never removed without prune', async () => {
    await withLibrary(async ({ drive, store, scan }) => {
      await makeFilm(drive, 'Alpha.2020.1080p.BluRay.x264-GRP.mkv', 1);
      await makeFilm(drive, 'Bravo.2019.1080p.BluRay.x264-GRP.mkv', 2);
      await scan();

      await unlink(join(drive, 'Alpha.2020.1080p.BluRay.x264-GRP.mkv'));
      const after = await scan();

      assert.equal(after.missing.length, 1);
      // A blank title here would make the report useless to the person reading it.
      assert.equal(after.missing[0].title, 'Alpha');
      assert.equal(after.missing[0].lastMedia, true);
      assert.equal(after.pruned, 0, 'a plain scan must never delete metadata');

      const { titles } = await store.loadAll();
      assert.equal(titles.length, 2, 'the record survives until pruning is asked for');
    });
  });

  test('prune removes the record only when asked', async () => {
    await withLibrary(async ({ drive, store, scan }) => {
      await makeFilm(drive, 'Alpha.2020.1080p.BluRay.x264-GRP.mkv', 1);
      await makeFilm(drive, 'Bravo.2019.1080p.BluRay.x264-GRP.mkv', 2);
      await scan();
      await unlink(join(drive, 'Alpha.2020.1080p.BluRay.x264-GRP.mkv'));

      const after = await scan(true);
      assert.equal(after.pruned, 1);

      const { titles } = await store.loadAll();
      assert.deepEqual(titles.map((t) => t.title), ['Bravo']);
    });
  });

  test('a new film is added without touching the others', async () => {
    await withLibrary(async ({ drive, store, scan }) => {
      await makeFilm(drive, 'Alpha.2020.1080p.BluRay.x264-GRP.mkv', 1);
      await scan();

      await makeFilm(drive, 'Bravo.2019.1080p.BluRay.x264-GRP.mkv', 2);
      const after = await scan();

      assert.equal(after.created, 1);
      assert.equal(after.unchanged, 1);
      assert.deepEqual(after.missing, []);
      const { titles } = await store.loadAll();
      assert.equal(titles.length, 2);
    });
  });
});
