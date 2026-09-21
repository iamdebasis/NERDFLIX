/**
 * What is ACTUALLY happening, not what we asked for.
 *
 * Every setting in this player is a request that mpv may decline: hardware decode can
 * fall back to software, an HDR hint can be ignored by the compositor, a 7.1 track can
 * be downmixed by the audio device. Reporting the request rather than the result is how
 * a Dolby Vision remux ended up being flattened to SDR for weeks without anyone
 * noticing — the config said HDR was enabled, and nothing ever checked.
 *
 * So each field here is read back from mpv after the file is playing, and the source is
 * shown beside the output so a mismatch is visible rather than inferred.
 */

import type { PlaybackEngine } from './engine.js';

export type PlaybackStatus = {
  /** What the file contains. */
  source: {
    width: number;
    height: number;
    codec: string;
    bitDepth: number | null;
    primaries: string | null;
    gamma: string | null;
    /** Peak luminance the master was graded for, in nits. */
    maxLuma: number | null;
    isHdr: boolean;
    dolbyVision: boolean;
  };
  /** What is being sent to the display. */
  output: {
    primaries: string | null;
    gamma: string | null;
    isHdr: boolean;
  };
  /** True when HDR content is reaching the display as HDR. */
  hdrPreserved: boolean;
  /** Whether passthrough was requested, read back from mpv rather than assumed. */
  hdrRequested: boolean;
  /** Peak luminance mpv is targeting. 'auto' means it asked the windowing system. */
  targetPeak: string | null;
  /**
   * Who turns frames into pixels.
   *
   * When a host app renders (`vo=libmpv`), mpv hands over frames and does not know what
   * becomes of them — `video-out-params` then describes nothing real, and any verdict
   * drawn from it is a guess dressed as a fact.
   */
  renderer: 'mpv' | 'host';
  hwdec: string | null;
  audio: {
    codec: string | null;
    inChannels: number | null;
    outChannels: number | null;
    layout: string | null;
    ao: string | null;
  };
};

/** PQ or HLG transfer means the content carries an HDR signal. */
function hdrGamma(gamma: string | null): boolean {
  return gamma === 'pq' || gamma === 'hlg';
}

export type StatusOptions = {
  /**
   * Which renderer is drawing.
   *
   * It changes how HDR is judged. With a bare mpv, `--target-colorspace-hint=yes` is
   * how the display is told the content is PQ, so its absence means tone-mapping. IINA
   * hosts libmpv and drives the CAMetalLayer itself, so the hint is irrelevant there —
   * requiring it reported "tone-mapped to SDR" over demonstrably working HDR.
   */
  renderer?: 'mpv' | 'host';
};

export async function readPlaybackStatus(
  engine: PlaybackEngine,
  opts: StatusOptions = {},
): Promise<PlaybackStatus> {
  /**
   * Read a property, retrying briefly.
   *
   * Properties populate asynchronously after a file opens, so a single read can return
   * a blank player — 0x0, no codec, no audio device — and report that as fact. Cheap
   * to retry; expensive to print a confident lie.
   */
  const get = async <T>(prop: string, tries = 5): Promise<T | null> => {
    for (let i = 0; i < tries; i++) {
      try {
        const v = await (engine as unknown as { get(p: string): Promise<T> }).get(prop);
        if (v !== null && v !== undefined) return v;
      } catch {
        /* not ready yet */
      }
      if (i < tries - 1) await new Promise((r) => setTimeout(r, 150));
    }
    return null;
  };

  const [
    width,
    height,
    codec,
    bitDepth,
    srcPrim,
    srcGamma,
    maxLuma,
    outPrim,
    outGamma,
    hwdec,
    acodec,
    inCh,
    outCh,
    layout,
    ao,
  ] = await Promise.all([
    get<number>('width'),
    get<number>('height'),
    get<string>('video-format'),
    get<number>('video-params/bitdepth'),
    get<string>('video-params/primaries'),
    get<string>('video-params/gamma'),
    get<number>('video-params/max-luma'),
    get<string>('video-out-params/primaries'),
    get<string>('video-out-params/gamma'),
    get<string>('hwdec-current'),
    get<string>('audio-codec-name'),
    get<number>('audio-params/channel-count'),
    get<number>('audio-out-params/channel-count'),
    get<string>('audio-out-params/hr-channels'),
    get<string>('current-ao'),
  ]);

  /**
   * Read the hint back from mpv rather than trusting our own config object.
   *
   * `video-out-params` alone is not enough: tone-mapping happens inside the GPU
   * renderer, and the property may still report the source transfer. The hint is what
   * actually decides whether the OS is handed an HDR signal, so both are reported.
   */
  const hintRaw = await get<boolean>('target-colorspace-hint');
  const peak = await get<string>('target-peak');
  const vo = await get<string>('current-vo');

  const sourceHdr = hdrGamma(srcGamma);
  const outputHdr = hdrGamma(outGamma);

  const viaHost = opts.renderer === 'host';

  return {
    renderer: opts.renderer ?? 'mpv',
    source: {
      width: width ?? 0,
      height: height ?? 0,
      codec: codec ?? '?',
      bitDepth: bitDepth,
      primaries: srcPrim,
      gamma: srcGamma,
      maxLuma,
      isHdr: sourceHdr,
      // DV profile 8 carries an HDR10 base layer; mpv reads that and ignores the RPU.
      dolbyVision: sourceHdr && srcPrim === 'bt.2020',
    },
    output: { primaries: outPrim, gamma: outGamma, isHdr: outputHdr },
    hdrRequested: hintRaw === true,
    targetPeak: peak === null ? null : String(peak),
    // HDR in, HDR out — and the display was actually told about it.
    hdrPreserved: !sourceHdr || (outputHdr && hintRaw === true),
    hwdec: hwdec && hwdec !== 'no' ? hwdec : null,
    audio: {
      codec: acodec,
      inChannels: inCh,
      outChannels: outCh,
      layout,
      ao,
    },
  };
}

