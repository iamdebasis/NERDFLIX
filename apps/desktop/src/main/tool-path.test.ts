import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { withToolDirs } from './tool-path.js';

const FINDER_PATH = '/usr/bin:/bin:/usr/sbin:/sbin';
const onlyHomebrew = (dir: string) => dir === '/opt/homebrew/bin';

describe('an app opened from Finder finds Homebrew tools', () => {
  test("Finder's minimal PATH gains Homebrew's folder — the packaged app scanned nothing without it", () => {
    assert.equal(withToolDirs(FINDER_PATH, onlyHomebrew), `${FINDER_PATH}:/opt/homebrew/bin`);
  });

  test('a PATH that already has it is left exactly as it was, order included', () => {
    const terminal = '/opt/homebrew/bin:/usr/bin:/bin';
    assert.equal(withToolDirs(terminal, onlyHomebrew), terminal);
  });

  test('only folders that exist are added', () => {
    assert.equal(withToolDirs(FINDER_PATH, () => false), FINDER_PATH);
    assert.equal(
      withToolDirs(FINDER_PATH, (d) => d !== '/opt/local/bin'),
      `${FINDER_PATH}:/opt/homebrew/bin:/usr/local/bin`,
    );
  });

  test('no PATH at all still yields a usable one', () => {
    assert.equal(withToolDirs(undefined, onlyHomebrew), '/opt/homebrew/bin');
  });
});
