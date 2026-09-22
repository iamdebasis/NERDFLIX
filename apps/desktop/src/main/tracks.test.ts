import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  audioOptions,
  hasTrackChoice,
  isCommentary,
  languageName,
  mpvTrackId,
  subtitleOptions,
} from './tracks.js';
import type { MediaFile } from '@nfl/core';

/**
 * Labels and, more importantly, IDs.
 *
 * The ID mapping is the part that can be wrong in a way nothing visible catches: pick
 * "Commentary" and get the feature's audio, with no error anywhere. Pinned against the
 * shape of a real remux — Cars 2006, whose four audio tracks came back from mpv as
 * `--aid=1..4` in ffprobe's order.
 */

function media(over: Partial<MediaFile> = {}): MediaFile {
  return {
    contentId: 'c1',
    container: 'mkv',
    resolution: '2160p',
    videoCodec: 'hevc',
    hdr: 'DV',
    bitrateMbps: 60,
    sizeBytes: 1,
    durationSec: 100,
    audio: [],
    subtitles: [],
    chapters: [],
    sightings: [],
    ...over,
  } as MediaFile;
}

const audio = (over: Record<string, unknown> = {}) => ({
  codec: 'ac3',
  channels: 6,
  objectAudio: false,
  isDefault: false,
  ...over,
});

const sub = (over: Record<string, unknown> = {}) => ({
  format: 'hdmv_pgs_subtitle',
  forced: false,
  isDefault: false,
  ...over,
});

describe('mpv track ids', () => {
  test('are 1-based within their own type, not ffprobe stream indices', () => {
    // Stream 3 of a file may be a subtitle; the third AUDIO track is still aid=3.
    assert.equal(mpvTrackId(0), 1);
    assert.equal(mpvTrackId(2), 3);
  });

  test('follow array position, so the list order is the contract', () => {
    const m = media({
      audio: [
        audio({ title: 'TrueHD Atmos 7.1', channels: 8, codec: 'truehd', isDefault: true }),
        audio({ title: 'AC-3 5.1-EX' }),
        audio({ title: 'Commentary by Director John Lasseter', channels: 2 }),
        audio({ title: 'Commentary by Story Artists', channels: 2 }),
      ],
    });
    assert.deepEqual(audioOptions(m).map((o) => o.id), [1, 2, 3, 4]);
  });

  test('subtitles are numbered separately from audio', () => {
    const m = media({
      audio: [audio(), audio()],
      subtitles: [sub({ lang: 'eng' }), sub({ lang: 'fra' })],
    });
    assert.deepEqual(audioOptions(m).map((o) => o.id), [1, 2]);
    assert.deepEqual(subtitleOptions(m).map((o) => o.id), [1, 2]);
  });
});

describe('audio labels', () => {
  test('prefer the disc’s own name over a codec summary', () => {
    const [o] = audioOptions(media({ audio: [audio({ title: 'TrueHD Atmos 7.1', codec: 'truehd', channels: 8 })] }));
    assert.equal(o.label, 'TrueHD Atmos 7.1');
    assert.match(o.detail ?? '', /truehd 7\.1/);
  });

  test('fall back to language, codec and layout when the track is unnamed', () => {
    const [o] = audioOptions(media({ audio: [audio({ lang: 'eng', codec: 'dts', channels: 6 })] }));
    assert.equal(o.label, 'English · dts · 5.1');
  });

  test('say what macOS will really do with an object track', () => {
    // It cannot bitstream TrueHD/Atmos, so the object layer is lost — see §Audio.
    const [o] = audioOptions(media({ audio: [audio({ title: 'Atmos', objectAudio: true })] }));
    assert.match(o.detail ?? '', /decoded to PCM/);
  });

  test('mark commentaries, because picking one by accident is silent', () => {
    const opts = audioOptions(media({
      audio: [audio({ title: 'TrueHD Atmos 7.1' }), audio({ title: 'Commentary by Director John Lasseter' })],
    }));
    assert.deepEqual(opts.map((o) => o.isCommentary), [false, true]);
  });

  test('shorten a track name that is a paragraph', () => {
    const long = 'Commentary by Story Artists Dan Scanlon and Steve Purcell, Directing Animators Bobby Podesta and Jim Murphy, Supervising Animators Scott Clark';
    const [o] = audioOptions(media({ audio: [audio({ title: long })] }));
    assert.ok(o.label.length <= 48, `label was ${o.label.length} chars`);
    assert.ok(o.label.endsWith('…'));
  });

  test('carry the container default through', () => {
    const opts = audioOptions(media({ audio: [audio({ isDefault: true }), audio()] }));
    assert.deepEqual(opts.map((o) => o.isDefault), [true, false]);
  });

  test('channel counts read as layouts', () => {
    const opts = audioOptions(media({
      audio: [audio({ channels: 8 }), audio({ channels: 6 }), audio({ channels: 2 }), audio({ channels: 1 }), audio({ channels: 3 })],
    }));
    assert.deepEqual(opts.map((o) => o.label.split(' · ').pop()), ['7.1', '5.1', 'Stereo', 'Mono', '3ch']);
  });
});

describe('subtitle labels', () => {
  test('the track name is what separates two English tracks', () => {
    // A disc's 25 subtitle tracks otherwise collapse to a list where "English"
    // appears twice and only one of them is SDH.
    const opts = subtitleOptions(media({
      subtitles: [sub({ lang: 'eng', title: 'English' }), sub({ lang: 'eng', title: 'English (SDH)' })],
    }));
    assert.deepEqual(opts.map((o) => o.label), ['English', 'English (SDH)']);
  });

  test('fall back to the language when the track is unnamed', () => {
    const [o] = subtitleOptions(media({ subtitles: [sub({ lang: 'fra' })] }));
    assert.equal(o.label, 'French');
  });

  test('flag forced tracks', () => {
    const [o] = subtitleOptions(media({ subtitles: [sub({ lang: 'eng', forced: true })] }));
    assert.match(o.detail ?? '', /Forced/);
  });
});

describe('languageName', () => {
  test('maps the codes a Blu-ray actually ships', () => {
    assert.equal(languageName('eng'), 'English');
    assert.equal(languageName('FRA'), 'French');
    assert.equal(languageName('zho'), 'Chinese');
  });

  test('an unknown code is shown rather than hidden', () => {
    assert.equal(languageName('qqq'), 'QQQ');
    assert.equal(languageName(undefined), undefined);
  });
});

describe('hasTrackChoice', () => {
  test('one audio track and no subtitles is not a choice', () => {
    assert.equal(hasTrackChoice(media({ audio: [audio()] })), false);
  });

  test('a second audio track is', () => {
    assert.equal(hasTrackChoice(media({ audio: [audio(), audio()] })), true);
  });

  test('so is a single subtitle track, since off is the other option', () => {
    assert.equal(hasTrackChoice(media({ audio: [audio()], subtitles: [sub()] })), true);
  });

  test('a missing media entry is not a crash', () => {
    assert.equal(hasTrackChoice(undefined), false);
  });
});

describe('isCommentary', () => {
  test('catches the wordings discs actually use', () => {
    assert.ok(isCommentary({ title: 'Commentary by Director John Lasseter' }));
    assert.ok(isCommentary({ title: 'Audio Commentary' }));
    assert.ok(isCommentary({ title: 'Isolated Score' }));
    assert.ok(!isCommentary({ title: 'TrueHD Atmos 7.1' }));
    assert.ok(!isCommentary({}));
  });
});
