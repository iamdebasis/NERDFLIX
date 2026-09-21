/**
 * MetaStore — one JSON file per title under db/, validated by Zod on read.
 *
 * Deliberately not a single monolithic file. Per-title files mean an agent can write
 * one record without rewriting the library, a malformed edit damages exactly one
 * title, and `git diff` shows what changed. See ARCHITECTURE.md §5.
 */

import { mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { TitleSchema, type Title } from '../schema/index.js';

export type LoadIssue = { file: string; error: string };

export type LoadResult = {
  titles: Title[];
  issues: LoadIssue[];
};

export class MetaStore {
  constructor(private readonly dbDir: string) {}

  private dirFor(type: 'movie' | 'show'): string {
    return join(this.dbDir, type === 'movie' ? 'movies' : 'shows');
  }

  async init(): Promise<void> {
    await mkdir(join(this.dbDir, 'movies'), { recursive: true });
    await mkdir(join(this.dbDir, 'shows'), { recursive: true });
  }

  /**
   * Load everything. Invalid records are collected rather than thrown, so one bad
   * agent edit degrades to "this title needs attention" instead of an empty library.
   */
  async loadAll(): Promise<LoadResult> {
    const titles: Title[] = [];
    const issues: LoadIssue[] = [];

    for (const type of ['movie', 'show'] as const) {
      const dir = this.dirFor(type);
      let files: string[];
      try {
        files = (await readdir(dir)).filter((f) => f.endsWith('.json'));
      } catch {
        continue;
      }

      for (const file of files) {
        const full = join(dir, file);
        try {
          const raw = JSON.parse(await readFile(full, 'utf8'));
          const parsed = TitleSchema.safeParse(raw);
          if (parsed.success) {
            titles.push(parsed.data);
          } else {
            issues.push({
              file: full,
              error: parsed.error.issues
                .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
                .join('; '),
            });
          }
        } catch (err) {
          issues.push({ file: full, error: err instanceof Error ? err.message : String(err) });
        }
      }
    }

    titles.sort((a, b) => a.sortTitle.localeCompare(b.sortTitle));
    return { titles, issues };
  }

  async get(id: string, type: 'movie' | 'show' = 'movie'): Promise<Title | null> {
    try {
      const raw = JSON.parse(await readFile(join(this.dirFor(type), `${id}.json`), 'utf8'));
      return TitleSchema.parse(raw);
    } catch {
      return null;
    }
  }

  /**
   * Write atomically: a crash mid-write must not leave a truncated JSON file that
   * fails to parse on next launch.
   */
  async save(title: Title): Promise<void> {
    const parsed = TitleSchema.parse({ ...title, updatedAt: new Date().toISOString() });
    const dir = this.dirFor(parsed.type);
    await mkdir(dir, { recursive: true });

    const target = join(dir, `${parsed.id}.json`);
    const tmp = `${target}.tmp`;
    await writeFile(tmp, JSON.stringify(parsed, null, 2) + '\n', 'utf8');
    await rename(tmp, target);
  }

  async delete(id: string, type: 'movie' | 'show' = 'movie'): Promise<void> {
    await unlink(join(this.dirFor(type), `${id}.json`)).catch(() => {});
  }
}

/**
 * Stable, human-readable, filesystem-safe id.
 *
 * Includes the year because "The Thing (1982)" and "The Thing (2011)" are different
 * films that would otherwise collide, and a collision here silently merges two titles.
 */
export function makeSlug(title: string, year?: number): string {
  const base = title
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return year ? `${base}-${year}` : base;
}

/** Articles move to the end so browsing sorts the way a shelf would. */
export function makeSortTitle(title: string): string {
  return title.replace(/^(the|a|an)\s+/i, '').trim() || title;
}
