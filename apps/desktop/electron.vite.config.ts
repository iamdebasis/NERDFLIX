import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';
import { builtinModules } from 'node:module';
import { resolve } from 'node:path';

/**
 * Two non-obvious constraints here, both learned the hard way:
 *
 * 1. `electron` MUST be external.
 *    The npm `electron` package is a shim whose index.js reads `path.txt` from its own
 *    directory to locate the real runtime. Bundle it and that lookup happens relative to
 *    `out/main/` instead of `node_modules/electron/`, so it throws "Electron failed to
 *    install correctly" — which sounds like a broken download but is actually a bundling
 *    bug. Supplying our own `build.rollupOptions` displaces electron-vite's default
 *    external list, so it has to be restated.
 *
 * 2. The `@nfl/*` workspace packages MUST be bundled, not externalized.
 *    Their package.json `main` points at TypeScript source (`./src/index.ts`), which is
 *    what we want for tsx-based CLIs but is unloadable by Electron's Node at runtime.
 */
const nodeExternals = [
  'electron',
  ...builtinModules,
  ...builtinModules.map((m) => `node:${m}`),
];

const workspacePackages = ['@nfl/core', '@nfl/player'];

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin({ exclude: workspacePackages })],
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/main/index.ts') },
        external: nodeExternals,
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin({ exclude: workspacePackages })],
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/preload/index.ts') },
        external: nodeExternals,
      },
    },
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    plugins: [react()],
    resolve: { alias: { '@': resolve(__dirname, 'src/renderer/src') } },
    build: {
      rollupOptions: { input: { index: resolve(__dirname, 'src/renderer/index.html') } },
    },
  },
});
