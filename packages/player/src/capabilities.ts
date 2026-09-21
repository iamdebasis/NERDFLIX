/**
 * Machine capability detection.
 *
 * Two jobs, both in service of ARCHITECTURE.md §2.1's rule: measure, never ship a chip
 * table. The GPU core count here is only an opening *guess* at a quality tier — the
 * frame-drop watchdog is the authority and will correct it in either direction.
 *
 * This is also why nothing in here is specific to one Mac. A fanless Air, an M-series
 * laptop, and a Mac Studio driving a Pro Display XDR all run the same code path and
 * settle at whatever they can actually sustain.
 */

import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { type QualityTier } from './quality.js';
import { playerCacheDir } from './cache-dir.js';

const exec = promisify(execFile);

/**
 * Bump whenever the tier definitions change in a way that could alter what a machine
 * can sustain, OR when the meaning of `observedCeiling` changes.
 *
 * v3: the watchdog can now climb back up, so ceilings recorded under the old
 * demotion-only behaviour are meaningless — they record the worst moment a machine
 * ever had, not what it can sustain.
 *
 * `observedCeiling` is a verdict about a *specific* set of quality settings. Moving
 * motion interpolation out of the tiers made Reference far cheaper, but a machine that
 * had already been demoted kept starting at High forever — the cache outlived the
 * thing it was measuring. A stale ceiling is worse than no ceiling: it silently caps
 * quality with no way for the user to know why.
 */
export const QUALITY_MODEL_VERSION = 3;

export type MachineCapabilities = {
  /**
   * The lowest tier the watchdog has had to fall back to, kept for diagnostics only.
   *
   * It is deliberately NOT used to pick a starting tier — see ExternalMpvEngine.start.
   * Doing so meant one bad session permanently capped every film afterwards.
   */
  qualityModelVersion?: number;
  chip: string;
  gpuCores: number | null;
  cpuCores: number;
  memoryGB: number;
  /** Opening guess from hardware. The watchdog overrides it. */
  suggestedTier: QualityTier;
  /**
   * Highest tier observed to run without dropping frames on THIS machine.
   *
   * Written by the watchdog when it demotes. Without this, every launch would
   * re-learn the same lesson and the viewer would see the same stutter-then-fix
   * cycle at the start of every film.
   */
  observedCeiling?: QualityTier;
  probedAt: string;
};

async function sysctl(key: string): Promise<string | null> {
  try {
    const { stdout } = await exec('sysctl', ['-n', key]);
    return stdout.trim();
  } catch {
    return null;
  }
}

/**
 * GPU core count from system_profiler. This call is slow (~1s), which is exactly why
 * the result is cached to disk keyed by chip string.
 */
async function gpuCoreCount(): Promise<number | null> {
  try {
    const { stdout } = await exec('system_profiler', ['SPDisplaysDataType', '-json'], {
      maxBuffer: 8 * 1024 * 1024,
    });
    const data = JSON.parse(stdout);
    const displays = data?.SPDisplaysDataType ?? [];
    for (const d of displays) {
      const cores = d?.sppci_cores ?? d?.spdisplays_cores;
      if (cores) {
        const n = Number(String(cores).replace(/\D/g, ''));
        if (Number.isFinite(n) && n > 0) return n;
      }
    }
  } catch {
    /* non-macOS, or the key moved between OS versions */
  }
  return null;
}

/**
 * Map GPU cores to an opening tier.
 *
 * Calibrated against measurement, not guesswork. On an M1 Pro (16 GPU cores, 16 GB)
 * playing 4K HEVC Dolby Vision at 57.7 Mb/s:
 *   reference + motion   → 1.15% of frames dropped
 *   reference, no motion → 0.00%
 *
 * Everything except motion interpolation is close to free on the GPU once VideoToolbox
 * is doing the decode — the scalers and deband passes operate on an already-decoded
 * frame. So the thresholds are deliberately generous, and `motionInterpolation` (the
 * one genuinely expensive setting) is opt-in rather than tied to a tier.
 *
 * Thresholds are core counts, never chip names, so future hardware slots in without a
 * code change. Being wrong costs one watchdog adjustment, which is then remembered.
 */
export function suggestTier(gpuCores: number | null, memoryGB: number): QualityTier {
  if (gpuCores === null) return 'high';
  if (gpuCores >= 14) return 'reference'; // Pro class and above
  if (gpuCores >= 8) return 'high'; // base chips
  if (gpuCores >= 4) return 'balanced';
  return 'efficient';
}

/**
 * Adjust the opening guess for what is actually being played.
 *
 * 2160p is four times the pixels of 1080p, and the expensive settings — chroma
 * scaling and multi-pass debanding — scale with pixel count. An M1 Pro that holds
 * Reference comfortably on a 1080p file drops ~6% of frames on a 4K REMUX.
 *
 * Measured the hard way: an earlier "Reference runs clean" conclusion came from 25
 * seconds of a near-static studio logo. Real footage with motion and fine detail is
 * a different workload, and a tier guess that ignores resolution is guessing about
 * the wrong thing.
 */
