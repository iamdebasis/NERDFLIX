import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { episodeSlots, nextUp, seasonsOf, slotProgress } from './episodes.js';
import { MediaResolver } from './resolver.js';
import { StateStore } from '../store/state-store.js';
import type { EpisodeProgress, MediaFile, Title } from '../schema/index.js';
import type { VolumeState } from '../volumes/manager.js';

function ep(season: number, episode: number, over: Partial<MediaFile> = {}): MediaFile {
  return {
    contentId: `c-${season}-${episode}`,
    probeVersion: 1,
    sightings: [{ volumeId: 'vol-a', relPath: `S${season}E${episode}.mkv`, fingerprint: '', lastSeen: '' }],
    releaseName: `Show.S${season}E${episode}`,
    releaseAttributes: [],
    container: 'matroska',
    videoCodec: 'hevc',
    resolution: '2160p',
    hdr: 'SDR',
    bitrateMbps: 40,
    sizeBytes: 1,
    durationSec: 3000,
    audio: [],
    subtitles: [],
    chapters: [],
    season,
    episode,
    ...over,
  } as MediaFile;
}

const show = (media: MediaFile[], episodeInfo: Title['episodeInfo'] = []) =>
  ({ media, episodeInfo }) as Pick<Title, 'media' | 'episodeInfo'>;

const watched = (at = '2026-01-01T00:00:00Z'): EpisodeProgress =>
  ({ positionSec: 0, durationSec: 3000, watched: true, lastPlayedAt: at });
const partway = (pos: number, at = '2026-01-02T00:00:00Z'): EpisodeProgress =>
  ({ positionSec: pos, durationSec: 3000, watched: false, lastPlayedAt: at });

describe('episode slots', () => {
  test('ordered by season then episode, with specials last', () => {
    const slots = episodeSlots(show([ep(2, 1), ep(0, 1), ep(1, 2), ep(1, 1)]));
    assert.deepEqual(slots.map((s) => s.key), ['1:1', '1:2', '2:1', '0:1']);
    assert.deepEqual(seasonsOf(slots), [1, 2, 0]);
  });

  test('two copies of one episode are ONE slot with two files', () => {
    const slots = episodeSlots(show([ep(1, 1), ep(1, 1, { contentId: 'c-4k', bitrateMbps: 80 })]));
    assert.equal(slots.length, 1);
    assert.equal(slots[0].files.length, 2);
  });

  test('TMDB info attaches by season and number', () => {
    const slots = episodeSlots(show([ep(1, 1)], [{ season: 1, episode: 1, name: 'Pilot' }]));
    assert.equal(slots[0].info?.name, 'Pilot');
  });

  test('a double episode keeps its range', () => {
    assert.equal(episodeSlots(show([ep(8, 1, { episodeEnd: 2 })]))[0].episodeEnd, 2);
  });

  test('media with no numbering is ignored rather than crashing the list', () => {
    assert.equal(episodeSlots(show([ep(1, 1), { ...ep(1, 2), season: undefined } as MediaFile])).length, 1);
  });

  test('a slot reports the most recently played of its copies', () => {
    const [slot] = episodeSlots(show([ep(1, 1), ep(1, 1, { contentId: 'c-4k' })]));
    const p = slotProgress(slot, { 'c-1-1': partway(500, '2026-01-01'), 'c-4k': partway(900, '2026-02-01') });
    assert.equal(p?.positionSec, 900);
  });
});

describe('next up', () => {
  const slots = episodeSlots(show([ep(1, 1), ep(1, 2), ep(1, 3), ep(2, 1), ep(0, 1)]));

  test('nothing watched: the first episode, as a start', () => {
    assert.deepEqual([nextUp(slots, {})?.slot.key, nextUp(slots, {})?.reason], ['1:1', 'start']);
  });

  test('part-way through the last episode touched: resume it', () => {
    const n = nextUp(slots, { 'c-1-2': partway(1500) }, 'c-1-2');
    assert.deepEqual([n?.slot.key, n?.reason, n?.resumeSec], ['1:2', 'resume', 1500]);
    assert.equal(Math.round(n?.resumePct ?? 0), 50);
  });

  test('finished an episode: the one after it', () => {
    const n = nextUp(slots, { 'c-1-2': watched() }, 'c-1-2');
    assert.deepEqual([n?.slot.key, n?.reason], ['1:3', 'next']);
  });

  test('finished a season: the next season opens', () => {
    const n = nextUp(slots, { 'c-1-3': watched() }, 'c-1-3');
    assert.equal(n?.slot.key, '2:1');
  });

  test('follows what you did, not the first gap — skipping the pilot is allowed', () => {
    const n = nextUp(slots, { 'c-1-3': partway(800) }, 'c-1-3');
    assert.equal(n?.slot.key, '1:3');
  });

  test('specials never come up on their own', () => {
    const n = nextUp(slots, { 'c-2-1': watched() }, 'c-2-1');
    // Everything after S2E1 is a special; the earlier regular episodes are unwatched.
    assert.notEqual(n?.slot.season, 0);
  });

  test('everything watched: round again from the top', () => {
    const all = Object.fromEntries(
      ['c-1-1', 'c-1-2', 'c-1-3', 'c-2-1'].map((c) => [c, watched()]),
    );
    const n = nextUp(slots, all, 'c-2-1');
    assert.deepEqual([n?.slot.key, n?.reason], ['1:1', 'rewatch']);
  });

  test('a show that is only specials still plays', () => {
    assert.equal(nextUp(episodeSlots(show([ep(0, 1)])), {})?.slot.key, '0:1');
  });

  test('no episodes: nothing to play', () => {
    assert.equal(nextUp([], {}), null);
  });
});

