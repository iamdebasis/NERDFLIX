/**
 * Geometry for the shared trailer player.
 *
 * Pure and React-free on purpose: this is where the trailer surface's real bugs
 * lived, and none of them were visible from reading the component. Keeping the
 * arithmetic here means they are covered by `pnpm test` rather than by eyeballing a
 * rendered frame.
 */

/** Every YouTube embed plays 16:9. Anything else is the player letterboxing itself. */
export const VIDEO_ASPECT = 16 / 9;

/**
 * How much is cropped off the TOP, in CSS pixels.
 *
 * This edge carries YouTube's title bar, which is drawn at a roughly FIXED size
 * regardless of how large the player is. A percentage would under-crop a small hover
 * card and over-crop a large modal, which is exactly what `132%` used to do.
 */
export const OVERSCAN_TOP_PX = 44;

/**
 * How much is cropped off the BOTTOM, as a FRACTION of the frame's height.
 *
 * A different quantity measured a different way, and treating it like the top edge was
 * a mistake worth spelling out. This edge carries whatever the trailer burned into
 * itself — subtitles, distributor bugs — and those are authored as a proportion of the
 * picture, not in pixels. A fixed 44px cleared them on a small hover card and left them
 * showing through the gradient on a large modal, where 44px is under 5% of the frame.
 *
 * A ratio clears the same band of PICTURE at every size, which is the thing that
 * actually needs to go.
 */
export const OVERSCAN_BOTTOM_RATIO = 0.1;

export type Box = { width: number; height: number };
export type Edges = { top: number; right: number; bottom: number; left: number };

/**
 * The iframe box that fills `box` with 16:9 video, no letterboxing, and enough margin
 * on each edge to crop what has to go.
 *
 * The bug this fixes: the host box is NOT 16:9. `.modal-hero` was `aspect-ratio: 16/9`
 * clamped by a `max-height`, so a wide modal rendered about 2.08:1 — and an iframe
 * sized as a percentage of that box was 2.08:1 too, so YouTube letterboxed the video
 * inside it and the hero showed black bars.
 *
 * Height solves `h = (boxHeight + top) + ratio * h`, because the bottom margin is a
 * share of the result rather than a constant.
 */
export function coverFrame(
  box: Box,
  topPx = OVERSCAN_TOP_PX,
  bottomRatio = OVERSCAN_BOTTOM_RATIO,
): Box {
  const boxW = Math.max(0, box.width);
  const boxH = Math.max(0, box.height);

  let height = (boxH + topPx) / (1 - bottomRatio);
  let width = height * VIDEO_ASPECT;

  // A very wide, short box is driven by its width instead; it is then taller than the
  // margins asked for, which only means cropping more than the minimum.
  if (width < boxW) {
    width = boxW;
    height = width / VIDEO_ASPECT;
  }
  return { width, height };
}

/**
 * How far to shift the frame so each edge gives up the right amount.
 *
 * Centred, both edges lose the same. Positive moves the frame DOWN, which takes less
 * off the top and more off the bottom — the split these two constants describe.
 */
export function frameOffsetY(box: Box, frame: Box, topPx = OVERSCAN_TOP_PX): number {
  const overscanY = frame.height - box.height;
  if (overscanY <= 0) return 0;
  // Never shift so far that an edge of the box is left uncovered.
  const dy = Math.max(-overscanY / 2, Math.min(overscanY / 2, overscanY / 2 - topPx));
  return dy === 0 ? 0 : dy;
}

/**
 * How far the player must be clipped on each edge to stay inside `clip`.
 *
 * The player is `position: fixed` at the document root so it can move between the
 * hover card and the modal without remounting, which also means it is not clipped by
 * either of them. Scrolling the modal moved the hero out of view while the video
 * carried on drawing over everything — the "detached" part of the report.
 */
export function clipInset(rect: Edges, clip: Edges | null): Edges | null {
  if (!clip) return null;
  const inset = {
    top: Math.max(0, clip.top - rect.top),
    right: Math.max(0, rect.right - clip.right),
    bottom: Math.max(0, rect.bottom - clip.bottom),
    left: Math.max(0, clip.left - rect.left),
  };
  const any = inset.top || inset.right || inset.bottom || inset.left;
  return any ? inset : null;
}

/** Pull the 11-character id out of any of YouTube's URL shapes. */
export function youTubeId(url: string | undefined): string | null {
  if (!url) return null;
  const m = url.match(/(?:v=|youtu\.be\/|embed\/)([A-Za-z0-9_-]{11})/);
  return m ? m[1] : null;
}
