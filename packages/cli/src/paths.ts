/**
 * Shared paths for the CLI commands.
 *
 * All library data lives under `data/` in the project root. See core's paths.ts for
 * the layout and the reasoning behind the db/state/cache split.
 */

import { join } from 'node:path';
import { dataPaths, ensureDataDirs } from '@nfl/core';

export const PATHS = dataPaths();
export const DB_DIR = PATHS.dbDir;
export const STATE_DIR = PATHS.stateDir;
export const CACHE_DIR = PATHS.cacheDir;
export const VOLUMES_FILE = PATHS.volumesFile;
export const STATE_FILE = PATHS.stateFile;
export const TMDB_CACHE_DIR = join(PATHS.cacheDir, 'tmdb');
export const ARTWORK_CACHE_DIR = join(PATHS.cacheDir, 'artwork');

/** Every command calls this first, so a fresh checkout works with no setup step. */
export async function ensureDirs(): Promise<void> {
  await ensureDataDirs();
}

/** Kept for call sites that predate `ensureDirs`; the data dir is created either way. */
export const ensureMigrated = ensureDirs;

export const DATA_ROOT = PATHS.root;
export const REPO_ROOT = PATHS.root;

/** Terminal colours, shared so every command reads the same. */
export const C = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
} as const;

/** Decimal, to match what Finder reports. */
export function fmtBytes(n: number): string {
  if (n >= 1e12) return `${(n / 1e12).toFixed(1)} TB`;
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)} GB`;
  if (n >= 1e6) return `${Math.round(n / 1e6)} MB`;
  return `${Math.round(n / 1e3)} kB`;
}

export function fmtDuration(sec: number): string {
  if (!Number.isFinite(sec) || sec <= 0) return '—';
  const h = Math.floor(sec / 3600);
  const m = Math.round((sec % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}
