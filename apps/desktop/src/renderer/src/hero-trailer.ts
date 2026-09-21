/**
 * When the hero billboard is allowed to play, expressed as data.
 *
 * Five separate conditions can each stop it, they arrive from five different places —
 * a timer, an IntersectionObserver, the shared player's suspension latch, the document's
 * visibility, the network — and getting any one of them wrong means either a video
 * nobody can see still pulling bandwidth, or a billboard that silently never starts.
 * Pure and tested rather than five `&&`s buried in an effect.
 */

export type HeroConditions = {
  /** The title has a trailer at all. */
  hasUrl: boolean;
  /** The settle delay has elapsed since the surface appeared. */
  settled: boolean;
  /** Enough of the hero is in the viewport to be worth playing. */
  onScreen: boolean;
  /** A film is starting or playing — see the shared player's suspension latch. */
  suspended: boolean;
  /** The window is minimised or behind something. */
  documentHidden: boolean;
  online: boolean;
  /**
   * Whether the player answers us.
   *
   * This is the difference between pausing and tearing down. YouTube's postMessage
   * channel needs a real page origin to reply to; a dev renderer is served over http
   * and answers, a packaged one is `file://` with a null origin and never will. When
   * it answers we can pause and keep our place. When it does not, the only way to stop
   * the download is to remove the frame, and coming back costs a reload.
   */
  canPause: boolean;
  /**
   * The trailer has finished and the billboard is holding on its artwork before
   * handing over. A beat of stillness, not a dead moment — see HERO_OUTRO_MS.
   */
  outro: boolean;
};

export type HeroReason =
  | 'playing'
  | 'no-trailer'
  | 'waiting'
  | 'outro'
  | 'off-screen'
  | 'film-playing'
  | 'window-hidden'
  | 'offline';

export type HeroVerdict = {
  /** Whether the iframe should exist. Removing it is what stops the download. */
  mount: boolean;
  /** Whether it should be playing rather than sitting paused where it was. */
  play: boolean;
  reason: HeroReason;
};

/**
 * Order matters, and it is the order of severity rather than of evaluation cost.
 *
 * The first four are terminal: there is nothing to keep, so the frame goes. The last
 * two are pauses — the billboard is coming back, and it should come back where it was
 * rather than at the beginning, so the frame stays IF the player will take a pause
 * command. That split is the whole design.
 */
export function heroTrailerVerdict(c: HeroConditions): HeroVerdict {
  if (!c.hasUrl) return { mount: false, play: false, reason: 'no-trailer' };
  // A film playing outranks everything: the billboard must not talk over it, and that
  // is the one failure a person would call a bug rather than a quirk.
  if (c.suspended) return { mount: false, play: false, reason: 'film-playing' };
  if (!c.online) return { mount: false, play: false, reason: 'offline' };
  if (!c.settled) return { mount: false, play: false, reason: 'waiting' };
  /*
   * Holding on the artwork before the hand-over. The frame STAYS, paused: tearing it
   * down here would cost a reload for the two seconds before it is discarded anyway,
   * and a frame disappearing mid-fade is exactly the flicker this phase exists to
   * avoid.
   */
  if (c.outro) return { mount: true, play: false, reason: 'outro' };
  if (c.documentHidden) return { mount: c.canPause, play: false, reason: 'window-hidden' };
  if (!c.onScreen) return { mount: c.canPause, play: false, reason: 'off-screen' };
  return { mount: true, play: true, reason: 'playing' };
}

/**
 * How long the artwork holds before the billboard comes to life.
 *
 * Long enough that arriving on the page is a still image — you see the poster art, read
 * the title, and the motion is a reward rather than a surprise. Netflix sits around
 * here too. Shorter feels twitchy; much longer and nobody ever sees it.
 */
export const HERO_SETTLE_MS = 5000;

/**
 * How much of the hero has to be visible before it is worth playing.
 *
 * Not 0: a sliver of billboard at the top of the screen while you read the rows below
 * is not something anyone is watching, and it would keep a video stream open for it.
 */
export const HERO_VISIBLE_RATIO = 0.35;

/**
 * How long a billboard holds when nothing will tell us the trailer finished.
 *
 * Two different situations, two different numbers:
 *
 *  - **No trailer at all.** Nothing is going to end, so the rotation would stall on a
 *    still image forever. It moves on after a reasonable look.
 *  - **A trailer playing, but the player will not talk to us.** A packaged renderer is
 *    `file://`, whose origin is null, so YouTube has nowhere to send events. Cutting a
 *    trailer off early is worse than holding it a little long, so this is generous —
 *    longer than most trailers run.
 */
/**
 * How long the billboard rests on its own artwork after the trailer finishes, before
 * handing over to the next film.
 *
 * Without it the cut from a moving frame straight into a different film reads as a
 * glitch — two unrelated images with nothing between them. Landing back on the still
 * you started from closes the loop, and gives the cross-dissolve something calm to
 * begin from. Long enough to register, short enough not to feel like a stall.
 */
export const HERO_OUTRO_MS = 2000;

/**
 * How long one billboard dissolves into the next.
 *
 * Slow enough to read as a deliberate scene change rather than a cut, short enough
 * that the new film's artwork is settled before its own hold begins.
 */
export const HERO_DISSOLVE_MS = 900;

export const HERO_NO_TRAILER_DWELL_MS = 20_000;
export const HERO_FALLBACK_DWELL_MS = 150_000;

/**
 * Did the trailer just finish?
 *
 * Detected as the loop WRAPPING rather than as an end event, and that is deliberate.
 * The embed keeps `loop=1`, because an ended YouTube video shows a grid of suggested
 * videos and the billboard would be showing someone else's thumbnails. Looping means
 * the end is never reached — so the signal is the playhead jumping backwards.
 *
 * `duration` is only used to rule out a seek: a jump back from near the end is a loop,
 * a jump back from the middle is not. When the duration is unknown, any large jump
 * backwards counts, which is the best that can be said without it.
 */
export function didTrailerLoop(prev: number, now: number, duration?: number): boolean {
  if (prev <= 1) return false;
  if (prev - now < 2) return false; // forwards, or a stutter

  if (duration && duration > 0) {
    /*
     * Near the end, then somewhere in the first half. The landing point is NOT assumed
     * to be zero: reports arrive a few times a second, and the first one after a loop
     * restart is routinely a second or three in — so testing for "back to the start"
     * missed the wrap entirely and the billboard never advanced.
     */
    return prev >= duration - 3 && now < duration / 2;
  }
  // Without a duration, only a jump to the very beginning is safe to call a loop.
  return now <= 1.5;
}

/**
 * The billboard rotation, in the order the "Recently Added" row shows.
 *
 * Titles without a backdrop are skipped rather than shown: a hero with no artwork is a
 * blank rectangle with text on it, which reads as broken rather than as minimal. That
 * filter is the one part of the old selection worth keeping.
 */
export function buildHeroQueue(
  orderedIds: string[],
  eligible: (id: string) => boolean,
): string[] {
  return orderedIds.filter(eligible);
}

/** Round the loop. Separate only so the wrap at the end is covered by a test. */
export function nextHeroIndex(current: number, length: number): number {
  if (length <= 0) return 0;
  return (current + 1) % length;
}
