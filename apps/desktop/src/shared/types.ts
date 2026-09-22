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
  totalBytes: number;
  needsMetadata: number;
  availableCount: number;
};

export type TitleCard = {
  id: string;
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

export type BrowseData = {
  titles: TitleCard[];
  rows: Array<{ title: string; titleIds: string[] }>;
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

export type PlaybackApi = {
  play(titleId: string, versionIndex?: number, fromStart?: boolean): Promise<{ ok: boolean }>;
  stop(): Promise<void>;
};
