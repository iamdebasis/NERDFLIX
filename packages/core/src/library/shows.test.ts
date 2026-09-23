import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { scanRoot } from '../scan/scan.js';
import { ingest } from './ingest.js';
import { MetaStore } from '../store/meta-store.js';
import type { LibraryRoot, Title } from '../schema/index.js';

const exec = promisify(execFile);

/**
 * TV ingest, against real files on disk.
 *
 * Every file gets a distinct hue: ffmpeg's test pattern is deterministic, so two
 * episodes of the same length would be byte-identical, share a contentId, and be
 * treated as ONE file seen twice — hiding exactly the grouping bugs this is here for.
 */
let seed = 0;
async function video(root: string, rel: string): Promise<void> {
  const full = join(root, rel);
  await mkdir(dirname(full), { recursive: true });
  seed += 1;
  await exec('ffmpeg', [
    '-y', '-v', 'error',
    '-f', 'lavfi', '-i', `testsrc2=size=64x64:rate=5:d=1`,
    '-vf', `hue=h=${(seed * 37) % 360}`,
    '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '40',
    full,
  ]);
}

const ROOT: LibraryRoot = {
  id: 'vol-test',
  label: 'TEST',
  kind: 'local',
  path: '',
  borrowed: false,
  readOnly: false,
  addedAt: '2026-01-01T00:00:00Z',
};

async function withLibrary(
  fn: (ctx: { root: string; store: MetaStore; scan: () => ReturnType<typeof ingest> }) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'nfl-tv-'));
  const db = await mkdtemp(join(tmpdir(), 'nfl-tvdb-'));
  try {
    const store = new MetaStore(db);
    await store.init();
    const scan = async () => {
      const report = await scanRoot(root, { minFeatureBytes: 1, concurrency: 2 });
      return ingest(report, { ...ROOT, path: root }, root, store);
    };
    await fn({ root, store, scan });
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(db, { recursive: true, force: true });
  }
}

const shows = async (store: MetaStore): Promise<Title[]> =>
  (await store.loadAll()).titles.filter((t) => t.type === 'show');
const films = async (store: MetaStore): Promise<Title[]> =>
  (await store.loadAll()).titles.filter((t) => t.type === 'movie');
const numbering = (t: Title) =>
  t.media.map((m) => `S${m.season}E${m.episode}${m.episodeEnd ? `-${m.episodeEnd}` : ''}`).sort();

