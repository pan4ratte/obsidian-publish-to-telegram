import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { withTimeout, retry } from '../src/util';

// util.ts uses the `window.`-prefixed timers Obsidian's lint rules require. Node has no
// `window`, so stand one up backed by the real timers before the helpers run.
(globalThis as unknown as { window: unknown }).window = { setTimeout, clearTimeout };

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

test('withTimeout resolves when the promise settles in time', async () => {
  assert.strictEqual(await withTimeout(Promise.resolve('ok'), 100), 'ok');
});

test('withTimeout rejects once the deadline passes', async () => {
  await assert.rejects(
    withTimeout(sleep(500).then(() => 'late'), 20),
    /Timed out/,
  );
});

test('withTimeout propagates the original rejection', async () => {
  await assert.rejects(withTimeout(Promise.reject(new Error('boom')), 100), /boom/);
});

test('withTimeout clears its timer so a fast result leaves nothing pending', async () => {
  let cleared = false;
  const win = (globalThis as unknown as { window: { clearTimeout: typeof clearTimeout } }).window;
  const realClear = win.clearTimeout;
  win.clearTimeout = ((id: Parameters<typeof clearTimeout>[0]) => { cleared = true; realClear(id); }) as typeof clearTimeout;
  try {
    await withTimeout(Promise.resolve('ok'), 1000);
    // The finally hook runs on the promise's microtask chain; yield once for it.
    await Promise.resolve();
    assert.ok(cleared, 'expected the pending timeout to be cleared');
  } finally {
    win.clearTimeout = realClear;
  }
});

test('retry returns the first success without further attempts', async () => {
  let calls = 0;
  const result = await retry(async () => { calls++; return 'first'; }, 3, 10);
  assert.strictEqual(result, 'first');
  assert.strictEqual(calls, 1);
});

test('retry keeps trying until an attempt succeeds', async () => {
  let calls = 0;
  const result = await retry(async () => {
    if (++calls < 3) throw new Error('transient');
    return `attempt ${calls}`;
  }, 3, 10);
  assert.strictEqual(result, 'attempt 3');
  assert.strictEqual(calls, 3);
});

test('retry exhausts its attempts and rethrows the last error', async () => {
  let calls = 0;
  await assert.rejects(
    retry(async () => { calls++; throw new Error(`fail ${calls}`); }, 3, 10),
    /fail 3/,
  );
  assert.strictEqual(calls, 3);
});

test('retry waits between attempts', async () => {
  const started = Date.now();
  await assert.rejects(retry(async () => { throw new Error('x'); }, 3, 50));
  // Two gaps between three attempts.
  assert.ok(Date.now() - started >= 100, 'expected ~100ms of backoff across retries');
});
