import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  HERO_SETTLE_MS,
  HERO_VISIBLE_RATIO,
  buildHeroQueue,
  didTrailerLoop,
  heroTrailerVerdict,
  nextHeroIndex,
} from './hero-trailer.js';
import { youTubeEmbedUrl } from './youtube.js';

const ready = {
  hasUrl: true,
  settled: true,
  onScreen: true,
  suspended: false,
  documentHidden: false,
  online: true,
  canPause: true,
};

describe('the hero billboard plays only when all of it is true', () => {
  test('everything ready means play', () => {
    assert.deepEqual(heroTrailerVerdict(ready), { mount: true, play: true, reason: 'playing' });
  });

  test('a title with no trailer never starts', () => {
    assert.deepEqual(heroTrailerVerdict({ ...ready, hasUrl: false }), {
      mount: false,
      play: false,
      reason: 'no-trailer',
    });
  });

  test('it waits out the settle delay', () => {
    assert.deepEqual(heroTrailerVerdict({ ...ready, settled: false }), {
      mount: false,
      play: false,
      reason: 'waiting',
    });
  });

  test('offline it never mounts, because a blocked frame still fires load', () => {
    assert.equal(heroTrailerVerdict({ ...ready, online: false }).mount, false);
  });

  /**
   * The one that would read as a bug rather than a quirk: playback happens in mpv's own
   * window, so this one stays open behind it. A billboard talking over the film is
   * exactly the fault that was fixed for the preview player.
   */
  test('a film playing outranks everything else', () => {
    for (const also of [
      { settled: false },
      { onScreen: false },
      { documentHidden: true },
      { online: false },
      { canPause: false },
    ]) {
      const v = heroTrailerVerdict({ ...ready, ...also, suspended: true });
      assert.equal(v.reason, 'film-playing', `suspension wins over ${JSON.stringify(also)}`);
      assert.equal(v.mount, false, 'and it lets the frame go entirely');
    }
  });

  test('having no trailer outranks even that — there is nothing to stop', () => {
    assert.equal(heroTrailerVerdict({ ...ready, hasUrl: false, suspended: true }).reason, 'no-trailer');
  });
});

describe('scrolling away pauses rather than restarts', () => {
  /**
   * The reported bug. Scrolling down used to remove the frame, so scrolling back began
   * the trailer again from zero. If the player answers us we can simply stop it where
   * it is and pick up from there.
   */
  test('off screen, the frame STAYS so its position is kept', () => {
    assert.deepEqual(heroTrailerVerdict({ ...ready, onScreen: false }), {
      mount: true,
      play: false,
      reason: 'off-screen',
    });
  });

  test('coming back on screen plays again', () => {
    assert.equal(heroTrailerVerdict({ ...ready, onScreen: true }).play, true);
  });

  test('a hidden window pauses the same way', () => {
    assert.deepEqual(heroTrailerVerdict({ ...ready, documentHidden: true }), {
      mount: true,
      play: false,
      reason: 'window-hidden',
    });
  });

  /**
   * Without a channel there is no way to say "stop". Leaving it mounted would keep it
   * streaming for a surface nobody can see, so the frame has to go — and coming back
   * costs a reload, which `start=` then makes nearly invisible.
   */
  test('with no control channel it must let the frame go instead', () => {
    assert.equal(heroTrailerVerdict({ ...ready, onScreen: false, canPause: false }).mount, false);
    assert.equal(heroTrailerVerdict({ ...ready, documentHidden: true, canPause: false }).mount, false);
  });

  test('but a dead channel changes nothing while it is on screen', () => {
    assert.equal(heroTrailerVerdict({ ...ready, canPause: false }).play, true);
  });
});

describe('the constants stay sane', () => {
  test('the settle delay is a pause, not a stall', () => {
    assert.ok(HERO_SETTLE_MS >= 2000 && HERO_SETTLE_MS <= 10000);
  });
  test('the visibility threshold is a real fraction of the hero', () => {
    assert.ok(HERO_VISIBLE_RATIO > 0 && HERO_VISIBLE_RATIO < 1);
  });
});

