/**
 * Who owns the shared trailer player, and when it is let go.
 *
 * Split out of the component and kept React-free because the bugs here are about
 * ORDERING, not rendering, and ordering bugs are invisible in a screenshot. The
 * handover from the hover card to the detail modal in particular is a sequence of
 * mount, unmount and frame callbacks that no amount of looking at the UI explains —
 * it just silently restarts the video. `pnpm test` can hold it still.
 */

export type TrailerSurface = 'hover' | 'modal';

/** Structural, so a test can describe a box without a DOM. */
export type Rect = Pick<DOMRect, 'top' | 'left' | 'right' | 'bottom' | 'width' | 'height'>;

export type Target = {
  /** Identifies the title, so moving between surfaces for the SAME film does not reload. */
  key: string;
  /** Which surface is holding it. A change here is a handover, and animates. */
  surface: TrailerSurface;
  url: string;
  title: string;
  rect: Rect;
  /** The owning container's box, in viewport coordinates, or null for the viewport. */
  clip: Rect | null;
  /** Corner rounding to match the surface underneath. A CSS border-radius value. */
  radius: string;
  delayMs: number;
};

let current: Target | null = null;
/**
 * Bumped by every claim that actually changes something.
 *
 * This, and NOT the key or the surface, is what says whether a pending release is
 * still entitled to fire. See `releaseTrailerSoon`.
 */
let claimSeq = 0;
const listeners = new Set<() => void>();
let suspended = false;
let activate: (() => void) | null = null;

function emit() {
  listeners.forEach((fn) => fn());
}

function sameRect(a: Rect | null, b: Rect | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.top === b.top && a.left === b.left && a.width === b.width && a.height === b.height;
}

export function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => void listeners.delete(fn);
}

export function getTarget(): Target | null {
  return current;
}

/** Claim the player. Called continuously while a surface wants it. */
export function claimTrailer(t: Target | null): void {
  if (suspended && t !== null) return;
  const same =
    current?.key === t?.key &&
    current?.surface === t?.surface &&
    sameRect(current?.rect ?? null, t?.rect ?? null) &&
    sameRect(current?.clip ?? null, t?.clip ?? null);
  if (same) return;
  current = t;
  claimSeq += 1;
  emit();
}

/**
 * Let go a beat late, so a handover is never a gap.
 *
 * THIS IS WHAT RESTARTED THE TRAILER ON EXPAND. Releasing the moment the hover card
 * unmounts looks safe, and the old code even guarded it with "release only if still
 * ours" — but the guard cannot help, because at that instant it IS still ours. React
 * runs an unmounting component's cleanup BEFORE the newly mounted one's effect, and the
 * modal's effect only starts a frame loop; it does not claim until the next frame.
 *
 * So the target went null for a frame, the host rendered nothing, and the iframe was
 * destroyed. The modal then mounted a fresh one, which is a fresh load: back to zero,
 * after you had been watching for a minute.
 *
 * Deferring closes that gap. Whoever claims in the meantime wins, and the pending
 * release finds the player no longer its own and does nothing.
 */
export const RELEASE_GRACE_MS = 120;
let releaseTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Entitlement is a TOKEN, not an identity.
 *
 * The obvious guard — "release only if the current owner is still the one I was
 * scheduled for" — compares key and surface, and it is wrong in a way that took a
 * while to see. React's StrictMode runs every effect twice in development: setup,
 * cleanup, setup. So a modal mounting does this:
 *
 *   1. hover card unmounts        -> schedules a release
 *   2. modal effect runs          -> starts a frame loop
 *   3. StrictMode tears it down   -> schedules a release for (title, MODAL)
 *   4. modal effect runs again    -> frame loop claims (title, MODAL)
 *   5. the timer from 3 fires     -> key matches, surface matches, so it RELEASES
 *
 * The second mount re-claims under the very identity the stale timer was waiting for,
 * so the guard waves it through and the live player is destroyed. A counter that every
 * real claim bumps cannot be fooled this way: anything claimed since makes the pending
 * release void, whoever claimed and whatever they called themselves.
 *
 * The frame loop's identical re-claims return early without bumping, so an ordinary
 * dismissal still releases on time.
 */
export function releaseTrailerSoon(): void {
  const token = claimSeq;
  if (releaseTimer) clearTimeout(releaseTimer);
  releaseTimer = setTimeout(() => {
    releaseTimer = null;
    if (claimSeq !== token) return; // someone has claimed since; not ours to let go
    activate = null;
    claimTrailer(null);
  }, RELEASE_GRACE_MS);
}

/**
 * Hold the player off entirely.
 *
 * Starting a film does NOT close this window — mpv and IINA play in their own — so the
 * browse surface stays put and the trailer carried on with its own audio over the top
 * of the film. Releasing the target is not enough on its own: the surface's frame loop
 * re-claims it on the very next tick, so this is a latch.
 */
export function suspendTrailer(): void {
  const was = suspended;
  suspended = true;
  activate = null;
  // Starting a film is deliberate; a release still in flight must not undo it.
  if (releaseTimer) {
    clearTimeout(releaseTimer);
    releaseTimer = null;
  }
  if (current !== null) {
    current = null;
    emit();
  } else if (!was) {
    // The hero billboard is not a claimant — it watches the latch itself — so the
    // change has to be announced even when nobody held the shared player.
    emit();
  }
}

export function resumeTrailer(): void {
  if (!suspended) return; // called on every surface attach; only a real change notifies
  suspended = false;
  emit();
}

export function isSuspended(): boolean {
  return suspended;
}

/** What a click on the video means, supplied by whichever surface holds it. */
export function setActivate(fn: (() => void) | null): void {
  activate = fn;
}

export function getActivate(): (() => void) | null {
  return activate;
}

/** Tests only: put the module back to how it started. */
export function __resetTrailerStore(): void {
  if (releaseTimer) clearTimeout(releaseTimer);
  releaseTimer = null;
  current = null;
  claimSeq = 0;
  suspended = false;
  activate = null;
  listeners.clear();
}
