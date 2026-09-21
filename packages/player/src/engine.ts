/**
 * The playback seam. See ARCHITECTURE.md §9.1.
 *
 * Two implementations will satisfy this: ExternalMpvEngine (Tier 0, separate process)
 * and EmbeddedMpvEngine (Tier 1, libmpv render API into an app-owned NSView). Nothing
 * above this interface may know which is running — that is the entire point.
 */

export type SeekMode = 'absolute' | 'relative';
export type TrackType = 'audio' | 'sub';
export type TrackId = number | 'no' | 'auto';
export type Unsub = () => void;

export type MpvTrack = {
  id: number;
  type: 'video' | 'audio' | 'sub';
  selected: boolean;
  codec?: string;
  lang?: string;
  title?: string;
  channels?: number;
  'demux-channel-count'?: number;
  default?: boolean;
  forced?: boolean;
  external?: boolean;
};

export type MpvChapter = { title: string; time: number };

/**
 * Observable properties, typed. Anything not listed here should be added rather
 * than cast — the type map is what keeps the React layer honest.
 */
export type MpvPropertyMap = {
  'time-pos': number | null;
  'duration': number | null;
  'percent-pos': number | null;
  pause: boolean;
  'eof-reached': boolean;
  'core-idle': boolean;
  'seeking': boolean;
  path: string | null;
  'media-title': string | null;
  'track-list': MpvTrack[];
  'chapter-list': MpvChapter[];
  chapter: number | null;
  aid: number | false;
  sid: number | false;
  volume: number;
  mute: boolean;
  width: number | null;
  height: number | null;
  'video-bitrate': number | null;
  'demuxer-cache-duration': number | null;
  'demuxer-cache-time': number | null;
  /**
   * The capability probe from ARCHITECTURE.md §2.1. Reports the decoder actually in
   * use, e.g. 'videotoolbox' or 'no' when it fell back to software. This is ground
   * truth on any chip, including ones that do not exist yet, which is why we measure
   * it instead of shipping a lookup table.
   */
  'hwdec-current': string;
  /** Frames the video output could not present in time. Drives the quality watchdog. */
  'frame-drop-count': number;
  /** Frames the decoder itself dropped — a much worse sign than VO drops. */
  'decoder-frame-drop-count': number;
  'display-fps': number | null;
  'estimated-display-fps': number | null;
  'container-fps': number | null;
  'file-format': string | null;
  'video-format': string | null;
  'audio-codec-name': string | null;
  'current-ao': string | null;
  'audio-params/channel-count': number | null;
  'audio-params/hr-channels': string | null;
  'audio-out-params/channel-count': number | null;
  'audio-out-params/hr-channels': string | null;
  'audio-device': string | null;
  speed: number;
  /** mpv's actual window size in pixels — used to keep the overlay aligned to it. */
  'osd-width': number | null;
  'osd-height': number | null;
  /** What the FILE is. */
  'video-params/primaries': string | null;
  'video-params/gamma': string | null;
  'video-params/bitdepth': number | null;
  'video-params/max-luma': number | null;
  /** What is actually reaching the display — the two differ when tone-mapping. */
  'video-out-params/primaries': string | null;
  'video-out-params/gamma': string | null;
  'target-colorspace-hint': boolean;
  'target-peak': string;
  'current-vo': string | null;
};

export type MpvProp = keyof MpvPropertyMap;

export type LoadOptions = {
  /** Resume position in seconds. */
  startAt?: number;
  /** mpv track id, not a stream index. */
  audioTrack?: number;
  subtitleTrack?: number | 'no';
};

export type PlaybackEngine = {
  load(path: string, opts?: LoadOptions): Promise<void>;
  play(): void;
  pause(): void;
  togglePause(): Promise<boolean>;
  seek(sec: number, mode: SeekMode): void;
  setTrack(type: TrackType, id: TrackId): Promise<void>;
  setVolume(volume: number): Promise<void>;
  setMute(mute: boolean): Promise<void>;
  setSpeed(speed: number): Promise<void>;
  get<K extends MpvProp>(prop: K): Promise<MpvPropertyMap[K]>;
  observe<K extends MpvProp>(prop: K, cb: (value: MpvPropertyMap[K]) => void): Unsub;
  /** Grab a frame for scrub previews. Tier 0 uses a throwaway process. */
  screenshotAt(sec: number, outPath: string): Promise<string>;
  dispose(): Promise<void>;
};
