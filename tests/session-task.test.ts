import assert from 'node:assert/strict';
import test from 'node:test';
import { runRetryableSessionTask } from '../src/lib/utils/sessionTask.ts';

test('a successful session task runs only once per key', async () => {
  const completed = new Set<string>();
  let runs = 0;
  const task = async () => {
    runs += 1;
    return true;
  };

  await runRetryableSessionTask(completed, 'user', task);
  await runRetryableSessionTask(completed, 'user', task);

  assert.equal(runs, 1);
  assert.equal(completed.has('user'), true);
});

test('a failed session task releases its key for another attempt', async () => {
  const completed = new Set<string>();
  let runs = 0;

  await assert.rejects(
    runRetryableSessionTask(completed, 'user', async () => {
      runs += 1;
      throw new Error('transaction failed');
    }),
    /transaction failed/,
  );
  assert.equal(completed.has('user'), false);

  await runRetryableSessionTask(completed, 'user', async () => {
    runs += 1;
    return true;
  });
  assert.equal(runs, 2);
  assert.equal(completed.has('user'), true);
});

test('a synchronous task failure also releases its key', async () => {
  const completed = new Set<string>();

  await assert.rejects(
    runRetryableSessionTask(completed, 'user', () => {
      throw new Error('setup failed');
    }),
    /setup failed/,
  );

  assert.equal(completed.has('user'), false);
});

test('a handled incomplete session task also releases its key', async () => {
  const completed = new Set<string>();
  let runs = 0;

  await runRetryableSessionTask(completed, 'user', async () => {
    runs += 1;
    return false;
  });
  await runRetryableSessionTask(completed, 'user', async () => {
    runs += 1;
    return true;
  });

  assert.equal(runs, 2);
  assert.equal(completed.has('user'), true);
});

test('a concurrent call does not duplicate an acquired session task', async () => {
  const completed = new Set<string>();
  let finish!: (complete: boolean) => void;
  const held = new Promise<boolean>((resolve) => {
    finish = resolve;
  });
  let runs = 0;
  const task = async () => {
    runs += 1;
    return held;
  };

  const first = runRetryableSessionTask(completed, 'user', task);
  await runRetryableSessionTask(completed, 'user', task);
  assert.equal(runs, 1);
  assert.equal(completed.has('user'), true);

  finish(true);
  await first;
  assert.equal(completed.has('user'), true);
});
