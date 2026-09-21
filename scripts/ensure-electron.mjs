#!/usr/bin/env node
/**
 * Guarantee the Electron runtime is actually downloaded.
 *
 * Electron ships as a small npm package plus a ~280 MB postinstall download. pnpm
 * gates postinstall scripts behind its `allowBuilds` config AND its own bookkeeping
 * of which packages it has already built — and the bookkeeping wins. A cached store
 * entry can be replayed without ever running the script, leaving a package directory
 * that looks installed but has no `path.txt` and no `dist/`.
 *
 * The symptom is `Error: Electron uninstall` from electron-vite's getElectronPath,
 * which is a confusing way to say "the binary is missing".
 *
 * So rather than trusting the package manager, check for the artefact and fetch it
 * if it is not there. Idempotent, and cheap when everything is fine.
 */

import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';

const require = createRequire(import.meta.url);

function electronDir() {
  try {
    return dirname(require.resolve('electron/package.json'));
  } catch {
    return null;
  }
}

const dir = electronDir();

if (!dir) {
  // Electron is a devDependency; a production-only install legitimately lacks it.
  process.exit(0);
}

const pathFile = join(dir, 'path.txt');
const distDir = join(dir, 'dist');

if (existsSync(pathFile) && existsSync(distDir)) {
  process.exit(0);
}

console.log('Electron runtime missing — downloading it (~280 MB, one time)…');

const result = spawnSync(process.execPath, [join(dir, 'install.js')], {
  stdio: 'inherit',
  cwd: dir,
});

if (result.status !== 0 || !existsSync(pathFile)) {
  console.error('');
  console.error('Could not download the Electron runtime.');
  console.error('The CLI tools still work: pnpm scan, pnpm library, pnpm play.');
  console.error('To retry the app:  node node_modules/electron/install.js');
  console.error('');
  // Do not fail the whole install — everything except `pnpm app` still works.
  process.exit(0);
}

console.log('Electron runtime ready.');
