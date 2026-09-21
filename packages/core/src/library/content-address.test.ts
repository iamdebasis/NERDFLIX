import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, copyFile, rename, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { scanRoot } from '../scan/scan.js';
import { computeContentId } from '../scan/content-id.js';
import { ingest } from './ingest.js';
import { MetaStore } from '../store/meta-store.js';
import type { LibraryRoot } from '../schema/index.js';

const exec = promisify(execFile);

/**
 * These cover the reason identity moved off location and onto content: media you do
 * not own. A borrowed NTFS drive cannot be written to, so nothing may be stored on
 * it — yet the library must still recognise those files later, and recognise them
 * again once they are copied somewhere else.
 */

function root(id: string, path: string, over: Partial<LibraryRoot> = {}): LibraryRoot {
  return {
    id,
    label: id,
    kind: 'removable',
    path,
    borrowed: false,
    readOnly: false,
    addedAt: '2026-01-01T00:00:00Z',
    ...over,
  };
}

async function film(dir: string, name: string, seconds = 2): Promise<void> {
  await exec('ffmpeg', [
    '-y', '-v', 'error',
    '-f', 'lavfi', '-i', `testsrc2=size=64x64:rate=5:d=${seconds}`,
    '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '45',
    join(dir, name),
  ]);
}

async function withDirs(fn: (a: string, b: string, store: MetaStore) => Promise<void>) {
  const a = await mkdtemp(join(tmpdir(), 'nfl-a-'));
  const b = await mkdtemp(join(tmpdir(), 'nfl-b-'));
  const db = await mkdtemp(join(tmpdir(), 'nfl-db-'));
  try {
    const store = new MetaStore(db);
    await store.init();
    await fn(a, b, store);
  } finally {
    await Promise.all([
      rm(a, { recursive: true, force: true }),
      rm(b, { recursive: true, force: true }),
      rm(db, { recursive: true, force: true }),
    ]);
  }
}

const scan = (dir: string, r: LibraryRoot, store: MetaStore, prune = false) =>
  scanRoot(dir, { minFeatureBytes: 1, concurrency: 2 }).then((rep) =>
    ingest(rep, r, dir, store, { prune }),
  );

