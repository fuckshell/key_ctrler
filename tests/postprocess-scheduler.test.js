const assert = require('node:assert/strict');
const { test } = require('node:test');
const { drainPostprocessPool, selectPostprocessJob, postprocessProviderRetryAt, postprocessLaneForReadyCount, postprocessApiBurstPlan, classifyPostprocessResult } = require('../wechat-ingest');
const now = Date.parse('2026-11-07T00:00:00Z');
function job(id, created, rest = {}) {
  return { id, status: 'queued', created_at: new Date(created).toISOString(), ...rest };
}
test('continuous new arrivals get every slot; retries never reserve a turn', () => {
  let queue = [job('retry', now - 30 * 86400000, {started_at: new Date(now - 100000).toISOString()})];
  for (let i = 0; i < 20; i++) {
    const fresh = job(`fresh-${i}`, now + i);
    queue.push(fresh);
    const pick = selectPostprocessJob(queue, now + i);
    assert.equal(pick.job.id, fresh.id);
    queue = queue.filter(j => j !== pick.job);
  }
  assert.equal(queue[0].id, 'retry');
});
test('thousands of old media retries cannot monopolize a new confirmation', () => {
  const queue = Array.from({length: 1300}, (_, i) => job(`retry-${i}`, now - 30 * 86400000 + i,
    {started_at: new Date(now - 1800000 + i).toISOString(), media_waits: 50}));
  queue.push(job('owner-confirmation', now - 1000));
  assert.equal(selectPostprocessJob(queue, now).job.id, 'owner-confirmation');
});
test('retry starts only after fresh work drained and sixty seconds of quiet', () => {
  const retry = job('retry', now - 100000, {started_at: new Date(now - 90000).toISOString()});
  const fresh = job('fresh', now);
  const queue = [retry, fresh];
  assert.equal(selectPostprocessJob(queue, now).job.id, 'fresh');
  fresh.status = 'succeeded'; fresh.started_at = new Date(now).toISOString();
  assert.equal(selectPostprocessJob(queue, now + 59999).job, undefined);
  assert.equal(selectPostprocessJob(queue, now + 59999).idleUntil, now + 60000);
  assert.equal(selectPostprocessJob(queue, now + 60000).job.id, 'retry');
  queue.push(job('arrived-during-retry-gap', now + 60001));
  assert.equal(selectPostprocessJob(queue, now + 60001).job.id, 'arrived-during-retry-gap');
});
test('one-time migrated retry replay is selectable from the same queue', () => {
  const migrated = job('migrated-retry', now - 1000, {
    repair_previous_status: 'retry',
    repair_replay_done_at: new Date(now).toISOString(),
  });
  assert.equal(selectPostprocessJob([migrated], now).job.id, 'migrated-retry');
});

test('backoff, completed and running jobs are never selected', () => {
  const queue = [job('waiting', now - 100000, {next_attempt_at_ms: now + 1}),
    job('running', now - 100000, {status:'running'}), job('done', now - 100000, {status:'succeeded'})];
  assert.equal(selectPostprocessJob(queue, now).job, undefined);
  assert.equal(selectPostprocessJob(queue, now + 1).job.id, 'waiting');
});
test('historical counter resets and missing terminal flags cannot reopen exhausted work', () => {
  const exhausted = [job('attempt-cap', now-100000, {attempts:2}),
    job('media-cap',now-100000,{attempts:0,media_waits:23,repair_previous_status:'retry'}),
    job('terminal',now-100000,{retry_exhausted:true})];
  assert.equal(selectPostprocessJob(exhausted,now).job,undefined);
  const fresh=job('new-message',now);
  assert.equal(selectPostprocessJob([...exhausted,fresh],now).job.id,fresh.id);
});
test('an old retried media item moves behind less recently served retry work', () => {
  const media = job('media', now - 100000, {started_at: new Date(now - 90000).toISOString()});
  const other = job('other', now - 80000, {started_at: new Date(now - 70000).toISOString()});
  const queue = [media, other];
  assert.equal(selectPostprocessJob(queue, now).job.id, 'media');
  media.started_at = new Date(now).toISOString();
  assert.equal(selectPostprocessJob(queue, now).job.id, 'other');
  assert.equal(queue.length, 2);
});

