import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findProjectRoot } from './paths.js';

const here = fileURLToPath(new URL('.', import.meta.url));

describe('the data directory is the same one for everybody', () => {
  /**
   * The bug this pins. `dataPaths()` used to walk three levels up from its own module,
   * which lands on the repo root from `packages/core/src/` — where the CLI runs it —
   * but on `<repo>/apps` from `apps/desktop/out/main/`, where Electron runs it after
   * bundling `@nfl/core` in. The app and the CLI therefore kept separate libraries and
   * each reported confidently on a directory the other had never written to.
   */
  test('resolves the same root from source and from a bundled main process', () => {
    const fromCore = findProjectRoot(here);
    assert.ok(fromCore, 'found from packages/core/src');
    const bundled = join(fromCore, 'apps', 'desktop', 'out', 'main');
    assert.equal(findProjectRoot(bundled), fromCore, 'a bundled main agrees with the CLI');
  });

  test('and from every other depth the code actually runs at', () => {
    const root = findProjectRoot(here)!;
    for (const d of [
      join(root, 'packages', 'cli', 'src'),
      join(root, 'packages', 'player', 'src'),
      join(root, 'apps', 'desktop', 'src', 'main'),
      join(root, 'apps', 'desktop', 'out', 'preload'),
      root,
    ]) {
      assert.equal(findProjectRoot(d), root, `agrees from ${d}`);
    }
  });

  test('the marker it looks for is really there, and only at the root', () => {
    const root = findProjectRoot(here)!;
    assert.ok(existsSync(join(root, 'pnpm-workspace.yaml')));
    assert.ok(!existsSync(join(root, 'apps', 'pnpm-workspace.yaml')));
    assert.ok(!existsSync(join(root, 'packages', 'pnpm-workspace.yaml')));
  });

  test('somewhere with no marker above it returns null rather than guessing', () => {
    assert.equal(findProjectRoot('/'), null);
  });
});
