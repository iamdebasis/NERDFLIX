import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

/**
 * How far through a film is, for the red bar on a card.
 *
 * This lived in the renderer and was derived from `runtimeMinutes`, which is a PROXY
 * for the duration: whole minutes, absent until a title is enriched, and 0 for
 * anything under thirty seconds. The bar's condition treated 0 as falsy, so it
 * silently disappeared rather than showing 0%. Both the position and the true duration
 * are recorded together in state, so the percentage belongs there.
 */
function resumePct(p: { positionSec: number; durationSec: number } | null): number | null {
  if (!p || p.durationSec <= 0) return null;
  return Math.min(100, Math.max(0, (p.positionSec / p.durationSec) * 100));
}

describe('resume percentage', () => {
  test('is computed from the real duration', () => {
    assert.equal(resumePct({ positionSec: 2, durationSec: 5 }), 40);
    assert.equal(resumePct({ positionSec: 4260, durationSec: 8520 }), 50);
  });

  test('survives a title with no runtime metadata', () => {
    // The regression: a short or unenriched title has runtimeMinutes 0, which the old
    // renderer check treated as "no progress" and hid the bar entirely.
    assert.equal(resumePct({ positionSec: 12, durationSec: 24 }), 50);
  });

  test('never exceeds the bar, whatever the state says', () => {
    assert.equal(resumePct({ positionSec: 9999, durationSec: 100 }), 100);
    assert.equal(resumePct({ positionSec: -5, durationSec: 100 }), 0);
  });

  test('is null when there is nothing to show, not zero', () => {
    // null hides the bar; 0 would draw an empty track on every unwatched film.
    assert.equal(resumePct(null), null);
    assert.equal(resumePct({ positionSec: 10, durationSec: 0 }), null);
  });
});

/**
 * Reading playback status too early reports a blank player as fact.
 *
 * With IINA the socket appears when its mpv starts, which can be before it has opened
 * anything — so a single read returned 0x0, no codec and "audio device did not open",
 * and the status block printed all of it confidently. Properties populate
 * asynchronously; retrying is cheap, printing a confident lie is not.
 */
async function readWithRetry<T>(
  source: () => Promise<T | null>,
  tries = 5,
): Promise<T | null> {
  for (let i = 0; i < tries; i++) {
    const v = await source().catch(() => null);
    if (v !== null && v !== undefined) return v;
  }
  return null;
}

describe('status reads tolerate a file that is not open yet', () => {
  test('retries until the property populates', async () => {
    let calls = 0;
    const width = async () => (++calls < 3 ? null : 3840);
    assert.equal(await readWithRetry(width), 3840);
    assert.equal(calls, 3);
  });

  test('gives up rather than hanging, and reports nothing known', async () => {
    assert.equal(await readWithRetry(async () => null, 3), null);
  });

  test('a throwing read is treated as not-ready, not fatal', async () => {
    let calls = 0;
    const flaky = async () => {
      if (++calls < 2) throw new Error('property unavailable');
      return 'hevc';
    };
    assert.equal(await readWithRetry(flaky), 'hevc');
  });
});

/**
 * Trailer ids come from TMDB as full YouTube URLs, in more than one shape.
 * A wrong id is a silent black box over the artwork, so parsing is worth pinning.
 */
function youTubeId(url: string | undefined): string | null {
  if (!url) return null;
  const m = url.match(/(?:v=|youtu\.be\/|embed\/)([A-Za-z0-9_-]{11})/);
  return m ? m[1] : null;
}

describe('trailer id parsing', () => {
  test('reads the watch URL TMDB stores', () => {
    assert.equal(youTubeId('https://www.youtube.com/watch?v=dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
  });

  test('and the short and embed forms', () => {
    assert.equal(youTubeId('https://youtu.be/dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
    assert.equal(youTubeId('https://www.youtube.com/embed/dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
  });

  test('survives extra query parameters', () => {
    assert.equal(youTubeId('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=30s'), 'dQw4w9WgXcQ');
  });

  test('ids with underscores and hyphens are not truncated', () => {
    assert.equal(youTubeId('https://www.youtube.com/watch?v=a_b-C1d2E3F'), 'a_b-C1d2E3F');
  });

  test('returns null rather than a broken embed', () => {
    // No trailer, or something unparseable, must fall back to the backdrop.
    assert.equal(youTubeId(undefined), null);
    assert.equal(youTubeId('https://vimeo.com/12345'), null);
    assert.equal(youTubeId('https://www.youtube.com/watch?v=tooshort'), null);
  });
});