test('fresh private conversation precedes bulk group media without promoting retries', () => {
  const old = job('old-private-retry', now - 100000, {started_at: new Date(now-90000).toISOString(), event:{talker:'wxid_a',type:1}});
  const privateText = job('private-swap-confirmation', now - 1000, {event:{talker:'wxid_a',type:1}});
  const groupImage = job('new-group-image', now, {event:{talker:'123@chatroom',type:3}});
  assert.equal(selectPostprocessJob([old, groupImage, privateText], now).job.id, privateText.id);
  privateText.status = 'succeeded';
  assert.equal(selectPostprocessJob([old, groupImage, privateText], now).job.id, groupImage.id);
});

test('historical recovery first attempt is idle work and cannot reset new-arrival quiet time', () => {
  const history = job('recovered-old-image', now, {event:{media_recovered:true,talker:'wxid_a',type:3}});
  const actualNew = job('current-private-message', now-1000, {event:{talker:'wxid_a',type:1}});
  assert.equal(selectPostprocessJob([history,actualNew],now).job.id,actualNew.id);
  actualNew.status='succeeded';actualNew.started_at=new Date(now-1000).toISOString();
  assert.equal(selectPostprocessJob([history,actualNew],now+59000).job.id,history.id);
  assert.equal(selectPostprocessJob([history],now).job.id,history.id);
});

test('paid API burst stays disabled regardless of backlog and stale worker settings', () => {
  assert.equal(postprocessLaneForReadyCount(50, 50), 'normal');
  assert.equal(postprocessLaneForReadyCount(51, 50), 'normal');
  assert.deepEqual(postprocessApiBurstPlan(917, 50, 99), {lane: 'normal', concurrency: 1});
  assert.deepEqual(postprocessApiBurstPlan(20, 50, 99), {lane: 'normal', concurrency: 1});
});

test('API burst uses the same business outcome checks as the normal worker', () => {
  const succeeded = classifyPostprocessResult({
    ok: true,
    calendar: {ok: true, result: {reason: 'llm-skip'}},
  });
  assert.equal(succeeded.ok, true);
  assert.equal(succeeded.retryable, false);

  const failed = classifyPostprocessResult({
    ok: false,
    calendar: {ok: false, reason: 'timeout'},
  });
  assert.equal(failed.ok, false);
  assert.equal(failed.retryable, true);
  assert.equal(failed.reason, 'timeout');
});

test('API burst remains an execution lane and does not promote retry records', () => {
  const retry = job('old-retry', now - 100000, {
    status: 'retry',
    started_at: new Date(now - 90000).toISOString(),
  });
  const fresh = job('fresh', now);
  assert.equal(selectPostprocessJob([retry, fresh], now).job.id, 'fresh');
  assert.equal(retry.status, 'retry');
});


test('unserved recovered messages run ahead of previously served retries, behind live work', () => {
  const retry = job('served', now - 86400000, {started_at: new Date(now - 80000000).toISOString()});
  const recovered = job('unserved-recovered', now - 100000, {event: {media_recovered: true}});
  const live = job('live', now - 1000);
  assert.equal(selectPostprocessJob([retry, recovered, live], now).job.id, 'live');
  live.status = 'succeeded'; live.started_at = new Date(now).toISOString();
  assert.equal(selectPostprocessJob([retry, recovered, live], now).job, undefined);
  assert.equal(selectPostprocessJob([retry, recovered, live], now + 60000).job.id, recovered.id);
});

