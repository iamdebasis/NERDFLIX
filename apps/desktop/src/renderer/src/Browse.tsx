import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  BrowseData,
  NextUpCard,
  RowKind,
  SeasonCard,
  ShowEpisodes,
  TitleCard,
  TrackChoice,
  TrackInfo,
  TrackOption,
} from '../../shared/types';
import { Wordmark } from './Wordmark';
import { HeroTrailer } from './HeroTrailer';
import { HERO_DISSOLVE_MS, buildHeroQueue, nextHeroIndex } from './hero-trailer';
import { errorMessage } from './ipc-error';
import {
  DEFAULT_SORT,
  NO_FILTERS,
  SORTS,
  activeCount,
  applyFilters,
  facets,
  isNarrowed,
  sortCards,
  toggleValue,
  type Filters,
  type SortKey,
} from './browse-filter';
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


/** "45m", "1h", "2h 45m" — never "1h 0m", which is how a 60-minute episode read. */
function fmtRuntime(min?: number): string {
  if (!min) return '';
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (h === 0) return `${m}m`;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

/** "12 films", "4 shows", or "16 titles" when the set holds both. */
function countNoun(cards: readonly TitleCard[]): string {
  const shows = cards.filter((c) => c.type === 'show').length;
  const films = cards.length - shows;
  const word = (n: number, w: string) => `${n} ${n === 1 ? w : `${w}s`}`;
  if (shows && films) return word(cards.length, 'title');
  return shows ? word(shows, 'show') : word(films, 'film');
}

/**
 * TB, GB, or MB — whichever says something. Whole gigabytes alone printed "0 GB" for
 * anything under half a gigabyte, which is most of an SD episode and a short season.
 */
function fmtBytes(n: number): string {
  if (n >= 1e12) return `${(n / 1e12).toFixed(1)} TB`;
  if (n >= 1e9) return `${(n / 1e9).toFixed(0)} GB`;
  return `${Math.max(1, Math.round(n / 1e6))} MB`;
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

/**
 * The Play button's word. For a show it follows next-up — "Resume" only when there is
 * an episode part-way through, because "Resume" on a show you finished yesterday would
 * mean the NEXT episode, which is not what the word says.
 */
function playLabel(card: TitleCard): string {
  if (card.type === 'show') return card.show?.nextUp?.reason === 'resume' ? 'Resume' : 'Play';
  return card.resumeSec !== null ? 'Resume' : 'Play';
}

/** What next-up is, in the words the hero uses above the Play button. */
const NEXT_UP_REASON: Record<NextUpCard['reason'], string> = {
  resume: 'Continue watching',
  next: 'Next episode',
  start: 'Start watching',
  rewatch: 'Watch again',
};

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
          {/* A show's length is its seasons, not the first episode's runtime — which is
              all `runtimeMinutes` knows about a show, and would read as a short film. */}
          {card.type === 'show' ? (
            <span>{card.show?.seasonsLabel}</span>
          ) : card.runtimeMinutes ? (
            // Guarded rather than always rendered: an unenriched title has no runtime
            // and an empty span still takes a gap, leaving a stray separator.
            <span>{fmtRuntime(card.runtimeMinutes)}</span>
          ) : null}
          {card.resolution ? <span className="tag">{card.resolution}</span> : null}
          {card.hdr !== 'SDR' && <span className="tag hdr">{card.hdr}</span>}
        </div>

        {/* Once you have started a show, say which episode Play means — the button
            alone cannot, and pressing it to find out is how you land in the wrong one. */}
        {card.show?.nextUp && card.show.nextUp.reason !== 'start' && (
          <div className="hover-nextup">
            {card.show.nextUp.resumePct !== null && (
              <span className="hover-nextup-bar">
                <span style={{ width: `${card.show.nextUp.resumePct}%` }} />
              </span>
            )}
            <span className="hover-nextup-label">
              <strong>{card.show.nextUp.label}</strong> {card.show.nextUp.name}
            </span>
          </div>
        )}

        <div className="hover-genres">{card.genres.slice(0, 3).join(' · ')}</div>
      </div>
    </div>
  );
}

// --- Detail modal -----------------------------------------------------------

/**
 * One track choice.
 *
 * A native `<select>`, deliberately. A disc can carry twenty-five subtitle tracks, and
 * a custom popup for that means writing scrolling, keyboard navigation and focus
 * trapping to arrive back where the platform already is. Only the closed control is
 * styled; the menu is the system's.
 */
