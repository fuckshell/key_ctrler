const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {test, after} = require('node:test');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-restart-budget-'));
process.env.WECHAT_WORKSPACE = root;
process.env.WECHAT_POSTPROCESS_JOB_FILE = path.join(root, 'state/jobs.json');
process.env.WECHAT_CODEX_REPAIR_DIR = path.join(root, 'state/codex-repair');
process.env.WECHAT_CODEX_REPAIR_DRY_RUN = '1';
const {loadPostprocessJobs, selectPostprocessJob} = require('../wechat-ingest');
const {repairPending, grantProviderRetry} = require('../postprocess-repair');
after(() => fs.rmSync(root, {recursive: true, force: true}));

test('restart preserves terminal failures and cannot renew the attempt budget through migration markers', () => {
  const now = Date.now();
  const base = {created_at: new Date(now - 120000).toISOString(),
    started_at: new Date(now - 100000).toISOString(), event: {talker: 'fixture'},
    attempts: 2, last_error: 'online-calendar-failed', completed_at: new Date(now).toISOString()};
  const terminal = {...base, id: 'terminal-without-version', status: 'retry', retry_exhausted: true};
  const oldMigration = {...base, id: 'old-migration', status: 'queued', retry_exhausted: false,
    repair_replay_version: '2026-11-08-flash-fix-v1'};
  const eligibleRetry = {...base, id: 'remaining-attempt', status: 'queued', attempts: 1,
    repair_replay_version: '2026-11-08-flash-fix-v1'};
  fs.mkdirSync(path.dirname(process.env.WECHAT_POSTPROCESS_JOB_FILE), {recursive: true});
  fs.writeFileSync(process.env.WECHAT_POSTPROCESS_JOB_FILE,
    JSON.stringify({version: 1, jobs: [terminal, oldMigration, eligibleRetry]}));

  loadPostprocessJobs();
  const saved = JSON.parse(fs.readFileSync(process.env.WECHAT_POSTPROCESS_JOB_FILE, 'utf8'));
  assert.equal(saved.jobs[0].status, 'retry');
  assert.equal(saved.jobs[0].retry_exhausted, true);
  assert.equal(saved.jobs[0].self_repair.reason, 'historical-terminal-retry');
  assert.equal(saved.jobs[0].self_repair_triggered_at != null, true);
  assert.equal(saved.jobs[1].status, 'retry');
  assert.equal(saved.jobs[1].retry_exhausted, true);
  for (const job of saved.jobs.slice(0, 2)) {
    assert.equal(job.attempts, 2);
    assert.equal(job.last_error, base.last_error);
    assert.equal(job.completed_at, base.completed_at);
    assert.equal(selectPostprocessJob([job], now + 86400000).job, undefined);
  }
  assert.deepEqual(saved.jobs[2], eligibleRetry);
  assert.equal(selectPostprocessJob(saved.jobs, now).job.id, eligibleRetry.id);
  const fresh = {id: 'fresh', status: 'queued', attempts: 0,
    created_at: new Date(now).toISOString(), event: {talker: 'fixture'}};
  assert.equal(selectPostprocessJob([...saved.jobs, fresh], now).job.id, fresh.id);

  loadPostprocessJobs();
  assert.deepEqual(JSON.parse(fs.readFileSync(process.env.WECHAT_POSTPROCESS_JOB_FILE, 'utf8')), saved);
  assert.equal(saved.jobs[1].self_repair.reason, 'historical-terminal-retry');
});

test('a legacy replay marker cannot select exhausted work before restart either', () => {
  for (const state of [{attempts: 2}, {attempts: 1, retry_exhausted: true}, {attempts: 0, media_waits: 2}]) {
    const job = {id: 'legacy', status: 'queued', created_at: '2026-11-01T00:00:00Z',
      repair_replay_version: '2026-11-08-flash-fix-v1', ...state};
    assert.equal(selectPostprocessJob([job], Date.now()).job, undefined);
  }
});

test('restart backfills a missing Codex request even when an old marker exists', () => {
  const now = Date.now();
  const missingRequest = path.join(process.env.WECHAT_CODEX_REPAIR_DIR, 'request-missing.json');
  const job = {
    id: 'terminal-marker-without-request', status: 'retry', attempts: 2,
    retry_exhausted: true, last_error: 'triage-providers-failed',
    self_repair_triggered_at: new Date(now - 1000).toISOString(),
    self_repair: {status: 'running', at: new Date(now - 1000).toISOString(),
      backfill_attempted_at: new Date(now - 1000).toISOString(),
      codex_repair: {request_id: 'missing-request', request_file: missingRequest}},
    created_at: new Date(now - 120000).toISOString(),
    completed_at: new Date(now - 1000).toISOString(), event: {talker: 'fixture'},
  };
  fs.writeFileSync(process.env.WECHAT_POSTPROCESS_JOB_FILE,
    JSON.stringify({version: 1, jobs: [job]}));

  loadPostprocessJobs();

  const saved = JSON.parse(fs.readFileSync(process.env.WECHAT_POSTPROCESS_JOB_FILE, 'utf8')).jobs[0];
  assert.equal(saved.status, 'retry');
  assert.equal(saved.attempts, 2);
  assert.equal(typeof saved.self_repair_triggered_at, 'string');
  assert.equal(saved.self_repair.backfill_attempted_at != null, true);
  assert.equal(saved.self_repair.codex_repair.status, 'spawn-failed');
  assert.equal(selectPostprocessJob([saved], now + 86400000).job, undefined);
});

test('automatic provider repair grants cannot renew exhausted work or run legacy grants', () => {
  const job = {id: 'provider-terminal', status: 'queued', attempts: 2,
    retry_exhausted: true, last_error: 'online-calendar-failed',
    created_at: '2026-11-01T00:00:00Z', event: {talker: 'fixture'},
    repair_execution: {fix_id: 'verified-provider-retry-v1', pending: true,
      attempts: 0, attempts_before: 2, repair_round: 4}};
  const original = structuredClone(job);
  assert.equal(repairPending(job), false);
  assert.equal(selectPostprocessJob([job], Date.now()).job, undefined);
  assert.throws(() => grantProviderRetry(job, {expected_attempts: 2,
    expected_error: job.last_error}), /automatic-provider-replay-disabled/);
  assert.deepEqual(job, original);

  fs.writeFileSync(process.env.WECHAT_POSTPROCESS_JOB_FILE,
    JSON.stringify({version: 1, jobs: [job]}));
  loadPostprocessJobs();
  const saved = JSON.parse(fs.readFileSync(process.env.WECHAT_POSTPROCESS_JOB_FILE, 'utf8')).jobs
    .find(entry => entry.id === job.id);
  assert.equal(saved.status, 'retry');
  assert.equal(saved.attempts, 2);
  assert.deepEqual(saved.repair_execution, original.repair_execution);
  assert.equal(selectPostprocessJob([saved], Date.now()).job, undefined);
});
