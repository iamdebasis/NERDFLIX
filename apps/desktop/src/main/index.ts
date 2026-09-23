// FIRST, always: it decides where data lives before anything reads that. See data-dir.ts.
import './data-dir.js';

import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import { watch } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  MediaResolver,
  MetaStore,
  StateStore,
  VolumeManager,
  dataPaths,
  ensureDataDirs,
  ingest,
  scanRoot,
  enrichTitle,
  episodeSlots,
  needsEnrichment,
  loadEnvFiles,
  TmdbClient,
  type VolumeState,
} from '@nfl/core';
import { ALL_LIBRARIES, type LibraryCard } from '../shared/types.js';
import { buildBrowseData, registerMediaProtocol, registerMediaScheme } from './browse.js';
import { disposePlayback, registerPlaybackIpc } from './library-ipc.js';

const here = dirname(fileURLToPath(import.meta.url));
// out/main → repo root
const REPO_ROOT = resolve(here, '..', '..', '..', '..');

// User data lives outside the repo so updating the code cannot erase a scanned
// library. See packages/core/src/paths.ts.
const PATHS = dataPaths();
const DB_DIR = PATHS.dbDir;
const VOLUMES_FILE = PATHS.volumesFile;

const vm = new VolumeManager(VOLUMES_FILE);
const store = new MetaStore(DB_DIR);
const state = new StateStore(PATHS.stateFile);
let lastStates: VolumeState[] = [];

let mainWindow: BrowserWindow | null = null;

/**
 * Build the picker cards.
 *
 * Title counts come from the DB, which knows what exists regardless of what is
 * plugged in — that separation is what lets an unplugged drive still show "217 films"
 * rather than an empty card. See ARCHITECTURE.md §8.5.
 */
async function buildCards(): Promise<LibraryCard[]> {
  const states = await vm.probeAll();
  lastStates = states;

  const { titles } = await store.loadAll();
  const resolver = new MediaResolver(states);

  const cards: LibraryCard[] = states.map((s) => {
    // A title belongs to this volume if ANY of its files have been seen there.
    const onThisVolume = (m: { sightings: { volumeId: string }[] }) =>
      m.sightings.some((sight) => sight.volumeId === s.root.id);
    const owned = titles.filter((t) => t.media.some(onThisVolume));
    const bytes = owned.reduce(
      (sum, t) =>
        sum + t.media.filter(onThisVolume).reduce((a, m) => a + m.sizeBytes, 0),
      0,
    );
    const needsMetadata = owned.filter(
      (t) => t.matchState === 'unmatched' || t.matchState === 'review',
    ).length;

    // A relocated drive is online, just at a new path. Persist it so the next launch
    // does not have to search again.
    if (s.status === 'relocated' && s.resolvedPath) {
      void vm.commitRelocation(s.root.id, s.resolvedPath);
    }

    return {
      id: s.root.id,
      label: s.root.label,
      path: s.resolvedPath ?? s.root.path,
      kind: s.root.kind,
      fileSystem: s.root.fileSystem,
      connected: s.status !== 'offline',
      relocated: s.status === 'relocated',
      titleCount: owned.length,
      showCount: owned.filter((t) => t.type === 'show').length,
      totalBytes: bytes,
      needsMetadata,
      neverScanned: owned.length === 0,
      availableCount: owned.filter((t) => resolver.resolve(t).status === 'available').length,
    } satisfies LibraryCard;
  });

  /**
   * One more card for everything at once.
   *
   * Only worth showing with more than one library — with a single drive it would just
   * duplicate the card beside it.
   *
   * The counts must be deduplicated rather than summed. Content addressing means a film
   * copied between drives is ONE title with two sightings, so 5 + 4 is not 9. Bytes
   * count the largest copy of each film, which answers "how much distinct content is
   * there" rather than "how much disk is consumed".
   */
  if (cards.length > 1) {
    const anywhere = titles.filter((t) =>
      t.media.some((m) => m.sightings.some((sg) => states.some((s) => s.root.id === sg.volumeId))),
    );

    const duplicateCount = anywhere.filter((t) =>
      t.media.some((m) => new Set(m.sightings.map((sg) => sg.volumeId)).size > 1),
    ).length;

    /*
     * The largest copy of each film — and, for a show, of EACH EPISODE. Taking the
     * largest single file of a show would count one episode and drop the rest.
     */
    const distinctBytes = (t: (typeof anywhere)[number]) =>
      t.type === 'show'
        ? episodeSlots(t).reduce((s, slot) => s + Math.max(0, ...slot.files.map((m) => m.sizeBytes)), 0)
        : Math.max(0, ...t.media.map((m) => m.sizeBytes));
    const bytes = anywhere.reduce((sum, t) => sum + distinctBytes(t), 0);
    const showCount = anywhere.filter((t) => t.type === 'show').length;

    cards.unshift({
      id: ALL_LIBRARIES,
      // "All films" would be a wrong promise the moment a library holds a series.
      label: showCount > 0 ? 'Everything' : 'All films',
      showCount,
      path: states.map((s) => s.root.label).join(' · '),
      connected: states.some((s) => s.status !== 'offline'),
      titleCount: anywhere.length,
      totalBytes: bytes,
      needsMetadata: anywhere.filter(
        (t) => t.matchState === 'unmatched' || t.matchState === 'review',
      ).length,
      neverScanned: anywhere.length === 0,
      availableCount: anywhere.filter((t) => resolver.resolve(t).status === 'available').length,
      // Not a real volume, so these are placeholders the UI does not read for it.
      kind: 'local',
      relocated: false,
      combined: true,
      duplicateCount,
      shelfSeeds: states.map((s) => s.root.id),
    } satisfies LibraryCard);
  }

  return cards;
}