describe('TV ingest', () => {
  test('a scene season pack becomes one show with every episode numbered', async () => {
    await withLibrary(async ({ root, store, scan }) => {
      for (const e of [1, 2, 3]) {
        await video(root, `Chernobyl.S01.2160p.UHD.BluRay.REMUX-GRP/Chernobyl.S01E0${e}.2160p.UHD.BluRay.REMUX-GRP.mkv`);
      }
      const stats = await scan();

      const [show] = await shows(store);
      assert.equal(show.title, 'Chernobyl');
      assert.equal(show.id, 'show-chernobyl');
      assert.deepEqual(numbering(show), ['S1E1', 'S1E2', 'S1E3']);
      assert.equal(stats.created, 1, 'one show, not three');
      assert.equal(stats.episodesAdded, 2);
      assert.equal((await films(store)).length, 0);
    });
  });

  test('Plex layout: bare episode names take the show from their folders', async () => {
    await withLibrary(async ({ root, store, scan }) => {
      await video(root, 'Breaking Bad (2008)/Season 01/S01E01.mkv');
      await video(root, 'Breaking Bad (2008)/Season 01/S01E02.mkv');
      await video(root, 'Breaking Bad (2008)/Season 02/Breaking Bad - S02E01 - Seven Thirty-Seven.mkv');
      await scan();

      const all = await shows(store);
      assert.equal(all.length, 1, `split into ${all.map((s) => s.id).join(', ')}`);
      assert.equal(all[0].title, 'Breaking Bad');
      assert.equal(all[0].year, 2008);
      assert.deepEqual(numbering(all[0]), ['S1E1', 'S1E2', 'S2E1']);
      const named = all[0].media.find((m) => m.season === 2);
      assert.equal(named?.episodeTitle, 'Seven Thirty-Seven');
    });
  });

  test('films and a show share a root without bleeding into each other', async () => {
    await withLibrary(async ({ root, store, scan }) => {
      await video(root, 'Cars.2006.2160p.UHD.BluRay.REMUX-GRP/Cars.2006.2160p.UHD.BluRay.REMUX-GRP.mkv');
      await video(root, 'Star.Wars.Episode.4.A.New.Hope.1977.2160p.UHD.BluRay.REMUX-GRP.mkv');
      await video(root, 'The.Wire.S01E01.The.Target.1080p.BluRay.REMUX-GRP.mkv');
      await scan();

      assert.deepEqual((await films(store)).map((f) => f.title).sort(), ['Cars', 'Star Wars Episode 4 A New Hope']);
      assert.deepEqual((await shows(store)).map((s) => s.title), ['The Wire']);
    });
  });

  test('a show and a film with the same name never share a record', async () => {
    await withLibrary(async ({ root, store, scan }) => {
      await video(root, 'Chernobyl.2021.1080p.BluRay.REMUX-GRP.mkv');
      await video(root, 'Chernobyl.S01E01.1080p.BluRay.REMUX-GRP.mkv');
      await scan();

      const [film] = await films(store);
      const [show] = await shows(store);
      assert.ok(film && show, 'one of each');
      assert.notEqual(film.id, show.id);
      assert.equal(film.media.length, 1);
      assert.equal(show.media.length, 1);
    });
  });

  test('a country suffix keeps a remake apart from its original', async () => {
    await withLibrary(async ({ root, store, scan }) => {
      await video(root, 'The.Office.US.S01E01.1080p-GRP.mkv');
      await video(root, 'The.Office.UK.S01E01.1080p-GRP.mkv');
      await scan();

      const all = await shows(store);
      assert.deepEqual(all.map((s) => s.originCountry).sort(), ['GB', 'US']);
    });
  });

  test('a double episode is one file covering two episodes', async () => {
    await withLibrary(async ({ root, store, scan }) => {
      await video(root, 'Game.of.Thrones.S08E01E02.2160p-GRP.mkv');
      await scan();
      assert.deepEqual(numbering((await shows(store))[0]), ['S8E1-2']);
    });
  });

  test('extras folders inside a show are never catalogued', async () => {
    await withLibrary(async ({ root, store, scan }) => {
      await video(root, 'Breaking Bad (2008)/Season 01/S01E01.mkv');
      await video(root, 'Breaking Bad (2008)/Behind The Scenes/Making of Breaking Bad.mkv');
      await video(root, 'Breaking Bad (2008)/Deleted Scenes/Pilot Alternate.mkv');
      await scan();

      assert.equal((await films(store)).length, 0, 'an extra became a film');
      assert.equal((await shows(store))[0].media.length, 1);
    });
  });

  test('a single-file season pack is reported, not invented as a film', async () => {
    await withLibrary(async ({ root, store, scan }) => {
      await video(root, 'Chernobyl.S01.COMPLETE.2160p.UHD.BluRay.REMUX-GRP.mkv');
      const stats = await scan();

      assert.equal((await store.loadAll()).titles.length, 0);
      assert.deepEqual(stats.skipped.map((s) => s.reason), ['tv-without-episode']);
    });
  });

  test('an episode with nothing naming its show is reported', async () => {
    await withLibrary(async ({ root, store, scan }) => {
      await video(root, 'TV Shows/S01E01.mkv');
      const stats = await scan();

      assert.equal((await store.loadAll()).titles.length, 0);
      assert.deepEqual(stats.skipped.map((s) => s.reason), ['unnamed-series']);
    });
  });

  test('a rescan is stable, and a new season joins the existing show', async () => {
    await withLibrary(async ({ root, store, scan }) => {
      await video(root, 'Severance.2022.S01E01.2160p-GRP.mkv');
      await scan();
      const again = await scan();
      assert.equal(again.created, 0);
      assert.equal(again.unchanged, 1);

      await video(root, 'Severance.S02E01.2160p-GRP.mkv'); // no year this time
      const later = await scan();
      assert.equal(later.created, 0, 'the new season split off into a second show');
      assert.deepEqual(numbering((await shows(store))[0]), ['S1E1', 'S2E1']);
    });
  });

  test('ids stay global: store.get finds a show without being told its type', async () => {
    await withLibrary(async ({ root, store, scan }) => {
      await video(root, 'The.Wire.S01E01.1080p-GRP.mkv');
      await scan();
      const [show] = await shows(store);
      assert.equal((await store.get(show.id))?.type, 'show');
    });
  });
});

/**
 * A file already in the library, read differently now — renamed, or read by a parser
 * that learned something. It is still found by content, in the record it was first
 * filed under; these pin that it moves to where it now belongs.
 */