describe('content addressing', () => {
  test('the same bytes produce the same id from any path', async () => {
    await withDirs(async (a, b) => {
      await film(a, 'Alpha.2020.1080p.BluRay.x264-GRP.mkv');
      await copyFile(
        join(a, 'Alpha.2020.1080p.BluRay.x264-GRP.mkv'),
        join(b, 'totally-different-name.mkv'),
      );

      const [one, two] = await Promise.all([
        computeContentId(join(a, 'Alpha.2020.1080p.BluRay.x264-GRP.mkv'), 0, 2),
        computeContentId(join(b, 'totally-different-name.mkv'), 0, 2),
      ]);
      assert.equal(one, two, 'identity must not depend on filename or location');
    });
  });

  test('different films produce different ids', async () => {
    await withDirs(async (a) => {
      await film(a, 'Alpha.2020.1080p.BluRay.x264-GRP.mkv', 2);
      await film(a, 'Bravo.2019.1080p.BluRay.x264-GRP.mkv', 3);
      const [one, two] = await Promise.all([
        computeContentId(join(a, 'Alpha.2020.1080p.BluRay.x264-GRP.mkv'), 111, 2),
        computeContentId(join(a, 'Bravo.2019.1080p.BluRay.x264-GRP.mkv'), 222, 3),
      ]);
      assert.notEqual(one, two);
    });
  });

  test('a film copied from a borrowed drive is recognised, not re-created', async () => {
    await withDirs(async (borrowed, mine, store) => {
      const theirs = root('vol-theirs', borrowed, { borrowed: true, readOnly: true });
      const ours = root('vol-mine', mine);

      await film(borrowed, 'Alpha.2020.1080p.BluRay.x264-GRP.mkv');
      const first = await scan(borrowed, theirs, store);
      assert.equal(first.created, 1);

      // Nothing was written to their drive — only the film is there.
      const { readdir } = await import('node:fs/promises');
      assert.deepEqual(await readdir(borrowed), ['Alpha.2020.1080p.BluRay.x264-GRP.mkv']);

      // Copy it to our own drive under a different name.
      await copyFile(
        join(borrowed, 'Alpha.2020.1080p.BluRay.x264-GRP.mkv'),
        join(mine, 'Alpha (2020).mkv'),
      );
      const second = await scan(mine, ours, store);

      assert.equal(second.created, 0, 'a copy must not become a second title');
      assert.equal(second.alreadyKnown, 1);

      const { titles } = await store.loadAll();
      assert.equal(titles.length, 1);
      assert.equal(titles[0].media.length, 1, 'one file, seen in two places');
      assert.deepEqual(
        titles[0].media[0].sightings.map((s) => s.volumeId).sort(),
        ['vol-mine', 'vol-theirs'],
      );
    });
  });

  test('unplugging the borrowed drive leaves the copy playable', async () => {
    await withDirs(async (borrowed, mine, store) => {
      const theirs = root('vol-theirs', borrowed, { borrowed: true, readOnly: true });
      const ours = root('vol-mine', mine);

      await film(borrowed, 'Alpha.2020.1080p.BluRay.x264-GRP.mkv');
      await scan(borrowed, theirs, store);
      await copyFile(
        join(borrowed, 'Alpha.2020.1080p.BluRay.x264-GRP.mkv'),
        join(mine, 'Alpha (2020).mkv'),
      );
      await scan(mine, ours, store);

      // Their drive goes home: rescanning it with everything gone, and pruning.
      await unlink(join(borrowed, 'Alpha.2020.1080p.BluRay.x264-GRP.mkv'));
      const after = await scan(borrowed, theirs, store, true);

      assert.equal(after.missing.length, 1);
      assert.equal(after.missing[0].onlyCopy, false, 'we still hold a copy');

      const { titles } = await store.loadAll();
      assert.equal(titles.length, 1, 'the title survives — we own a copy');
      assert.deepEqual(titles[0].media[0].sightings.map((s) => s.volumeId), ['vol-mine']);
    });
  });

  test('a move within a drive keeps one sighting, not two', async () => {
    await withDirs(async (a, _b, store) => {
      const r = root('vol-a', a);
      await film(a, 'Alpha.2020.1080p.BluRay.x264-GRP.mkv');
      await scan(a, r, store);

      await rename(join(a, 'Alpha.2020.1080p.BluRay.x264-GRP.mkv'), join(a, 'Alpha (2020).mkv'));
      const after = await scan(a, r, store);

      assert.equal(after.relocated, 1);
      assert.equal(after.created, 0);
      assert.deepEqual(after.missing, [], 'the old path is not a missing file');

      const { titles } = await store.loadAll();
      assert.equal(titles[0].media[0].sightings.length, 1);
      assert.equal(titles[0].media[0].sightings[0].relPath, 'Alpha (2020).mkv');
    });
  });

  test('deleting the only copy still reports it as gone', async () => {
    await withDirs(async (a, _b, store) => {
      const r = root('vol-a', a);
      await film(a, 'Alpha.2020.1080p.BluRay.x264-GRP.mkv');
      await film(a, 'Bravo.2019.1080p.BluRay.x264-GRP.mkv', 3);
      await scan(a, r, store);

      await unlink(join(a, 'Alpha.2020.1080p.BluRay.x264-GRP.mkv'));
      const dry = await scan(a, r, store);
      assert.equal(dry.missing.length, 1);
      assert.equal(dry.missing[0].title, 'Alpha');
      assert.equal(dry.missing[0].onlyCopy, true);
      assert.equal(dry.pruned, 0, 'a plain scan never deletes');

      const pruned = await scan(a, r, store, true);
      assert.equal(pruned.pruned, 1);
      const { titles } = await store.loadAll();
      assert.deepEqual(titles.map((t) => t.title), ['Bravo']);
    });
  });
});