export function suggestTierForContent(
  base: QualityTier,
  videoHeight: number | null,
  gpuCores: number | null,
): QualityTier {
  if (!videoHeight || videoHeight < 1400) return base;
  // 4K: only a much larger GPU should attempt Reference.
  if (base === 'reference' && (gpuCores ?? 0) < 30) return 'high';
  return base;
}

// Inside the project's own data directory, not the user's home — see cache-dir.ts.
const CACHE_PATH = join(playerCacheDir(), 'capabilities.json');

/**
 * Record that a tier proved too expensive here, so the next launch starts lower.
 * Merges into the existing cache rather than re-probing (system_profiler is slow).
 */
/**
 * Deliberately a no-op.
 *
 * Persisting a measured ceiling was a mistake that caused three separate bugs and kept
 * a 16-core M1 Pro pinned at 'Efficient'. What it recorded was the WORST moment a
 * machine ever had — a scan running in the background, another app compositing, one
 * unusually heavy scene — and then applied that verdict to every future session.
 *
 * The watchdog now reacts within about ten seconds and climbs back on its own, so
 * there is nothing worth carrying across sessions. Each playback starts at what the
 * hardware and content warrant and adapts from there, in both directions.
 *
 * Kept as a function so callers need not change, and so this reasoning stays attached
 * to the thing it is about.
 */
export async function recordObservedCeiling(_tier: QualityTier): Promise<void> {
  /* intentionally does nothing — see above */
}


export async function detectCapabilities(useCache = true): Promise<MachineCapabilities> {
  const chip = (await sysctl('machdep.cpu.brand_string')) ?? 'unknown';

  if (useCache) {
    try {
      const cached = JSON.parse(await readFile(CACHE_PATH, 'utf8')) as MachineCapabilities;
      // Keyed by chip: moving the config to another Mac must re-probe, not inherit.
      if (cached.chip === chip) {
        // Drop a ceiling measured against different tier definitions.
        if (cached.qualityModelVersion !== QUALITY_MODEL_VERSION) {
          delete cached.observedCeiling;
          cached.qualityModelVersion = QUALITY_MODEL_VERSION;
          cached.suggestedTier = suggestTier(cached.gpuCores, cached.memoryGB);
          await writeFile(CACHE_PATH, JSON.stringify(cached, null, 2)).catch(() => {});
        }
        return cached;
      }
    } catch {
      /* no cache yet */
    }
  }

  const memBytes = Number((await sysctl('hw.memsize')) ?? 0);
  const memoryGB = Math.round(memBytes / 1024 ** 3);
  const cpuCores = Number((await sysctl('hw.ncpu')) ?? 0) || 1;
  const gpuCores = await gpuCoreCount();

  const caps: MachineCapabilities = {
    qualityModelVersion: QUALITY_MODEL_VERSION,
    chip,
    gpuCores,
    cpuCores,
    memoryGB,
    suggestedTier: suggestTier(gpuCores, memoryGB),
    probedAt: new Date().toISOString(),
  };

  try {
    await mkdir(dirname(CACHE_PATH), { recursive: true });
    await writeFile(CACHE_PATH, JSON.stringify(caps, null, 2));
  } catch {
    /* cache is an optimisation, not a requirement */
  }

  return caps;
}

/**
 * Which options this mpv build understands.
 *
 * mpv exits on an unrecognised option, so a tier referencing something the installed
 * build lacks would take the whole app down. Different Macs will have different
 * Homebrew mpv versions; filtering against the real option list makes the tiers
 * forward- and backward-compatible instead of pinned to one version.
 */
/**
 * GPU contexts this mpv build actually offers.
 *
 * Needed because the option FILTER only validates names, and `gpu-context` is a valid
 * name everywhere — but an unavailable VALUE is a fatal error, so mpv exits and there
 * is no video at all. `macvk` exists only on macOS builds with MoltenVK.
 */
let gpuContextCache: Set<string> | null = null;

export async function supportedGpuContexts(mpvPath = 'mpv'): Promise<Set<string>> {
  if (gpuContextCache) return gpuContextCache;
  try {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const exec = promisify(execFile);
    // mpv prints the list and exits non-zero, so the output is on stdout either way.
    const { stdout } = await exec(mpvPath, ['--gpu-context=help']).catch(
      (e: { stdout?: string }) => ({ stdout: e.stdout ?? '' }),
    );
    gpuContextCache = new Set(
      stdout
        .split('\n')
        .map((l) => l.trim().split(/\s+/)[0])
        .filter((w) => /^[a-z0-9]+$/.test(w)),
    );
  } catch {
    gpuContextCache = new Set();
  }
  return gpuContextCache;
}

export async function supportedOptions(mpvPath = 'mpv'): Promise<Set<string>> {
  try {
    const { stdout } = await exec(mpvPath, ['--list-options'], { maxBuffer: 16 * 1024 * 1024 });
    const names = new Set<string>();
    for (const line of stdout.split('\n')) {
      const m = line.match(/^\s*--([a-z0-9-]+)/);
      if (m) names.add(m[1]);
    }
    return names;
  } catch {
    return new Set();
  }
}
