import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { hasMovedFiles } from './moved.js';
import type { Title } from '../schema/index.js';

const title = (volumeId: string, relPaths: string[]): Title =>
  ({
    media: relPaths.map((relPath) => ({ sightings: [{ volumeId, relPath, fingerprint: '', lastSeen: '' }] })),
  }) as unknown as Title;

async function withDrive(fn: (dir: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), 'nfl-moved-'));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe('has a drive been reorganised since its last scan?', () => {
  test('everything where it was: no', async () => {
    await withDrive(async (dir) => {
      await writeFile(join(dir, 'Cars.2006.mkv'), 'x');
      assert.equal(await hasMovedFiles([title('v', ['Cars.2006.mkv'])], 'v', dir), false);
    });
  });

  test('films moved into a new "Cars" folder: yes', async () => {
    await withDrive(async (dir) => {
      await writeFile(join(dir, 'Cars.2006.mkv'), 'x');
      await mkdir(join(dir, 'CARS Collection'));
      await rename(join(dir, 'Cars.2006.mkv'), join(dir, 'CARS Collection', 'Cars.2006.mkv'));
      assert.equal(await hasMovedFiles([title('v', ['Cars.2006.mkv'])], 'v', dir), true);
    });
  });

  test("only this drive's files count — another drive's paths are not looked for here", async () => {
    await withDrive(async (dir) => {
      assert.equal(await hasMovedFiles([title('other', ['Elsewhere.mkv'])], 'v', dir), false);
    });
  });
});
