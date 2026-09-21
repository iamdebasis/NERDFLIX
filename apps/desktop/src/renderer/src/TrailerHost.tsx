import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { clipInset, coverFrame, frameOffsetY, youTubeId } from './trailer-geometry.js';
import { youTubeEmbedUrl } from './youtube.js';
import {
  claimTrailer,
  getActivate,
  getTarget,
  releaseTrailerSoon,
  resumeTrailer,
  setActivate,
  subscribe,
  suspendTrailer,
  type TrailerSurface,
} from './trailer-store.js';

export { claimTrailer, resumeTrailer, suspendTrailer } from './trailer-store.js';
export type { TrailerSurface } from './trailer-store.js';

export { youTubeId } from './trailer-geometry.js';

/**
 * One trailer player for the whole app, positioned over whichever element claims it.
 *
 * The obvious implementation — each surface renders its own `<iframe>` — restarts the
 * video twice over: once when the mute button changes a URL parameter, and again when
 * a hover card expands into the detail modal, because that is a different component
 * and therefore a different iframe. An iframe cannot be moved in the DOM either; React
 * portals and manual `appendChild` both reload it.
 *
 * So the iframe is mounted ONCE at the document root, fixed-positioned, and animated
 * to the bounding box of whatever surface currently wants it. Nothing remounts, so
 * nothing restarts. Hovering a card and clicking into it is one continuous playback,
 * which is what Netflix does and why it feels seamless.
 *
 * Being fixed at the document root is also the source of three bugs that took a while
 * to see, each fixed below and each worth understanding before changing anything here:
 *
 *  1. It is not clipped by the surface it sits over, so scrolling the modal left the
 *     video drawing across the page. `clip` carries the owning container's box.
 *  2. Its position transition, which exists to make the hover→modal handover read as
 *     a movement, also applied to per-frame scroll tracking — so the video eased 260ms
 *     behind the page. The transition is now armed only for a handover.
 *  3. Its box is whatever shape the surface is, which is NOT 16:9 for the modal hero,
 *     so a percentage-sized iframe letterboxed the video. See `coverFrame`.
 */

/**
 * How long to wait after the frame's `load` before crossfading the video in.
 *
 * YouTube shows its transport controls in the MIDDLE of the player for the first
 * seconds of every embed, whatever `controls=0` says. They cannot be cropped away —
 * they are not at the edges — and they cannot be detected, because the postMessage
 * channel needs a real page origin and a packaged renderer is `file://`, whose origin
 * is null. So the only lever is to reveal after they have gone.
 *
 * Measured on this machine: still on screen ~1.2s after the frame loads, gone by 5s.
 * 1.6s is the judgement call between a clean cut and a long stare at the backdrop —
 * the backdrop is showing throughout, so the wait costs nothing but immediacy. Raise
 * it if chrome still flashes through; lower it if the reveal feels sluggish.
 */
const REVEAL_SETTLE_MS = 1600;

/**
 * Sound preference, shared across every trailer for the session.
 *
 * Unmuting one card and having the next start silent again would feel broken. Held in
 * memory rather than persisted: a fresh session starting with sound because of a choice
 * made days ago is worse than clicking once.
 */
let soundOn = false;
const soundListeners = new Set<() => void>();

/**
 * What a click on the video should do, supplied by whichever surface holds it.
 *
 * Kept outside the target so that a changing handler identity cannot churn the
 * subscription every frame. See `.trailer-shield` for why the player needs to swallow
 * clicks at all.
 */
let activate: (() => void) | null = null;



/**
 * Which title is on screen with video actually running.
 *
 * Surfaces need this because the player now sits BEHIND the modal (see the z-index
 * note below): the hero's still backdrop has to get out of the way once the trailer
 * is up, or it would cover the very video it was standing in for.
 */
let visibleKey: string | null = null;
const visibleListeners = new Set<() => void>();

/** Set by the host so a surface can flip mute without owning the player. */
let applySound: (() => void) | null = null;

export function useTrailerVisible(key: string): boolean {
  return useSyncExternalStore(
    (fn) => {
      visibleListeners.add(fn);
      return () => void visibleListeners.delete(fn);
    },
    () => visibleKey === key,
    () => false,
  );
}

/** Sound state plus the toggle, for a surface that draws its own mute control. */
export function useTrailerSound(): [boolean, () => void] {
  const on = useSyncExternalStore(
    (fn) => {
      soundListeners.add(fn);
      return () => void soundListeners.delete(fn);
    },
    () => soundOn,
    () => false,
  );
  return [on, () => applySound?.()];
}

/**
 * The mute control.
 *
 * Mounted by whichever side of the video its surface sits on: the hover card is
 * BELOW the player, so the host draws it there; the modal is ABOVE the player, so the
 * modal draws it itself. Same component either way — only the iframe is singular, and
 * a button is not worth a second implementation.
 */
