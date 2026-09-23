import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { StateStore, salvageState } from './state-store.js';
import { StateFileSchema } from '../schema/index.js';

/**
 * state/ is the one directory nothing regenerates, so these pin the two ways it was
 * lost. First: a player reporting an UNAVAILABLE time-pos (mpv omits `data` as a file
 * unloads) wrote an entry with no position. Second — the amplifier — load() treated
 * that one bad entry as a corrupt file, started empty, and the next write saved the
 * empty slate over everything: watch history, My List, track choices.
 *
 * The fixture is the exact shape observed on a real run with IINA.
 */
const OBSERVED_CORRUPTION = {
  version: 1,
  progress: {
    'cars-2006': { mediaIndex: 0, positionSec: 600, durationSec: 7000, watched: false, lastPlayedAt: '2026-09-01T00:00:00Z' },
    // Written from an unavailable time-pos: no positionSec at all.
    'show-chernobyl': { contentId: 'c-e4', mediaIndex: 0, durationSec: 240.023, watched: false, lastPlayedAt: '2026-09-23T17:12:13Z' },
  },
  myList: ['cars-2006', 'show-chernobyl'],
  thumbs: {},
  tracks: { 'show-chernobyl': { audio: 2 } },
  episodes: {
    'c-e3': { positionSec: 168.9, durationSec: 240.023, watched: true, lastPlayedAt: '2026-09-23T17:09:20Z' },
    'c-e4': { durationSec: 240.023, watched: true, lastPlayedAt: '2026-09-23T17:12:13Z' },
  },
};

async function withDir(fn: (dir: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), 'nfl-safety-'));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe('nothing that is not a position enters state/', () => {
  for (const bad of [undefined, null, NaN, Infinity, -5]) {
    test(`an episode position of ${String(bad)} is refused`, async () => {
      await withDir(async (dir) => {
        const path = join(dir, 'progress.json');
        const s = new StateStore(path);
        await s.setEpisodeProgress('show-x', 'c-1', 900, 3000);
        await s.setEpisodeProgress('show-x', 'c-1', bad as unknown as number, 3000);
        await s.settle();

        const onDisk = JSON.parse(await readFile(path, 'utf8'));
        assert.ok(StateFileSchema.safeParse(onDisk).success, 'the file on disk no longer validates');
        assert.equal(onDisk.episodes['c-1'].positionSec, 900, 'a good position was overwritten');
      });
    });
  }

  test('a film position of undefined is refused too — the latent film bug', async () => {
    await withDir(async (dir) => {
      const path = join(dir, 'progress.json');
      const s = new StateStore(path);
      await s.setProgress('cars-2006', 600, 7000);
      await s.setProgress('cars-2006', undefined as unknown as number, 7000);
      await s.settle();
      assert.equal(JSON.parse(await readFile(path, 'utf8')).progress['cars-2006'].positionSec, 600);
    });
  });
});

describe('a bad entry never costs the whole file', () => {
  test('the observed corruption is salvaged: every valid entry survives', async () => {
    await withDir(async (dir) => {
      const path = join(dir, 'progress.json');
      await writeFile(path, JSON.stringify(OBSERVED_CORRUPTION));

      const s = await new StateStore(path).load();

      assert.deepEqual(s.myList, ['cars-2006', 'show-chernobyl'], 'My List was lost');
      assert.deepEqual(s.tracks['show-chernobyl'], { audio: 2 }, 'track choices were lost');
      assert.equal(s.progress['cars-2006']?.positionSec, 600, 'film history was lost');
      assert.equal(s.episodes['c-e3']?.watched, true, 'a valid episode was lost');
      // Only the two broken entries go.
      assert.equal(s.progress['show-chernobyl'], undefined);
      assert.equal(s.episodes['c-e4'], undefined);
    });
  });

  test('the original is kept byte for byte beside it', async () => {
    await withDir(async (dir) => {
      const path = join(dir, 'progress.json');
      const original = JSON.stringify(OBSERVED_CORRUPTION);
      await writeFile(path, original);
      await new StateStore(path).load();

      const copies = (await readdir(dir)).filter((f) => f.startsWith('progress.json.invalid-'));
      assert.equal(copies.length, 1);
      assert.equal(await readFile(join(dir, copies[0]), 'utf8'), original);
    });
  });

  test('the next write saves the salvaged state, not an empty one', async () => {
    await withDir(async (dir) => {
      const path = join(dir, 'progress.json');
      await writeFile(path, JSON.stringify(OBSERVED_CORRUPTION));
      const s = new StateStore(path);
      await s.toggleMyList('dune-2021');
      await s.settle();

      const onDisk = JSON.parse(await readFile(path, 'utf8'));
      assert.ok(onDisk.myList.includes('cars-2006'), 'the write replaced history with an empty slate');
      assert.ok(StateFileSchema.safeParse(onDisk).success);
    });
  });

  test('unparseable JSON is kept aside before starting clean', async () => {
    await withDir(async (dir) => {
      const path = join(dir, 'progress.json');
      await writeFile(path, '{"version":1,"progress":{"cars');
      const s = await new StateStore(path).load();
      assert.deepEqual(s.myList, []);
      assert.equal((await readdir(dir)).filter((f) => f.includes('.unparseable-')).length, 1);
    });
  });

  test('a valid file is used as-is, with no copy made', async () => {
    await withDir(async (dir) => {
      const path = join(dir, 'progress.json');
      await writeFile(path, JSON.stringify({ version: 1, progress: {}, myList: ['a'], thumbs: {} }));
      assert.deepEqual((await new StateStore(path).load()).myList, ['a']);
      assert.deepEqual(await readdir(dir), ['progress.json']);
    });
  });

  test('a missing file is a first run, not an error', async () => {
    await withDir(async (dir) => {
      const s = await new StateStore(join(dir, 'progress.json')).load();
      assert.deepEqual(s.myList, []);
      assert.deepEqual(await readdir(dir), []);
    });
  });

  test('salvage tolerates sections of the wrong type', () => {
    const s = salvageState({ progress: 'nope', myList: [1, 'ok', null], tracks: null });
    assert.deepEqual(s.myList, ['ok']);
    assert.deepEqual(s.progress, {});
  });
});