describe('re-filing a known file whose reading changed', () => {
  const EPISODE = 'Tom and Jerry - S1940E01 - Puss Gets The Boot.mkv';

  test('a file stored as a film moves into its show, keeping every drive it was seen on', async () => {
    await withLibrary(async ({ root, store, scan }) => {
      await video(root, 'Puss.Gets.The.Boot.1940.mkv');
      await scan();
      const [film] = await films(store);
      assert.ok(film, 'precondition: it was filed as a film');
      // Seen on a second drive too — that must survive the move.
      film.media[0].sightings.push({ volumeId: 'vol-other', relPath: 'x/Puss.mkv', fingerprint: 'f', lastSeen: '2026-01-01T00:00:00Z' });
      await store.save(film);

      await rename(join(root, 'Puss.Gets.The.Boot.1940.mkv'), join(root, EPISODE));
      const stats = await scan();

      assert.equal(stats.reclassified, 1);
      assert.equal((await films(store)).length, 0, 'the emptied film record was left behind');
      const [show] = await shows(store);
      assert.equal(show.title, 'Tom and Jerry');
      assert.deepEqual(numbering(show), ['S1940E1']);
      assert.equal(show.media[0].contentId, film.media[0].contentId, 'the same file, not a new one');
      assert.deepEqual(
        show.media[0].sightings.map((x) => x.volumeId).sort(),
        ['vol-other', 'vol-test'],
        'the other drive was forgotten',
      );
    });
  });

  test('a film with two versions keeps the one that is still a film', async () => {
    await withLibrary(async ({ root, store, scan }) => {
      await video(root, 'Heat.1995.Theatrical.Cut.1080p.mkv');
      await video(root, 'Heat.1995.Directors.Cut.1080p.mkv');
      await scan();
      assert.equal((await films(store))[0]?.media.length, 2, 'precondition: one film, two versions');

      await rename(join(root, 'Heat.1995.Directors.Cut.1080p.mkv'), join(root, 'Heat.S01E01.1080p.mkv'));
      await scan();
      const [film] = await films(store);
      assert.equal(film.media.length, 1);
      assert.equal(film.media[0].season, undefined);
      assert.equal((await shows(store)).length, 1);
    });
  });

  test('the reverse: an episode that now reads as a film leaves its show', async () => {
    await withLibrary(async ({ root, store, scan }) => {
      await video(root, 'Heat.S01E01.1080p.mkv');
      await scan();
      await rename(join(root, 'Heat.S01E01.1080p.mkv'), join(root, 'Heat.1995.1080p.mkv'));
      const stats = await scan();

      assert.equal(stats.reclassified, 1);
      assert.equal((await shows(store)).length, 0);
      const [film] = await films(store);
      assert.equal(film.id, 'heat-1995');
      assert.equal(film.media[0].season, undefined, 'a film kept its old episode numbering');
    });
  });

  test('a title the user confirmed stays exactly where they left it', async () => {
    await withLibrary(async ({ root, store, scan }) => {
      await video(root, 'Puss.Gets.The.Boot.1940.mkv');
      await scan();
      const [film] = await films(store);
      await store.save({ ...film, matchState: 'confirmed' });

      await rename(join(root, 'Puss.Gets.The.Boot.1940.mkv'), join(root, EPISODE));
      const stats = await scan();

      assert.equal(stats.reclassified, 0);
      assert.equal(stats.skippedConfirmed, 1);
      assert.equal((await films(store)).length, 1);
      assert.equal((await shows(store)).length, 0);
    });
  });

  test('a reading that could not be filed does not pull an episode out of its show', async () => {
    await withLibrary(async ({ root, store, scan }) => {
      await mkdir(join(root, 'Chernobyl.S01.2160p-GRP'), { recursive: true });
      await video(root, 'Chernobyl.S01.2160p-GRP/Chernobyl.S01E01.2160p-GRP.mkv');
      await scan();
      // Now named like a season pack with no episode number: unplaced TV, skipped.
      await rename(
        join(root, 'Chernobyl.S01.2160p-GRP/Chernobyl.S01E01.2160p-GRP.mkv'),
        join(root, 'Chernobyl.S01.2160p-GRP/Chernobyl.S01.2160p.BluRay.REMUX-GRP.mkv'),
      );
      const stats = await scan();
      assert.equal(stats.reclassified, 0);
      assert.equal((await shows(store))[0]?.media.length, 1, 'the episode was lost');
    });
  });
});
