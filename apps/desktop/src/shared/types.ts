/** Sentinel volume id meaning "every library at once". */
export const ALL_LIBRARIES = '__all__';

/** Shared between main and renderer. The renderer never imports @nfl/core directly. */

export type LibraryCard = {
  /**
   * The synthetic "everything" card, not a real paired volume.
   *
   * Its counts are DEDUPLICATED: a film held on two drives is one title with two
   * sightings, so adding the per-drive numbers would overstate the library. Its bytes
   * count one copy per film — the volume of distinct content, not of disk used.
   */
  combined?: boolean;
  /** How many films are held on more than one drive. Only set on the combined card. */
  duplicateCount?: number;
  /** Seeds for drawing a shelf per source library. Only set on the combined card. */
  shelfSeeds?: string[];
  id: string;
  label: string;
  path: string;
  kind: 'local' | 'removable' | 'smb' | 'nfs';
  fileSystem?: string;
  connected: boolean;
  /** Never scanned, so the card should offer Scan rather than Rescan. */
  neverScanned: boolean;

  relocated: boolean;
  titleCount: number;
  /** How many of `titleCount` are shows — so a 40-episode series is "1 show", not 40 films. */
  showCount: number;
  totalBytes: number;
  needsMetadata: number;
  availableCount: number;
  /**
   * Connected, but some file is no longer where the last scan saw it — the drive has
   * been reorganised. The picker rescans such a drive by itself, once per launch;
   * identity is content, so the moved files are found and nothing about them is lost.
   */
  filesMoved?: boolean;
};

/**
 * One selectable track, already labelled by the main process.
 *
 * `id` is mpv's `aid`/`sid` — 1-based within its own type — not an ffprobe stream
 * index. The renderer passes it straight back and never does arithmetic on it.
 */
export type TrackOption = {
  id: number;
  label: string;
  detail?: string;
  isDefault: boolean;
  isCommentary: boolean;
};

/** Which episode Play means for a show, already decided by the main process. */
export type NextUpCard = {
  /** Slot key, `"1:4"` — what `play({ episodeKey })` takes back. */
  key: string;
  /** `S1:E4` — Netflix's short form. */
  label: string;
  name?: string;
  reason: 'resume' | 'next' | 'start' | 'rewatch';
  resumePct: number | null;
  available: boolean;
  offlineOn: string | null;
};

/** One season, as a card on its show's own shelf. */
export type SeasonCard = {
  season: number;
  /** "Season 1950", "Miniseries", "Specials" — the episode list's own name for it. */
  name: string;
  /** Episodes on your drives. */
  episodeCount: number;
  /** "1950–1958", or a single year: from the episodes' air dates, else TMDB's season year. */
  yearLabel?: string;
  /** media:// URL of the season's own poster; null means the card wears the show's. */
  poster: string | null;
  watchedCount: number;
  /** Where you are: next-up is in this season, and you have started the show. */
  upNext: boolean;
  /** At least one episode of it is reachable now. */
  available: boolean;
  /** When none is: the drive to plug in. */
  offlineOn: string | null;
};

/** Show-only facts for tiles, the hover card and the billboard. */
export type ShowSummary = {
  seasonCount: number;
  /**
   * "2 Seasons", "Season 2", "Limited Series", "Specials", or "46 Episodes" for one
   * season numbered by a year — what Netflix prints there.
   */
  seasonsLabel: string;
  episodeCount: number;
  creators: string[];
  /** "2008–2013" for an ended show; just the first year while it is running. */
  yearLabel?: string;
  /** Null only for a show with no playable episode numbering. */
  nextUp: NextUpCard | null;
  /**
   * Described episode by episode from TMDB films (Tom and Jerry's shorts). There is no
   * series synopsis to show — each episode has its own — so the detail view leaves the
   * space out rather than printing the "No description" meant for unmatched titles.
   */
  episodesAsFilms: boolean;
  /** Every owned season in order, Specials last — the cards on the show's shelf. */
  seasons: SeasonCard[];
};

export type TitleCard = {
  id: string;
  type: 'movie' | 'show';
  /** Present exactly when `type === 'show'`. */
  show?: ShowSummary;
  title: string;
  /** The scanner's article-stripped form, so "The Dark Knight" files under D. */
  sortTitle: string;
  year?: number;
  tagline?: string;
  overview: string;
  genres: string[];
  runtimeMinutes?: number;
  certification?: string;
  cast: string[];
  directors: string[];
  /** A film's studio, or a show's network ("HBO") — what people know a series by. */
  studio?: string;
  /** TMDB's franchise grouping, when the film is in one. Drives the collection rows. */
  collection?: { id: number; name: string };
  /** ISO timestamp of when the scanner first recorded it — the sort key for "recent". */
  addedAt: string;

  /** media:// URLs, or null when that artwork was never downloaded. */
  poster: string | null;
  backdrop: string | null;
  logo: string | null;

  /** Technical badges for the detail view. */
  resolution: string;
  hdr: string;
  audio: string | null;
  sizeBytes: number;
  bitrateMbps: number;

  available: boolean;
  /** Drive name, shown instead of Play when the disk is elsewhere. */
  offlineOn: string | null;
  /** Several cuts of the same film. */
  editions: string[];

  resumeSec: number | null;
  /**
   * How far through, 0–100, computed where BOTH the position and the real duration are
   * known. The renderer used to derive this from `runtimeMinutes`, which is a proxy:
   * it is whole minutes, can be absent before enrichment, and is 0 for anything under
   * 30 seconds — so the progress bar silently vanished whenever it was falsy.
   */
  resumePct: number | null;
  /** YouTube trailer URL from TMDB, when one was found. */
  trailerUrl?: string;
  watched: boolean;
  inMyList: boolean;
};

