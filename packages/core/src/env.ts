/**
 * Token loading.
 *
 * Checked in order: the user data directory first, then the repo.
 *
 * The data directory matters for the same reason the library lives there — replacing
 * the code folder on an update wipes anything inside it, and `.env` is deliberately
 * absent from any distributed archive because it holds a secret. So a token kept only
 * in the repo has to be re-pasted after every update, and the failure is confusing:
 * "TMDB_READ_TOKEN is not set" right after you set it.
 */

import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export type EnvSource = { path: string; existed: boolean; keys: string[] };

function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed
      .slice(eq + 1)
      .trim()
      .replace(/^["']|["']$/g, '');
    if (key && value) out[key] = value;
  }
  return out;
}

async function readIfPresent(path: string): Promise<EnvSource> {
  try {
    const parsed = parseEnv(await readFile(path, 'utf8'));
    for (const [k, v] of Object.entries(parsed)) {
      if (!process.env[k]) process.env[k] = v;
    }
    return { path, existed: true, keys: Object.keys(parsed) };
  } catch {
    return { path, existed: false, keys: [] };
  }
}

/**
 * Load env from both locations. Already-set process env always wins, so an exported
 * shell variable overrides a file, and the data dir overrides the repo.
 */
export async function loadEnvFiles(dataDir: string, repoRoot: string): Promise<EnvSource[]> {
  const sources: EnvSource[] = [];
  sources.push(await readIfPresent(join(dataDir, '.env')));
  sources.push(await readIfPresent(join(repoRoot, '.env')));
  return sources;
}

/**
 * Copy a repo .env into the data directory so the next update cannot lose it.
 * Only runs when the data copy does not already exist.
 */
export async function persistEnvToDataDir(
  dataDir: string,
  repoRoot: string,
): Promise<string | null> {
  const target = join(dataDir, '.env');
  try {
    await readFile(target, 'utf8');
    return null; // already there
  } catch {
    /* continue */
  }
  try {
    const text = await readFile(join(repoRoot, '.env'), 'utf8');
    await mkdir(dataDir, { recursive: true });
    await writeFile(target, text, { mode: 0o600 });
    return target;
  } catch {
    return null;
  }
}
