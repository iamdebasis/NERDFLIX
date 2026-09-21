import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { coverFrame, frameOffsetY } from './trailer-geometry.js';
import { isSuspended, subscribe } from './trailer-store.js';
import { youTubeEmbedUrl } from './youtube.js';
import {
  HERO_FALLBACK_DWELL_MS,
  HERO_NO_TRAILER_DWELL_MS,
  HERO_SETTLE_MS,
  HERO_VISIBLE_RATIO,
  didTrailerLoop,
  heroTrailerVerdict,
} from './hero-trailer.js';

/**
 * The billboard trailer — the hero's artwork coming to life a few seconds after you
 * arrive.
 *
 * WHY THIS IS A SECOND PLAYER, when the rule is one player for the whole app.
 *
 * That rule exists for the preview that FOLLOWS THE POINTER: hover card and detail
 * modal are two components showing the same film, and rendering an iframe in each
 * meant the video restarted every time it moved between them. One player that
 * relocates is the only way to make that a move rather than a reload.
 *
 * The billboard is a different thing. It never moves, it is never the same element as
 * the preview, and it is tied to one title for as long as the page shows it. Sharing
 * the pointer's player with it would mean the billboard stopping dead every time you
 * hovered a poster and restarting when you looked away — visibly worse than not having
 * it. So: two players, each stationary within its own surface, and the rule the other
 * one follows is untouched.
 *
 * It is also far simpler than the preview player, and for one structural reason: this
 * is a CHILD of `.hero` rather than a fixed element at the document root. It needs no
 * position tracking, no clipping, and no z-index inversion — the hero's gradient and
 * its title block are later siblings, so they paint over it for free.
 */