describe('the embed url', () => {
  const id = 'dQw4w9WgXcQ';
  test('resumes where a forced reload interrupted it', () => {
    assert.ok(youTubeEmbedUrl(id, { muted: true, startAt: 42.7 }).includes('start=42'));
  });
  test('and says nothing about start when there is nothing to resume', () => {
    assert.ok(!youTubeEmbedUrl(id, { muted: true }).includes('start='));
    assert.ok(!youTubeEmbedUrl(id, { muted: true, startAt: 0 }).includes('start='));
  });
  test('loops a single-item playlist, or the end shows a grid of suggestions', () => {
    const u = youTubeEmbedUrl(id, { muted: true });
    assert.ok(u.includes('loop=1'));
    assert.ok(u.includes(`playlist=${id}`));
  });
  test('autoplays muted, because Chromium blocks audible autoplay', () => {
    assert.ok(youTubeEmbedUrl(id, { muted: true }).includes('mute=1'));
    assert.ok(youTubeEmbedUrl(id, { muted: false }).includes('mute=0'));
  });
  test('uses the no-cookie host the CSP allows', () => {
    assert.ok(youTubeEmbedUrl(id, { muted: true }).startsWith('https://www.youtube-nocookie.com/embed/'));
  });
});

describe('the billboard rotates through Recently Added', () => {
  test('it walks the row in order and wraps', () => {
    const q = ['a', 'b', 'c'];
    let i = 0;
    const seen = [q[i]];
    for (let n = 0; n < 4; n += 1) {
      i = nextHeroIndex(i, q.length);
      seen.push(q[i]);
    }
    assert.deepEqual(seen, ['a', 'b', 'c', 'a', 'b'], 'loops rather than stopping');
  });

  test('an empty queue cannot divide by zero', () => {
    assert.equal(nextHeroIndex(0, 0), 0);
    assert.equal(nextHeroIndex(5, 0), 0);
  });

  test('a single title just stays put', () => {
    assert.equal(nextHeroIndex(0, 1), 0);
  });

  /** A hero with no artwork is a blank rectangle with text on it. */
  test('titles without artwork are skipped, order otherwise preserved', () => {
    const art = new Set(['a', 'c', 'd']);
    assert.deepEqual(buildHeroQueue(['a', 'b', 'c', 'd'], (id) => art.has(id)), ['a', 'c', 'd']);
  });

  test('nothing eligible gives an empty rotation rather than throwing', () => {
    assert.deepEqual(buildHeroQueue(['a', 'b'], () => false), []);
  });
});

describe('finishing is detected as the loop wrapping', () => {
  /**
   * The embed keeps `loop=1` so an ended video never shows YouTube's grid of suggested
   * thumbnails. That means the end is never reached, so the signal is the playhead
   * jumping backwards from near the end.
   */
  test('a wrap from the end counts', () => {
    assert.equal(didTrailerLoop(144.8, 0.2, 145.3), true);
  });

  /**
   * The one that bit. Reports arrive a few times a second, so the first one after the
   * loop restarts is routinely a second or three in, not zero. Requiring "back to the
   * start" missed the wrap and the billboard never advanced.
   */
  test('and so does a wrap whose first report lands a few seconds in', () => {
    assert.equal(didTrailerLoop(138.6, 2.4, 139), true);
    assert.equal(didTrailerLoop(138.6, 5.1, 139), true);
  });

  test('ordinary playback does not', () => {
    assert.equal(didTrailerLoop(40.1, 40.6, 145.3), false);
    assert.equal(didTrailerLoop(0.2, 0.7, 145.3), false);
  });

  test('a seek back to the start from the middle is not a wrap', () => {
    assert.equal(didTrailerLoop(70, 0.3, 145.3), false, 'nowhere near the end');
  });

  test('but not a jump into the second half — that is a seek, not a loop', () => {
    assert.equal(didTrailerLoop(138.6, 90, 139), false);
  });

  test('without a duration, any big jump back from near-zero counts', () => {
    assert.equal(didTrailerLoop(88, 0.4, undefined), true);
    assert.equal(didTrailerLoop(88, 40, undefined), false, 'landed mid-video, not a wrap');
  });

  test('a tiny stutter backwards is not a wrap', () => {
    assert.equal(didTrailerLoop(1.4, 0.9, 145.3), false);
  });
});