function TrackSelect({
  label,
  options,
  value,
  onChange,
  offLabel,
}: {
  label: string;
  options: TrackOption[];
  /** `undefined` is "not chosen" — the player applies its own rules. */
  value: number | 'no' | undefined;
  onChange: (value: number | 'no' | undefined) => void;
  /** Subtitles can be switched off, which is a different thing from not choosing. */
  offLabel?: string;
}) {
  return (
    <label className="track-select">
      <span className="track-select-label">{label}</span>
      <select
        value={value === undefined ? '' : String(value)}
        onChange={(e) => {
          const v = e.target.value;
          onChange(v === '' ? undefined : v === 'no' ? 'no' : Number(v));
        }}
      >
        {/* Not a track: it means "say nothing to the player", which is what happens
            for anyone who never opens this. */}
        <option value="">Automatic</option>
        {offLabel && <option value="no">{offLabel}</option>}
        {options.map((o) => (
          <option key={o.id} value={o.id}>
            {o.isCommentary ? `\u25CB ${o.label}` : o.label}
            {o.detail ? ` — ${o.detail}` : ''}
            {o.isDefault ? ' (default)' : ''}
          </option>
        ))}
      </select>
    </label>
  );
}

/**
 * A show's episodes, one season at a time.
 *
 * Fetched when the dialog opens rather than carried on every card: a show can have a
 * hundred episodes with synopses and stills, and only this surface wants them. Refetched
 * whenever the card is replaced — which happens when browse data refreshes after
 * playback — so coming back from an episode shows its new progress.
 *
 * Each row is ONE button. Clicking anywhere on it plays that episode: a small play
 * target inside a large row is a miss waiting to happen, and Netflix's row is whole.
 */
