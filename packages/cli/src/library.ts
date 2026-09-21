#!/usr/bin/env tsx
/**
 * pnpm library [--available] [--review] [--json]
 *
 * Reads the persisted library and resolves availability against whatever drives are
 * attached right now. This is the shape the Home screen consumes — build it here
 * first so the availability model is proven before any UI depends on it.
 */

import { MediaResolver, MetaStore, StateStore, VolumeManager } from '@nfl/core';
import { C, DB_DIR, fmtBytes, fmtDuration, STATE_FILE, VOLUMES_FILE , ensureMigrated } from './paths.js';

async function main() {
  await ensureMigrated();
  const args = process.argv.slice(2);
  const onlyAvailable = args.includes('--available');
  const onlyReview = args.includes('--review');
  const prune = args.includes('--prune');
  const asJson = args.includes('--json');

  const store = new MetaStore(DB_DIR);
  const vm = new VolumeManager(VOLUMES_FILE);
  const state = new StateStore(STATE_FILE);

  const [{ titles, issues }, volumeStates] = await Promise.all([store.loadAll(), vm.probeAll()]);
  const resolver = new MediaResolver(volumeStates);

  if (asJson) {
    console.log(
      JSON.stringify(
        titles.map((t) => ({ title: t, availability: resolver.resolve(t) })),
        null,
        2,
      ),
    );
    return;
  }

  if (titles.length === 0) {
    console.log(`\n${C.dim}Library is empty.${C.reset}`);
    console.log(`  pnpm volumes add /Volumes/YourDrive/Movies`);
    console.log(`  pnpm scan\n`);
    return;
  }

  const summary = resolver.summary(titles);
  const continueWatching = await state.continueWatching();
  const resumeById = new Map(continueWatching.map((c) => [c.titleId, c.progress]));

  console.log(
    `\n${C.bold}Library${C.reset} ${C.dim}${titles.length} titles · ` +
      `${C.green}${summary.available} available${C.reset}${C.dim} · ` +
      `${summary.offline} offline · ${summary.missing} missing${C.reset}\n`,
  );

  for (const t of titles) {
    const avail = resolver.resolve(t);
    if (onlyAvailable && avail.status !== 'available') continue;
    if (onlyReview && t.matchState !== 'unmatched' && t.matchState !== 'review') continue;

    const badge =
      avail.status === 'available'
        ? `${C.green}●${C.reset}`
        : avail.status === 'offline'
          ? `${C.dim}○${C.reset}`
          : `${C.red}✕${C.reset}`;

    const year = t.year ? ` ${C.dim}(${t.year})${C.reset}` : '';
    console.log(`  ${badge} ${C.bold}${t.title}${C.reset}${year}`);

    if (avail.status !== 'missing') {
      const m = avail.media;
      const bits = [
        m.resolution,
        m.videoCodec.toUpperCase(),
        m.hdr === 'DV' && m.dvProfile ? `DV P${m.dvProfile}` : m.hdr,
        `${m.bitrateMbps} Mb/s`,
        fmtDuration(m.durationSec),
        fmtBytes(m.sizeBytes),
      ];
      console.log(`      ${C.dim}${bits.join(' · ')}${C.reset}`);
      if (m.edition) console.log(`      ${C.yellow}${m.edition}${C.reset}`);
    }

    // Show what enrichment actually produced. Without this the only signal that
    // metadata arrived is the ABSENCE of a warning, which is a poor way to verify it.
    const facts = [
      t.certification,
      t.genres.slice(0, 3).join(', ') || null,
      t.directors[0] ? `dir. ${t.directors[0]}` : null,
    ].filter(Boolean);
    if (facts.length) console.log(`      ${C.dim}${facts.join('  ·  ')}${C.reset}`);

    if (t.tagline) console.log(`      ${C.cyan}${t.tagline}${C.reset}`);

    if (t.overview) {
      const line = t.overview.length > 96 ? `${t.overview.slice(0, 96)}…` : t.overview;
      console.log(`      ${C.dim}${line}${C.reset}`);
    }

    if (t.cast.length) {
      console.log(`      ${C.dim}${t.cast.slice(0, 4).map((c) => c.name).join(', ')}${C.reset}`);
    }

    const art = [
      t.artwork.poster ? 'poster' : null,
      t.artwork.backdrop ? 'backdrop' : null,
      t.artwork.logo ? 'logo' : null,
    ].filter(Boolean);
    if (art.length) console.log(`      ${C.green}art:${C.reset} ${C.dim}${art.join(' · ')}${C.reset}`);

    if (t.media.length > 1) {
      const editions = t.media.map((m) => m.edition ?? 'Standard').join(', ');
      console.log(`      ${C.cyan}${t.media.length} versions:${C.reset} ${C.dim}${editions}${C.reset}`);
    }

    // The §8.5 requirement made concrete: offline titles still render, Play changes.
    if (avail.status === 'offline') {
      console.log(`      ${C.dim}▸ On ${avail.volumeLabel}${C.reset}`);
    }

    const resume = resumeById.get(t.id);
    if (resume) {
      const pct = Math.round((resume.positionSec / resume.durationSec) * 100);
      console.log(`      ${C.cyan}▸ Resume at ${fmtDuration(resume.positionSec)} (${pct}%)${C.reset}`);
    }

    if (t.matchState === 'unmatched' || t.matchState === 'review') {
      const why = t.matchWarnings.length ? `: ${t.matchWarnings.join(', ')}` : '';
      console.log(`      ${C.yellow}⚠ needs metadata${why}${C.reset}`);
      if (t.searchTitles.length) {
        console.log(`      ${C.dim}will try: ${t.searchTitles.map((s) => `"${s}"`).join(' | ')}${C.reset}`);
      }
    }
    console.log('');
  }

  // Titles whose volume no longer exists in volumes.json. Distinct from "offline":
  // an offline drive is paired but unplugged, an orphan has no paired drive at all.
  // These used to accumulate silently whenever a library was removed and re-added,
  // because volume ids were random. Ids are deterministic now, but existing databases
  // may still carry orphans from before the fix.
  const knownVolumes = new Set(volumeStates.map((s) => s.root.id));
  const orphans = titles.filter((t) => t.media.every((m) => !knownVolumes.has(m.sightings[0]?.volumeId)));

  if (orphans.length) {
    console.log(
      `${C.yellow}${orphans.length} title(s) reference a library that is no longer paired${C.reset}`,
    );
    for (const o of orphans.slice(0, 8)) {
      console.log(`  ${C.dim}${o.title} → volume ${o.media[0]?.sightings[0]?.volumeId}${C.reset}`);
    }
    if (orphans.length > 8) console.log(`  ${C.dim}…and ${orphans.length - 8} more${C.reset}`);

    if (prune) {
      for (const o of orphans) await store.delete(o.id, o.type);
      console.log(`  ${C.green}removed ${orphans.length} orphaned record(s)${C.reset}\n`);
    } else {
      console.log(`  ${C.dim}pnpm library --prune to remove them${C.reset}\n`);
    }
  }

  if (issues.length) {
    console.log(`${C.red}${issues.length} record(s) failed validation${C.reset}`);
    for (const i of issues) console.log(`  ${C.dim}${i.file}${C.reset}\n    ${i.error}`);
    console.log('');
  }
}

main().catch((err) => {
  console.error(`${C.red}${err instanceof Error ? err.message : String(err)}${C.reset}`);
  process.exit(1);
});
