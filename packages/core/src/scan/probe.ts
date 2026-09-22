/**
 * ffprobe wrapper. See ARCHITECTURE.md §5.3 — ffprobe is authoritative for everything
 * technical. Never take codecs, HDR, or audio layout from the filename.
 *
 * Codecs that lack hardware decode on Apple Silicon are flagged here as a *hint* only.
 * Actual decode capability is measured at playback time via mpv's `hwdec-current`
 * (§2.1), because it varies by chip generation and we refuse to ship a chip table.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

export type HdrFormat = 'SDR' | 'HDR10' | 'HDR10+' | 'HLG' | 'DV';

export type AudioTrack = {
  index: number;
  codec: string;
  channels: number;
  lang?: string;
  title?: string;
  bitrateKbps?: number;
  /** Lossless formats macOS must decode to PCM; object layers are lost. */
  objectAudio: boolean;
  isDefault: boolean;
};

/**
 * Bumped whenever this module learns to read something new from a stream.
 *
 * A rescan re-probes any media entry stamped with an older value and refreshes its
 * technical fields. The re-probe is free at that point: ffprobe has already run,
 * because `contentId` needs the duration.
 */
export const PROBE_VERSION = 1;

export type SubtitleTrack = {
  index: number;
  format: string;
  lang?: string;
  title?: string;
  forced: boolean;
  isDefault: boolean;
};

export type Chapter = { title: string; startSec: number };

export type ProbeResult = {
  container: string;
  durationSec: number;
  sizeBytes: number;
  bitrateMbps: number;
  videoCodec: string;
  profile?: string;
  width: number;
  height: number;
  resolution: string;
  bitDepth?: number;
  hdr: HdrFormat;
  dvProfile?: number;
  frameRate?: number;
  /** Hint only — codecs with no hardware decode path on current Apple Silicon. */
  likelySoftwareDecode: boolean;
  audio: AudioTrack[];
  subtitles: SubtitleTrack[];
  chapters: Chapter[];
};

/** Codecs with no dedicated media-engine decode on Apple Silicon (see §2). */
const NO_HW_DECODE = new Set(['vc1', 'mpeg2video', 'vp8', 'vp9']);
/** AV1 gained hardware decode on M3-generation chips; earlier ones fall back. */
const GENERATION_DEPENDENT = new Set(['av1']);

function resolutionLabel(w: number, h: number): string {
  if (h >= 2000 || w >= 3800) return '2160p';
  if (h >= 1000 || w >= 1900) return '1080p';
  if (h >= 700) return '720p';
  if (h >= 540) return '576p';
  return `${h}p`;
}

function parseRate(r?: string): number | undefined {
  if (!r) return undefined;
  const [n, d] = r.split('/').map(Number);
  if (!n || !d) return undefined;
  return Math.round((n / d) * 1000) / 1000;
}

function detectHdr(stream: any): { hdr: HdrFormat; dvProfile?: number } {
  const sideData: any[] = stream.side_data_list ?? [];

  const dv = sideData.find(
    (s) => s.side_data_type === 'DOVI configuration record' || s.dv_profile !== undefined,
  );
  if (dv) return { hdr: 'DV', dvProfile: dv.dv_profile };

  const hasHdr10Plus = sideData.some((s) =>
    String(s.side_data_type ?? '').toLowerCase().includes('hdr dynamic metadata'),
  );

  const trc = stream.color_transfer ?? stream.color_trc;
  if (trc === 'smpte2084') return { hdr: hasHdr10Plus ? 'HDR10+' : 'HDR10' };
  if (trc === 'arib-std-b67') return { hdr: 'HLG' };
  return { hdr: 'SDR' };
}

function bitDepthOf(stream: any): number | undefined {
  if (stream.bits_per_raw_sample) return Number(stream.bits_per_raw_sample);
  const fmt = String(stream.pix_fmt ?? '');
  const m = fmt.match(/(\d{2})le|(\d{2})be/);
  if (m) return Number(m[1] ?? m[2]);
  return fmt.includes('p10') ? 10 : undefined;
}

export async function probe(path: string, sizeBytes: number): Promise<ProbeResult> {
  const { stdout } = await exec(
    'ffprobe',
    [
      '-v', 'quiet',
      '-print_format', 'json',
      '-show_format',
      '-show_streams',
      '-show_chapters',
      path,
    ],
    { maxBuffer: 32 * 1024 * 1024 },
  );

  const data = JSON.parse(stdout);
  const streams: any[] = data.streams ?? [];
  const format: any = data.format ?? {};

  const video = streams.find((s) => s.codec_type === 'video' && s.disposition?.attached_pic !== 1);
  if (!video) throw new Error(`No video stream in ${path}`);

  const durationSec = Number(format.duration ?? video.duration ?? 0);
  const width = Number(video.width ?? 0);
  const height = Number(video.height ?? 0);
  const { hdr, dvProfile } = detectHdr(video);
  const codec = String(video.codec_name ?? 'unknown');

  const audio: AudioTrack[] = streams
    .filter((s) => s.codec_type === 'audio')
    .map((s) => {
      const codecName = String(s.codec_name ?? 'unknown');
      const profile = String(s.profile ?? '');
      return {
        index: Number(s.index),
        codec: profile && profile !== 'unknown' ? `${codecName} (${profile})` : codecName,
        channels: Number(s.channels ?? 0),
        lang: s.tags?.language,
        title: s.tags?.title,
        bitrateKbps: s.bit_rate ? Math.round(Number(s.bit_rate) / 1000) : undefined,
        objectAudio: /truehd|eac3/i.test(codecName) || /atmos|dts:?x/i.test(profile),
        isDefault: s.disposition?.default === 1,
      };
    });

  const subtitles: SubtitleTrack[] = streams
    .filter((s) => s.codec_type === 'subtitle')
    .map((s) => ({
      index: Number(s.index),
      format: String(s.codec_name ?? 'unknown'),
      lang: s.tags?.language,
      title: s.tags?.title,
      forced: s.disposition?.forced === 1,
      isDefault: s.disposition?.default === 1,
    }));

  const chapters: Chapter[] = (data.chapters ?? []).map((c: any) => ({
    title: c.tags?.title ?? '',
    startSec: Number(c.start_time ?? 0),
  }));

  return {
    container: String(format.format_name ?? '').split(',')[0],
    durationSec,
    sizeBytes,
    bitrateMbps: durationSec > 0 ? Math.round(((sizeBytes * 8) / durationSec / 1e6) * 10) / 10 : 0,
    videoCodec: codec,
    profile: video.profile,
    width,
    height,
    resolution: resolutionLabel(width, height),
    bitDepth: bitDepthOf(video),
    hdr,
    dvProfile,
    frameRate: parseRate(video.r_frame_rate),
    likelySoftwareDecode: NO_HW_DECODE.has(codec) || GENERATION_DEPENDENT.has(codec),
    audio,
    subtitles,
    chapters,
  };
}


