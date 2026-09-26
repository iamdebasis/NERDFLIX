import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { errorMessage } from './ipc-error.js';

describe('an error from the main process reads as its own sentence', () => {
  test("Electron's wrapping is removed (observed verbatim in the Play toast)", () => {
    const err = new Error(
      "Error invoking remote method 'library:play': Error: Sunrise Test is no longer on HDRLAB — it may have been deleted, or moved off the drive.",
    );
    assert.equal(
      errorMessage(err),
      'Sunrise Test is no longer on HDRLAB — it may have been deleted, or moved off the drive.',
    );
  });

  test('a named error class is removed too', () => {
    const err = new Error("Error invoking remote method 'libraries:scan': TypeError: bad volume");
    assert.equal(errorMessage(err), 'bad volume');
  });

  test('anything else is left exactly as it was', () => {
    assert.equal(errorMessage(new Error('Error: keep me')), 'Error: keep me');
    assert.equal(errorMessage('plain string'), 'plain string');
  });
});
