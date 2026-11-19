const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const {createRequire} = require('node:module');
const {canonicalQueueCounts} = require('../wechat-dashboard/server.js');

test('missing attachment remains an exhausted audit record after two source attempts', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'attachment-source-exhaustion-'));
  const filename = path.resolve(__dirname, '../wechat-pc-media.js');
  const manifest = path.join(root, 'media/manifest.jsonl');
  fs.mkdirSync(path.join(root, 'account'));
  let calls = 0;
  function load() {
    const module = {exports:{}};
    const ctx = vm.createContext({module, exports:module.exports, __dirname:path.dirname(filename),
      require:createRequire(filename), process:{env:{HOME:root, WECHAT_WORKSPACE:root}},
      Buffer, URL, console:{log(){},warn(){},error(){}}, setTimeout, clearTimeout,
      setInterval, clearInterval, setImmediate,
      missing:async () => { calls++; return {ok:false, reason:'file_not_found'}; }});
    vm.runInContext(fs.readFileSync(filename, 'utf8') + `
      fetchMessageResources = async () => [];
      fetchExactMessageRow = async (cfg, row) => ({local_type:row.kind === 'video' ? 43 : 25769803825});
      materializeFile = missing;
      materializeVideo = missing;
      triggerDistill = () => {throw new Error('must not replay unresolved media');};
      module.exports.retry = retryMissingFileManifest;
    `, ctx, {filename});
    return module.exports;
  }
  const latest = () => Object.values(Object.fromEntries(fs.readFileSync(manifest, 'utf8').trim()
    .split('\n').map(JSON.parse).map(r => [r.id,r])));
  try {
    const media = load();
    const now = 1794360168000;
    const rows = ['file','video'].map((kind,i) => ({id:kind,message_key:kind,source:'pc-hook',kind,
      talker:'fixture-'+kind,local_id:i+1,ts:now-1000,status:'pending',attachment_retry_attempts:0}));
    const cfg = {wechat_files_root:root,wechat_account_wxid:'account'};
    const fresh = canonicalQueueCounts([{...rows[0], attachment_failure_class:'attachment_unresolved',
      attachment_failure_reason:'source-resolution-not-started', vision_state:'waiting_media'}], []);
    assert.equal(fresh.newBacklog, 1, 'source registration is still a new message');
    assert.equal(fresh.retryBacklog, 0);
    await media.retry(cfg, rows, now);
    assert.equal(calls, 2);
    await media.retry(cfg, latest(), now+16000);
    assert.equal(calls, 4);
    for (const row of latest()) {
      assert.equal(row.status, 'pending');
      assert.equal(row.attachment_retry_attempts, 2);
      assert.equal(row.vision_state, 'attachment_resolve_failed');
      assert.equal(row.media_error, 'attachment-unresolved:file_not_found');
      assert.equal(row.vision_next_retry_at, null);
    }
    const counts = canonicalQueueCounts(latest(), []);
    assert.equal(counts.retryBacklog, 0, 'unclaimed exhausted source rows are not executable retries');
    assert.equal(counts.newBacklog, 0);
    assert.equal(counts.successCount, 0);
    const before = fs.readFileSync(manifest, 'utf8');
    await media.retry(cfg, latest(), now+60000);
    await load().retry(cfg, latest(), now+120000);
    assert.equal(calls, 4, 'persistent attempts prohibit a third call after restart');
    assert.equal(fs.readFileSync(manifest, 'utf8'), before);
  } finally {
    fs.rmSync(root, {recursive:true,force:true});
  }
});

test('clarification waiting is excluded from the executable image queue', () => {
  const job = {
    id: 'clarification-wait',
    status: 'retry',
    attempts: 2,
    retry_exhausted: true,
    last_error: 'online-clarification-suppressed',
    evidence_status: 'awaiting-evidence',
    event: {
      media_message_key: 'fixture@chatroom|1|2|3',
      media_kind: 'image',
    },
    result: {
      vision_calendar: {
        result: {reason: 'online-clarification-required'},
      },
    },
  };
  const counts = canonicalQueueCounts([], [job]);
  assert.equal(counts.newBacklog, 0);
  assert.equal(counts.retryBacklog, 0);
  assert.equal(counts.runnableBacklog, 0);
});
