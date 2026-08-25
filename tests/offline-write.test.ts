import assert from 'node:assert/strict';
import test from 'node:test';
import { acceptReportedWrite, invokeReportedWrite } from '../src/lib/utils/offlineWrite.ts';

test('a reported offline write advances once before server acknowledgement', async () => {
  let rejectWrite!: (error: Error) => void;
  const completion = new Promise<void>((_resolve, reject) => {
    rejectWrite = reject;
  });
  const latch = { accepted: false };
  let writes = 0;
  let accepted = 0;
  let globallyReported: unknown;

  const handled = acceptReportedWrite(
    latch,
    () => invokeReportedWrite(
      () => {
        writes += 1;
        return completion;
      },
      (error) => {
        globallyReported = error;
      },
    ),
    () => {
      accepted += 1;
    },
    () => assert.fail('the asynchronous rejection is not synchronous'),
  );
  const duplicate = acceptReportedWrite(
    latch,
    async () => {
      writes += 1;
    },
    () => {
      accepted += 1;
    },
    () => assert.fail('the duplicate must not call the writer'),
  );

  assert.equal(latch.accepted, true);
  assert.equal(writes, 1);
  assert.equal(accepted, 1);
  assert.equal(duplicate, null);
  assert.ok(handled instanceof Promise);

  const failure = new Error('flush rejected');
  rejectWrite(failure);
  await handled;
  assert.equal(globallyReported, failure);
});

test('a synchronous write failure keeps the draft retryable and reports inline', () => {
  const latch = { accepted: false };
  const failure = new Error('persistence is unavailable');
  let accepted = 0;
  let globallyReported: unknown;
  let inlineReported: unknown;

  const handled = acceptReportedWrite(
    latch,
    () => invokeReportedWrite(
      () => {
        throw failure;
      },
      (error) => {
        globallyReported = error;
      },
    ),
    () => {
      accepted += 1;
    },
    (error) => {
      inlineReported = error;
    },
  );

  assert.equal(handled, null);
  assert.equal(latch.accepted, false);
  assert.equal(accepted, 0);
  assert.equal(globallyReported, failure);
  assert.equal(inlineReported, failure);
});
