import assert from 'node:assert/strict';
import test from 'node:test';
import { httpReadError, pollConversation } from '../chatgpt-read.mjs';

const done = { state: 'done', node: 'answer', text: 'complete answer', userMessageId: 'user' };
function harness(sequence, options = {}) {
  let time = 0;
  let reads = 0;
  const sleeps = [];
  return {
    get reads() { return reads; }, sleeps,
    run: () => pollConversation({
      timeoutSec: 120, now: () => time, random: () => 0,
      sleep: async ms => { sleeps.push(ms); time += ms; },
      read: async () => { const value = sequence[Math.min(reads++, sequence.length - 1)]; if (value instanceof Error) throw value; return value; },
      ...options,
    }),
  };
}

test('completed answers need one read, even if the next response would be 429', async () => {
  const h = harness([done, httpReadError(429)]);
  assert.deepEqual(await h.run(), done);
  assert.equal(h.reads, 1);
  assert.deepEqual(h.sleeps, []);
});

test('an already observed completed submission is reused without another read', async () => {
  const h = harness([httpReadError(429)], { initialSnapshot: done });
  assert.deepEqual(await h.run(), done);
  assert.equal(h.reads, 0);
});

test('Retry-After supports seconds and HTTP dates while rejecting invalid and negative values', () => {
  assert.equal(httpReadError(429, '20').retryAfterSec, 20);
  assert.equal(httpReadError(429, 'Thu, 01 Jan 1970 00:01:00 GMT', 'conversation', 10000).retryAfterSec, 50);
  assert.equal(httpReadError(429, 'invalid').retryAfterSec, null);
  assert.equal(httpReadError(429, '-1').retryAfterSec, null);
});

test('a rate-limited read honors Retry-After before retrying the same resource', async () => {
  const h = harness([httpReadError(429, '20'), done]);
  assert.equal((await h.run()).state, 'done');
  assert.deepEqual(h.sleeps, [20000]);
  assert.equal(h.reads, 2);
});

test('server cooldowns exceeding the budget are returned without premature retry', async () => {
  const h = harness([httpReadError(429, '60'), done], { timeoutSec: 30 });
  const r = await h.run();
  assert.equal(r.state, 'rate_limited');
  assert.equal(r.retryAfterSec, 60);
  assert.equal(h.reads, 1);
  assert.deepEqual(h.sleeps, []);
});

test('persistent throttling backs off exponentially with bounded retries and individual waits', async () => {
  const h = harness([httpReadError(429)], { timeoutSec: 300 });
  const r = await h.run();
  assert.equal(r.state, 'rate_limited');
  assert.equal(r.retryAttempts, 3);
  assert.equal(h.reads, 4);
  assert.equal(h.sleeps.reduce((a, b) => a + b, 0), 70000);
  assert.ok(h.sleeps.every(ms => ms <= 30000));
});

test('large Retry-After sleeps are split into intervals of at most thirty seconds', async () => {
  const h = harness([httpReadError(429, '65'), done]);
  assert.equal((await h.run()).state, 'done');
  assert.deepEqual(h.sleeps, [30000, 30000, 5000]);
});

test('missing, forbidden, and unauthorized resources fail once with distinct classifications', async () => {
  for (const [status, state] of [[401, 'noauth'], [403, 'forbidden'], [404, 'not_found']]) {
    const h = harness([httpReadError(status), done]);
    assert.equal((await h.run()).state, state);
    assert.equal(h.reads, 1);
    assert.deepEqual(h.sleeps, []);
  }
});

test('network and server errors retry without being reported as unfinished research', async () => {
  for (const failure of [new Error('fetch failed'), httpReadError(503)]) {
    const h = harness([failure, done]);
    assert.equal((await h.run()).state, 'done');
    assert.equal(h.reads, 2);
  }
  const h = harness([new Error('fetch failed')], { timeoutSec: 0 });
  assert.equal((await h.run()).state, 'read_error');
});

test('unchanged pending turns reduce poll frequency and stop at the deadline', async () => {
  const h = harness([{ state: 'pending', node: 'work', steps: 11 }], { timeoutSec: 30 });
  assert.equal((await h.run()).state, 'pending');
  assert.deepEqual(h.sleeps, [5000, 7500, 11250, 6250]);
  assert.equal(h.reads, 4);
});

test('a late timer never triggers an extra request beyond the deadline', async () => {
  let time = 0;
  let reads = 0;
  const result = await pollConversation({
    timeoutSec: 12, now: () => time, random: () => 0,
    read: async () => { reads++; return httpReadError(429); },
    sleep: async ms => { time += ms + 5000; },
  });
  assert.equal(result.state, 'rate_limited');
  assert.equal(reads, 1);
});

test('one-shot preflight returns a pending turn without waiting or submitting another prompt', async () => {
  const h = harness([{ state: 'pending' }], { stopWhen: () => true });
  assert.equal((await h.run()).state, 'pending');
  assert.equal(h.reads, 1);
  assert.deepEqual(h.sleeps, []);
});