test('pool restores all spare lanes after quiet selection while one task remains in flight', async () => {
  const queue = [{id: 'slow', status: 'queued'}];
  const release = new Map();
  let active = 0, peak = 0;
  const pool = drainPostprocessPool({concurrency: 4, pollMs: 5, stopped: () => false,
    select: () => ({job: queue.find(j => j.status === 'queued')}),
    processJob: async (j) => {
      j.status = 'running'; active++; peak = Math.max(peak, active);
      await new Promise(resolve => release.set(j.id, resolve));
      active--; j.status = 'succeeded';
    },
  });
  queue.push(...Array.from({length: 3}, (_, i) => ({id: 'new-' + i, status: 'queued'})));
  try {
    for (let i = 0; i < 100 && release.size < 4; i++) await new Promise(r => setTimeout(r, 5));
    assert.equal(release.size, 4, 'spare lanes must start before slow task finishes');
    assert.equal(peak, 4);
  } finally {
    for (const resolve of release.values()) resolve();
    await pool;
  }
  assert.ok(queue.every(j => j.status === 'succeeded'));
});

test('pool drains active tasks when stopped without claiming more work', async () => {
  const queue = [{id: 1}, {id: 2}]; let stopped = false; let count = 0;
  await drainPostprocessPool({concurrency: 4, stopped: () => stopped,
    select: () => ({job: queue.shift()}),
    processJob: async () => {count++; stopped = true;},
  });
  assert.equal(count, 1); assert.equal(queue.length, 1);
});


test('first attempt yielded to fresh work resumes ahead of old failed retries', () => {
  const oldRetry = job('failed', now - 86400000, {attempts: 1, started_at: new Date(now - 80000000).toISOString()});
  const yielded = job('yielded-first-attempt', now - 100000, {attempts: 0,
    event: {media_recovered: true}, started_at: new Date(now - 70000).toISOString(),
    last_error: 'temporary-new-messages-pending'});
  assert.equal(selectPostprocessJob([oldRetry, yielded], now).job.id, yielded.id);
  const live = job('new-live', now - 1000);
  assert.equal(selectPostprocessJob([oldRetry, yielded, live], now).job.id, live.id);
});


test('eight newly recovered messages precede migrated retries whose yields refunded attempts', () => {
  const old = Array.from({length: 180}, (_, i) => job(`migrated-${i}`, now - 30 * 86400000 + i, {
    attempts: 0, repair_previous_status: 'retry',
    started_at: new Date(now - 1800000 + i).toISOString(),
    last_error: 'temporary-new-messages-pending',
  }));
  const fresh = Array.from({length: 8}, (_, i) => job(`recovered-${i}`, now - 120000 + i, {
    attempts: 0, event: {media_recovered: true},
    ...(i < 2 ? {started_at: new Date(now - 90000).toISOString(),
      last_error: 'temporary-new-messages-pending'} : {}),
  }));
  const queue = [...old, ...fresh];
  for (const expected of fresh) {
    const selected = selectPostprocessJob(queue, now).job;
    assert.equal(selected.id, expected.id);
    selected.status = 'succeeded';
  }
  assert.equal(selectPostprocessJob(queue, now).job.id, old[0].id);
  queue.push(job('live-now', now));
  assert.equal(selectPostprocessJob(queue, now).job.id, 'live-now');
});

test('continuous historical recovery cannot starve repaired retries in the fourth idle slot', () => {
  const active = Array.from({length: 3}, (_, i) => job(`active-${i}`, now-100000,
    {status:'running', attempts:1, started_at:new Date(now-1000).toISOString(), event:{media_recovered:true}}));
  const recovered = job('next-recovered', now-100000, {event:{media_recovered:true}});
  const retry = job('old-retry', now-86400000, {attempts:1, started_at:new Date(now-80000000).toISOString()});
  assert.equal(selectPostprocessJob([...active,recovered,retry],now).job.id,retry.id);
  // With a retry already running, remaining capacity belongs to recovered work.
  retry.status='running';retry.attempts=2;
  assert.equal(selectPostprocessJob([...active,recovered,retry],now).job.id,recovered.id);
  // An actual new message always takes that same available slot.
  const live=job('live',now-1000);
  retry.status='queued';retry.attempts=1;
  assert.equal(selectPostprocessJob([...active,recovered,retry,live],now).job.id,live.id);
  live.status='succeeded';live.started_at=new Date(now-1000).toISOString();
  assert.equal(selectPostprocessJob([...active,recovered,retry,live],now).job,undefined);
});