export function TrailerSoundButton({ className = 'trailer-sound' }: { className?: string }) {
  const [on, toggle] = useTrailerSound();
  return (
    <button
      className={className}
      onClick={(e) => {
        e.stopPropagation();
        toggle();
      }}
      aria-label={on ? 'Mute trailer' : 'Unmute trailer'}
      title={on ? 'Mute' : 'Unmute'}
    >
      {on ? (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M4 9v6h4l5 4V5L8 9H4z" fill="currentColor" />
          <path d="M16 8.5a5 5 0 0 1 0 7M19 6a9 9 0 0 1 0 12" stroke="currentColor" strokeWidth="2" fill="none" strokeLinecap="round" />
        </svg>
      ) : (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M4 9v6h4l5 4V5L8 9H4z" fill="currentColor" />
          <path d="M17 9.5l5 5M22 9.5l-5 5" stroke="currentColor" strokeWidth="2" fill="none" strokeLinecap="round" />
        </svg>
      )}
    </button>
  );
}

/**
 * The nearest ancestor that clips its overflow.
 *
 * Resolved once per attachment rather than per frame: the element identity cannot
 * change while the surface is mounted, only its box can.
 */
function clippingParent(el: HTMLElement): HTMLElement | null {
  let p = el.parentElement;
  while (p && p !== document.body && p !== document.documentElement) {
    const s = getComputedStyle(p);
    if (s.overflow !== 'visible' || s.overflowX !== 'visible' || s.overflowY !== 'visible') {
      return p;
    }
    p = p.parentElement;
  }
  return null;
}

/**
 * Attach the player to a surface for as long as it is shown.
 *
 * Reports the element's box on a frame loop rather than once, because the hover card
 * animates in and the modal scrolls — a rect measured once would leave the video
 * behind.
 */