describe('resolving an episode never substitutes another', () => {
  const vols = (online: string[]): VolumeState[] =>
    ['vol-a', 'vol-b'].map((id) => ({
      root: { id, label: id.toUpperCase(), kind: 'local', path: `/${id}`, borrowed: false, readOnly: false, addedAt: '' },
      status: online.includes(id) ? 'online' : 'offline',
      resolvedPath: online.includes(id) ? `/${id}` : undefined,
      probeMs: 0,
    })) as VolumeState[];

  test('an episode on an unplugged drive is offline — not another episode', () => {
    const e4 = ep(1, 4, { sightings: [{ volumeId: 'vol-b', relPath: 'S1E4.mkv', fingerprint: '', lastSeen: '' }] });
    const e1 = ep(1, 1, { bitrateMbps: 99 }); // on vol-a, reachable, higher bitrate
    const r = new MediaResolver(vols(['vol-a']));

    // The film-shaped resolve() would hand back E1 here. That is the bug being guarded.
    assert.equal(r.resolve({ media: [e1, e4] } as Title).status, 'available');
    const exact = r.resolveMedia(e4);
    assert.equal(exact.status, 'offline');
    assert.equal(exact.status === 'offline' && exact.volumeLabel, 'VOL-B');
  });

  test('among copies of ONE episode, the best reachable wins', () => {
    const hd = ep(1, 1, { contentId: 'hd', bitrateMbps: 20 });
    const uhd = ep(1, 1, { contentId: 'uhd', bitrateMbps: 80 });
    const r = new MediaResolver(vols(['vol-a']));
    const got = r.resolveAmong([hd, uhd]);
    assert.equal(got.status === 'available' && got.media.contentId, 'uhd');
  });
});

describe('episode progress in state/', () => {
  async function withState(fn: (s: StateStore) => Promise<void>) {
    const dir = await mkdtemp(join(tmpdir(), 'nfl-state-'));
    try {
      await fn(new StateStore(join(dir, 'progress.json')));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  test('part-way: the episode and the show both remember it', async () => {
    await withState(async (s) => {
      await s.setEpisodeProgress('show-x', 'c-1-3', 900, 3000);
      assert.equal((await s.getEpisodes())['c-1-3'].positionSec, 900);
      assert.equal((await s.getProgress('show-x'))?.contentId, 'c-1-3');
    });
  });

  test('finishing marks the episode watched and keeps the show in view', async () => {
    await withState(async (s) => {
      await s.setEpisodeProgress('show-x', 'c-1-3', 2950, 3000);
      assert.equal((await s.getEpisodes())['c-1-3'].watched, true);
      const recent = await s.recentProgress();
      assert.equal(recent[0].titleId, 'show-x', 'a finished episode must not drop the show');
    });
  });

  test('sampling the next episode does not forget the one you finished', async () => {
    await withState(async (s) => {
      await s.setEpisodeProgress('show-x', 'c-1-4', 2950, 3000); // finished E4
      await s.setEpisodeProgress('show-x', 'c-1-5', 45, 3000); // tried E5 for 45s
      assert.equal((await s.getProgress('show-x'))?.contentId, 'c-1-4');
      assert.equal((await s.getEpisodes())['c-1-5'], undefined);
    });
  });

  test('a rewatch abandoned early is still a watched episode', async () => {
    await withState(async (s) => {
      await s.setEpisodeProgress('show-x', 'c-1-1', 2950, 3000);
      await s.setEpisodeProgress('show-x', 'c-1-1', 30, 3000);
      assert.equal((await s.getEpisodes())['c-1-1'].watched, true);
    });
  });

  test('a state file written before TV support still loads', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'nfl-state-'));
    try {
      const { writeFile } = await import('node:fs/promises');
      const path = join(dir, 'progress.json');
      await writeFile(path, JSON.stringify({
        version: 1,
        progress: { 'cars-2006': { mediaIndex: 0, positionSec: 600, durationSec: 7000, watched: false, lastPlayedAt: '2026-01-01' } },
        myList: ['cars-2006'],
        thumbs: {},
      }));
      const s = new StateStore(path);
      assert.deepEqual(await s.getMyList(), ['cars-2006'], 'old state was reset — watch history lost');
      assert.deepEqual(await s.getEpisodes(), {});
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
