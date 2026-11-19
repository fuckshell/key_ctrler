const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const {test, after} = require('node:test');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'middle-dispatch-'));
process.env.WECHAT_WORKSPACE = root;
process.env.WECHAT_POSTPROCESS_JOB_FILE = path.join(root, 'state/jobs.json');
process.env.WECHAT_CODEX_REPAIR_DIR = path.join(root, 'repair');
process.env.WECHAT_CODEX_REPAIR_DRY_RUN = '1';
const {processPostprocessJob, normalizeTerminalMiddleMedia} = require('../wechat-ingest');
const {grantRepair, repairPending} = require('../postprocess-repair');
after(() => fs.rmSync(root, {recursive:true, force:true}));
function granted(id, fix_id='verified-middle-upgrade-v1') {
  return {id, status:'queued', attempts:2, retry_exhausted:true,
    last_error:'image-tier-not-ready', event:{}, repair_execution:{fix_id,
      pending:true, attempts:0, attempts_before:2, previous_error:'image-tier-not-ready',
      proof:{ok:true, job_id:id, attempts:2, last_error:'image-tier-not-ready'}}};
}
test('verified middle and OCR grants reach the processor exactly once without resetting original attempts', async () => {
  for (const fix of ['verified-middle-upgrade-v1', 'completed-flash-ocr-v1', 'verified-middle-dispatch-v2']) {
    const job = granted(fix, fix); let calls = 0;
    await processPostprocessJob(job, {postprocess:async () => {calls++; return {ok:true,calendar:false,vision_calendar:false};}});
    assert.equal(calls,1); assert.equal(job.status,'succeeded');
    assert.equal(job.attempts,2); assert.equal(job.repair_execution.attempts,1);
    assert.equal(repairPending(job),false);
  }
});
test('native verified middle is usable while high definition is still pending', () => {
  const file=path.join(root,'middle.jpg'); fs.writeFileSync(file, 'middle-fixture');
  const sha=require('node:crypto').createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  const job={last_error:'image-tier-not-ready',event:{media_path:file,media_captured_tier:'middle',
    media_middle_sha256:sha,media_thumbnail_sha256:'other',media_middle_pending:false,
    media_hd_pending:true,media_note:'hd_upgrade_pending'}};
  assert.equal(normalizeTerminalMiddleMedia(job),true);
  assert.equal(job.event.media_file_sha256,sha);
  const thumbnail={last_error:'image-tier-not-ready',event:{...job.event,media_thumbnail_sha256:sha}};
  assert.equal(normalizeTerminalMiddleMedia(thumbnail),false);
});
test('only a proven pre-processor block can receive one dispatch repair', () => {
  const job=granted('blocked'); job.status='retry';job.last_error='terminal-resolution-no-new-evidence';
  job.result={terminal_resolution:true,reason:job.last_error};
  Object.assign(job.repair_execution,{pending:false,attempts:1,outcome:'retry',started_at:'exact'});
  job.event.media_file_sha256='middle';job.repair_execution.proof.file_sha='middle';
  const proof={ok:true,fix_id:'verified-middle-dispatch-v2',job_id:job.id,attempts:2,
    last_error:job.last_error,file_sha:'middle',blocked_execution_started_at:'exact'};
  const req={fix_id:proof.fix_id,expected_attempts:2,expected_error:job.last_error};
  const unknown=structuredClone(job);unknown.result={reason:'calendar-child-timeout-outcome-unknown'};
  assert.throws(()=>grantRepair(unknown,req,proof),/not-verified/);
  grantRepair(job,req,proof);assert.equal(job.attempts,2);assert.equal(job.repair_execution_history.length,1);
  assert.equal(repairPending(job),true);
  assert.throws(()=>grantRepair(job,req,proof),/not-verified/);
});
