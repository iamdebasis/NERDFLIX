#!/usr/bin/env tsx
/**
 * pnpm enrich [--force] [--no-artwork] [--limit=N]
 *
 * Fetches metadata and artwork for every title that needs it. Safe to re-run: already
 * enriched titles are skipped, and confirmed matches are never touched.
 */

import { join } from 'node:path';
import {
  enrichTitle,
  loadEnvFiles,
  MetaStore,
  persistEnvToDataDir,
  TmdbClient,
  VolumeManager,
  type EnrichOutcome,
} from '@nfl/core';
import {
  C,
  CACHE_DIR,
  DATA_ROOT,
  DB_DIR,
  REPO_ROOT,
  VOLUMES_FILE,
  ensureMigrated,
} from './paths.js';

function icon(status: EnrichOutcome['status']): string {
  switch (status) {
    case 'matched': return `${C.green}✓${C.reset}`;
    case 'review': return `${C.yellow}?${C.reset}`;
    case 'not-found': return `${C.red}✕${C.reset}`;
    case 'failed': return `${C.red}!${C.reset}`;
    default: return `${C.dim}·${C.reset}`;
  }
}

async function main() {
  await ensureMigrated();
  const sources = await loadEnvFiles(DATA_ROOT, REPO_ROOT);

  // A token pasted into the repo is one update away from being lost. Copy it once to
  // the data directory, which survives replacing the code folder.
  const saved = await persistEnvToDataDir(DATA_ROOT, REPO_ROOT);
  if (saved) {
    console.log(`\n${C.dim}copied your .env to ${saved}`);
    console.log(`  so updating the code no longer loses your token${C.reset}`);
  }

  const args = process.argv.slice(2);
  const force = args.includes('--force');
  const skipArtwork = args.includes('--no-artwork');
  const limitArg = args.find((a) => a.startsWith('--limit='));
  const limit = limitArg ? Number(limitArg.split('=')[1]) : Infinity;

  const token = process.env.TMDB_READ_TOKEN;
  if (!token) {
    console.error(`\n${C.red}TMDB_READ_TOKEN is not set.${C.reset}\n`);
    // Say exactly what was checked and what was found — "not set" right after you set
    // it is only confusing if the error will not say where it looked.
    for (const s of sources) {
      if (!s.existed) console.error(`  ${C.dim}no file   ${s.path}${C.reset}`);
      else if (!s.keys.includes('TMDB_READ_TOKEN'))
        console.error(`  ${C.yellow}found, but no TMDB_READ_TOKEN${C.reset}  ${s.path}`);
      else console.error(`  ${C.yellow}TMDB_READ_TOKEN present but empty${C.reset}  ${s.path}`);
    }
    console.error(`\n  Add this line to ${join(DATA_ROOT, '.env')} (survives updates):\n`);
    console.error(`    TMDB_READ_TOKEN=eyJhbGci...\n`);
    console.error(`${C.dim}  Get one free at themoviedb.org → Settings → API${C.reset}\n`);
    process.exit(1);
  }

  const store = new MetaStore(DB_DIR);
  const vm = new VolumeManager(VOLUMES_FILE);
  const client = new TmdbClient(token, CACHE_DIR);

  const [{ titles }, states] = await Promise.all([store.loadAll(), vm.probeAll()]);
  const country = process.env.NFL_COUNTRY ?? 'IN';

  const todo = titles
    .filter((t) => force || t.matchState === 'unmatched' || t.matchState === 'review' || !t.overview)
    .slice(0, limit);

  if (todo.length === 0) {
    console.log(`\n${C.dim}Nothing to enrich. ${titles.length} titles already have metadata.${C.reset}`);
    console.log(`${C.dim}Use --force to refetch.${C.reset}\n`);
    return;
  }

  console.log(`\n${C.bold}Enriching${C.reset} ${C.dim}${todo.length} of ${titles.length} titles${C.reset}\n`);

  const outcomes: EnrichOutcome[] = [];
  for (const [i, title] of todo.entries()) {
    process.stderr.write(`${C.dim}[${i + 1}/${todo.length}] ${title.title}…${C.reset}\x1b[K\r`);
    const outcome = await enrichTitle(title, client, states, store, CACHE_DIR, country, {
      force,
      skipArtwork,
    });
    outcomes.push(outcome);

    process.stderr.write('\x1b[K');
    const label = outcome.matchedTo ?? title.title;
    console.log(`  ${icon(outcome.status)} ${C.bold}${title.title}${C.reset} ${C.dim}→ ${label}${C.reset}`);

    if (outcome.status === 'review') {
      console.log(`      ${C.yellow}${outcome.reasons?.join(', ')}${C.reset} ${C.dim}(${outcome.confidence})${C.reset}`);
      if (outcome.alternatives?.length) {
        console.log(`      ${C.dim}also considered: ${outcome.alternatives.join(' · ')}${C.reset}`);
      }
    }
    if (outcome.status === 'failed') console.log(`      ${C.red}${outcome.error}${C.reset}`);
  }

  const count = (s: EnrichOutcome['status']) => outcomes.filter((o) => o.status === s).length;
  console.log(`\n${C.bold}Done${C.reset}`);
  console.log(`  ${C.green}${count('matched')}${C.reset} matched`);
  if (count('review')) console.log(`  ${C.yellow}${count('review')}${C.reset} need review — ${C.dim}pnpm library --review${C.reset}`);
  if (count('not-found')) console.log(`  ${C.red}${count('not-found')}${C.reset} not found on TMDB`);
  if (count('failed')) console.log(`  ${C.red}${count('failed')}${C.reset} failed`);
  console.log('');
}

main().catch((err) => {
  console.error(`${C.red}${err instanceof Error ? err.message : String(err)}${C.reset}`);
  process.exit(1);
});
