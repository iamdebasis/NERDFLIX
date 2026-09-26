import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { VolumeManager, inspectVolume, volumePathOf, type DiskInfo } from './manager.js';
import type { LibraryRoot } from '../schema/index.js';

/**
 * Is a paired library connected?
 *
 * The real report: an SSD plugged in, visible in Finder, and the app saying "Not
 * connected". The owner had reorganised it — moved Back to the Future into a "Back to
 * the Future Trilogy" folder — and that one file was the sentinel picked at pairing, the
 * only proof the app accepted, because the drive's UUID had never been recorded
 * (diskutil was asked about the library folder, and answers only for a volume).
 */

type Drive = { dir: string; store: string };

async function withDrive(fn: (d: Drive) => Promise<void>) {
  const base = await mkdtemp(join(tmpdir(), 'nfl-vol-'));
  try {
    const dir = join(base, 'MOVIEX');
    await mkdir(dir);
    await fn({ dir, store: join(base, 'volumes.json') });
  } finally {
    await rm(base, { recursive: true, force: true });
  }
}

const root = (over: Partial<LibraryRoot> & { path: string }): LibraryRoot => ({
  id: 'vol-moviex',
  label: 'MOVIEX',
  kind: 'local',
  borrowed: false,
  readOnly: true,
  addedAt: '2026-09-23T00:00:00Z',
  ...over,
});

async function manager(store: string, roots: LibraryRoot[], deps: ConstructorParameters<typeof VolumeManager>[2] = {}) {
  await writeFile(store, JSON.stringify({ version: 1, roots }));
  return new VolumeManager(store, 2000, deps);
}

const noDisk = async (): Promise<DiskInfo> => ({ removable: false, readOnly: false });
const disk = (uuid: string, mountPoint: string) => async (): Promise<DiskInfo> => ({
  volumeUUID: uuid,
  mountPoint,
  fileSystem: 'NTFS',
  removable: true,
  readOnly: true,
});

describe('a connected drive is recognised, however it has been reorganised', () => {
  test('the sentinel moved into a new folder — still connected (the reported bug)', async () => {
    await withDrive(async ({ dir, store }) => {
      await writeFile(join(dir, 'Back.to.the.Future.1985.mkv'), 'x');
      const vm = await manager(store, [root({ path: dir, sentinel: 'Back.to.the.Future.1985.mkv' })], { inspect: noDisk });
      // Reorganise: the sentinel goes into a trilogy folder.
      await mkdir(join(dir, 'Back to the Future Trilogy'));
      await rename(join(dir, 'Back.to.the.Future.1985.mkv'), join(dir, 'Back to the Future Trilogy', 'Back.to.the.Future.1985.mkv'));
      const [state] = await vm.probeAll();
      assert.equal(state.status, 'online');
    });
  });

  test('a folder that is gone, or empty, is not connected', async () => {
    await withDrive(async ({ dir, store }) => {
      const vm = await manager(store, [root({ path: join(dir, 'nowhere'), sentinel: 'x.mkv' })], { inspect: noDisk });
      assert.equal((await vm.probeAll())[0].status, 'offline');
      const empty = await manager(store, [root({ path: dir, sentinel: 'x.mkv' })], { inspect: noDisk });
      assert.equal((await empty.probeAll())[0].status, 'offline');
    });
  });

  test('the drive UUID is proof enough — whatever has moved on it', async () => {
    await withDrive(async ({ dir, store }) => {
      const vm = await manager(store, [root({ path: dir, volumeUUID: 'U-1', sentinel: 'gone.mkv' })], {
        inspect: disk('U-1', dir),
      });
      assert.equal((await vm.probeAll())[0].status, 'online');
    });
  });

  test('a DIFFERENT drive at the same path is not ours', async () => {
    await withDrive(async ({ dir, store }) => {
      await writeFile(join(dir, 'Some.Film.mkv'), 'x');
      const vm = await manager(store, [root({ path: dir, volumeUUID: 'U-1' })], {
        inspect: disk('U-2', dir),
        findByUUID: async () => null,
      });
      assert.equal((await vm.probeAll())[0].status, 'offline');
    });
  });

  test('remounted under another name: found by UUID, AT the library folder inside the drive', async () => {
    await withDrive(async ({ dir, store }) => {
      const mount = join(dir, '..');
      const vm = await manager(
        store,
        // The old mount name — which must not exist here, or it would simply be found there.
        [root({ path: '/Volumes/NerdflixTestNoSuchDrive/MOVIEX', volumeUUID: 'U-1', volumePath: 'MOVIEX' })],
        { inspect: disk('U-1', mount), findByUUID: async () => mount },
      );
      await writeFile(join(dir, 'Film.mkv'), 'x');
      const [state] = await vm.probeAll();
      // It used to resolve to the drive's top level, pointing the library at the whole drive.
      assert.deepEqual([state.status, state.resolvedPath], ['relocated', dir]);
    });
  });
});

describe('an old pairing is completed once the drive is in reach', () => {
  test('it gains the drive UUID, its folder inside the drive and a fresh sentinel — and keeps its id', async () => {
    await withDrive(async ({ dir, store }) => {
      await mkdir(join(dir, 'Back to the Future Trilogy'));
      const vm = await manager(store, [root({ path: dir, sentinel: 'Back.to.the.Future.1985.mkv' })], {
        inspect: disk('439652F4', join(dir, '..')),
      });
      await vm.probeAll();
      const [saved] = JSON.parse(await readFile(store, 'utf8')).roots as LibraryRoot[];
      assert.deepEqual(
        [saved.id, saved.volumeUUID, saved.volumePath, saved.fileSystem, saved.sentinel],
        ['vol-moviex', '439652F4', 'MOVIEX', 'NTFS', 'Back to the Future Trilogy'],
      );
    });
  });

  test('re-pairing a folder already paired keeps its id, even now its UUID is known', async () => {
    await withDrive(async ({ dir, store }) => {
      await writeFile(join(dir, 'Film.mkv'), 'x');
      const vm = await manager(store, [root({ path: dir, id: 'vol-daba7eb812' })], { inspect: disk('U-1', join(dir, '..')) });
      const paired = await vm.pair(dir, 'MOVIEX');
      assert.equal(paired.id, 'vol-daba7eb812', 'a new id would orphan every sighting of this library');
      assert.equal((await vm.load()).length, 1);
    });
  });
});

describe('asking macOS about the drive a folder is on', () => {
  test('volumePathOf', () => {
    assert.equal(volumePathOf('/Volumes/X/MOVIEX', '/Volumes/X'), 'MOVIEX');
    assert.equal(volumePathOf('/Volumes/X', '/Volumes/X'), '');
    assert.equal(volumePathOf('/Users/me/DOC', '/System/Volumes/Data'), undefined);
    assert.equal(volumePathOf('/Volumes/XY/a', '/Volumes/X'), undefined, 'a prefix of another name');
  });

  test('a FOLDER gets its volume UUID — diskutil used to be asked about the folder and fail', { skip: process.platform !== 'darwin' }, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'nfl-inspect-'));
    try {
      const info = await inspectVolume(join(dir));
      assert.ok(info.volumeUUID, 'no volume UUID for a folder');
      assert.ok(info.mountPoint, 'no mount point for a folder');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