test('provider circuit prevents claims and budget exhaustion until fresh work can run', async () => {
  const queue = Array.from({length: 30}, (_, i) => job(`prior-${i}`, now - 86400000 + i,
    {attempts: 1, started_at: new Date(now - 80000000).toISOString(), last_error: 'online-rate-limit'}));
  const fresh = job('new-private-message', now, {attempts: 0, event: {talker: 'wxid_new', type: 1}});
  const exhausted = job('exhausted', now - 86400000, {status: 'retry', attempts: 2, retry_exhausted: true});
  queue.push(fresh, exhausted);
  const before = JSON.stringify(queue);
  const providerRetryAt = now + 60000;
  let calls = 0;
  await drainPostprocessPool({concurrency: 3, stopped: () => false,
    select: () => selectPostprocessJob(queue, now, {providerRetryAt}),
    processJob: async () => {calls++;},
  });
  assert.equal(calls, 0, 'a cached failure must never start a processor or repair');
  assert.deepEqual(selectPostprocessJob(queue, now + 59999, {providerRetryAt}),
    {job: undefined, idleUntil: providerRetryAt});
  assert.equal(JSON.stringify(queue), before, 'no status, attempts or historical evidence may change');
  assert.equal(selectPostprocessJob(queue, providerRetryAt, {providerRetryAt}).job, fresh);
  assert.equal(selectPostprocessJob([exhausted], providerRetryAt, {providerRetryAt}).job, undefined);
});

test('only a current, bounded provider circuit matching Python config SHA defers dispatch', (t) => {
  const fs = require('node:fs');
  const path = require('node:path');
  const crypto = require('node:crypto');
  const root = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'provider-circuit-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const circuitFile = path.join(root, 'circuit.json');
  const configFiles = [path.join(root, 'config.json'), path.join(root, 'auth.json')];
  fs.writeFileSync(configFiles[0], '{}');
  fs.writeFileSync(configFiles[1], '{"profiles":{}}');
  const digest = crypto.createHash('sha256');
  for (const file of configFiles) digest.update(fs.readFileSync(file));
  const circuit = {ok: false, retryable: true, reason: 'online-rate-limit',
    retry_after: now / 1000 + 60, config_revision: digest.digest('hex')};
  const read = () => postprocessProviderRetryAt(now, {circuitFile, configFiles});
  const write = (value) => fs.writeFileSync(circuitFile, JSON.stringify(value));
  write(circuit);
  assert.equal(read(), now + 60000);
  for (const reason of ['online-auth', 'online-spend-cap']) {
    write({...circuit, reason, retry_after: now / 1000 + 1800});
    assert.equal(read(), now + 1800000);
  }
  for (const changes of [{ok: true}, {retryable: false}, {reason: 'online-calendar-failed'},
    {retry_after: now / 1000}, {retry_after: now / 1000 + 1801}, {retry_after: 'Infinity'},
    {retry_after: String(now / 1000 + 60)}, {config_revision: 'outdated'}]) {
    write({...circuit, ...changes});
    assert.equal(read(), 0, JSON.stringify(changes));
  }
  write(circuit);
  fs.writeFileSync(configFiles[1], '{"profiles":{"changed":true}}');
  assert.equal(read(), 0, 'a repaired configuration must invalidate the old circuit');
  fs.writeFileSync(circuitFile, '{broken');
  assert.equal(read(), 0);
  fs.unlinkSync(circuitFile);
  assert.equal(read(), 0);
});
