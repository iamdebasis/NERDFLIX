/**
 * How large to draw the interface for the window it is in.
 *
 * The UI was designed and checked on a 16" MacBook Pro, 1728 points wide, so that
 * screen stays exactly as drawn. On a
 * bigger window it used to stay that size and float in the middle of a sea of black.
 * Reported on a 27" 2560×1440 monitor: the detail view took a third of the width,
 * where Netflix's takes about half. So the whole page is scaled with the window,
 * by Chromium's own zoom. That is one knob for everything: rem, px, and the
 * geometry the renderer computes in JS (hover-card placement, the trailer frame's
 * crop). Scaling fonts alone would have left every px value and every JS measurement
 * behind. Text and icons are re-rasterised at the new size, not stretched.
 *
 * - Width sets the scale; height only limits it. The page is never scaled so far that
 *   fewer than HEIGHT_FLOOR points of it remain, so an ultrawide or a short window
 *   cannot scale past what fits. The laptop, 1084 high, is well above the floor.
 * - Never below 1: a small window gets the design as drawn, which already fits
 *   `minWidth`.
 * - Rounded to 0.05, so dragging a window edge does not re-lay out the page on every
 *   pixel.
 * - Capped at 3 for a 4K TV at 1× (3840 wide), which would otherwise go further.
 *
 * Content-area sizes in points: 16" MacBook Pro maximised (Dock hidden), 1728×1084 → 1.0.
 * 27" 2560×1440 monitor maximised, 2560×1415 → 1.45; full screen → 1.5. 4K TV set to
 * "looks like 1080p", 1920×1055 → 1.1. 4K TV at native resolution → 2.2.
 *
 * The first version took a 14" MacBook Pro (1512×945) as the reference. The machine it
 * is actually tested on is the 16", so a maximised window there would have grown 15%
 * with nobody asking. Found by launching the built app, before it shipped.
 */

export const DESIGN_WIDTH = 1728;
export const HEIGHT_FLOOR = 960;
export const MAX_SCALE = 3;
const STEP = 0.05;

export function uiScaleFor(width: number, height: number): number {
  const raw = Math.min(width / DESIGN_WIDTH, height / HEIGHT_FLOOR);
  const clamped = Math.min(MAX_SCALE, Math.max(1, raw));
  return Math.round(Math.round(clamped / STEP) * STEP * 100) / 100;
}

/**
 * Where the traffic lights go at a given scale.
 *
 * They are native and do not zoom with the page. Left where they were designed
 * (20, 20), they drift up and away from the nav as it grows, sitting visibly above the
 * wordmark on a big screen. So the cluster's CENTRE is kept at the point it occupies
 * in the design, scaled.
 */
const LIGHTS = { x: 20, y: 20, size: 14 };

export function trafficLightsFor(scale: number): { x: number; y: number } {
  const half = LIGHTS.size / 2;
  return {
    x: Math.round(LIGHTS.x * scale),
    y: Math.round((LIGHTS.y + half) * scale - half),
  };
}

/** A usable override from the environment (`NFL_UI_SCALE=1.5`), or null. */
export function scaleOverride(value: string | undefined): number | null {
  const n = Number(value);
  return value && Number.isFinite(n) && n >= 0.5 && n <= MAX_SCALE ? n : null;
}
