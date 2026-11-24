const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const http = require('node:http');
const {createRequire} = require('node:module');
const {enqueueRecoveredFiles, processRecoveredFileQueue} = require('../wechat-pc-bridge');

test('timer recovers an exhausted video after a same-name partial download finishes', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'late-clip-'));
  t.after(() => fs.rmSync(root, {recursive:true, force:true}));
  const filename = require.resolve('../wechat-pc-media');
  const env = {HOME:root, WECHAT_WORKSPACE:root};
  const context = vm.createContext({module:{exports:{}}, require:createRequire(filename), __dirname:path.dirname(filename),
    process:{env}, Buffer, URL, setTimeout, clearTimeout, setInterval, clearInterval, setImmediate, console});
  vm.runInContext(fs.readFileSync(filename, 'utf8') + `
    fetchExactMessageRow = async () => { throw new Error('unexpected active lookup'); };
    triggerDistill = () => { throw new Error('unexpected inference replay'); };
  `, context, {filename});
  const media = context.module.exports;
  const cfg = {wechat_files_root:root, wechat_account_wxid:'account', state_file:path.join(root,'state.json')};
  const folder = path.join(root,'account/msg/video/2025-01');
  fs.mkdirSync(folder, {recursive:true});
  const clip = path.join(folder, 'original.mp4');
  fs.writeFileSync(clip,'partial');
  const content = Buffer.from('complete video bytes');
  const md5 = crypto.createHash('md5').update(content).digest('hex');
  const ts = Math.floor(Date.now()/1000);
  const key = ['fixture',7,ts,'90071992547409933'].join('|');
  const row = {id:key, message_key:key, talker:'fixture', server_id:'90071992547409933', local_id:7,
    message_create_time:ts, ts:ts*1000, original_content:'<msg><videomsg md5="'+md5+'"/></msg>',
    kind:'video', source:'pc-hook', status:'pending', vision_state:'attachment_resolve_failed',
    vision_last_error:'inference-budget-exhausted', vision_attempts:2, attachment_retry_attempts:2,
    attachment_failure_reason:'video-cache-not-found'};
  media.appendManifest(row);
  media.appendManifest({...row, id:'different-key', message_key:'different-key'});
  const tick = () => media.retryHdPendingManifest(cfg, {filesOnly:true, force:true});
  assert.equal((await tick()).length,0);
  assert.equal((await tick()).length,0);
  fs.writeFileSync(clip,content);
  const hits = await tick();
  assert.equal(hits.length,1);
  assert.equal(hits[0].message_key,key);
  assert.equal(hits[0].attachment_byte_evidence.md5,md5);
  assert.equal(hits[0].vision_state,'repair_required');
  assert.equal(hits[0].vision_last_error,row.vision_last_error);
  assert.equal(hits[0].attachment_retry_attempts,2);
  assert.deepEqual(fs.readFileSync(hits[0].file),content);
  assert.equal((await tick()).length,0);
  let event;
  const server = http.createServer((req,res) => {
    let body = '';
    req.on('data',chunk => body += chunk);
    req.on('end', () => {
      event = JSON.parse(body);
      res.writeHead(202, {'Content-Type':'application/json'});
      res.end(JSON.stringify({accepted:true,request_id:'fixture'}));
    });
  });
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  cfg.ingest_url = 'http://127.0.0.1:'+server.address().port+'/v1/wechat/event';
  const state = {};
  enqueueRecoveredFiles(cfg,state,hits);
  await processRecoveredFileQueue(cfg,state);
  assert.equal(event.type,43);
  assert.equal(event.media_kind,'video');
  assert.equal(event.media_message_key,key);
  assert.equal(event.media_status,'ready');
  assert.equal(event.media_path,hits[0].file);
  assert.equal(event.media_file_sha256,crypto.createHash('sha256').update(content).digest('hex'));
});
