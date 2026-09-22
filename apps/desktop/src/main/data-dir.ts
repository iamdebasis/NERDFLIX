/**
 * Decide where the app keeps its data, BEFORE anything reads that decision.
 *
 * `@nfl/core` finds the data directory by looking upward for `pnpm-workspace.yaml`,
 * which is right when the app runs from a checkout — the CLI and the app then agree on
 * one `data/` folder. A PACKAGED app has no workspace above it. The search fails, the
 * fallback counts directories instead, and it lands INSIDE `Nerdflix.app`, which is
 * read-only and is replaced wholesale on every update. The library would fail to write
 * and it would look like a permissions bug rather than a path bug.
 *
 * Two corrections are needed for a packaged build, and the first is not obvious:
 *
 *  1. **The app has to be named.** Electron derives `userData` from `package.json`'s
 *     `name`, which in a workspace is `@nfl/desktop` — so a shipped build created a
 *     literal `@nfl` folder in the user's Application Support and put the app inside
 *     it. Observed exactly that before this line existed.
 *
 *  2. **Our data goes in a `data/` subfolder of it**, not directly in `userData`.
 *     Electron keeps Chromium's caches, session storage and preferences in that
 *     directory; a library sitting loose among them invites "clear the app's data"
 *     taking the watch history with it, and mirrors the checkout layout besides.
 *
 * Nothing downstream changes, because `dataPaths()` already honours `NFL_DATA_DIR` and
 * `packages/player` honours the same variable — so the two cannot end up disagreeing.
 *
 * This module must be imported FIRST in the main process. `dataPaths()` is called at
 * module scope and imports evaluate in order, so a later import would be too late.
 */

import { app } from 'electron';
import { join } from 'node:path';

export const APP_NAME = 'Nerdflix';

if (app.isPackaged) {
  // Before any getPath('userData') call — that is what it feeds.
  app.setName(APP_NAME);
  if (!process.env.NFL_DATA_DIR) {
    process.env.NFL_DATA_DIR = join(app.getPath('userData'), 'data');
  }
}

/** Which arrangement is in force, for the diagnostics that report it. */
export const DATA_DIR_SOURCE = app.isPackaged ? 'packaged' : 'checkout';
