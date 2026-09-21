#!/usr/bin/env tsx
/**
 * pnpm scan <path> [--json] [--fast]
 *
 * Standalone library scanner. No Electron, no UI, no network. Run this against the real
 * drive first — it surfaces the weird cases in minutes and it is the input contract for
 * every downstream stage (ARCHITECTURE.md §12).
 */

import { ingest, MetaStore, scanRoot, syncVolume, VolumeManager, type ScannedTitle } from '@nfl/core';
import { DB_DIR, VOLUMES_FILE , ensureMigrated } from './paths.js';

const C = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
};

/**
 * macOS Finder reports decimal units (1 GB = 10^9 bytes), and has since 10.6.
 * Using binary units while labelling them "GB" makes every file look ~7.4% smaller
 * than Finder says, which reads as a bug to anyone cross-checking. Match the platform.
 */
function fmtBytes(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)} GB`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(0)} MB`;
  return `${n} B`;
}

function fmtDuration(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.round((sec % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function hdrBadge(hdr: string, dvProfile?: number): string {
  if (hdr === 'SDR') return `${C.dim}SDR${C.reset}`;
  const label = hdr === 'DV' && dvProfile !== undefined ? `DV P${dvProfile}` : hdr;
  return `${C.cyan}${label}${C.reset}`;
}

function renderTitle(t: ScannedTitle, index: number): string {
  const lines: string[] = [];
  const { parsed, probe, unit, externalIds } = t;

  const heading = parsed.title || `${C.red}<unparsed>${C.reset}`;
  const year = parsed.year ? ` ${C.dim}(${parsed.year})${C.reset}` : ` ${C.red}(no year)${C.reset}`;
  lines.push(`${C.bold}${String(index + 1).padStart(3)}. ${heading}${C.reset}${year}`);

  const tags: string[] = [];
  if (parsed.edition) tags.push(`${C.yellow}${parsed.edition}${C.reset}`);
  if (parsed.source) tags.push(parsed.source);
  for (const attr of parsed.releaseAttributes) tags.push(`${C.dim}${attr}${C.reset}`);
  if (parsed.releaseGroup) tags.push(`${C.dim}-${parsed.releaseGroup}${C.reset}`);
  if (parsed.isShow) tags.push(`${C.blue}S${parsed.seasons?.join(',')}E${parsed.episodes?.join(',')}${C.reset}`);
  if (tags.length) lines.push(`     ${tags.join('  ')}`);

  if (externalIds.imdbId || externalIds.tmdbId) {
    const ids = [externalIds.imdbId, externalIds.tmdbId ? `tmdb:${externalIds.tmdbId}` : null]
      .filter(Boolean)
      .join(' ');
    lines.push(`     ${C.green}✓ external id  ${ids}${C.reset} ${C.dim}(exact match available)${C.reset}`);
  }

  if (probe) {
    const v = [
      probe.resolution,
      probe.videoCodec.toUpperCase(),
      probe.bitDepth ? `${probe.bitDepth}-bit` : null,
      hdrBadge(probe.hdr, probe.dvProfile),
      `${probe.bitrateMbps} Mb/s`,
      fmtDuration(probe.durationSec),
      fmtBytes(probe.sizeBytes),
    ]
      .filter(Boolean)
      .join(' · ');
    lines.push(`     ${v}`);

    const a = probe.audio
      .slice(0, 3)
      .map((track) => {
        const obj = track.objectAudio ? ` ${C.yellow}→PCM${C.reset}` : '';
        return `${track.codec} ${track.channels}ch${track.lang ? ` [${track.lang}]` : ''}${obj}`;
      })
      .join(', ');
    if (a) lines.push(`     ${C.dim}audio:${C.reset} ${a}${probe.audio.length > 3 ? ` +${probe.audio.length - 3}` : ''}`);

    if (probe.subtitles.length) {
      // Remux discs routinely carry 40+ subtitle tracks. Printing every language code
      // wraps across terminal lines and buries the useful signal, which is: how many
      // tracks, and is English among them.
      const langs = [...new Set(probe.subtitles.map((s) => s.lang ?? '??'))];
      const shown = langs.slice(0, 6).join(',');
      const more = langs.length > 6 ? ` +${langs.length - 6} more` : '';
      const forced = probe.subtitles.filter((s) => s.forced).length;
      lines.push(
        `     ${C.dim}subs:${C.reset}  ${probe.subtitles.length} tracks [${shown}${more}]` +
          (forced ? ` ${C.dim}${forced} forced${C.reset}` : ''),
      );
    }
    if (probe.chapters.length) {
      // Skip Intro is a TV-episode affordance. A movie's opening-credits chapter
      // (e.g. Star Wars' crawl) is not something anyone wants to skip.
      const intro =
        parsed.isShow && probe.chapters.some((c) => /\b(intro|opening|recap)\b/i.test(c.title));
      lines.push(
        `     ${C.dim}chapters:${C.reset} ${probe.chapters.length}${intro ? ` ${C.green}(Skip Intro available)${C.reset}` : ''}`,
      );
    }
    if (probe.likelySoftwareDecode) {
      lines.push(`     ${C.yellow}⚠ ${probe.videoCodec} may lack hardware decode — verify via hwdec-current${C.reset}`);
    }
  } else if (t.probeError) {
    lines.push(`     ${C.red}probe failed: ${t.probeError}${C.reset}`);
  }

  if (parsed.warnings.length) {
    lines.push(`     ${C.red}⚠ review: ${parsed.warnings.join(', ')}${C.reset}`);
    if (parsed.searchTitles.length > 1 || parsed.originalYear) {
      const tries = parsed.searchTitles.map((t) => `"${t}"`).join(' | ');
      const years = [parsed.year, parsed.originalYear].filter(Boolean).join(' | ');
      lines.push(`     ${C.dim}will try: ${tries}  years: ${years}${C.reset}`);
    }
  }
  lines.push(`     ${C.dim}${unit.nameSource}: ${unit.releaseName}${C.reset}`);

  return lines.join('\n');
}

async function main() {
  await ensureMigrated();
  const args = process.argv.slice(2);
  const root = args.find((a) => !a.startsWith('--'));
  const asJson = args.includes('--json');
  const fast = args.includes("--fast");
  const prune = args.includes('--prune');
  const minArg = args.find((a) => a.startsWith("--min-size="));
  const minFeatureBytes = minArg ? Number(minArg.split("=")[1]) : undefined;

  // No path: scan every paired root and PERSIST into db/.
  if (!root) {
    const vm = new VolumeManager(VOLUMES_FILE);
    const states = await vm.probeAll();
    if (states.length === 0) {
      console.error('No paired roots. Add one first:');
      console.error('  pnpm volumes add /Volumes/YourDrive/Movies --label="Movies SSD"');
      console.error('Or scan a path ad-hoc without saving:  pnpm scan <path>');
      process.exit(1);
    }

    const store = new MetaStore(DB_DIR);
    for (const st of states) {
      if (st.status === 'offline' || !st.resolvedPath) {
        console.log(`${C.dim}skipping ${st.root.label} — offline${C.reset}`);
        continue;
      }
      // Pull the drive's own metadata in first. On a machine that has never seen this
      // drive, this is the whole job — the scan below then finds everything unchanged.
      const sync = await syncVolume(st, store);
      if (sync && (sync.pulled > 0 || sync.pushed > 0)) {
        console.log(
          `  ${C.bold}${st.root.label}${C.reset} ${C.cyan}synced from drive${C.reset} ` +
            `${C.dim}${sync.pulled} in · ${sync.pushed} out${C.reset}`,
        );
      }

      process.stderr.write(`${C.dim}scanning ${st.root.label}…${C.reset}\n`);
      const rep = await scanRoot(st.resolvedPath, {
        concurrency: 4,
        minFeatureBytes: minFeatureBytes,
        onProgress: (done, total, name) =>
          process.stderr.write(`\r${C.dim}probing ${done}/${total} — ${name.slice(0, 48)}${C.reset}\x1b[K`),
      });
      process.stderr.write('\r\x1b[K');

      const stats = await ingest(rep, st.root, st.resolvedPath, store, { prune });
      console.log(
        `  ${C.bold}${st.root.label}${C.reset} ${C.dim}${rep.titles.length} files · ${rep.elapsedMs}ms${C.reset}`,
      );
      console.log(
        `    ${C.green}${stats.created} new${C.reset} · ${stats.updated} updated · ` +
          `${C.dim}${stats.unchanged} unchanged${C.reset}` +
          (stats.editionsAdded ? ` · ${C.cyan}${stats.editionsAdded} extra editions${C.reset}` : '') +
          (stats.skippedConfirmed ? ` · ${C.dim}${stats.skippedConfirmed} confirmed, left alone${C.reset}` : ''),
      );
      if (false) {
        console.log(
          `    ${C.yellow}drive is read-only — metadata stays local only, so this ` +
            `library will not travel with the disk${C.reset}`,
        );
      } else if (0 > 0) {
        console.log(
          `    ${C.dim}${0} written to the drive (.netflix-local) — ` +
            `plug it into another Mac and it will not need rescanning${C.reset}`,
        );
      }
      if (stats.alreadyKnown > 0) {
        console.log(
          `    ${C.cyan}${stats.alreadyKnown} already known${C.reset} ` +
            `${C.dim}— same file catalogued from another drive${C.reset}`,
        );
      }

      if (stats.relocated > 0) {
        console.log(
          `    ${C.cyan}${stats.relocated} renamed${C.reset} ${C.dim}— matched by content, ` +
            `metadata kept${C.reset}`,
        );
      }

      if (stats.missing.length > 0) {
        const removed = stats.missing.filter((m) => m.lastMedia).length;
        if (prune) {
          console.log(
            `    ${C.yellow}${stats.pruned} removed${C.reset} ${C.dim}— files no longer on the drive` +
              `${removed ? `, ${removed} title(s) dropped entirely` : ''}${C.reset}`,
          );
        } else {
          console.log(`    ${C.yellow}${stats.missing.length} file(s) no longer on this drive:${C.reset}`);
          for (const m of stats.missing.slice(0, 8)) {
            console.log(`      ${C.dim}${m.title}${C.reset} ${C.dim}— ${m.relPath}${C.reset}`);
          }
          if (stats.missing.length > 8) {
            console.log(`      ${C.dim}…and ${stats.missing.length - 8} more${C.reset}`);
          }
          console.log(`    ${C.dim}pnpm scan --prune to remove these records${C.reset}`);
        }
      }

      if (rep.issues.length) {
        console.log(`    ${C.yellow}${rep.issues.length} needing attention${C.reset}`);
        for (const i of rep.issues) console.log(`      ${C.yellow}${i.reason}${C.reset} ${C.dim}${i.path}${C.reset}`);
      }
    }
    console.log(`\n${C.dim}pnpm library${C.reset} to see the result\n`);
    return;
  }

  const report = await scanRoot(root, {
    skipProbe: fast,
    minFeatureBytes,
    concurrency: 4,
    onProgress: (done, total, name) => {
      if (!asJson) process.stderr.write(`\r${C.dim}probing ${done}/${total} — ${name.slice(0, 50)}${C.reset}\x1b[K`);
    },
  });

  if (!asJson) process.stderr.write('\r\x1b[K');

  if (asJson) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  console.log(`\n${C.bold}Scanned${C.reset} ${report.root}`);
  console.log(`${C.dim}${report.titles.length} titles · ${report.issues.length} issues · ${report.elapsedMs}ms${C.reset}\n`);

  report.titles.forEach((t, i) => {
    console.log(renderTitle(t, i));
    console.log('');
  });

  if (report.issues.length) {
    console.log(`${C.bold}${C.yellow}Needs attention${C.reset}`);
    for (const issue of report.issues) {
      console.log(`  ${C.yellow}${issue.reason}${C.reset}  ${issue.path}`);
      if (issue.detail) console.log(`     ${C.dim}${issue.detail}${C.reset}`);
    }
    console.log('');
  }

  // Buckets must be mutually exclusive: an external ID wins over a shaky parse,
  // because the ID makes the parse irrelevant.
  let exact = 0;
  let fuzzy = 0;
  let review = 0;
  for (const t of report.titles) {
    if (t.externalIds.imdbId || t.externalIds.tmdbId) exact += 1;
    else if (t.parsed.lowConfidence) review += 1;
    else fuzzy += 1;
  }
  console.log(`${C.bold}Summary${C.reset}`);
  console.log(`  ${C.green}${exact}${C.reset} with external IDs (exact match)`);
  console.log(`  ${C.green}${fuzzy}${C.reset} need fuzzy title+year match`);
  console.log(`  ${review > 0 ? C.red : C.dim}${review}${C.reset} need manual review\n`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