export function useTrailerTarget(
  ref: React.RefObject<HTMLElement | null>,
  opts: {
    key: string;
    url?: string;
    title: string;
    surface: TrailerSurface;
    radius?: string;
    delayMs?: number;
    /** What clicking the video means here — opening the detail view, usually. */
    onActivate?: () => void;
  },
) {
  const { key, url, title, surface, radius = '0', delayMs = 1200 } = opts;
  // Read through a ref so a fresh closure each render does not restart the frame loop.
  const activateRef = useRef(opts.onActivate);
  activateRef.current = opts.onActivate;

  useEffect(() => {
    if (!url) return;
    // A fresh attachment means the user has moved on from whatever was playing.
    resumeTrailer();
    let raf = 0;
    let clipEl: HTMLElement | null = null;
    let resolvedClip = false;

    const tick = () => {
      const el = ref.current;
      if (el) {
        if (!resolvedClip) {
          clipEl = clippingParent(el);
          resolvedClip = true;
        }
        setActivate(activateRef.current ?? null);
        claimTrailer({
          key,
          surface,
          url,
          title,
          rect: el.getBoundingClientRect(),
          clip: clipEl ? clipEl.getBoundingClientRect() : null,
          radius,
          delayMs,
        });
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(raf);
      // Deferred on purpose — see releaseTrailerSoon. Releasing here and now is what
      // made hover → modal a reload instead of a move.
      releaseTrailerSoon();
    };
  }, [ref, key, url, title, surface, radius, delayMs]);
}

export function TrailerHost() {
  const target = useSyncExternalStore(
    subscribe,
    getTarget,
    () => null,
  );
  const frame = useRef<HTMLIFrameElement>(null);
  const [mounted, setMounted] = useState(false);
  const [visible, setVisible] = useState(false);
  const [online, setOnline] = useState(() => navigator.onLine);
  /** True once the player has spoken to us, meaning mute can be changed in place. */
  const [canTalk, setCanTalk] = useState(false);
  /** Bumped to force a reload, only when postMessage is unavailable. */
  const [reloadNonce, setReloadNonce] = useState(0);
  /** Armed for the length of a handover, so scroll tracking stays frame-exact. */
  const [moving, setMoving] = useState(false);

  const id = youTubeId(target?.url);
  const key = target?.key ?? null;
  const surface = target?.surface ?? null;

  /**
   * The mount delay, held in a ref rather than read as a dependency.
   *
   * THIS WAS THE RESTART BUG. The hover card claims with 1200ms and the modal with
   * 400ms, so expanding a card changed `delayMs` — and because it was in the mount
   * effect's dependency array, the effect tore down, unmounted the iframe, and
   * remounted it 400ms later. The trailer began again from zero on every expand, which
   * is the single most noticeable way this feature can feel broken.
   *
   * The delay only ever matters for the FIRST mount of a title, so it is read at
   * effect setup and never becomes a reason to remount.
   */
  const delayRef = useRef(target?.delayMs ?? 1200);
  if (target) delayRef.current = target.delayMs;

  /**
   * Do not mount while offline. A cross-origin iframe cannot report that its content
   * failed — an unreachable host renders the browser's own error page inside the frame
   * and `onError` never fires.
   */
  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    return () => {
      window.removeEventListener('online', update);
      window.removeEventListener('offline', update);
    };
  }, []);

  /**
   * Stop when the window is not on screen.
   *
   * Surfaces track their box with `requestAnimationFrame`, which Chromium pauses
   * outright for a hidden window — measured here as zero frames in three seconds while
   * timers carried on. So a minimised window can never ATTACH the player, but one that
   * was already playing kept going, with its audio, out of a window nobody could see.
   * That is the same fault as a trailer talking over a film, arrived at from a
   * different direction.
   *
   * Resuming on the way back is required rather than optional: the frame loop starts
   * again by itself, but `suspended` would still be set, and nothing re-attaches until
   * the pointer visits a new tile.
   */
  useEffect(() => {
    const onVisibility = () => {
      if (document.hidden) suspendTrailer();
      else resumeTrailer();
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, []);

  // Delay past the hover-intent delay, so sweeping a row fires no loads at all.
  useEffect(() => {
    if (!id || !online) {
      setMounted(false);
      setVisible(false);
      return;
    }
    const t = window.setTimeout(() => setMounted(true), delayRef.current);
    return () => {
      window.clearTimeout(t);
      setMounted(false);
      setVisible(false);
      setCanTalk(false);
    };
    // Keyed on the VIDEO only. Not the surface, not the rect, and not the delay —
    // anything else here remounts the iframe and restarts playback.
  }, [id, online]);

  /**
   * Arm the position transition for a handover only.
   *
   * The transition is what makes hover → modal read as the card growing into the
   * dialog. Left permanently on, it also applied to the per-frame updates that track
   * scrolling, so the video eased 260ms behind the page and read as a separate
   * floating object. Scroll tracking now lands exactly on the frame it is given.
   */
  useEffect(() => {
    if (!key) return;
    setMoving(true);
    const t = window.setTimeout(() => setMoving(false), 300);
    return () => window.clearTimeout(t);
  }, [key, surface]);

  /**
   * Listen for anything the player says.
   *
   * YouTube's `enablejsapi` protocol needs a real page origin to post back to, and a
   * packaged Electron renderer is loaded from `file://`, whose origin is null. So this
   * may never fire — nothing depends on it, and its only job is to tell us whether
   * mute can be changed without a reload.
   */
  useEffect(() => {
    if (!mounted) return;

    const onMessage = (e: MessageEvent) => {
      if (!String(e.origin).includes('youtube')) return;
      setCanTalk(true);
    };
    window.addEventListener('message', onMessage);

    const hello = window.setInterval(() => {
      frame.current?.contentWindow?.postMessage(
        JSON.stringify({ event: 'listening', id: 1, channel: 'widget' }),
        '*',
      );
    }, 400);

    return () => {
      window.removeEventListener('message', onMessage);
      window.clearInterval(hello);
    };
  }, [mounted]);

  // Publish what is actually on screen, and keep the toggle reachable from a surface.
  useEffect(() => {
    visibleKey = visible && key ? key : null;
    visibleListeners.forEach((fn) => fn());
  }, [visible, key]);

  const onLoad = useCallback(() => {
    // `load` fires cross-origin, unlike anything inside the frame. It means the player
    // document is up, not that video is on screen, so settle before revealing.
    window.setTimeout(() => setVisible(true), REVEAL_SETTLE_MS);
  }, []);

  const toggleSound = useCallback(() => {
    soundOn = !soundOn;
    soundListeners.forEach((fn) => fn());

    if (canTalk) {
      // In place, no restart.
      frame.current?.contentWindow?.postMessage(
        JSON.stringify({
          event: 'command',
          func: soundOn ? 'unMute' : 'mute',
          args: [],
        }),
        '*',
      );
      if (soundOn) {
        frame.current?.contentWindow?.postMessage(
          JSON.stringify({ event: 'command', func: 'setVolume', args: [60] }),
          '*',
        );
      }
      return;
    }

    // No channel to the player: a reload is the only way, and it restarts the trailer.
    setVisible(false);
    setReloadNonce((n) => n + 1);
  }, [canTalk]);

  useEffect(() => {
    applySound = toggleSound;
    return () => {
      if (applySound === toggleSound) applySound = null;
    };
  }, [toggleSound]);

  /**
   * The embed URL, frozen per (video, reload).
   *
   * Assigning a different `src` to a live iframe NAVIGATES it, which restarts playback
   * just as surely as remounting does. `mute` is derived from state that changes
   * during playback, so computing the URL inline made every such change a silent
   * reload. It is captured here and only ever revised by a deliberate reload.
   */
  const src = useMemo(() => {
    if (!id) return null;
    return youTubeEmbedUrl(id, { muted: !soundOn });
    // soundOn is read deliberately without subscribing: a reload is the only thing
    // allowed to pick up a new value, and it bumps the nonce.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, reloadNonce]);

  if (!target || !id || !online || !src) return null;

  const { rect, radius } = target;
  const frameBox = coverFrame({ width: rect.width, height: rect.height });
  // Take the crop off the top, where YouTube's title bar is. See frameOffsetY.
  const frameDy = frameOffsetY({ width: rect.width, height: rect.height }, frameBox);
  const inset = clipInset(rect, target.clip);

  return (
    <div
      className={`trailer-host${moving ? ' is-moving' : ''}`}
      style={{
        /*
         * WHICH SIDE OF THE VIDEO THE SURFACE SITS ON.
         *
         * The hover card is painted UNDER the player (95 clears the card at 60), which
         * is why the host draws the mute button itself there.
         *
         * The modal is the other way round, and that inversion is what makes the
         * Netflix layout possible at all. A fixed sibling cannot be above the modal's
         * backdrop and below its title at the same time — so the player goes BENEATH
         * the dialog (75), the dialog's own background is made transparent where the
         * video should show, and `.modal-dim` at 70 carries the page wash that used to
         * live on the scrim. Everything inside the modal then paints over the video for
         * free: logo, Resume, progress, mute.
         */
        zIndex: target.surface === 'modal' ? 75 : 95,
        left: rect.left,
        top: rect.top,
        width: rect.width,
        height: rect.height,
        borderRadius: radius,
        // Stay inside whatever is scrolling underneath, instead of drawing over the
        // whole page once the surface has scrolled away.
        clipPath: inset
          ? `inset(${inset.top}px ${inset.right}px ${inset.bottom}px ${inset.left}px)`
          : undefined,
      }}
    >
      {mounted && !visible && (
        <div className="trailer-loader" aria-hidden="true">
          <span />
        </div>
      )}

      {mounted && (
        <iframe
          // Keyed on the video and the reload nonce only — NOT on position, surface or
          // delay, so moving between the hover card and the modal never reloads.
          key={`${id}-${reloadNonce}`}
          ref={frame}
          onLoad={onLoad}
          className={`trailer-video${visible ? ' is-playing' : ''}`}
          // Sized in JS because the surface is not 16:9 and CSS cannot solve for a
          // cover fit against an unknown box. See coverFrame.
          style={{
            width: frameBox.width,
            height: frameBox.height,
            transform: `translate(-50%, calc(-50% + ${frameDy}px))`,
          }}
          src={src}
          title={`${target.title} — trailer`}
          allow="autoplay; encrypted-media"
          frameBorder={0}
          tabIndex={-1}
        />
      )}

      {/*
        Veils over the frame's edges.

        Cropping alone cannot be relied on: YouTube shows a title bar for the first few
        seconds of every embed regardless of `controls=0`, and its height does not
        scale with the player. Cropping far enough to clear it at hover-card size would
        throw away a third of the picture. A gradient hides it at any size, and doubles
        as the fade into the panel below — which the player, sitting above both
        surfaces, would otherwise paint over.
      */}
      {/*
        A transparent sheet over the player, and the reason the YouTube controls finally
        go away.

        `pointer-events: none` on the iframe is NOT reliable for a cross-origin frame:
        YouTube runs out of process, and hit testing for an out-of-process iframe happens
        in the compositor, which routes the pointer to the child frame before the parent's
        `pointer-events` has any say. So the player saw hover after all, and drew its
        centred transport controls — which no amount of cropping can remove, because they
        sit in the middle of the picture rather than at its edges.

        The sheet is a same-process element that physically occupies the hit region, so
        the pointer never reaches YouTube. It forwards the click to whatever the surface
        underneath meant by it, so the card still expands when you click the video.
      */}
      <div
        className="trailer-shield"
        style={{ cursor: getActivate() ? 'pointer' : 'default' }}
        onClick={(e) => {
          e.stopPropagation();
          getActivate()?.();
        }}
      />

      <div
        className={`trailer-veil${visible ? ' is-playing' : ''}${
          target.surface === 'hover' ? ' with-base' : ''
        }`}
        aria-hidden="true"
      />

      {/* Only the hover card needs this here — the modal sits above the video and
          mounts its own, so the control lands inside the layout rather than over it. */}
      {visible && target.surface === 'hover' && <TrailerSoundButton />}
    </div>
  );
}
