/**
 * Scan orchestrator: discover → parse → sidecar IDs → probe.
 *
 * Deliberately stops short of TMDB matching. This stage answers "what is on this drive
 * and what is in these files", which is the input contract for everything downstream
 * (ARCHITECTURE.md §12). Matching is a separate, networked, resumable step.
 */

import { discoverReleaseUnits, type DiscoveryIssue, type ReleaseUnit } from './discover.js';
import { extractExternalIds, type ExternalIds } from './sidecar.js';
import { parseRelease, type ParsedRelease } from './parse.js';
import { probe, type ProbeResult } from './probe.js';
import { computeContentId, fingerprint } from './content-id.js';

export type ScannedTitle = {
  /** Identity derived from the bytes. Empty only when probing failed. */
  contentId: string;
  unit: ReleaseUnit;
  parsed: ParsedRelease;
  externalIds: ExternalIds;
  probe?: ProbeResult;
  probeError?: string;
  fingerprint: string;
};

export type ScanReport = {
  root: string;
  titles: ScannedTitle[];
  issues: DiscoveryIssue[];
  elapsedMs: number;
};

export type ScanOptions = {
  /** Skip ffprobe. Fast structural pass for testing parse behaviour. */
  skipProbe?: boolean;
  /** Concurrent ffprobe calls. Keep low on spinning disks and network shares. */
  concurrency?: number;
  /** Override the feature-size floor. Tests only. */
  minFeatureBytes?: number;
  onProgress?: (done: number, total: number, name: string) => void;
};

async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const i = cursor++;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

export async function scanRoot(root: string, opts: ScanOptions = {}): Promise<ScanReport> {
  const started = Date.now();
  const { units, issues } = await discoverReleaseUnits(root, {
    minFeatureBytes: opts.minFeatureBytes,
  });

  let done = 0;
  const titles = await mapLimit(units, opts.concurrency ?? 4, async (unit) => {
    const parsed = parseRelease(unit.releaseName);
    const externalIds = await extractExternalIds(unit.sidecars);

    let probeResult: ProbeResult | undefined;
    let probeError: string | undefined;
    let contentId = '';

    if (!opts.skipProbe && !unit.discStructure) {
      try {
        probeResult = await probe(unit.videoPath, unit.sizeBytes);
        // 2 MB read regardless of file size — see scan/content-id.ts.
        contentId = await computeContentId(
          unit.videoPath,
          unit.sizeBytes,
          probeResult.durationSec,
        );
      } catch (err) {
        probeError = err instanceof Error ? err.message : String(err);
      }
    }

    done += 1;
    opts.onProgress?.(done, units.length, parsed.title || unit.releaseName);

    return {
      contentId,
      unit,
      parsed,
      externalIds,
      probe: probeResult,
      probeError,
      fingerprint: fingerprint(unit.sizeBytes, unit.mtimeMs),
    } satisfies ScannedTitle;
  });

  return { root, titles, issues, elapsedMs: Date.now() - started };
}
