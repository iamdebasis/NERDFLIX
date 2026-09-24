import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { MediaResolver, type EpisodeProgress, type MediaFile, type Title, type VolumeState } from '@nfl/core';
import { episodeToPlay, showEpisodes, showSummary } from './shows.js';
import { validTracksFor } from './tracks.js';

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
    hdr: 'DV',
    dvProfile: 8,
    bitrateMbps: 40,
    sizeBytes: 1000,
    durationSec: 3000,
    audio: [],
    subtitles: [],
    chapters: [],
    season,
    episode,
    ...over,
  } as MediaFile;
}

function show(media: MediaFile[], over: Partial<Title> = {}): Title {
  return {
    id: 'show-x',
    type: 'show',
    title: 'X',
    sortTitle: 'X',
    year: 2008,
    endYear: 2013,
    overview: '',
    genres: [],
    contentTags: [],
    cast: [],
    directors: [],
    creators: ['Vince Gilligan'],
    seasonInfo: [{ season: 1, name: 'Season 1', episodeCount: 7 }],
    episodeInfo: [
      { season: 1, episode: 1, name: 'Pilot', runtimeMinutes: 58, still: '/cache/show-x/still-s01e001.jpg' },
    ],
    externalIds: {},
    artwork: {},
    media,
    similarIds: [],
    matchState: 'auto',
    matchConfidence: 1,
    matchWarnings: [],
    searchTitles: ['X'],
    derivedVersion: 1,
    addedAt: '',
    updatedAt: '',
    ...over,
  } as Title;
}

const volumes = (online: string[]): VolumeState[] =>
  ['vol-a', 'vol-b'].map((id) => ({
    root: { id, label: id.toUpperCase(), kind: 'local', path: `/${id}`, borrowed: false, readOnly: false, addedAt: '' },
    status: online.includes(id) ? 'online' : 'offline',
    resolvedPath: online.includes(id) ? `/${id}` : undefined,
    probeMs: 0,
  })) as VolumeState[];

const ctx = (byContent: Record<string, EpisodeProgress> = {}, last?: string, online = ['vol-a', 'vol-b']) => ({
  resolver: new MediaResolver(volumes(online)),
  byContent,
  lastContentId: last,
});

describe('show summary', () => {
  test('counts regular seasons, not specials', () => {
    const { summary } = showSummary(show([ep(1, 1), ep(2, 1), ep(0, 1)]), ctx());
    assert.equal(summary.seasonCount, 2);
    assert.equal(summary.episodeCount, 3);
  });

  test('an ended show reads as a year range', () => {
    assert.equal(showSummary(show([ep(1, 1)]), ctx()).summary.yearLabel, '2008–2013');
    assert.equal(
      showSummary(show([ep(1, 1)], { endYear: undefined }), ctx()).summary.yearLabel,
      '2008',
    );
  });

  test('next-up carries its label, name and reachability', () => {
    const { summary, playable } = showSummary(show([ep(1, 1), ep(1, 2)]), ctx());
    assert.deepEqual(
      [summary.nextUp?.label, summary.nextUp?.name, summary.nextUp?.reason, summary.nextUp?.available],
      ['S1:E1', 'Pilot', 'start', true],
    );
    assert.equal(playable?.contentId, 'c-1-1');
  });

  test('a next-up episode on an unplugged drive says which drive', () => {
    const offline = ep(1, 1, { sightings: [{ volumeId: 'vol-b', relPath: 'x', fingerprint: '', lastSeen: '' }] });
    const { summary } = showSummary(show([offline, ep(1, 2)]), ctx({}, undefined, ['vol-a']));
    assert.deepEqual([summary.nextUp?.available, summary.nextUp?.offlineOn], [false, 'VOL-B']);
  });

  test('resume progress shows only when resuming', () => {
    const partway = { 'c-1-1': { positionSec: 1500, durationSec: 3000, watched: false, lastPlayedAt: 'x' } };
    assert.equal(showSummary(show([ep(1, 1)]), ctx(partway, 'c-1-1')).summary.nextUp?.resumePct, 50);
    assert.equal(showSummary(show([ep(1, 1)]), ctx()).summary.nextUp?.resumePct, null);
  });
});

