import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  OVERSCAN_BOTTOM_RATIO,
  OVERSCAN_TOP_PX,
  VIDEO_ASPECT,
  clipInset,
  coverFrame,
  frameOffsetY,
  youTubeId,
} from './trailer-geometry.js';

const aspectOf = (b: { width: number; height: number }) => b.width / b.height;

/** What each edge actually gives up, once the frame is sized and shifted. */
function crops(box: { width: number; height: number }) {
  const frame = coverFrame(box);
  const dy = frameOffsetY(box, frame);
  const overscanY = frame.height - box.height;
  return {
    frame,
    top: overscanY / 2 - dy,
    bottom: overscanY / 2 + dy,
    side: (frame.width - box.width) / 2,
  };
}

// The two surfaces, at the sizes they really render.
const HOVER = { width: 320, height: 180 };
const MODAL = { width: 896, height: 504 };

describe('the trailer frame covers its surface instead of letterboxing', () => {
  test('a 16:9 hover card keeps 16:9', () => {
    assert.ok(Math.abs(aspectOf(coverFrame(HOVER)) - VIDEO_ASPECT) < 1e-9);
  });

  /**
   * The modal regression. `.modal-hero` was `aspect-ratio: 16/9` clamped by a
   * `max-height`, so a wide modal rendered an 864x416 box — 2.08:1. The old
   * `width: 132%; height: 132%` made the IFRAME 2.08:1 as well, so YouTube letterboxed
   * the video inside it and the hero showed black bars.
   */
  test('a letterbox-shaped hero still gets a 16:9 frame', () => {
    assert.ok(Math.abs(aspectOf(coverFrame({ width: 864, height: 416 })) - VIDEO_ASPECT) < 1e-9);
  });

  test('the frame always covers the box, never sits inside it', () => {
    for (const box of [HOVER, MODAL, { width: 864, height: 416 }, { width: 400, height: 700 }, { width: 1200, height: 200 }]) {
      const frame = coverFrame(box);
      assert.ok(frame.width >= box.width - 1e-9, `width covers ${box.width}`);
      assert.ok(frame.height >= box.height - 1e-9, `height covers ${box.height}`);
    }
  });

  test('a zero-sized box does not produce NaN', () => {
    const frame = coverFrame({ width: 0, height: 0 });
    assert.ok(Number.isFinite(frame.width) && Number.isFinite(frame.height));
  });
});

describe('each edge is cropped by the measure that suits what is on it', () => {
  /** YouTube's title bar is a fixed size, so the top crop must be too. */
  test('the top gives up the same PIXELS at every size', () => {
    assert.ok(Math.abs(crops(HOVER).top - OVERSCAN_TOP_PX) < 0.5);
    assert.ok(Math.abs(crops(MODAL).top - OVERSCAN_TOP_PX) < 0.5);
  });

  /**
   * The bug the user found. Burned-in subtitles are authored as a share of the picture,
   * so a fixed 44px cleared them on a 320px hover card and left them showing through
   * the gradient on the modal, where the same 44px is under 5% of the frame.
   */
  test('the bottom gives up the same SHARE at every size', () => {
    for (const box of [HOVER, MODAL]) {
      const c = crops(box);
      const share = c.bottom / c.frame.height;
      assert.ok(
        Math.abs(share - OVERSCAN_BOTTOM_RATIO) < 0.01,
        `${box.width}x${box.height} cropped ${(share * 100).toFixed(1)}% off the bottom`,
      );
    }
  });

  /**
   * Why the old model could not work, stated as arithmetic.
   *
   * A fixed pixel crop is a much smaller SHARE of a big frame than a small one, so one
   * constant cannot clear a proportional band on both surfaces. That is exactly the
   * reported symptom: subtitles gone on the hover card, still showing on the modal.
   */
  test('a single pixel constant cannot clear a proportional band on both surfaces', () => {
    const asShareOf = (box: { width: number; height: number }) =>
      OVERSCAN_TOP_PX / coverFrame(box).height;

    assert.ok(
      asShareOf(MODAL) < asShareOf(HOVER) / 2,
      `44px is ${(asShareOf(MODAL) * 100).toFixed(1)}% of the modal frame but ` +
        `${(asShareOf(HOVER) * 100).toFixed(1)}% of the hover card's`,
    );
    // And the ratio the bottom now uses clears more than the pixel constant managed.
    assert.ok(OVERSCAN_BOTTOM_RATIO > asShareOf(MODAL));
  });

  test('no edge of the box is ever left uncovered by the shift', () => {
    for (const box of [HOVER, MODAL, { width: 1200, height: 200 }, { width: 400, height: 700 }]) {
      const c = crops(box);
      assert.ok(c.top >= -1e-9, `top ${c.top}`);
      assert.ok(c.bottom >= -1e-9, `bottom ${c.bottom}`);
      assert.ok(c.side >= -1e-9, `side ${c.side}`);
    }
  });

  test('no overscan means no shift', () => {
    assert.equal(frameOffsetY({ width: 100, height: 100 }, { width: 100, height: 100 }), 0);
  });
});

describe('the player is clipped to the surface that owns it', () => {
  const rect = { top: 100, right: 500, bottom: 300, left: 100 };

  test('fully inside its container needs no clip', () => {
    assert.equal(clipInset(rect, { top: 0, right: 900, bottom: 900, left: 0 }), null);
  });

  /** Scrolling the modal: the hero slides up past the container's top edge. */
  test('scrolled above the container, the overflow is clipped away', () => {
    const inset = clipInset(rect, { top: 180, right: 900, bottom: 900, left: 0 });
    assert.deepEqual(inset, { top: 80, right: 0, bottom: 0, left: 0 });
  });

  test('clipping applies on every edge', () => {
    const inset = clipInset(rect, { top: 120, right: 480, bottom: 280, left: 130 });
    assert.deepEqual(inset, { top: 20, right: 20, bottom: 20, left: 30 });
  });

  test('no container means no clip', () => {
    assert.equal(clipInset(rect, null), null);
  });
});

describe('youTubeId', () => {
  test('reads watch, short and embed urls', () => {
    assert.equal(youTubeId('https://www.youtube.com/watch?v=dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
    assert.equal(youTubeId('https://youtu.be/dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
    assert.equal(youTubeId('https://www.youtube.com/embed/dQw4w9WgXcQ?rel=0'), 'dQw4w9WgXcQ');
  });

  test('anything else is not a trailer', () => {
    assert.equal(youTubeId(undefined), null);
    assert.equal(youTubeId('https://vimeo.com/12345'), null);
  });
});
