import assert from 'node:assert/strict';
import { after, describe, test } from 'node:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discoverReleaseUnits, looksLikeMultiPart } from './discover.js';

/** Small enough to write quickly, large enough to clear the floor we pass in. */
const FEATURE = Buffer.alloc(4096);
const MIN = 1024;

const roots: string[] = [];
async function fixture(tree: Record<string, 'video' | 'text' | 'dir'>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'nfl-discover-'));
  roots.push(root);
  for (const [rel, kind] of Object.entries(tree)) {
    const full = join(root, rel);
    if (kind === 'dir') {
      await mkdir(full, { recursive: true });
      continue;
    }
    await mkdir(join(full, '..'), { recursive: true });
    await writeFile(full, kind === 'video' ? FEATURE : 'sidecar');
  }
  return root;
}
after(async () => {
  for (const r of roots) await rm(r, { recursive: true, force: true });
});

const names = (u: { releaseName: string }[]) => u.map((x) => x.releaseName).sort();

describe('a folder of films is looked INTO, not thrown away', () => {
  /**
   * The reported bug, as the library actually looks on disk.
   *
   * "Star Wars Collection" holds seven bare files and one release folder. Discovery
   * found eight features in it, called that `multiple-features`, and skipped the whole
   * folder — so pairing MOVIEX reported four films and the eight in the collection
   * could only be seen by pairing that subfolder separately.
   */
  test('a nested collection contributes all of its films', async () => {
    const root = await fixture({
      'Cars.2006.REMUX-FraMeSToR/Cars.2006.REMUX-FraMeSToR.mkv': 'video',
      'Interstellar.2014.REMUX-FraMeSToR/Interstellar.2014.REMUX-FraMeSToR.mkv': 'video',
      'Star Wars Collection/Rogue One 2016 Remux -DDR/Rogue One 2016 Remux -DDR.mkv': 'video',
      'Star Wars Collection/Star.Wars.Episode.I.1999.Remux-3L.mkv': 'video',
      'Star Wars Collection/Star.Wars.Episode.II.2002.Remux-3L.mkv': 'video',
      'Star Wars Collection/Star.Wars.Episode.III.2005.Remux-3L.mkv': 'video',
      'The.Dark.Knight.Rises.2012.REMUX-FraMeSToR.mkv': 'video',
    });
    const { units } = await discoverReleaseUnits(root, { minFeatureBytes: MIN });
    assert.deepEqual(names(units), [
      'Cars.2006.REMUX-FraMeSToR',
      'Interstellar.2014.REMUX-FraMeSToR',
      'Rogue One 2016 Remux -DDR',
      'Star.Wars.Episode.I.1999.Remux-3L',
      'Star.Wars.Episode.II.2002.Remux-3L',
      'Star.Wars.Episode.III.2005.Remux-3L',
      'The.Dark.Knight.Rises.2012.REMUX-FraMeSToR',
    ]);
  });

  test('a release folder inside a collection still names itself from its folder', async () => {
    const root = await fixture({
      'Collection/Rogue One 2016 Remux -DDR/Rogue One 2016 Remux -DDR.mkv': 'video',
      'Collection/Star.Wars.1977.mkv': 'video',
    });
    const { units } = await discoverReleaseUnits(root, { minFeatureBytes: MIN });
    const rogue = units.find((u) => u.releaseName.startsWith('Rogue'))!;
    assert.equal(rogue.nameSource, 'folder', 'the folder name is the canonical one');
    const bare = units.find((u) => u.releaseName.startsWith('Star'))!;
    assert.equal(bare.nameSource, 'file');
  });

  test('films nested several folders deep are still found', async () => {
    const root = await fixture({
      '1980s/Sci-Fi/Ridley Scott/Blade.Runner.1982.Remux.mkv': 'video',
      '2000s/Nolan/Memento.2000.Remux/Memento.2000.Remux.mkv': 'video',
    });
    const { units } = await discoverReleaseUnits(root, { minFeatureBytes: MIN });
    assert.deepEqual(names(units), ['Blade.Runner.1982.Remux', 'Memento.2000.Remux']);
  });

  test('a genuinely empty folder is still reported as empty', async () => {
    const root = await fixture({ 'Nothing Here': 'dir', 'Nothing Here/notes.txt': 'text' });
    const { units, issues } = await discoverReleaseUnits(root, { minFeatureBytes: MIN });
    assert.equal(units.length, 0);
    assert.deepEqual(
      issues.map((i) => i.reason),
      ['no-feature'],
    );
  });

  test('junk folders are not descended into', async () => {
    const root = await fixture({
      'Film.2020.Remux/Film.2020.Remux.mkv': 'video',
      'Film.2020.Remux/Sample/Film.2020.sample.mkv': 'video',
      'Film.2020.Remux/Subs/whatever.mkv': 'video',
    });
    const { units } = await discoverReleaseUnits(root, { minFeatureBytes: MIN });
    assert.deepEqual(names(units), ['Film.2020.Remux'], 'one film, not three');
  });
});

describe('one film split across files must not become several', () => {
  test('CD1/CD2 is a single release needing review, not two films', async () => {
    const root = await fixture({
      'Old.Film.1968.DVDRip/Old.Film.1968.DVDRip.CD1.avi': 'video',
      'Old.Film.1968.DVDRip/Old.Film.1968.DVDRip.CD2.avi': 'video',
    });
    const { units, issues } = await discoverReleaseUnits(root, { minFeatureBytes: MIN });
    assert.equal(units.length, 0);
    assert.equal(issues[0]?.reason, 'multiple-features');
  });

  test('the part test is narrow — different films are never parts', () => {
    assert.equal(looksLikeMultiPart(['Movie.CD1.avi', 'Movie.CD2.avi']), true);
    assert.equal(looksLikeMultiPart(['Movie.part1.mkv', 'Movie.part2.mkv']), true);
    assert.equal(looksLikeMultiPart(['Movie Disc 1.mkv', 'Movie Disc 2.mkv']), true);

    assert.equal(looksLikeMultiPart(['Star.Wars.I.mkv', 'Star.Wars.II.mkv']), false);
    assert.equal(
      looksLikeMultiPart(['Rocky.1976.mkv', 'Rocky.II.1979.mkv']),
      false,
      'sequels are not parts',
    );
    assert.equal(
      looksLikeMultiPart(['Alien.part1.mkv', 'Aliens.part1.mkv']),
      false,
      'same marker, different films',
    );
    assert.equal(looksLikeMultiPart(['Movie.CD1.avi']), false, 'one file is not a split');
  });
});