describe('seasons label', () => {
  test('counts, a miniseries, and specials', () => {
    assert.equal(showSummary(show([ep(1, 1), ep(2, 1)]), ctx()).summary.seasonsLabel, '2 Seasons');
    assert.equal(showSummary(show([ep(1, 1)]), ctx()).summary.seasonsLabel, 'Season 1');
    // Owning season 2 of a long show must not read as a one-season show.
    assert.equal(showSummary(show([ep(2, 1)], { seasonInfo: [] }), ctx()).summary.seasonsLabel, 'Season 2');
    const mini = show([ep(1, 1)], { seasonInfo: [{ season: 1, name: 'Miniseries' }] });
    assert.equal(showSummary(mini, ctx()).summary.seasonsLabel, 'Limited Series');
    assert.equal(showSummary(show([ep(0, 1)]), ctx()).summary.seasonsLabel, 'Specials');
  });

  test('one season numbered by a year is counted, not named — "Season 1940" says nothing', () => {
    const shorts = show([ep(1940, 1), ep(1940, 2), ep(1940, 3)], { seasonInfo: [{ season: 1940, name: 'Season 1940' }] });
    assert.equal(showSummary(shorts, ctx()).summary.seasonsLabel, '3 Episodes');
    assert.equal(showSummary(show([ep(1940, 1)], { seasonInfo: [] }), ctx()).summary.seasonsLabel, '1 Episode');
    // Several year-numbered seasons are still counted as seasons.
    assert.equal(showSummary(show([ep(1940, 1), ep(1950, 1)]), ctx()).summary.seasonsLabel, '2 Seasons');
  });
});

describe('episode list', () => {
  const list = showEpisodes(show([ep(1, 1), ep(1, 2, { episodeTitle: 'Cats in the Bag' })]), ctx());

  test('seasons use TMDB names and know how many episodes exist', () => {
    assert.deepEqual(list.seasons, [{ season: 1, name: 'Season 1', owned: 2, total: 7, airYear: undefined }]);
  });

  test('names fall back from TMDB to the filename, never empty', () => {
    assert.deepEqual(list.episodes.map((e) => e.name), ['Pilot', 'Cats in the Bag']);
    const bare = showEpisodes(show([ep(1, 3)], { episodeInfo: [] }), ctx());
    assert.equal(bare.episodes[0].name, 'Episode 3');
  });

  test('a still is served under the title, by file name only', () => {
    assert.equal(list.episodes[0].still, 'media://art/show-x/still-s01e001.jpg');
    assert.equal(list.episodes[1].still, null);
  });

  test('runtime prefers TMDB, falls back to the file', () => {
    assert.deepEqual(list.episodes.map((e) => e.runtimeMinutes), [58, 50]);
  });

  test('badges describe the copy that would play', () => {
    assert.deepEqual([list.episodes[0].resolution, list.episodes[0].hdr], ['2160p', 'DV P8']);
  });

  test('a double episode shows its range', () => {
    const d = showEpisodes(show([ep(8, 1, { episodeEnd: 2 })], { episodeInfo: [] }), ctx());
    assert.deepEqual([d.episodes[0].number, d.episodes[0].label], ['1–2', 'S8:E1–E2']);
  });

  test('watched and part-watched rows', () => {
    const l = showEpisodes(
      show([ep(1, 1), ep(1, 2)]),
      ctx({
        'c-1-1': { positionSec: 0, durationSec: 3000, watched: true, lastPlayedAt: 'a' },
        'c-1-2': { positionSec: 750, durationSec: 3000, watched: false, lastPlayedAt: 'b' },
      }, 'c-1-2'),
    );
    assert.deepEqual(l.episodes.map((e) => [e.watched, e.resumePct]), [[true, null], [false, 25]]);
    assert.equal(l.nextUpKey, '1:2');
  });
});

describe('what Play starts', () => {
  test('a requested episode resumes from ITS OWN progress only', () => {
    const t = show([ep(1, 1), ep(1, 2)]);
    const got = episodeToPlay(
      t,
      ctx({ 'c-1-1': { positionSec: 900, durationSec: 3000, watched: false, lastPlayedAt: 'a' } }, 'c-1-1'),
      '1:2',
    );
    assert.deepEqual([got?.slot.key, got?.resumeSec], ['1:2', undefined]);
  });

  test('no key means next-up, resuming where you were', () => {
    const got = episodeToPlay(
      show([ep(1, 1), ep(1, 2)]),
      ctx({ 'c-1-2': { positionSec: 600, durationSec: 3000, watched: false, lastPlayedAt: 'a' } }, 'c-1-2'),
    );
    assert.deepEqual([got?.slot.key, got?.resumeSec], ['1:2', 600]);
  });

  test('an unknown episode key plays nothing rather than something else', () => {
    assert.equal(episodeToPlay(show([ep(1, 1)]), ctx(), '9:9'), null);
  });
});

describe('remembered tracks against a particular file', () => {
  const two = { audio: [{}, {}], subtitles: [{}] } as unknown as MediaFile;

  test('an audio id this file lacks is dropped — aid=3 on two tracks is silence', () => {
    assert.equal(validTracksFor({ audio: 3 }, two), undefined);
  });

  test('ids the file has are kept', () => {
    assert.deepEqual(validTracksFor({ audio: 2, subtitle: 1 }, two), { audio: 2, subtitle: 1 });
  });

  test('subtitles off is valid for every file', () => {
    assert.deepEqual(validTracksFor({ audio: 5, subtitle: 'no' }, two), { subtitle: 'no' });
  });

  test('nothing chosen stays nothing', () => {
    assert.equal(validTracksFor(undefined, two), undefined);
  });
});