/**
 * Why a row exists. The renderer keys its behaviour on this — which rows survive a
 * TV/Films tab with one title, which one the billboard follows — never on a title
 * string: "Recently Added" became two rows, and every check against the old name
 * would have quietly stopped matching.
 */
export type RowKind = 'continue' | 'my-list' | 'recent' | 'seasons' | 'collection' | 'genre';

export type BrowseRow = {
  kind: RowKind;
  title: string;
  /** One quiet line after the title: "2 Seasons · 114 Episodes · 1940–1958". */
  subtitle?: string;
  titleIds: string[];
};

export type BrowseData = {
  titles: TitleCard[];
  rows: BrowseRow[];
  heroId: string | null;
};

export type ScanProgress = {
  volumeId: string;
  done: number;
  total: number;
  current: string;
  phase: 'scanning' | 'saving' | 'done';
};

export type ScanResult = {
  created: number;
  updated: number;
  unchanged: number;
  /** Known content found at a new path — moved or renamed. */
  moved: number;
  /** Known content seen here for the first time, e.g. copied from another drive. */
  alreadyKnown: number;
  /** Episodes that joined a show already in the library — a new season, say. */
  episodesAdded: number;
  /** Known files re-filed because they now read as the other kind: film ↔ episode. */
  reclassified: number;
  /** Files in the database that are no longer on the drive. */
  missing: Array<{ title: string; relPath: string }>;
  pruned: number;
  elapsedMs: number;
};

export type EnrichProgress = { done: number; total: number; current: string };

export type EnrichResult = {
  /** 'no-token' when TMDB_READ_TOKEN is not configured. */
  skipped: 'no-token' | null;
  matched: number;
  failed: number;
};

export type LibraryApi = {
  /** Fetch artwork and details for anything still unmatched. */
  enrich(): Promise<EnrichResult>;
  setToken(token: string): Promise<boolean>;
  hasToken(): Promise<boolean>;
  onEnrichProgress(cb: (p: EnrichProgress) => void): () => void;
  /** Scan a paired drive and fold the result into the database. */
  scan(volumeId: string, prune?: boolean): Promise<ScanResult>;
  onScanProgress(cb: (p: ScanProgress) => void): () => void;
  list(): Promise<LibraryCard[]>;
  add(): Promise<string | null>;
  remove(id: string): Promise<boolean>;
  reveal(path: string): Promise<void>;
  onChanged(cb: () => void): () => void;
  browse(volumeId?: string): Promise<BrowseData>;
  toggleMyList(titleId: string): Promise<boolean>;
};

/** One episode row in a show's detail view. */
export type EpisodeRow = {
  key: string;
  season: number;
  episode: number;
  episodeEnd?: number;
  /** `S1:E4` */
  label: string;
  /** "4", or "1–2" for a double episode — the big number in the list. */
  number: string;
  /** TMDB's name, else the filename's, else "Episode 4". Never empty. */
  name: string;
  overview?: string;
  runtimeMinutes?: number;
  airDate?: string;
  /** media:// URL of the still, or null when TMDB has none. */
  still: string | null;
  available: boolean;
  offlineOn: string | null;
  resumePct: number | null;
  watched: boolean;
  resolution: string;
  hdr: string;
};

export type SeasonRow = {
  season: number;
  /** "Season 1", "Miniseries", "Specials" — TMDB's name when there is one. */
  name: string;
  /** Episodes on your drives. */
  owned: number;
  /** Episodes TMDB lists, when known — for "8 of 10 episodes". */
  total?: number;
  airYear?: number;
};

export type ShowEpisodes = {
  seasons: SeasonRow[];
  episodes: EpisodeRow[];
  /** The slot key Play means right now, so the list can open on its season. */
  nextUpKey: string | null;
};

/** mpv ids, or `'no'` for subtitles off. Absent means "let the player decide". */
export type TrackChoice = { audio?: number; subtitle?: number | 'no' };

export type TrackInfo = {
  audio: TrackOption[];
  subtitles: TrackOption[];
  /**
   * The audio track "Automatic" plays — the best soundtrack, never a commentary. Shown
   * beside "Automatic" so the picker says what it will do rather than hiding it.
   */
  automaticAudio: number | null;
  /** What was chosen last time, if anything. */
  choice: TrackChoice | null;
};

export type PlayOptions = {
  versionIndex?: number;
  /**
   * Shows only: which episode, as a slot key (`"1:4"`). Omitted means next-up. A slot
   * rather than a file, because one episode can exist in several copies and the main
   * process picks the best reachable one — of THAT episode, never another.
   */
  episodeKey?: string;
  fromStart?: boolean;
  /**
   * What the user chose, field by field. An unchosen audio track is decided in the main
   * process (the best soundtrack, never a commentary); unchosen subtitles are left to
   * the player's own rules.
   */
  tracks?: TrackChoice;
};

export type PlaybackApi = {
  play(titleId: string, opts?: PlayOptions): Promise<{ ok: boolean }>;
  stop(): Promise<void>;
  /**
   * Fetched when the detail view opens rather than shipped on every card: a remux can
   * carry twenty-five subtitle tracks, and the browse payload should not grow by the
   * whole disc's track table for every film in the library.
   */
  tracks(titleId: string, versionIndex?: number): Promise<TrackInfo>;
  /** A show's seasons and episodes, fetched when its detail view opens. */
  episodes(titleId: string): Promise<ShowEpisodes>;
};
