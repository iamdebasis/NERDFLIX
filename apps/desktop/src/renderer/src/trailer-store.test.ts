import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';
import {
  RELEASE_GRACE_MS,
  __resetTrailerStore,
  claimTrailer,
  getTarget,
  isSuspended,
  releaseTrailerSoon,
  resumeTrailer,
  subscribe,
  suspendTrailer,
  type Target,
  type TrailerSurface,
} from './trailer-store.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const box = (left: number, top: number, width: number, height: number) => ({
  left,
  top,
  width,
  height,
  right: left + width,
  bottom: top + height,
});

function target(key: string, surface: TrailerSurface, left = 0): Target {
  return {
    key,
    surface,
    url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    title: 'A Film',
    rect: box(left, 100, 320, 180),
    clip: null,
    radius: surface === 'modal' ? '8px 8px 0 0' : '6px',
    delayMs: surface === 'modal' ? 400 : 1200,
  };
}

afterEach(() => __resetTrailerStore());

describe('hover → modal is a move, never a reload', () => {
  /**
   * The reported bug, as a sequence.
   *
   * Watch a trailer on the hover card for a while, click to expand, and it began again
   * from zero. The cause was ordering, not rendering: React runs the unmounting hover
   * card's cleanup BEFORE the modal's effect, and the modal only starts a frame loop —
   * it does not claim until the next frame. The player was therefore unowned for a
   * frame, the host rendered nothing, and the iframe was destroyed and remounted.
   */
  test('the player is never unowned during a handover', async () => {
    const seen: (string | null)[] = [];
    subscribe(() => seen.push(getTarget() ? `${getTarget()!.key}:${getTarget()!.surface}` : null));

    claimTrailer(target('dune', 'hover'));
    // The hover card unmounts. Its cleanup runs first.
    releaseTrailerSoon();
    // The modal's frame loop claims one frame later.
    await sleep(16);
    claimTrailer(target('dune', 'modal'));
    // Well past the release grace.
    await sleep(RELEASE_GRACE_MS + 80);

    assert.equal(getTarget()?.surface, 'modal', 'the modal ends up holding it');
    assert.ok(!seen.includes(null), `player was never released, saw: ${JSON.stringify(seen)}`);
  });

  test('releasing immediately is what used to break it', async () => {
    // The old behaviour, for contrast: release at once and the gap is real.
    claimTrailer(target('dune', 'hover'));
    claimTrailer(null);
    assert.equal(getTarget(), null, 'this is the frame that destroyed the iframe');
  });

  /**
   * The case the identity guard could not see.
   *
   * StrictMode runs every effect twice in development — setup, cleanup, setup — so the
   * modal schedules a release for ITSELF between its two mounts, and then re-claims
   * under exactly the identity that release was waiting for. "Release only if still
   * ours" therefore said yes and destroyed the live player, which is why expanding a
   * card kept starting the trailer over even after the gap was closed.
   */
  test('StrictMode running the modal effect twice does not kill the player', async () => {
    const seen: (string | null)[] = [];
    subscribe(() => seen.push(getTarget() ? `${getTarget()!.key}:${getTarget()!.surface}` : null));

    claimTrailer(target('dune', 'hover')); // watching on the hover card
    releaseTrailerSoon(); // the card unmounts as the modal opens

    // Modal effect: setup, then StrictMode's immediate teardown. Its frame loop is
    // cancelled before it ever fires, so the only thing that happened is a release.
    releaseTrailerSoon();

    // Second setup. Its frame loop claims on the next frame — same key, same surface.
    await sleep(16);
    claimTrailer(target('dune', 'modal'));

    await sleep(RELEASE_GRACE_MS + 80);
    assert.equal(getTarget()?.surface, 'modal', 'the modal still holds the player');
    assert.ok(!seen.includes(null), `never unowned, saw: ${JSON.stringify(seen)}`);
  });

  test('a genuine dismissal still releases', async () => {
    claimTrailer(target('dune', 'hover'));
    releaseTrailerSoon();
    assert.ok(getTarget() !== null, 'not instantly — the grace has to elapse');
    await sleep(RELEASE_GRACE_MS + 80);
    assert.equal(getTarget(), null);
  });

  test('a release cannot steal the player from whoever claimed next', async () => {
    claimTrailer(target('dune', 'hover'));
    releaseTrailerSoon();
    claimTrailer(target('arrival', 'hover'));
    await sleep(RELEASE_GRACE_MS + 80);
    assert.equal(getTarget()?.key, 'arrival', 'the newer claim survives the older release');
  });

  test('moving between two tiles still releases the one left behind', async () => {
    claimTrailer(target('dune', 'hover'));
    releaseTrailerSoon();
    await sleep(RELEASE_GRACE_MS + 80);
    assert.equal(getTarget(), null);
  });
});

describe('starting a film silences the trailer', () => {
  test('suspending drops the player at once', () => {
    claimTrailer(target('dune', 'modal'));
    suspendTrailer();
    assert.equal(getTarget(), null);
    assert.ok(isSuspended());
  });

  test('and the frame loop cannot claim it straight back', () => {
    claimTrailer(target('dune', 'modal'));
    suspendTrailer();
    claimTrailer(target('dune', 'modal'));
    assert.equal(getTarget(), null, 'a latch, not a one-off release');
  });

  /** Otherwise a release still in flight fires later and undoes the suspension. */
  test('a pending release cannot resurrect anything after a suspension', async () => {
    claimTrailer(target('dune', 'hover'));
    releaseTrailerSoon();
    suspendTrailer();
    await sleep(RELEASE_GRACE_MS + 80);
    assert.equal(getTarget(), null);
    assert.ok(isSuspended(), 'still suspended');
  });

  test('resuming lets the next surface attach', () => {
    suspendTrailer();
    resumeTrailer();
    claimTrailer(target('dune', 'hover'));
    assert.equal(getTarget()?.key, 'dune');
  });
});

describe('claims do not churn', () => {
  test('re-claiming the same box on the same surface notifies nobody', () => {
    let notifications = 0;
    subscribe(() => notifications++);
    claimTrailer(target('dune', 'hover'));
    const first = notifications;
    // The frame loop re-claims every frame with an identical box.
    claimTrailer(target('dune', 'hover'));
    claimTrailer(target('dune', 'hover'));
    assert.equal(notifications, first, 'an unchanged claim is not a change');
  });

  test('but a moved box does notify, so the player tracks it', () => {
    let notifications = 0;
    subscribe(() => notifications++);
    claimTrailer(target('dune', 'hover', 0));
    const first = notifications;
    claimTrailer(target('dune', 'hover', 40));
    assert.ok(notifications > first, 'scrolling must move the player');
  });
});
