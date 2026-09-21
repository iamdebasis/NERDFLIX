import { useCallback, useEffect, useRef, useState } from 'react';
import type { BrowseData, TitleCard } from '../../shared/types';
import { Wordmark } from './Wordmark';
import { HeroTrailer } from './HeroTrailer';
import { buildHeroQueue, nextHeroIndex } from './hero-trailer';
import {
  TrailerHost,
  TrailerSoundButton,
  resumeTrailer,
  suspendTrailer,
  useTrailerTarget,
  useTrailerVisible,
} from './TrailerHost';

declare global {
  interface Window {
    playback: import('../../shared/types').PlaybackApi;
  }
}


function fmtRuntime(min?: number): string {
  if (!min) return '';
  const h = Math.floor(min / 60);
  const m = min % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function fmtBytes(n: number): string {
  return n >= 1e12 ? `${(n / 1e12).toFixed(1)} TB` : `${(n / 1e9).toFixed(0)} GB`;
}

/**
 * Why a title cannot be played.
 *
 * `offlineOn` is the drive to go and fetch, but it is only known when that drive is
 * still paired. A title whose volume has been removed resolves as `missing`, and the
 * badge then rendered the bare word "On" followed by nothing — and the Play tooltip
 * read "On null". Naming no drive at all is not an answer; say plainly that the file
 * is not reachable from any library that is set up.
 */
function unavailableLabel(card: TitleCard): string {
  return card.offlineOn ? `On ${card.offlineOn}` : 'Not on any paired drive';
}

// --- Icons ------------------------------------------------------------------

/**
 * Drawn, not typed.
 *
 * These were text glyphs — ▶ ✓ + ⌄ ✕ ⓘ. A glyph is whatever the installed font decides
 * it is: it sits on a text baseline rather than in the middle of its button, its weight
 * does not match anything around it, and its size changes with the font stack. Paths
 * land on the pixel they are told to, scale with the control, and take `currentColor`,
 * so one sizing rule governs every control on every surface.
 */
const IconPlay = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path d="M7 4.5v15a1 1 0 0 0 1.53.85l12-7.5a1 1 0 0 0 0-1.7l-12-7.5A1 1 0 0 0 7 4.5z" fill="currentColor" />
  </svg>
);
const IconPlus = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" fill="none" />
  </svg>
);
const IconCheck = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path d="M5 12.5l4.5 4.5L19 7" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" fill="none" />
  </svg>
);
const IconChevron = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path d="M6 9.5l6 6 6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" fill="none" />
  </svg>
);
const IconClose = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path d="M6.5 6.5l11 11M17.5 6.5l-11 11" stroke="currentColor" strokeWidth="2" strokeLinecap="round" fill="none" />
  </svg>
);
/** Shown in place of the play triangle while a film is being opened. */
const IconSpinner = () => (
  <svg className="icon-spin" viewBox="0 0 24 24" aria-hidden="true">
    <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2" fill="none" opacity="0.25" />
    <path
      d="M21 12a9 9 0 0 0-9-9"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      fill="none"
    />
  </svg>
);
const IconInfo = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2" fill="none" />
    <path d="M12 11v5.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    <circle cx="12" cy="7.8" r="1.15" fill="currentColor" />
  </svg>
);

// --- Hover card -------------------------------------------------------------

/**
 * Netflix's preview card. Two details do most of the work:
 *
 *  - It is rendered in a portal-style fixed layer, because rows clip their overflow
 *    for the carousel and an in-flow card would be cut off at the row edge.
 *  - Its transform origin is clamped at the row edges, so the first and last tiles
 *    grow inward instead of off-screen.
 */