function EpisodeList({
  card,
  initialSeason,
  starting,
  onPlayEpisode,
}: {
  card: TitleCard;
  /** Opened from a season card: that season, not next-up's. */
  initialSeason?: number;
  starting: boolean;
  onPlayEpisode: (key: string) => void;
}) {
  const [data, setData] = useState<ShowEpisodes | null>(null);
  const [season, setSeason] = useState<number | null>(null);
  // Which row was pressed, so the spinner appears on it rather than on every row.
  const [pressed, setPressed] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    window.playback
      .episodes(card.id)
      .then((d) => {
        if (!live) return;
        setData(d);
        // Keep the season being browsed if it still exists. Otherwise open on the one
        // a season card asked for — choosing "Season 1950" and landing on 1940 would
        // make the card a decoration — and failing that, the one Play means.
        const has = (n: number | null | undefined) => n != null && d.seasons.some((s) => s.season === n);
        const nextSeason = d.episodes.find((e) => e.key === d.nextUpKey)?.season;
        setSeason((cur) =>
          has(cur) ? cur : has(initialSeason) ? initialSeason! : (nextSeason ?? d.seasons[0]?.season ?? null),
        );
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [card, initialSeason]);

  useEffect(() => {
    if (!starting) setPressed(null);
  }, [starting]);

  if (!data || season === null) {
    // Reserve the heading's height so the dialog does not jump when the list arrives.
    return <section className="episodes is-loading" aria-busy="true" />;
  }

  const info = data.seasons.find((s) => s.season === season);
  const rows = data.episodes.filter((e) => e.season === season);

  return (
    <section className="episodes" aria-label="Episodes">
      <header className="episodes-head">
        <h2>Episodes</h2>
        {data.seasons.length > 1 ? (
          <label className="season-select">
            <span className="visually-hidden">Season</span>
            <select value={season} onChange={(e) => setSeason(Number(e.target.value))}>
              {data.seasons.map((s) => (
                <option key={s.season} value={s.season}>
                  {s.name}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <span className="season-name">{info?.name}</span>
        )}
      </header>

      {/* Honest about a partial season rather than implying the list is complete. */}
      {info?.total && info.total > info.owned ? (
        <p className="episodes-note">
          {info.owned} of {info.total} episodes on your drives
        </p>
      ) : null}

      <ol className="episode-list">
        {rows.map((ep) => {
          const isNext = ep.key === data.nextUpKey;
          const busy = starting && pressed === ep.key;
          const progress = ep.watched ? 100 : ep.resumePct;
          return (
            <li key={ep.key}>
              <button
                className={`episode${isNext ? ' is-next' : ''}${ep.available ? '' : ' is-offline'}${ep.watched ? ' is-watched' : ''}`}
                disabled={!ep.available || starting}
                onClick={() => {
                  setPressed(ep.key);
                  onPlayEpisode(ep.key);
                }}
                title={
                  ep.available
                    ? `Play ${ep.label}`
                    : ep.offlineOn
                      ? `On ${ep.offlineOn}`
                      : 'Not on any paired drive'
                }
              >
                <span className="episode-number">{ep.number}</span>

                <span className="episode-still">
                  {ep.still ? (
                    <img src={ep.still} alt="" draggable={false} loading="lazy" />
                  ) : (
                    <span className="episode-still-fallback">{ep.label}</span>
                  )}
                  <span className="episode-play" aria-hidden="true">
                    {busy ? <IconSpinner /> : <IconPlay />}
                  </span>
                  {progress !== null && (
                    <span className="episode-progress">
                      <span style={{ width: `${progress}%` }} />
                    </span>
                  )}
                </span>

                <span className="episode-text">
                  <span className="episode-title-row">
                    <span className="episode-name">{ep.name}</span>
                    {ep.runtimeMinutes ? (
                      <span className="episode-runtime">{fmtRuntime(ep.runtimeMinutes)}</span>
                    ) : null}
                  </span>
                  {ep.overview && <span className="episode-overview">{ep.overview}</span>}
                  {!ep.available && (
                    <span className="episode-offline">
                      {ep.offlineOn ? `On ${ep.offlineOn}` : 'Not on any paired drive'}
                    </span>
                  )}
                </span>
              </button>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

function DetailModal({
  card,
  initialSeason,
  onClose,
  onPlay,
  onToggleList,
  starting,
}: {
  card: TitleCard;
  /** Opened from a season card: the episode list starts on that season. */
  initialSeason?: number;
  onClose: () => void;
  /** `episodeKey` plays that episode; omitted, a show plays next-up. */
  onPlay: (tracks?: TrackChoice, episodeKey?: string) => void;
  onToggleList: () => void;
  /** A film is being opened; the dialog stays until it is running. */
  starting: boolean;
}) {
  const isShow = card.type === 'show';
  const next = card.show?.nextUp ?? null;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  /**
   * What is in the file, fetched when the dialog opens rather than carried on every
   * browse card — a remux's track table is large and only this surface wants it.
   */
  const [tracks, setTracks] = useState<TrackInfo | null>(null);
  const [audio, setAudio] = useState<number | undefined>();
  const [subtitle, setSubtitle] = useState<number | 'no' | undefined>();

  useEffect(() => {
    let live = true;
    setTracks(null);
    window.playback
      .tracks(card.id)
      .then((info) => {
        if (!live) return;
        setTracks(info);
        // Start from whatever was chosen last time, so reopening shows the truth.
        setAudio(info.choice?.audio);
        setSubtitle(info.choice?.subtitle);
      })
      // A missing track table costs the picker, not the dialog.
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [card.id]);

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

              {/* For a show, say WHICH episode Play means before the button does it. */}
              {isShow && next && (
                <div className="nextup">
                  <span className="nextup-kind">{NEXT_UP_REASON[next.reason]}</span>
                  <span className="nextup-episode">
                    <strong>{next.label}</strong>
                    {next.name ? <span className="nextup-name"> · {next.name}</span> : null}
                  </span>
                  {next.resumePct !== null && (
                    <div className="resume-bar nextup-bar">
                      <span style={{ width: `${next.resumePct}%` }} />
                    </div>
                  )}
                </div>
              )}

              {!isShow && card.resumeSec !== null && (
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
                  onClick={() => onPlay({ audio, subtitle })}
                  disabled={!card.available || starting}
                >
                  {starting ? <IconSpinner /> : <IconPlay />}
                  <span>{starting ? 'Starting…' : playLabel(card)}</span>
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
            {/*
              * Shown only when there is a decision to make — one audio track and no
              * subtitles is not a choice, and a control that cannot change anything
              * is the same fault the browse filters avoid.
              *
              * It belongs here rather than in the action row above: crowding Play with
              * two dropdowns buries the button the dialog exists for.
              */}
            {tracks && (tracks.audio.length > 1 || tracks.subtitles.length > 0) && (
              <div className="track-picker">
                {tracks.audio.length > 1 && (
                  <TrackSelect
                    label="Audio"
                    options={tracks.audio}
                    value={audio}
                    // No "off" option is offered for audio, so 'no' cannot arrive —
                    // narrowed here rather than cast, so adding one later is a type
                    // error instead of a silently ignored value.
                    onChange={(v) => setAudio(v === 'no' ? undefined : v)}
                  />
                )}
                {tracks.subtitles.length > 0 && (
                  <TrackSelect
                    label="Subtitles"
                    options={tracks.subtitles}
                    value={subtitle}
                    onChange={setSubtitle}
                    offLabel="Off"
                  />
                )}
              </div>
            )}

            <div className="modal-body">
              <div>
                <div className="modal-meta">
                  {isShow ? (
                    <>
                      {card.show?.yearLabel && <span>{card.show.yearLabel}</span>}
                      <span>{card.show?.seasonsLabel}</span>
                    </>
                  ) : (
                    <>
                      {card.year && <span>{card.year}</span>}
                      <span>{fmtRuntime(card.runtimeMinutes)}</span>
                    </>
                  )}
                  <span className="tag">{card.resolution}</span>
                  {card.hdr !== 'SDR' && <span className="tag hdr">{card.hdr}</span>}
                  {card.certification && <span className="cert">{card.certification}</span>}
                </div>
                {card.tagline && <p className="tagline">{card.tagline}</p>}
                {card.overview ? (
                  <p className="overview">{card.overview}</p>
                ) : (
                  // A show told through its episodes' own synopses is not "undescribed".
                  !card.show?.episodesAsFilms && <p className="overview">No description available.</p>
                )}
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
                {/* A show's director changes every episode; who made it is its creator. */}
                {isShow && (card.show?.creators.length ?? 0) > 0 && (
                  <p>
                    <span className="label">Created by: </span>
                    {card.show!.creators.join(', ')}
                  </p>
                )}
                {card.genres.length > 0 && (
                  <p>
                    <span className="label">Genres: </span>
                    {card.genres.join(', ')}
                  </p>
                )}
                {isShow && card.studio && (
                  <p>
                    <span className="label">Network: </span>
                    {card.studio}
                  </p>
                )}
                <p className="file-line">
                  {card.audio && <>{card.audio} · </>}
                  {isShow
                    ? `${card.show?.episodeCount} ${card.show?.episodeCount === 1 ? 'episode' : 'episodes'}`
                    : `${card.bitrateMbps} Mb/s`}{' '}
                  · {fmtBytes(card.sizeBytes)}
                </p>
                {card.editions.length > 1 && (
                  <p>
                    <span className="label">Versions: </span>
                    {card.editions.join(', ')}
                  </p>
                )}
              </aside>
            </div>

            {isShow && (
              <EpisodeList
                card={card}
                initialSeason={initialSeason}
                starting={starting}
                onPlayEpisode={(key) => onPlay({ audio, subtitle }, key)}
              />
            )}
          </div>
        </div>
      </div>
    </>
  );
}

// --- Row --------------------------------------------------------------------

/**
 * A shelf, either as a horizontal row or as a wrapping grid.
 *
 * Browsing is rows: a shelf is a slice of the library and its length is not the point.
 * A RESULT — from search, from My List, from a filter — is a set, and its size is the
 * whole point, so it wraps. Twelve results in a horizontal strip leave four fifths of
 * the page black and read as a broken page rather than an answer.
 *
 * The grid is the easier of the two for the hover card: `.row-scroller` is
 * `scroll-snap-type: x proximity`, and a scaling `.tile:hover` makes the browser
 * re-snap and fire a scroll event with nothing having moved. A grid neither scrolls
 * horizontally nor snaps, so that whole class of flicker cannot arise.
 */
function Row({
  title,
  cards,
  layout = 'row',
  onHover,
  onOpen,
}: {
  title: string;
  cards: TitleCard[];
  layout?: 'row' | 'grid';
  onHover: (card: TitleCard, rect: DOMRect, el: HTMLElement) => void;
  onOpen: (card: TitleCard) => void;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const page = (dir: 1 | -1) => {
    const el = scroller.current;
    if (el) el.scrollBy({ left: dir * el.clientWidth * 0.9, behavior: 'smooth' });
  };

  const tiles = cards.map((card) => (
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
  ));

  if (layout === 'grid') {
    return (
      <section className="row is-grid">
        <h2 className="row-title">{title}</h2>
        <div className="row-grid">{tiles}</div>
      </section>
    );
  }

  return (
    <section className="row">
      <h2 className="row-title">{title}</h2>
      <div className="row-viewport">
        <button className="pager left" onClick={() => page(-1)} aria-label="Scroll left">
          ‹
        </button>
        <div className="row-scroller" ref={scroller}>
          {tiles}
        </div>
        <button className="pager right" onClick={() => page(1)} aria-label="Scroll right">
          ›
        </button>
      </div>
    </section>
  );
}

type ShelfKind = RowKind | 'results';
type Shelf = { kind: ShelfKind; title: string; subtitle?: string; cards: TitleCard[] };

/** "Season 1950" → a small "SEASON" over a large "1950". "Miniseries", "Specials" stay words. */
function seasonCaption(name: string): { kicker: string | null; big: string; isWord: boolean } {
  const m = name.match(/^season\s+(\d+)$/i);
  return m ? { kicker: 'Season', big: m[1], isWord: false } : { kicker: null, big: name, isWord: true };
}

/**
 * A show's own shelf: one card per season, the way a franchise gets a collection row.
 *
 * A card opens the detail view ON its season — choosing "Season 1950" and landing on
 * 1940's episodes would make the card a decoration. These are not hover-card tiles: the
 * hover preview describes a TITLE, and every card on this shelf is the same title, so it
 * would say the same thing six times over.
 */
function SeasonShelf({
  card,
  title,
  subtitle,
  onOpenSeason,
}: {
  card: TitleCard;
  title: string;
  subtitle?: string;
  onOpenSeason: (season: number) => void;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const page = (dir: 1 | -1) => {
    const el = scroller.current;
    if (el) el.scrollBy({ left: dir * el.clientWidth * 0.9, behavior: 'smooth' });
  };
  const seasons: SeasonCard[] = card.show?.seasons ?? [];

  return (
    <section className="row season-shelf">
      <h2 className="row-title">
        {title}
        {subtitle && <span className="row-subtitle">{subtitle}</span>}
      </h2>
      <div className="row-viewport">
        <button className="pager left" onClick={() => page(-1)} aria-label="Scroll left">
          ‹
        </button>
        <div className="row-scroller" ref={scroller}>
          {seasons.map((s) => {
            const caption = seasonCaption(s.name);
            // A season without art of its own wears the show's, and says which season it is.
            const art = s.poster ?? card.poster;
            const where = s.available ? null : s.offlineOn ? `On ${s.offlineOn}` : 'Not on any paired drive';
            return (
              <button
                key={s.season}
                className={`tile season-tile${s.available ? '' : ' offline'}`}
                onClick={() => onOpenSeason(s.season)}
                aria-label={`${card.title}, ${s.name}: ${s.episodeCount} episodes${where ? `, ${where}` : ''}`}
              >
                {art ? <img src={art} alt="" draggable={false} loading="lazy" /> : <div className="art-fallback" />}
                {s.upNext && <span className="season-badge">Up next</span>}
                <span className="season-caption">
                  {caption.kicker && <span className="season-kicker">{caption.kicker}</span>}
                  <span className={`season-big${caption.isWord ? ' is-word' : ''}`}>{caption.big}</span>
                  <span className="season-meta">
                    {where ??
                      [`${s.episodeCount} ${s.episodeCount === 1 ? 'episode' : 'episodes'}`, s.yearLabel]
                        .filter(Boolean)
                        .join(' \u00b7 ')}
                  </span>
                  {/* Always present, hidden when unwatched: its height is what keeps every
                      card's caption on one line across the shelf. Without it, a season
                      you had started sat its "SEASON 1940" higher than its neighbour's. */}
                  <span
                    className={`season-watched${s.watchedCount > 0 ? '' : ' is-empty'}`}
                    aria-hidden={s.watchedCount === 0}
                  >
                    <span className="season-watched-bar">
                      <span style={{ width: `${(s.watchedCount / Math.max(1, s.episodeCount)) * 100}%` }} />
                    </span>
                    {s.watchedCount === s.episodeCount ? 'Watched' : `${s.watchedCount} of ${s.episodeCount}`}
                  </span>
                </span>
              </button>
            );
          })}
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
  const [view, setView] = useState<'home' | 'list' | 'shows' | 'films'>('home');

  /**
   * Search matters at real library sizes. Nine posters fit on a screen; a hundred and
   * twenty-eight do not, and scrolling genre rows to find a specific film is hopeless.
   */
  const [query, setQuery] = useState('');

  /**
   * Sort and filter.
   *
   * Both narrow the shelf into ONE ordered set, exactly as search does, for the same
   * reason: the same film under "Action", "Science Fiction" and "Recently Added" reads
   * as three results. A sort counts as narrowing on its own — asking for the library
   * in title order and getting genre rows each internally sorted is not what was asked.
   */
  const [sort, setSort] = useState<SortKey>(DEFAULT_SORT);
  const [filters, setFilters] = useState<Filters>(NO_FILTERS);
  const [filterOpen, setFilterOpen] = useState(false);

  // Escape closes the panel. The detail modal has its own handler; this one only
  // listens while the panel is actually open, so the two cannot fight over the key.
  useEffect(() => {
    if (!filterOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setFilterOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [filterOpen]);

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
  const play = async (
    titleId: string,
    fromStart = false,
    tracks?: TrackChoice,
    episodeKey?: string,
  ) => {
    setPlayError(null);
    suspendTrailer();
    setStarting(true);
    try {
      // Only the detail view carries a picker. Everywhere else sends nothing, and the
      // main process falls back to whatever was chosen for this film last time.
      await window.playback.play(titleId, { fromStart, tracks, episodeKey });
      setHover(null);
      closeDetail();
    } catch (err) {
      // Without rendering this, a failed Play does nothing visible at all — the most
      // confusing possible outcome.
      const message = errorMessage(err);
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
  /**
   * The artwork of the film the billboard is leaving, kept alive for the length of the
   * cross-dissolve.
   *
   * Without it there is nothing to dissolve FROM: the hero layer remounts on the new
   * title, so fading it in would reveal the page background rather than the previous
   * film. One extra `<img>` for under a second is a cheap way to make a hand-over read
   * as one picture becoming another.
   */
  const [outgoingArt, setOutgoingArt] = useState<string | null>(null);
  /** What the billboard is showing right now, read during the swap effect below. */
  const heroSnapshot = useRef<{ id: string; backdrop: string | null } | null>(null);
  const lastHeroId = useRef<string | null>(null);
  /** The backdrop currently on screen, so the next turn knows what it is leaving. */
  const outgoingRef = useRef<string | null>(null);
  const dissolveTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const [hover, setHover] = useState<{
    card: TitleCard;
    rect: DOMRect;
    /** The tile element, so the card can tell a real scroll from snap jitter. */
    el: HTMLElement | null;
  } | null>(null);
  const [open, setOpen] = useState<TitleCard | null>(null);
  /** The season a season card asked for; cleared with the dialog, so it never lingers. */
  const [openSeason, setOpenSeason] = useState<number | undefined>();
  const openDetail = (card: TitleCard, season?: number) => {
    setHover(null);
    setOpenSeason(season);
    setOpen(card);
  };
  const closeDetail = () => {
    setOpen(null);
    setOpenSeason(undefined);
  };
  const [scrolled, setScrolled] = useState(false);

  const load = useCallback(async () => {
    setData(await window.libraries.browse(volumeId));
  }, [volumeId]);

  useEffect(() => {
    void load();
    return window.libraries.onChanged(() => void load());
  }, [load]);

  /**
   * Hold the outgoing artwork for the length of the dissolve, then drop it.
   *
   * Deliberately NOT keyed on the hero id in a dependency array: the snapshot is taken
   * during render, so the comparison has to happen after every commit to catch the one
   * where it changed.
   */
  useEffect(() => {
    const now = heroSnapshot.current;
    const was = lastHeroId.current;
    if (now && was && now.id !== was && outgoingRef.current) {
      /*
       * The timer lives in a ref, NOT in this effect's cleanup.
       *
       * This effect runs after every render by design — the snapshot is taken during
       * render, so the comparison has to happen on every commit to catch the one where
       * it changed. Returning `clearTimeout` from it therefore cancelled the timer on
       * the very next render, which `setOutgoingArt` had just caused. The outgoing
       * layer was never removed: measured still mounted seven seconds into a 900ms
       * dissolve, and it would have been stale when the next hand-over began.
       */
      clearTimeout(dissolveTimer.current);
      setOutgoingArt(outgoingRef.current);
      dissolveTimer.current = setTimeout(() => setOutgoingArt(null), HERO_DISSOLVE_MS);
    }
    if (now) {
      lastHeroId.current = now.id;
      outgoingRef.current = now.backdrop;
    }
  });

  useEffect(() => () => clearTimeout(dissolveTimer.current), []);

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
   * It follows what was added most recently, films and shows together, newest first,
   * and moves on each time a
   * trailer has been round once. That replaces the old rule, which was not a selection
   * at all: the first title `readdir` happened to return with artwork, which meant the
   * same film every launch forever.
   *
   * Titles without a backdrop are skipped — a hero with no artwork is a blank
   * rectangle with text on it. The row's own order is otherwise preserved, so the
   * billboard shows you what arrived most recently, newest first.
   */
  // Both Recently Added rows — films and shows — merged back into arrival order.
  const recentIds = data.rows
    .filter((r) => r.kind === 'recent')
    .flatMap((r) => r.titleIds)
    .sort((a, b) => (byId.get(b)?.addedAt ?? '').localeCompare(byId.get(a)?.addedAt ?? ''));
  const heroQueue = buildHeroQueue(recentIds, (id) => Boolean(byId.get(id)?.backdrop));
  const hero =
    (heroQueue.length ? byId.get(heroQueue[heroIndex % heroQueue.length]) : null) ??
    (data.heroId ? byId.get(data.heroId) : null);
  heroSnapshot.current = hero ? { id: hero.id, backdrop: hero.backdrop } : null;

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
    (c.show?.creators ?? []).some((d) => d.toLowerCase().includes(q)) ||
    c.cast.some((n) => n.toLowerCase().includes(q));

  /**
   * The view picks the base set, search narrows it, filters narrow it again, and a
   * narrowed set is sorted. They compose rather than override each other: filtering
   * search results, or sorting My List, are both reasonable things to want.
   */
  /*
   * TV Shows and Films are offered only when the library holds both — a tab that shows
   * the same thing as Browse is a control that cannot change anything, the same rule
   * the filter facets follow.
   */
  const hasShows = allCards.some((c) => c.type === 'show');
  const hasFilms = allCards.some((c) => c.type === 'movie');
  // Derived, not stored: if a rescan leaves only films, the TV tab disappears and the
  // page reads as Browse — rather than staying stuck on a view with no way back.
  const activeView =
    (view === 'shows' || view === 'films') && !(hasShows && hasFilms) ? 'home' : view;
  const typeView = activeView === 'shows' ? 'show' : activeView === 'films' ? 'movie' : null;

  const base =
    activeView === 'list'
      ? allCards.filter((c) => c.inMyList)
      : typeView
        ? allCards.filter((c) => c.type === typeView)
        : allCards;
  const searched = q ? base.filter(matches) : base;
  const result = applyFilters(searched, filters);

  const narrowed = isNarrowed(filters, sort);
  const collapsed = Boolean(q) || activeView === 'list' || narrowed;

  // Only a narrowed set is re-ordered. My List keeps the order things were added in
  // and search keeps the library's, which is what each of them meant before.
  const resultCards = narrowed ? sortCards(result, sort) : result;

  const resultTitle = q
    ? `Results for “${query.trim()}”`
    : activeView === 'list'
      ? 'My List'
      : countNoun(result);

  /*
   * TV Shows / Films keep the SHELVES, filtered — the way Netflix's own TV and Films
   * pages are shelves rather than a grid. The fixed rows survive with one title; a
   * genre or franchise row filtered down to one is noise and goes, the same MIN_ROW
   * rule the main process applies. "TV Shows" is dropped from the TV view as redundant.
   */
  const shelves: Shelf[] = (data?.rows ?? []).map((row) => ({
    kind: row.kind,
    title: row.title,
    subtitle: row.subtitle,
    cards: row.titleIds.map((id) => byId.get(id)).filter(Boolean) as TitleCard[],
  }));
  // Rows that stand with one title: the fixed rows, and a show's own shelf — whose
  // cards are its seasons, however many titles it holds.
  const KEEP_WITH_ONE = new Set<ShelfKind>(['continue', 'my-list', 'recent', 'seasons']);
  const typedShelves = typeView
    ? shelves
        // The tab already says which kind; "Recently Added TV Shows" there repeats itself.
        .map((row) => (row.kind === 'recent' ? { ...row, title: 'Recently Added' } : row))
        .map((row) => ({ ...row, cards: row.cards.filter((c) => c.type === typeView) }))
        .filter((row) => row.cards.length >= (KEEP_WITH_ONE.has(row.kind) ? 1 : 2))
    : shelves;

  const visibleRows: Shelf[] = collapsed
    ? [{ kind: 'results', title: resultTitle, cards: resultCards }]
    : typedShelves;

  // Offered from what the library actually holds, never a fixed list — a pill that
  // cannot change the result set is a control that looks broken when you press it.
  const available = facets(base);
  const filterCount = activeCount(filters);
  const resetFilters = () => {
    setFilters(NO_FILTERS);
    setSort(DEFAULT_SORT);
  };

  // The hero belongs to the full browse. Over a filtered view it is just a large
  // picture of something you did not ask for.
  const showHero = !q && activeView === 'home' && !narrowed;

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
            className={activeView === 'home' ? 'active' : ''}
            onClick={() => {
              setView('home');
              setQuery('');
            }}
          >
            Browse
          </button>
          {hasShows && hasFilms && (
            <>
              <button
                className={activeView === 'shows' ? 'active' : ''}
                onClick={() => {
                  setView('shows');
                  setQuery('');
                }}
              >
                TV Shows
              </button>
              <button
                className={activeView === 'films' ? 'active' : ''}
                onClick={() => {
                  setView('films');
                  setQuery('');
                }}
              >
                Films
              </button>
            </>
          )}
          <button
            className={activeView === 'list' ? 'active' : ''}
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

        <div className="nav-filter">
          <button
            className={`filter-toggle${filterOpen ? ' open' : ''}${narrowed ? ' on' : ''}`}
            onClick={() => setFilterOpen((v) => !v)}
            aria-expanded={filterOpen}
            aria-label="Sort and filter"
          >
            {/* Drawn, never typed — a glyph sits on a text baseline rather than in the
                middle of its button. See CLAUDE.md §Buttons. */}
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <g stroke="currentColor" strokeWidth="2" strokeLinecap="round" fill="none">
                <path d="M4 7h7M15 7h5M4 12h11M19 12h1M4 17h3M11 17h9" />
                <circle cx="13" cy="7" r="2" />
                <circle cx="17" cy="12" r="2" />
                <circle cx="9" cy="17" r="2" />
              </g>
            </svg>
            <span>Filters</span>
            {filterCount > 0 && <span className="filter-badge">{filterCount}</span>}
          </button>

          {filterOpen && (
            <>
              {/* Closes on a click anywhere else. Behind the panel, so the panel's own
                  controls are still reachable. */}
              <div className="filter-backdrop" onClick={() => setFilterOpen(false)} />
              <div className="filter-panel" role="dialog" aria-label="Sort and filter">
                <section>
                  <h3>Sort by</h3>
                  <div className="filter-sorts">
                    {SORTS.map((s) => (
                      <button
                        key={s.key}
                        className={sort === s.key ? 'on' : ''}
                        onClick={() => setSort(s.key)}
                      >
                        {s.label}
                      </button>
                    ))}
                  </div>
                </section>

                {available.genres.length > 0 && (
                  <section>
                    <h3>Genre</h3>
                    <div className="filter-pills">
                      {available.genres.map((g) => (
                        <button
                          key={g}
                          className={filters.genres.includes(g) ? 'on' : ''}
                          onClick={() =>
                            setFilters((f) => ({ ...f, genres: toggleValue(f.genres, g) }))
                          }
                        >
                          {g}
                        </button>
                      ))}
                    </div>
                  </section>
                )}

                {(available.resolutions.length > 0 || available.hdr) && (
                  <section>
                    <h3>Quality</h3>
                    <div className="filter-pills">
                      {available.resolutions.map((r) => (
                        <button
                          key={r}
                          className={filters.resolutions.includes(r) ? 'on' : ''}
                          onClick={() =>
                            setFilters((f) => ({
                              ...f,
                              resolutions: toggleValue(f.resolutions, r),
                            }))
                          }
                        >
                          {r === '2160p' ? '4K' : r}
                        </button>
                      ))}
                      {available.hdr && (
                        <button
                          className={filters.hdr ? 'on' : ''}
                          onClick={() => setFilters((f) => ({ ...f, hdr: !f.hdr }))}
                        >
                          HDR
                        </button>
                      )}
                    </div>
                  </section>
                )}

                {(available.unwatched || available.availability) && (
                  <section>
                    <h3>Show</h3>
                    <div className="filter-pills">
                      {available.unwatched && (
                        <button
                          className={filters.unwatched ? 'on' : ''}
                          onClick={() => setFilters((f) => ({ ...f, unwatched: !f.unwatched }))}
                        >
                          Unwatched
                        </button>
                      )}
                      {available.availability && (
                        <button
                          className={filters.available ? 'on' : ''}
                          onClick={() => setFilters((f) => ({ ...f, available: !f.available }))}
                        >
                          On a connected drive
                        </button>
                      )}
                    </div>
                  </section>
                )}

                <footer className="filter-foot">
                  <span>
                    {result.length} of {base.length}
                  </span>
                  <button className="filter-reset" disabled={!narrowed} onClick={resetFilters}>
                    Reset
                  </button>
                </footer>
              </div>
            </>
          )}
        </div>
      </header>

      {showHero && hero && (
        <div className="hero">
          {/* The film being left behind, fading out UNDER the one arriving. First in
              the DOM so it paints below without needing a z-index of its own. */}
          {outgoingArt && (
            <img className="hero-outgoing" src={outgoingArt} alt="" draggable={false} />
          )}

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
                <span>{starting ? 'Starting…' : playLabel(hero)}</span>
              </button>
              <button className="info-button" onClick={() => openDetail(hero)}>
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
        {visibleRows.map((row) =>
          row.kind === 'seasons' && row.cards[0] ? (
            <SeasonShelf
              key={`seasons:${row.cards[0].id}`}
              card={row.cards[0]}
              title={row.title}
              subtitle={row.subtitle}
              onOpenSeason={(season) => openDetail(row.cards[0], season)}
            />
          ) : (
            <Row
              key={`${row.kind}:${row.title}`}
              title={row.title}
              cards={row.cards}
              layout={collapsed ? 'grid' : 'row'}
              onHover={(card, rect, el) => setHover({ card, rect, el })}
              onOpen={(card) => openDetail(card)}
            />
          ),
        )}

        {/*
          * Say what happened AND what to do, rather than showing a blank page.
          *
          * Which of these it is matters: a search and a filter can both be narrowing at
          * once, and blaming the search alone for a result the FILTER excluded sends
          * you off retyping a query that was never the problem.
          */}
        {collapsed && visibleRows[0].cards.length === 0 && (
          <p className="browse-empty">
            {activeView === 'list' && base.length === 0 ? (
              <>
                Your list is empty. Hover any film and press <strong>+</strong> to save it here.
              </>
            ) : q && narrowed ? (
              <>
                Nothing matches “{query.trim()}” with these filters.{' '}
                <button className="link-button" onClick={resetFilters}>
                  Reset the filters
                </button>
                .
              </>
            ) : q ? (
              <>Nothing matches “{query.trim()}”.</>
            ) : (
              <>
                No film matches these filters.{' '}
                <button className="link-button" onClick={resetFilters}>
                  Reset them
                </button>
                .
              </>
            )}
          </p>
        )}
      </div>

      {hover && !open && (
        <HoverCard
          card={hover.card}
          rect={hover.rect}
          anchor={hover.el}
          onLeave={() => setHover(null)}
          onOpen={() => openDetail(hover.card)}
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
          initialSeason={openSeason}
          onClose={closeDetail}
          onPlay={(tracks, episodeKey) => void play(open.id, false, tracks, episodeKey)}
          onToggleList={() => void toggleList(open)}
          starting={starting}
        />
      )}
    </div>
  );
}