export function HeroTrailer({
  titleId,
  url,
  title,
  backdrop,
  covered,
  onFinished,
}: {
  titleId: string;
  url?: string;
  title: string;
  /** Shown until the video is up, and again whenever it stops. */
  backdrop: string | null;
  /** Something is over the billboard — a detail dialog. Hold, do not play to nobody. */
  covered?: boolean;
  /**
   * The trailer has been round once, so the billboard can move to the next film.
   * Also fires for a title with no trailer, or the rotation would stall on a still.
   */
  onFinished?: () => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ width: 0, height: 0 });
  const [settled, setSettled] = useState(false);
  const [onScreen, setOnScreen] = useState(true);
  const [visible, setVisible] = useState(false);
  const [online, setOnline] = useState(() => navigator.onLine);
  const [documentHidden, setDocumentHidden] = useState(() => document.hidden);
  const [muted, setMuted] = useState(true);
  /** Bumped only when a reload is genuinely unavoidable. */
  const [reloadNonce, setReloadNonce] = useState(0);

  const frameRef = useRef<HTMLIFrameElement>(null);
  /**
   * Whether the player answers us.
   *
   * YouTube's postMessage channel needs a real page origin to reply to. A dev renderer
   * is served over http and answers; a packaged one is `file://`, whose origin is
   * null, and never will. Everything below has to work either way, so this is
   * discovered rather than assumed — it flips the moment any message arrives.
   */
  const [canTalk, setCanTalk] = useState(false);
  /** Bumped whenever a frame appears, so the handshake restarts with it. */
  const [mountedTick, setMountedTick] = useState(0);
  const verdictMountRef = useRef(false);
  /** Last position the player reported, and when it said so. */
  const position = useRef(0);
  const positionAt = useRef(0);
  /** Where the CURRENT src was told to begin, so the estimate has an origin. */
  const startedAt = useRef(0);
  /** Wall clock at the moment playback began, used only when the channel is dead. */
  const playingSince = useRef<number | null>(null);
  /** Reported by the player, when it talks. Used to tell a loop from a seek. */
  const duration = useRef<number | undefined>(undefined);
  /** One advance per title; a wrap plus a timer must not both fire. */
  const finished = useRef(false);

  const finishedRef = useRef(onFinished);
  finishedRef.current = onFinished;
  const finish = useCallback(() => {
    if (finished.current) return;
    finished.current = true;
    finishedRef.current?.();
  }, []);

  const post = useCallback((msg: unknown) => {
    frameRef.current?.contentWindow?.postMessage(JSON.stringify(msg), '*');
  }, []);
  const command = useCallback(
    (func: string, args: unknown[] = []) => post({ event: 'command', func, args }),
    [post],
  );

  /**
   * Where the video actually is.
   *
   * The player's own `currentTime` when it has reported one, extrapolated forward if
   * it is still playing — reports arrive a few times a second, not continuously, and a
   * stale one would put the resume point seconds behind. Wall clock only when the
   * player has never spoken, which is the packaged `file://` case.
   */
  const readPosition = useCallback(() => {
    if (positionAt.current > 0) {
      const since = playingSince.current === null ? 0 : (Date.now() - positionAt.current) / 1000;
      return position.current + since;
    }
    if (playingSince.current === null) return startedAt.current;
    return startedAt.current + (Date.now() - playingSince.current) / 1000;
  }, []);

  // A film playing outranks everything; the shared player's latch is the single source
  // of that truth, so the billboard watches it rather than keeping its own.
  const suspended = useSyncExternalStore(subscribe, isSuspended, () => false);

  // The artwork holds first. Reset per title, so a different hero starts its own clock.
  useEffect(() => {
    setSettled(false);
    setVisible(false);
    finished.current = false;
    position.current = 0;
    positionAt.current = 0;
    duration.current = undefined;
    playingSince.current = null;
    const t = window.setTimeout(() => setSettled(true), HERO_SETTLE_MS);
    return () => window.clearTimeout(t);
  }, [titleId]);

  /**
   * Size the frame from the hero's own box.
   *
   * A ResizeObserver, not a frame loop: this player is a child of the element it
   * fills, so it can only change size, never drift away from it. The preview player
   * needs per-frame tracking precisely because it is NOT a child of its surface.
   */
  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const measure = () => {
      const r = el.getBoundingClientRect();
      setBox({ width: r.width, height: r.height });
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Stop when it scrolls away — a sliver of billboard above the rows is not something
  // anyone is watching, and it would hold a video stream open for it.
  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const io = new IntersectionObserver(
      ([entry]) => setOnScreen(entry.intersectionRatio >= HERO_VISIBLE_RATIO),
      { threshold: [0, HERO_VISIBLE_RATIO, 1] },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  useEffect(() => {
    const net = () => setOnline(navigator.onLine);
    const vis = () => setDocumentHidden(document.hidden);
    window.addEventListener('online', net);
    window.addEventListener('offline', net);
    document.addEventListener('visibilitychange', vis);
    return () => {
      window.removeEventListener('online', net);
      window.removeEventListener('offline', net);
      document.removeEventListener('visibilitychange', vis);
    };
  }, []);

  const verdict = heroTrailerVerdict({
    hasUrl: Boolean(url),
    settled,
    onScreen,
    suspended,
    // A dialog over the billboard is the same situation as scrolling away: hold where
    // you are, do not play to a covered surface.
    documentHidden: documentHidden || Boolean(covered),
    online,
    canPause: canTalk,
  });

  useEffect(() => {
    const had = verdictMountRef.current;
    verdictMountRef.current = verdict.mount;
    if (verdict.mount && !had) setMountedTick((n) => n + 1);
  }, [verdict.mount]);

  // Back to artwork the moment the frame goes, so the hero is never a black rectangle.
  // A PAUSE is not that: the frame stays, holding the last drawn picture.
  useEffect(() => {
    if (!verdict.mount) {
      // Remember where we were, so coming back can resume rather than restart.
      position.current = readPosition();
      playingSince.current = null;
      setVisible(false);
    }
  }, [verdict.mount, readPosition]);

  /**
   * Play and pause in place.
   *
   * This is what makes scrolling away cheap: the frame keeps its place and its buffer,
   * and scrolling back picks up mid-sentence instead of starting the trailer over.
   */
  useEffect(() => {
    if (!verdict.mount || !canTalk) return;
    if (verdict.play) {
      command('playVideo');
      playingSince.current = Date.now();
    } else {
      command('pauseVideo');
      position.current = readPosition();
      playingSince.current = null;
    }
  }, [verdict.mount, verdict.play, canTalk, command, readPosition]);

  /**
   * Listen for anything the player says, and keep its position.
   *
   * `infoDelivery` carries `currentTime` a few times a second once we are listening,
   * which is a far better answer than counting wall-clock seconds — that drifts
   * whenever the video stalls to buffer. The handshake repeats only until the first
   * reply, because one sent before the frame is ready is simply lost and after that
   * YouTube keeps talking on its own.
   */
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (!String(e.origin).includes('youtube')) return;
      /*
       * Only OUR frame. The preview player is a second YouTube embed on the same page,
       * and it reports its own `currentTime` to the same window — so without this the
       * two streams interleave and the billboard reads the preview's playhead as its
       * own. Observed live: reports alternating between 62s and 3s, which made a
       * perfectly ordinary pair look like the trailer had looped and handed the
       * billboard on early.
       */
      if (e.source !== frameRef.current?.contentWindow) return;
      setCanTalk(true);
      try {
        const d = typeof e.data === 'string' ? JSON.parse(e.data) : e.data;
        const dur = d?.info?.duration;
        if (typeof dur === 'number' && dur > 0) duration.current = dur;
        const t = d?.info?.currentTime;
        if (typeof t === 'number' && t >= 0) {
          // The playhead jumping backwards from near the end is the trailer finishing
          // — see didTrailerLoop for why this is not an `ended` event.
          if (didTrailerLoop(position.current, t, duration.current)) finish();
          position.current = t;
          positionAt.current = Date.now();
        }
      } catch {
        /* not every message is JSON we care about */
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  /**
   * Keep saying `listening` for as long as the frame exists.
   *
   * Not just until it answers, which is what this did at first and it quietly broke the
   * whole point: YouTube streams `infoDelivery` — the messages carrying `currentTime` —
   * only while it is being listened to. Stop the handshake and the reports stop with
   * it, so the remembered position froze near zero and a forced reload would have
   * resumed at the beginning after all. A message to a child frame costs nothing.
   */
  useEffect(() => {
    if (!verdictMountRef.current) return;
    post({ event: 'listening', id: 1, channel: 'widget' });
    const hello = window.setInterval(
      () => post({ event: 'listening', id: 1, channel: 'widget' }),
      900,
    );
    return () => window.clearInterval(hello);
  }, [post, reloadNonce, mountedTick]);

  /**
   * Move on even when nothing will tell us the trailer ended.
   *
   * A title with no trailer has nothing to finish, and a packaged renderer cannot hear
   * the player at all. Without these the rotation stalls on one film forever. Both
   * clocks stop while the billboard is paused, so time spent scrolled away does not
   * count against the film you are about to look at.
   */
  useEffect(() => {
    if (!settled || suspended) return;
    if (!url) {
      const t = window.setTimeout(finish, HERO_NO_TRAILER_DWELL_MS);
      return () => window.clearTimeout(t);
    }
    if (canTalk || !verdict.play) return;
    const t = window.setTimeout(finish, HERO_FALLBACK_DWELL_MS);
    return () => window.clearTimeout(t);
  }, [settled, suspended, url, canTalk, verdict.play, finish]);

  const onLoad = useCallback(() => {
    // `load` fires cross-origin; it means the player document is up, not that video is
    // on screen. The wait is for YouTube's opening chrome — see REVEAL_SETTLE_MS in
    // TrailerHost for the measurement.
    window.setTimeout(() => {
      setVisible(true);
      playingSince.current = Date.now();
    }, 1600);
  }, []);

  const videoId = url ? /(?:v=|youtu\.be\/|embed\/)([A-Za-z0-9_-]{11})/.exec(url)?.[1] : null;

  /**
   * Frozen per (video, reload).
   *
   * Assigning a different `src` to a live iframe NAVIGATES it, which restarts playback
   * just as surely as remounting does — so mute and the resume point are captured at
   * reload time and can never change it from under us.
   */
  const src = useMemo(() => {
    if (!videoId) return null;
    startedAt.current = position.current;
    return youTubeEmbedUrl(videoId, { muted, startAt: position.current });
    // `muted` is read deliberately without subscribing: only a reload picks up a new
    // value, and a reload bumps the nonce.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [videoId, reloadNonce]);
  const frame = coverFrame(box);
  const dy = frameOffsetY(box, frame);

  return (
    <>
      <div className="hero-trailer" ref={host}>
      {/* The still, underneath. It is what you see for the first seconds, for a title
          with no trailer, and whenever the video stands down. */}
      {backdrop && (
        <img
          className={`hero-bg${visible ? ' is-behind' : ''}`}
          src={backdrop}
          alt=""
          draggable={false}
        />
      )}

      {verdict.mount && videoId && src && box.width > 0 && (
        <iframe
          key={`${videoId}-${reloadNonce}`}
          className={`trailer-video${visible ? ' is-playing' : ''}`}
          style={{
            width: frame.width,
            height: frame.height,
            transform: `translate(-50%, calc(-50% + ${dy}px))`,
          }}
          ref={frameRef}
          onLoad={onLoad}
          src={src}
          title={`${title} — trailer`}
          allow="autoplay; encrypted-media"
          frameBorder={0}
          tabIndex={-1}
        />
      )}

      {/* Keeps the pointer out of YouTube's out-of-process frame, which otherwise
          draws its centred transport controls. See TrailerHost's shield. */}
      {verdict.mount && <div className="trailer-shield hero-shield" />}

        <div className={`trailer-veil${visible ? ' is-playing' : ''}`} aria-hidden="true" />
      </div>

      {/* Outside the video layer on purpose — see .hero-mute. */}
      {visible && (
        <button
          className="circle big hero-mute"
          onClick={() => {
            const next = !muted;
            setMuted(next);
            if (canTalk) {
              // In place. No reload, no restart — the reported bug.
              command(next ? 'mute' : 'unMute');
              if (!next) command('setVolume', [70]);
              return;
            }
            /*
             * No channel to the player, which is the packaged `file://` case. A reload
             * is the only way to change `mute`, so at least come back where we were
             * rather than at the beginning.
             */
            position.current = readPosition();
            playingSince.current = null;
            setVisible(false);
            setReloadNonce((n) => n + 1);
          }}
          aria-label={muted ? 'Unmute trailer' : 'Mute trailer'}
          title={muted ? 'Unmute' : 'Mute'}
        >
          {muted ? (
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M4 9v6h4l5 4V5L8 9H4z" fill="currentColor" />
              <path d="M17 9.5l5 5M22 9.5l-5 5" stroke="currentColor" strokeWidth="2" fill="none" strokeLinecap="round" />
            </svg>
          ) : (
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M4 9v6h4l5 4V5L8 9H4z" fill="currentColor" />
              <path d="M16 8.5a5 5 0 0 1 0 7M19 6a9 9 0 0 1 0 12" stroke="currentColor" strokeWidth="2" fill="none" strokeLinecap="round" />
            </svg>
          )}
        </button>
      )}
    </>
  );
}