function HoverCard({
  card,
  rect,
  anchor,
  onOpen,
  onPlay,
  onToggleList,
  onLeave,
  starting,
}: {
  card: TitleCard;
  rect: DOMRect;
  /** The tile this card grew out of. Read live, not as a snapshot — see below. */
  anchor: HTMLElement | null;
  onOpen: () => void;
  onPlay: () => void;
  onToggleList: () => void;
  onLeave: () => void;
  /** A film is being opened; the card stays until it is running. */
  starting: boolean;
}) {
  const width = Math.max(rect.width * 1.5, 320);
  const margin = 24;
  let left = rect.left + rect.width / 2 - width / 2;
  left = Math.max(margin, Math.min(left, window.innerWidth - width - margin));

  // The shared player follows this box. Keyed by title id so expanding into the modal
  // is a move, not a reload.
  const artRef = useRef<HTMLDivElement>(null);
  useTrailerTarget(artRef, {
    key: card.id,
    url: card.trailerUrl,
    title: card.title,
    surface: 'hover',
    radius: '6px',
    // The player covers the artwork, so clicking the video has to mean what clicking
    // the artwork means: expand into the detail view.
    onActivate: onOpen,
  });

  /**
   * Dismiss on where the POINTER is, not on which element it left.
   *
   * `onMouseLeave` on this card could not work, and the symptom was that the trailer's
   * mute button was unclickable. The player is a fixed-position element at the document
   * root — it has to be, so that hover → modal moves it rather than remounting it — so
   * its mute button is NOT a descendant of this card. Reaching for it fired mouseleave
   * here, which dismissed the card, which unmounted the player, which took the button
   * away before the click could land.
   *
   * The player always sits inside this card's box, so testing the pointer against the
   * box keeps the card alive across everything drawn over it, whatever the DOM says.
   */
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const GRACE = 12; // diagonal travel to a control near the edge must not flicker
    const inside = (x: number, y: number, b: DOMRect) =>
      x >= b.left - GRACE && x <= b.right + GRACE && y >= b.top - GRACE && y <= b.bottom + GRACE;

    /**
     * Alive while the pointer is over the CARD or over the TILE it came from.
     *
     * The card alone is not enough, and that is half of why the tiles at either end of
     * a row misbehaved. The card is clamped to the viewport, so for the first tile it
     * gets pushed inward to `margin` — leaving the left of that tile outside the card's
     * box entirely. Pointing at the poster you were trying to preview dismissed it.
     */
    const onMove = (e: PointerEvent) => {
      const el = rootRef.current;
      if (!el) return;
      if (inside(e.clientX, e.clientY, el.getBoundingClientRect())) return;
      if (anchor && inside(e.clientX, e.clientY, anchor.getBoundingClientRect())) return;
      onLeave();
    };

    /**
     * Dismiss when the tile has actually MOVED, not on any scroll event at all.
     *
     * The card is pinned to a screen position while the page behind it moves, so a
     * scroll leaves it beside whatever slid under it — but "a scroll happened" is far
     * too blunt a test. `.row-scroller` is `scroll-snap-type: x proximity` and
     * `.tile:hover` scales to 1.04, so merely hovering a tile changes the snap geometry
     * and the browser re-snaps, firing a scroll event with nothing having moved. At the
     * ends of a row that re-snap actually shifts the scroller, which is exactly why the
     * first and last tiles flashed a card and lost it while the middle was fine.
     *
     * The tile's CENTRE is the right thing to watch: a centred scale leaves it where it
     * was, while genuine scrolling or paging moves it.
     */
    const centreOf = (el: HTMLElement) => {
      const b = el.getBoundingClientRect();
      return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
    };
    const origin = anchor ? centreOf(anchor) : null;
    const onScroll = () => {
      if (!anchor || !origin) return onLeave();
      const now = centreOf(anchor);
      if (Math.abs(now.x - origin.x) > 4 || Math.abs(now.y - origin.y) > 4) onLeave();
    };

    document.addEventListener('pointermove', onMove);
    // A fast exit past the window edge never produces a final pointermove inside it.
    document.documentElement.addEventListener('mouseleave', onLeave);
    window.addEventListener('scroll', onScroll, true);
    return () => {
      document.removeEventListener('pointermove', onMove);
      document.documentElement.removeEventListener('mouseleave', onLeave);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, [onLeave, anchor]);

  return (
    <div className="hover-card" ref={rootRef} style={{ left, top: rect.top - 40, width }}>
      <div className="hover-art" ref={artRef} onClick={onOpen}>
        {/* The backdrop stays mounted underneath: it is what shows before the trailer
            loads, and what remains if there is no trailer or no network. The player
            itself lives in TrailerHost — see there for why it is not rendered here. */}
        {card.backdrop ? (
          <img src={card.backdrop} alt="" draggable={false} />
        ) : (
          <div className="art-fallback">{card.title}</div>
        )}
        {card.logo && <img className="hover-logo" src={card.logo} alt="" draggable={false} />}
        {!card.available && (
          <span className="offline-strip">{unavailableLabel(card)}</span>
        )}
      </div>

      <div className="hover-body">
        <div className="hover-actions">
          <button
            className="circle primary"
            onClick={onPlay}
            disabled={!card.available || starting}
            title={card.available ? 'Play' : unavailableLabel(card)}
            aria-label="Play"
          >
            {starting ? <IconSpinner /> : <IconPlay />}
          </button>
          <button
            className="circle"
            onClick={onToggleList}
            title={card.inMyList ? 'Remove from My List' : 'Add to My List'}
            aria-label={card.inMyList ? 'Remove from My List' : 'Add to My List'}
          >
            {card.inMyList ? <IconCheck /> : <IconPlus />}
          </button>
          <button className="circle chevron" onClick={onOpen} title="More info" aria-label="More info">
            <IconChevron />
          </button>
        </div>

        <div className="hover-meta">
          {/* Year first, because the detail view this expands into leads with it too —
              so it does not jump position mid-transition. */}
          {card.year ? <span>{card.year}</span> : null}
          {card.certification && <span className="cert">{card.certification}</span>}
          {/* Guarded rather than always rendered: an unenriched title has no runtime
              and an empty span still takes a gap, leaving a stray separator. */}
          {card.runtimeMinutes ? <span>{fmtRuntime(card.runtimeMinutes)}</span> : null}
          {card.resolution ? <span className="tag">{card.resolution}</span> : null}
          {card.hdr !== 'SDR' && <span className="tag hdr">{card.hdr}</span>}
        </div>

        <div className="hover-genres">{card.genres.slice(0, 3).join(' · ')}</div>
      </div>
    </div>
  );
}