function registerIpc(): void {
  ipcMain.handle('libraries:list', () => buildCards());

  ipcMain.handle('libraries:add', async () => {
    if (!mainWindow) return null;
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Choose a folder of films',
      properties: ['openDirectory', 'createDirectory'],
      message: 'Pick the folder that holds your films. Subfolders are included.',
      buttonLabel: 'Add library',
    });
    if (result.canceled || result.filePaths.length === 0) return null;

    const path = result.filePaths[0];

    /**
     * No question is asked here.
     *
     * A native alert in the middle of a designed UI is jarring, and it asked something
     * the system can mostly answer itself: pairing only writes a small identity file,
     * and a drive we cannot write to is already treated as read-only — which has the
     * same effect as borrowed. Marking a writable drive as someone else's is rare, so
     * it belongs in Manage libraries, not in the path everyone walks.
     */
    const root = await vm.pair(path);
    return root.id;
  });

  /**
   * Fetch artwork and metadata for anything still unmatched.
   *
   * Runs automatically after a scan when a TMDB token is configured — a library of
   * grey rectangles is not worth looking at, and requiring a second terminal command
   * to make it usable is a poor default.
   */
  ipcMain.handle('libraries:enrich', async () => {
    // data/.env first, then the project root's .env. Passing the data dir twice
    // meant a token in the project root was silently ignored.
    await loadEnvFiles(PATHS.root, join(PATHS.root, '..'));

    const token = process.env.TMDB_READ_TOKEN;
    if (!token) return { skipped: 'no-token' as const, matched: 0, failed: 0 };

    const { titles } = await store.loadAll();
    // Only what still needs it. A 'confirmed' match is a human decision and is never
    // redone, but it can still be re-derived from cache — `needsEnrichment` knows the
    // difference, and `enrichTitle` enforces it.
    const pending = titles.filter((t) => needsEnrichment(t, { withArtwork: true }));
    if (pending.length === 0) return { skipped: null, matched: 0, failed: 0 };

    // TmdbClient appends 'tmdb' itself — passing it here too produced cache/tmdb/tmdb/.
    const client = new TmdbClient(token, PATHS.cacheDir);
    let matched = 0;
    let failed = 0;

    for (const [i, title] of pending.entries()) {
      mainWindow?.webContents.send('libraries:enrichProgress', {
        done: i,
        total: pending.length,
        current: title.title,
      });
      try {
        const outcome = await enrichTitle(
          title,
          client,
          store,
          join(PATHS.cacheDir, 'artwork'),
          'US',
        );
        if (outcome.status === 'matched') matched += 1;
        else if (outcome.status === 'failed') failed += 1;
      } catch {
        failed += 1;
      }
    }

    mainWindow?.webContents.send('libraries:enrichProgress', {
      done: pending.length,
      total: pending.length,
      current: '',
    });
    mainWindow?.webContents.send('libraries:changed');
    return { skipped: null, matched, failed };
  });

  /** Mark a writable drive as someone else's, so we stop writing to it. */
  ipcMain.handle('libraries:setBorrowed', async (_e, id: string, borrowed: boolean) => {
    await vm.update(id, { borrowed });
    mainWindow?.webContents.send('libraries:changed');
    return true;
  });

  /**
   * Save a TMDB token from the UI.
   *
   * Editing a dotfile is not a reasonable requirement, and it is easy to put the token
   * in `.env.example` — a template that is never read — and conclude the app is broken.
   */
  ipcMain.handle('libraries:setToken', async (_e, token: string) => {
    const clean = token.trim();
    if (!clean) return false;
    const { writeFile, mkdir } = await import('node:fs/promises');
    await mkdir(PATHS.root, { recursive: true });
    await writeFile(join(PATHS.root, '.env'), `TMDB_READ_TOKEN=${clean}\n`, { mode: 0o600 });
    process.env.TMDB_READ_TOKEN = clean;
    return true;
  });

  ipcMain.handle('libraries:hasToken', async () => {
    await loadEnvFiles(PATHS.root, join(PATHS.root, '..'));
    return Boolean(process.env.TMDB_READ_TOKEN);
  });

  ipcMain.handle('libraries:remove', async (_e, id: string) => {
    await vm.remove(id);
    return true;
  });

  ipcMain.handle('libraries:reveal', async (_e, path: string) => {
    shell.showItemInFolder(path);
  });

  /**
   * Scan from the UI.
   *
   * Content on a drive changes — films get added, deleted, renamed — and until now the
   * only way to reflect that was `pnpm scan` in a terminal. A library that silently
   * disagrees with the disk is worse than one that is obviously empty, so this has to
   * be reachable from the card itself.
   */
  ipcMain.handle('libraries:scan', async (_e, volumeId: string, prune = false) => {
    const state = lastStates.find((s) => s.root.id === volumeId);
    if (!state || state.status === 'offline' || !state.resolvedPath) {
      throw new Error('That drive is not connected');
    }

    const send = (payload: unknown) =>
      mainWindow?.webContents.send('libraries:scanProgress', payload);

    const report = await scanRoot(state.resolvedPath, {
      concurrency: 4,
      // The 200 MB feature floor is right for films but wrong for a library of
      // short clips, and impossible to test against without an override.
      minFeatureBytes: process.env.NFL_MIN_SIZE ? Number(process.env.NFL_MIN_SIZE) : undefined,
      onProgress: (done, total, current) =>
        send({ volumeId, done, total, current, phase: 'scanning' }),
    });

    send({ volumeId, done: report.titles.length, total: report.titles.length, current: '', phase: 'saving' });

    const stats = await ingest(report, state.root, state.resolvedPath, store, { prune });

    send({ volumeId, done: 0, total: 0, current: '', phase: 'done' });
    mainWindow?.webContents.send('libraries:changed');

    return {
      created: stats.created,
      updated: stats.updated,
      unchanged: stats.unchanged,
      moved: stats.relocated,
      alreadyKnown: stats.alreadyKnown,
      missing: stats.missing.map((m) => ({ title: m.title, relPath: m.relPath })),
      pruned: stats.pruned,
      elapsedMs: report.elapsedMs,
    };
  });

  ipcMain.handle('library:browse', async (_e, volumeId?: string) => {
    const states = await vm.probeAll();
  lastStates = states;
    return buildBrowseData(store, state, states, volumeId);
  });

  ipcMain.handle('library:toggleMyList', async (_e, titleId: string) => {
    const added = await state.toggleMyList(titleId);
    await state.settle();
    return added;
  });
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    show: false,
    backgroundColor: '#141414',
    // Frameless with an inset traffic-light cluster: the picker is a full-bleed
    // canvas, and a standard title bar would cut the composition in half.
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 20, y: 20 },
    webPreferences: {
      preload: join(here, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // Paint only once there is something to show, so launch is a cut, not a flash.
  mainWindow.once('ready-to-show', () => mainWindow?.show());

  if (process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void mainWindow.loadFile(join(here, '../renderer/index.html'));
  }

  // Live mount detection: plugging a drive in updates the picker immediately
  // instead of requiring a relaunch.
  vm.watchMounts(() => {
    mainWindow?.webContents.send('libraries:changed');
  });

  // Watch db/ too. `pnpm scan` runs in a separate terminal, so without this the picker
  // keeps saying "Not scanned yet" until the app is restarted — which is the very
  // first thing anyone does after pairing a drive.
  let dbDebounce: NodeJS.Timeout | undefined;
  try {
    watch(DB_DIR, { recursive: true }, () => {
      clearTimeout(dbDebounce);
      // A scan writes one file per title; coalesce the burst into one refresh.
      dbDebounce = setTimeout(() => mainWindow?.webContents.send('libraries:changed'), 600);
    });
  } catch {
    // db/ may not exist yet on a first run; the mount watcher still covers pairing.
  }
}

// Before ready.
registerMediaScheme();

void app.whenReady().then(async () => {
  registerMediaProtocol();
  // Anyone who scanned before the data move still has records in the repo.
  await mkdir(DB_DIR, { recursive: true }).catch(() => {});

  await ensureDataDirs();
  registerIpc();
  registerPlaybackIpc({
    store,
    state,
    getStates: () => lastStates,
    // Quitting mpv should show fresh progress on the tiles.
    onClosed: () => mainWindow?.webContents.send('libraries:changed'),
  });

  // Warm the volume + artwork index before the first paint, so posters resolve on
  // the first render rather than after a refresh.
  await buildCards().catch(() => []);

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('before-quit', () => {
  void disposePlayback();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
