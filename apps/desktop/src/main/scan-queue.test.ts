import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { scanQueue } from './scan-queue.js';

/** A scan that finishes when told to, recording every run. */
function harness() {
  const runs: { volumeId: string; prune: boolean; finish: () => void; fail: () => void }[] = [];
  const scan = scanQueue(
    (volumeId, prune) =>
      new Promise<string>((resolve, reject) => {
        runs.push({
          volumeId,
          prune,
          finish: () => resolve(`${volumeId}${prune ? ' pruned' : ''} #${runs.length}`),
          fail: () => reject(new Error('scan failed')),
        });
      }),
  );
  return { scan, runs };
}

const tick = () => new Promise((r) => setImmediate(r));

describe('one scan per drive at a time', () => {
  test('Play arriving during the automatic rescan joins it rather than racing it', async () => {
    const { scan, runs } = harness();
    const auto = scan('moviex');
    const play = scan('moviex');
    await tick();
    assert.equal(runs.length, 1);
    runs[0].finish();
    assert.deepEqual(await Promise.all([auto, play]), ['moviex #1', 'moviex #1']);
  });

  test('different drives scan side by side', async () => {
    const { scan, runs } = harness();
    void scan('moviex');
    void scan('doc');
    await tick();
    assert.deepEqual(runs.map((r) => r.volumeId), ['moviex', 'doc']);
  });

  test('a prune is never swallowed by a scan that does not prune — it runs after', async () => {
    const { scan, runs } = harness();
    const auto = scan('moviex');
    const prune = scan('moviex', true);
    await tick();
    assert.equal(runs.length, 1, 'the prune must not start while the first scan runs');
    runs[0].finish();
    await auto;
    await tick();
    assert.deepEqual(runs.map((r) => r.prune), [false, true]);
    runs[1].finish();
    assert.equal(await prune, 'moviex pruned #2');
  });

  test('a scan asked for while a prune is queued joins the prune', async () => {
    const { scan, runs } = harness();
    void scan('moviex');
    const prune = scan('moviex', true);
    const later = scan('moviex');
    await tick();
    runs[0].finish();
    await tick();
    runs[1].finish();
    assert.equal(await later, await prune);
    assert.equal(runs.length, 2);
  });

  test('the first scan failing does not stop the prune queued behind it', async () => {
    const { scan, runs } = harness();
    const auto = scan('moviex');
    const prune = scan('moviex', true);
    await tick();
    runs[0].fail();
    await assert.rejects(auto);
    await tick();
    runs[1].finish();
    assert.equal(await prune, 'moviex pruned #2');
  });

  test('once finished, the next request is a fresh scan', async () => {
    const { scan, runs } = harness();
    const first = scan('moviex');
    await tick();
    runs[0].finish();
    await first;
    void scan('moviex');
    await tick();
    assert.equal(runs.length, 2);
  });
});
