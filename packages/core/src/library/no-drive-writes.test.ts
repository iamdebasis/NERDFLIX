import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { scanRoot } from '../scan/scan.js';
import { ingest } from './ingest.js';
import { MetaStore } from '../store/meta-store.js';
import { VolumeManager } from '../volumes/manager.js';

const exec = promisify(execFile);

/**
 * "Nothing is ever written to your drives" — the README's promise, held against the
 * real pairing, scanning and ingest code on a real file.
 *
 * Compared by modification time as well as by listing, because the old writability
 * check created and deleted a probe file: the listing afterwards was identical, and
 * only the folder's mtime showed that the drive had been written to.
 */
async function snapshot(root: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const walk = async (dir: string) => {
    const s = await lstat(dir);
    out.set(dir, `dir ${s.mtimeMs}`);
    for (const name of await readdir(dir)) {
      const full = join(dir, name);
      const st = await lstat(full);
      if (st.isDirectory()) await walk(full);
      else out.set(full, `file ${st.size} ${st.mtimeMs}`);
    }
  };
  await walk(root);
  return out;
}

describe('nothing is written to a library', () => {
  test('pairing, scanning and ingesting leave the drive exactly as it was', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nfl-drive-'));
    const data = await mkdtemp(join(tmpdir(), 'nfl-data-'));
    try {
      const film = join(root, 'Heat.1995.2160p.UHD.BluRay.REMUX-GRP', 'Heat.1995.2160p.UHD.BluRay.REMUX-GRP.mkv');
      await mkdir(dirname(film), { recursive: true });
      await exec('ffmpeg', [
        '-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=64x64:rate=5:d=1',
        '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '40', film,
      ]);
      // What an old build left behind. It must be neither read nor touched.
      await mkdir(join(root, '.netflix-local', 'titles'), { recursive: true });
      await writeFile(join(root, '.netflix-local', 'titles', 'heat-1995.json'), '{}');

      // Let the fixture's own mtimes settle, so a later write cannot share a timestamp.
      await new Promise((r) => setTimeout(r, 50));
      const before = await snapshot(root);

      const vm = new VolumeManager(join(data, 'volumes.json'));
      const paired = await vm.pair(root, 'TEST');
      const store = new MetaStore(join(data, 'db'));
      await store.init();
      const report = await scanRoot(root, { minFeatureBytes: 1, concurrency: 1 });
      const stats = await ingest(report, paired, root, store);
      assert.equal(stats.created, 1, 'the fixture film was not scanned, so this proves nothing');

      assert.deepEqual(await snapshot(root), before);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(data, { recursive: true, force: true });
    }
  });
});
