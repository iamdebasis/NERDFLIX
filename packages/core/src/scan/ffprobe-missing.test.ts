import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { scanRoot } from './scan.js';
import { FfprobeMissingError } from './probe.js';

/**
 * Found by launching the packaged app from Finder, whose PATH has no Homebrew: a folder
 * holding a film scanned as "Up to date", nothing found and nothing said. Every file's
 * probe failed the same way and each failure was filed against that file.
 */
async function withFilm(fn: (dir: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), 'nfl-ffprobe-'));
  try {
    // Not a real video: discovery needs only a name and a size.
    await writeFile(join(dir, 'Some.Film.2020.1080p.BluRay.mkv'), 'not really a video');
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe('a scan that cannot read anything says so', () => {
  test('no ffprobe on PATH: the scan stops with how to install it, instead of "Up to date"', async () => {
    await withFilm(async (dir) => {
      const saved = process.env.PATH;
      process.env.PATH = join(dir, 'no-tools-here');
      try {
        await assert.rejects(scanRoot(dir, { minFeatureBytes: 1 }), (err: unknown) => {
          assert.ok(err instanceof FfprobeMissingError);
          assert.match((err as Error).message, /brew install ffmpeg/);
          return true;
        });
      } finally {
        process.env.PATH = saved;
      }
    });
  });

  test('one file ffprobe cannot read is still that file’s problem — the scan carries on', async () => {
    await withFilm(async (dir) => {
      const report = await scanRoot(dir, { minFeatureBytes: 1 });
      assert.equal(report.titles.length, 1);
      assert.ok(report.titles[0].probeError, 'an unreadable file is recorded, not thrown');
    });
  });
});