const C = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  cyan: '\x1b[36m',
} as const;

/** Human-readable transfer name — 'pq' means nothing to most people. */
function transferName(gamma: string | null): string {
  if (gamma === 'pq') return 'HDR10 (PQ)';
  if (gamma === 'hlg') return 'HLG';
  if (gamma === 'bt.1886' || gamma === 'srgb') return 'SDR';
  return gamma ?? 'unknown';
}

/**
 * The status block printed once playback is running.
 *
 * Deliberately shows source and output side by side for HDR: a single "HDR: yes" line
 * cannot distinguish "the file is HDR" from "HDR is reaching your screen", and that
 * distinction is the whole point.
 */
export function formatStatus(s: PlaybackStatus): string[] {
  const lines: string[] = [];

  const depth = s.source.bitDepth ? ` ${s.source.bitDepth}-bit` : '';
  lines.push(
    `  ${s.source.width}x${s.source.height} ${s.source.codec}${depth}` +
      `${s.source.primaries ? ` ${C.dim}${s.source.primaries}${C.reset}` : ''}`,
  );

  if (s.source.isHdr) {
    // Mastering metadata gives a raw float (3999.72168); round it — the precision is
    // meaningless and the noise makes the line hard to scan.
    const graded = s.source.maxLuma
      ? ` ${C.dim}graded for ${Math.round(s.source.maxLuma).toLocaleString()} nits${C.reset}`
      : '';
    /**
     * When a host app presents, mpv's output params describe nothing real — it is not
     * the thing driving the display. Claiming either passthrough or tone-mapping from
     * them would be a guess dressed as a measurement. Report the SOURCE, which is
     * genuinely known, and name who is presenting it.
     */
    if (s.renderer === 'host') {
      lines.push(
        // "HDR source", not "HDR passthrough": we know what the FILE is, and the host
        // is presenting it. Anything stronger would be a claim about a pipeline we
        // cannot see.
        `  ${C.green}✓ HDR source${C.reset} ${transferName(s.source.gamma)} ` +
          `${s.source.primaries ?? ''}${graded} ${C.dim}· presented by the player${C.reset}`,
      );
    } else if (s.hdrPreserved) {
      // Only reached when WE drive mpv's output — the host case returned above, where
      // mpv's target-peak would say nothing about what the host negotiated.
      //
      // Showing the peak matters here: an underestimate makes HDR look DIMMER than
      // SDR, which is the opposite of what anyone expects from turning HDR on.
      const peak =
        s.targetPeak && s.targetPeak !== 'auto'
          ? ` ${C.dim}· display ${s.targetPeak} nits${C.reset}`
          : ` ${C.dim}· display peak auto${C.reset}`;
      lines.push(
        `  ${C.green}✓ HDR passthrough${C.reset} ${transferName(s.source.gamma)} ` +
          `${s.source.primaries ?? ''} → display${graded}${peak}`,
      );
    } else if (!s.hdrRequested) {
      lines.push(
        `  ${C.yellow}⚠ HDR source, tone-mapped to SDR${C.reset} ` +
          `${C.dim}passthrough disabled — drop --no-hdr to keep it${C.reset}`,
      );
    } else {
      lines.push(
        `  ${C.yellow}⚠ HDR requested but output is ${transferName(s.output.gamma)}${C.reset} ` +
          `${C.dim}the display or compositor declined it${C.reset}`,
      );
    }
  } else {
    lines.push(`  ${C.dim}SDR source${C.reset}`);
  }

  lines.push(
    s.hwdec
      ? `  ${C.green}✓ hardware decode${C.reset} ${C.dim}${s.hwdec}${C.reset}`
      : `  ${C.yellow}⚠ software decode${C.reset} ${C.dim}— expect dropped frames on 4K${C.reset}`,
  );

  const a = s.audio;
  if (a.outChannels === 0 || a.outChannels === null) {
    lines.push(`  ${C.red}⚠ audio device did not open${C.reset}`);
  } else {
    const down = a.inChannels && a.outChannels < a.inChannels ? ' downmixed' : '';
    lines.push(
      `  ${C.dim}audio ${a.codec ?? '?'} ${a.inChannels ?? '?'}ch → ${a.outChannels}ch` +
        `${a.layout ? ` (${a.layout})` : ''}${down} via ${a.ao ?? '?'}${C.reset}`,
    );
  }

  return lines;
}
