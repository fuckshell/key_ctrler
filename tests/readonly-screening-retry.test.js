const assert = require('node:assert/strict');
const { test, after } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'readonly-screening-'));
fs.mkdirSync(path.join(root, 'state'));
process.env.WECHAT_WORKSPACE = root;
process.env.WECHAT_POSTPROCESS_JOB_FILE = path.join(root, 'state/jobs.json');
process.env.WECHAT_POSTPROCESS_RETRY_BASE_MS = '15000';
const { processPostprocessJob } = require('../wechat-ingest');
after(() => fs.rmSync(root, { recursive: true, force: true }));

test('screening admission preserves the attempt and can resume on the subscription', async () => {
  const job = { id: 'screen', status: 'queued', attempts: 1, event: {} };
  for (const reason of ['provider-rate-limit-wait', 'subscription-worker-busy', 'phone-worker-busy']) {
    const retryAfter = Math.ceil(Date.now() / 1000) + 3600;
    await processPostprocessJob(job, { postprocess: async () => ({
      calendar: { ok: true, result: {
        ok: false, reason, stage: 'readonly-screening', retry_after: retryAfter
      } }
    }) });
    assert.equal(job.status, 'queued');
    assert.equal(job.attempts, 1);
    assert.ok(job.next_attempt_at_ms <= Date.now() + 15000);
  }
  await processPostprocessJob(job, { postprocess: async () => ({ ok: true, calendar: false }) });
  assert.equal(job.status, 'succeeded');
});

test('an error after screening still consumes a business attempt', async () => {
  const job = { id: 'write', status: 'queued', attempts: 0, event: {} };
  await processPostprocessJob(job, { postprocess: async () => ({
    calendar: { ok: true, result: { ok: false, retryable: true, reason: 'provider-rate-limit-wait' } }
  }) });
  assert.equal(job.attempts, 1);
  assert.equal(job.last_error, 'provider-rate-limit-wait');
});