// --- Detail modal -----------------------------------------------------------

function DetailModal({
  card,
  onClose,
  onPlay,
  onToggleList,
  starting,
}: {
  card: TitleCard;
  onClose: () => void;
  onPlay: () => void;
  onToggleList: () => void;
  /** A film is being opened; the dialog stays until it is running. */
  starting: boolean;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Computed in the main process from the real duration — never re-derived here from
  // `runtimeMinutes`, which is whole minutes, absent before enrichment, and 0 for
  // anything short, all of which silently hid the bar.
  const resumePct = card.resumePct ?? 0;

  // Same key as the hover card, so opening the modal moves the player rather than
  // reloading it. Shorter delay: opening is deliberate, so there is no risk of firing
  // loads for titles nobody looked at.
  const heroRef = useRef<HTMLDivElement>(null);
  useTrailerTarget(heroRef, {
    key: card.id,
    url: card.trailerUrl,
    title: card.title,
    surface: 'modal',
    // Only the top corners: the hero is the top of the dialog, and a single radius
    // drew square corners over the dialog's rounded ones.
    radius: '8px 8px 0 0',
    delayMs: 400,
  });

  /**
   * The still backdrop has to retire once the video is up.
   *
   * The player is painted BEHIND the dialog now, so anything opaque inside the hero
   * covers it. The backdrop is what stands in before the trailer loads, for a title
   * with no trailer, and when offline — so it stays mounted and fades, rather than
   * being conditionally rendered and popping.
   */
  const trailerUp = useTrailerVisible(card.id);

  return (
    <>
      {/*
        The page wash, as its own layer.
        It used to live on `.modal-scrim`, which sits ABOVE the player — so putting the
        video under the dialog would have dimmed the video by 75% along with the page.
        Below the player, it dims only what is behind.
      */}
      <div className="modal-dim" />

      <div className="modal-scrim" onClick={onClose}>
        <div className="modal" onClick={(e) => e.stopPropagation()}>
          <button className="modal-close" onClick={onClose} aria-label="Close" title="Close">
            <IconClose />
          </button>

          <div className="modal-hero" ref={heroRef}>
            <div className={`modal-hero-plate${trailerUp ? ' is-hidden' : ''}`}>
              {card.backdrop && <img src={card.backdrop} alt="" draggable={false} />}
            </div>

            {/* Reads down into the panel, and buries whatever the trailer has burned
                into its own bottom edge — captions, watermarks — instead of leaving it
                floating in a murky band under the picture. */}
            <div className="modal-hero-fade" />

            <div className="modal-hero-content">
              {card.logo ? (
                <img className="modal-logo" src={card.logo} alt={card.title} draggable={false} />
              ) : (
                <h1 className="modal-title">{card.title}</h1>
              )}

              {card.resumeSec !== null && (
                <div className="resume-row">
                  <div className="resume-bar">
                    <span style={{ width: `${resumePct}%` }} />
                  </div>
                  <span className="resume-label">
                    {fmtRuntime(Math.round(card.resumeSec / 60))}
                    {card.runtimeMinutes ? ` of ${fmtRuntime(card.runtimeMinutes)}` : ''}
                  </span>
                </div>
              )}

              <div className="modal-actions">
                <button
                  className="play-button"
                  onClick={onPlay}
                  disabled={!card.available || starting}
                >
                  {starting ? <IconSpinner /> : <IconPlay />}
                  <span>
                    {starting ? 'Starting…' : card.resumeSec !== null ? 'Resume' : 'Play'}
                  </span>
                </button>
                <button
                  className="circle big"
                  onClick={onToggleList}
                  title={card.inMyList ? 'Remove from My List' : 'Add to My List'}
                  aria-label={card.inMyList ? 'Remove from My List' : 'Add to My List'}
                >
                  {card.inMyList ? <IconCheck /> : <IconPlus />}
                </button>
                {!card.available && (
                  <span className="offline-note">{unavailableLabel(card)}</span>
                )}
                {/* Far right, on the same baseline as Play — where Netflix puts it. */}
                {trailerUp && <TrailerSoundButton className="circle big trailer-mute" />}
              </div>
            </div>
          </div>

          <div className="modal-panel">
            <div className="modal-body">
              <div>
                <div className="modal-meta">
                  {card.year && <span>{card.year}</span>}
                  <span>{fmtRuntime(card.runtimeMinutes)}</span>
                  <span className="tag">{card.resolution}</span>
                  {card.hdr !== 'SDR' && <span className="tag hdr">{card.hdr}</span>}
                  {card.certification && <span className="cert">{card.certification}</span>}
                </div>
                {card.tagline && <p className="tagline">{card.tagline}</p>}
                <p className="overview">{card.overview || 'No description available.'}</p>
              </div>

              <aside className="modal-side">
                {card.cast.length > 0 && (
                  <p>
                    <span className="label">Cast: </span>
                    {card.cast.slice(0, 5).join(', ')}
                  </p>
                )}
                {card.directors.length > 0 && (
                  <p>
                    <span className="label">Director: </span>
                    {card.directors.join(', ')}
                  </p>
                )}
                {card.genres.length > 0 && (
                  <p>
                    <span className="label">Genres: </span>
                    {card.genres.join(', ')}
                  </p>
                )}
                <p className="file-line">
                  {card.audio && <>{card.audio} · </>}
                  {card.bitrateMbps} Mb/s · {fmtBytes(card.sizeBytes)}
                </p>
                {card.editions.length > 1 && (
                  <p>
                    <span className="label">Versions: </span>
                    {card.editions.join(', ')}
                  </p>
                )}
              </aside>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

// --- Row --------------------------------------------------------------------

function Row({
  title,
  cards,
  onHover,
  onOpen,
}: {
  title: string;
  cards: TitleCard[];
  onHover: (card: TitleCard, rect: DOMRect, el: HTMLElement) => void;
  onOpen: (card: TitleCard) => void;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const page = (dir: 1 | -1) => {
    const el = scroller.current;
    if (el) el.scrollBy({ left: dir * el.clientWidth * 0.9, behavior: 'smooth' });
  };

  return (
    <section className="row">
      <h2 className="row-title">{title}</h2>
      <div className="row-viewport">
        <button className="pager left" onClick={() => page(-1)} aria-label="Scroll left">
          ‹
        </button>
        <div className="row-scroller" ref={scroller}>
          {cards.map((card) => (
            <button
              key={card.id}
              className={`tile${card.available ? '' : ' offline'}`}
              onClick={() => onOpen(card)}
              onMouseEnter={(e) => {
                const tile = e.currentTarget;
                const rect = tile.getBoundingClientRect();
                // Netflix waits before expanding, so travelling across a row does not
                // fire a card under every tile on the way past.
                clearTimeout(timer.current);
                timer.current = setTimeout(() => onHover(card, rect, tile), 400);
              }}
              onMouseLeave={() => clearTimeout(timer.current)}
            >
              {card.poster ? (
                <img src={card.poster} alt={card.title} draggable={false} />
              ) : (
                <div className="art-fallback">{card.title}</div>
              )}
              {card.resumePct !== null && (
                <span className="tile-progress">
                  <span style={{ width: `${card.resumePct}%` }} />
                </span>
              )}
            </button>
          ))}
        </div>
        <button className="pager right" onClick={() => page(1)} aria-label="Scroll right">
          ›
        </button>
      </div>
    </section>
  );
}

// --- Browse -----------------------------------------------------------------

export function Browse({
  volumeId,
  libraryLabel,
  onBack,
}: {
  volumeId?: string;
  /** Which library is on screen. Shown in the nav so "where am I" is answerable. */
  libraryLabel: string;
  onBack: () => void;
}) {
  /**
   * Home vs My List is a real mode, not a scroll target.
   *
   * The previous nav had "Home" and "My List" as inert spans — they looked like
   * navigation and did nothing, which is worse than omitting them. My List is a
   * genuinely different view of the library, so it gets one.
   */
  const [view, setView] = useState<'home' | 'list'>('home');

  /**
   * Search matters at real library sizes. Nine posters fit on a screen; a hundred and
   * twenty-eight do not, and scrolling genre rows to find a specific film is hopeless.
   */
  const [query, setQuery] = useState('');
  const [playError, setPlayError] = useState<string | null>(null);
  /** A film is being opened. The surface stays up until it is actually running. */
  const [starting, setStarting] = useState(false);

  /**
   * Start a film and stand down.
   *
   * Playback happens in mpv's or IINA's own window, so THIS window does not go
   * anywhere — which meant the trailer kept playing, with its own audio, over the top
   * of the film that had just started. Two things have to happen, in this order:
   *
   *  1. Silence the trailer immediately, on the click. Waiting for the engine to
   *     resolve leaves a second or two of trailer audio over the opening of the film.
   *  2. Dismiss the surface once the film is genuinely running — not before. IINA can
   *     take a moment to launch, and a modal that vanishes instantly leaves you
   *     staring at the browse grid wondering whether the click registered.
   *
   * If it fails, the surface stays put and says why, which is the only moment the
   * context is still useful.
   */
  const play = async (titleId: string, fromStart = false) => {
    setPlayError(null);
    suspendTrailer();
    setStarting(true);
    try {
      await window.playback.play(titleId, 0, fromStart);
      setHover(null);
      setOpen(null);
    } catch (err) {
      // Without rendering this, a failed Play does nothing visible at all — the most
      // confusing possible outcome.
      const message = err instanceof Error ? err.message : String(err);
      console.error('play failed:', message);
      setPlayError(message);
      // Nothing is playing, so there is nothing for the trailer to talk over.
      resumeTrailer();
    } finally {
      setStarting(false);
    }
  };

  const [data, setData] = useState<BrowseData | null>(null);
  /** Position in the billboard rotation — see where `heroQueue` is built. */
  const [heroIndex, setHeroIndex] = useState(0);
  const [hover, setHover] = useState<{
    card: TitleCard;
    rect: DOMRect;
    /** The tile element, so the card can tell a real scroll from snap jitter. */
    el: HTMLElement | null;
  } | null>(null);
  const [open, setOpen] = useState<TitleCard | null>(null);
  const [scrolled, setScrolled] = useState(false);

  const load = useCallback(async () => {
    setData(await window.libraries.browse(volumeId));
  }, [volumeId]);

  useEffect(() => {
    void load();
    return window.libraries.onChanged(() => void load());
  }, [load]);

  const toggleList = async (card: TitleCard) => {
    const rowsBefore = data?.rows.map((r) => r.title).join('|');

    const added = await window.libraries.toggleMyList(card.id);
    const next = await window.libraries.browse(volumeId);
    setData(next);

    // `hover` and `open` hold their own copies of the card, taken when they opened.
    // Reloading does not touch them, so without this the button you just clicked
    // keeps its old state and the click looks like it did nothing.
    setOpen((o) => (o && o.id === card.id ? { ...o, inMyList: added } : o));

    /**
     * Adding the first item creates the My List row; removing the last one destroys
     * it. Either way every row below moves, while the hover card stays pinned to the
     * screen position of a tile that is no longer there — so unrelated posters appear
     * beside it and it reads as though the click added them.
     *
     * Dismiss instead of trying to re-anchor: the tile the user was pointing at has
     * genuinely moved, and a card that silently re-targets is worse than one that closes.
     */
    const rowsAfter = next.rows.map((r) => r.title).join('|');
    if (rowsBefore !== rowsAfter) {
      setHover(null);
    } else {
      setHover((h) =>
        h && h.card.id === card.id ? { ...h, card: { ...h.card, inMyList: added } } : h,
      );
    }
  };

  if (!data) {
    return (
      <div className="screen">
        <p className="loading">Loading your library…</p>
      </div>
    );
  }

  const byId = new Map(data.titles.map((t) => [t.id, t]));

  /**
   * The billboard rotation.
   *
   * It follows the "Recently Added" row, in that row's order, and moves on each time a
   * trailer has been round once. That replaces the old rule, which was not a selection
   * at all: the first title `readdir` happened to return with artwork, which meant the
   * same film every launch forever.
   *
   * Titles without a backdrop are skipped — a hero with no artwork is a blank
   * rectangle with text on it. The row's own order is otherwise preserved, so the
   * billboard shows you what arrived most recently, newest first.
   */
  const recentIds = data.rows.find((r) => r.title === 'Recently Added')?.titleIds ?? [];
  const heroQueue = buildHeroQueue(recentIds, (id) => Boolean(byId.get(id)?.backdrop));
  const hero =
    (heroQueue.length ? byId.get(heroQueue[heroIndex % heroQueue.length]) : null) ??
    (data.heroId ? byId.get(data.heroId) : null);

  /**
   * Which rows to show.
   *
   * Search collapses everything into one result row rather than filtering each genre
   * row in place: a search that returns the same film under "Action", "Crime" and
   * "Recently Added" reads as three results, which is actively misleading.
   */
  const q = query.trim().toLowerCase();
  const allCards = data ? [...byId.values()] : [];

  const matches = (c: TitleCard): boolean =>
    c.title.toLowerCase().includes(q) ||
    String(c.year ?? '').includes(q) ||
    c.genres.some((g) => g.toLowerCase().includes(q)) ||
    c.directors.some((d) => d.toLowerCase().includes(q)) ||
    c.cast.some((n) => n.toLowerCase().includes(q));

  const visibleRows = q
    ? [{ title: `Results for “${query.trim()}”`, cards: allCards.filter(matches) }]
    : view === 'list'
      ? [{ title: 'My List', cards: allCards.filter((c) => c.inMyList) }]
      : (data?.rows ?? []).map((row) => ({
          title: row.title,
          cards: row.titleIds.map((id) => byId.get(id)).filter(Boolean) as TitleCard[],
        }));

  // The hero belongs to the full browse. Over a filtered view it is just a large
  // picture of something you did not ask for.
  const showHero = !q && view === 'home';

  return (
    <div
      className="browse"
      onScroll={(e) => setScrolled((e.target as HTMLElement).scrollTop > 40)}
    >
      <header className={`nav${scrolled ? ' solid' : ''}`}>
        {/* The mark identifies the app; the control beside it says where you are and
            gets you out. Keeping them separate means the logo is not load-bearing
            navigation — which was the original sin of "▸ LOCAL". */}
        <Wordmark className="nav-mark" size={19} />

        <button className="brand" onClick={onBack} title="Choose another library">
          <span className="brand-chevron" aria-hidden="true">‹</span>
          <span className="brand-label">{libraryLabel}</span>
        </button>

        <nav className="nav-links">
          <button
            className={view === 'home' ? 'active' : ''}
            onClick={() => {
              setView('home');
              setQuery('');
            }}
          >
            Browse
          </button>
          <button
            className={view === 'list' ? 'active' : ''}
            onClick={() => {
              setView('list');
              setQuery('');
            }}
          >
            My List
          </button>
        </nav>

        <div className="nav-search">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <circle cx="11" cy="11" r="7" stroke="currentColor" strokeWidth="2" fill="none" />
            <path d="M20 20l-4-4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </svg>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search titles, cast, director"
            aria-label="Search the library"
          />
          {query && (
            <button className="nav-search-clear" onClick={() => setQuery('')} aria-label="Clear">
              ×
            </button>
          )}
        </div>
      </header>

      {showHero && hero && (
        <div className="hero">
          {/* The artwork lives inside this now, so the still and the video can
              crossfade as one thing. The gradient and the title block are later
              siblings, so they paint over both without any z-index work. */}
          <HeroTrailer
            /*
             * Keys must be UNIQUE AMONG SIBLINGS, and `.hero-body` below is keyed on
             * the same title. Using the bare id for both made React unable to match
             * children across a rotation, so each new billboard was MOUNTED WITHOUT
             * the old one being unmounted — three players stacked in the hero after
             * two handovers, all still streaming. React says so out loud
             * ("Encountered two children with the same key"); nothing looked wrong on
             * screen because the newest one paints on top.
             */
            key={`hero-video-${hero.id}`}
            titleId={hero.id}
            url={hero.trailerUrl}
            title={hero.title}
            backdrop={hero.backdrop}
            // A detail dialog covers the billboard; it holds rather than playing to a
            // surface nobody can see, and the rotation waits with it.
            covered={open !== null}
            onFinished={() => setHeroIndex((i) => nextHeroIndex(i, heroQueue.length))}
          />
          <div className="hero-fade" />
          <div className="hero-body" key={`hero-body-${hero.id}`}>
            {hero.logo ? (
              <img className="hero-logo" src={hero.logo} alt={hero.title} />
            ) : (
              <h1 className="hero-title">{hero.title}</h1>
            )}
            {hero.tagline && <p className="hero-tagline">{hero.tagline}</p>}
            <p className="hero-overview">{hero.overview.slice(0, 220)}</p>
            <div className="hero-actions">
              <button
                className="play-button"
                disabled={!hero.available || starting}
                onClick={() => void play(hero.id)}
              >
                {starting ? <IconSpinner /> : <IconPlay />}
                <span>
                  {starting ? 'Starting…' : hero.resumeSec !== null ? 'Resume' : 'Play'}
                </span>
              </button>
              <button className="info-button" onClick={() => setOpen(hero)}>
                <IconInfo />
                <span>More Info</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* One player for the whole app. Rendered here rather than inside a card so it
          survives the hover-card → modal transition without reloading. */}
      <TrailerHost />

      <div className={`rows${showHero ? '' : ' rows-bare'}`}>
        {visibleRows.map((row) => (
          <Row
            key={row.title}
            title={row.title}
            cards={row.cards}
            onHover={(card, rect, el) => setHover({ card, rect, el })}
            onOpen={(card) => {
              setHover(null);
              setOpen(card);
            }}
          />
        ))}

        {/* Say what happened and what to do, rather than showing a blank page. */}
        {q && visibleRows[0].cards.length === 0 && (
          <p className="browse-empty">
            Nothing matches “{query.trim()}”.
          </p>
        )}
        {!q && view === 'list' && visibleRows[0].cards.length === 0 && (
          <p className="browse-empty">
            Your list is empty. Hover any film and press <strong>+</strong> to save it here.
          </p>
        )}
      </div>

      {hover && !open && (
        <HoverCard
          card={hover.card}
          rect={hover.rect}
          anchor={hover.el}
          onLeave={() => setHover(null)}
          onOpen={() => {
            setOpen(hover.card);
            setHover(null);
          }}
          onPlay={() => void play(hover.card.id)}
          onToggleList={() => void toggleList(hover.card)}
          starting={starting}
        />
      )}

      {playError && (
        <div className="toast" onClick={() => setPlayError(null)}>
          {playError}
        </div>
      )}

      {open && (
        <DetailModal
          card={open}
          onClose={() => setOpen(null)}
          onPlay={() => void play(open.id)}
          onToggleList={() => void toggleList(open)}
          starting={starting}
        />
      )}
    </div>
  );
}
