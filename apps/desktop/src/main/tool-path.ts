/**
 * Let an app opened from Finder find the tools Homebrew installed.
 *
 * ffprobe and mpv are run by name, so they are found only if their folder is on PATH.
 * A terminal's PATH includes Homebrew, but an app opened from Finder or the Dock gets
 * launchd's minimal `/usr/bin:/bin:/usr/sbin:/sbin`. Measured on the packaged build
 * launched that way: a scan of a folder holding a film found nothing and reported
 * "Up to date", and bare mpv could not start. From a terminal the same build worked,
 * which is why running from source never showed it.
 *
 * The folders are the ones the README's `brew install` puts tools in: `/opt/homebrew`
 * on Apple silicon, `/usr/local` for an Intel-era Homebrew, and MacPorts. Appended rather
 * than prepended, so a PATH that already finds a tool keeps finding the same one.
 */

import { existsSync } from 'node:fs';

export const TOOL_DIRS = ['/opt/homebrew/bin', '/usr/local/bin', '/opt/local/bin'] as const;

export function withToolDirs(
  path: string | undefined,
  exists: (dir: string) => boolean = existsSync,
): string {
  const parts = (path ?? '').split(':').filter(Boolean);
  for (const dir of TOOL_DIRS) {
    if (!parts.includes(dir) && exists(dir)) parts.push(dir);
  }
  return parts.join(':');
}

process.env.PATH = withToolDirs(process.env.PATH);
