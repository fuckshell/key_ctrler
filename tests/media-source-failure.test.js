const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const {createRequire} = require('node:module');
const {test, after} = require('node:test');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-source-failure-'));
after(() => fs.rmSync(root, {recursive:true, force:true}));
function fixture(file, suffix='') {
  const filename=path.resolve(__dirname,'..',file);
  const module={exports:{}};
  const context=vm.createContext({module,exports:module.exports,__dirname:path.dirname(filename),
    require:createRequire(filename),process:{env:{HOME:root,WECHAT_WORKSPACE:root}},
    console:{log(){},error(){},warn(){}},Buffer,URL,setTimeout,clearTimeout,setInterval,clearInterval,setImmediate});
  vm.runInContext(fs.readFileSync(filename,'utf8')+suffix,context,{filename});
  return module.exports;
}
const media=fixture('wechat-pc-media.js', `
  fetchMessageResources = async () => [{packed_info:'0123456789abcdef0123456789abcdef'}];
  materializeImage = async () => {const err=new Error('source cache disappeared');err.code='ENOENT';throw err;};
  triggerDistill = () => {throw new Error('unresolved source must not start inference');};
`);
test('image CDN attributes retain exact middle, thumbnail and full identities', () => {
  // Native XML puts thumbnail metadata before the middle length. Attribute
  // suffixes must not supply another tier's byte count or decryption key.
  const fields=media.extractImageCdnFields(`<msg><img
    cdnthumbaeskey="thumbnail-key" cdnthumblength="8857"
    length="111585" hdlength="795814" aeskey="middle-key"
    cdnmidimgurl="fixture-middle-fileid" /></msg>`);
  assert.equal(fields.length,111585);
  assert.equal(fields.cdnthumblength,8857);
  assert.equal(fields.hdlength,795814);
  assert.equal(fields.aeskey,'middle-key');
  const noMiddle=media.extractImageCdnFields(`<msg><img
    cdnthumblength="8857" hdlength="795814" aeskey="middle-key"
    cdnmidimgurl="fixture-middle-fileid" /></msg>`);
  assert.equal(noMiddle.length,0);
  assert.equal(media.extractImageCdnFields(`<msg><img
    cdnthumbaeskey="thumbnail-key" cdnmidimgurl="fixture-middle-fileid" /></msg>`),null);
});
test('resolver exceptions persist exact legacy identity and actionable pending source', async () => {
  fs.mkdirSync(path.join(root,'wxid_fixture'),{recursive:true});
  const event={talker:'fixture@chatroom',local_id:42,msg_svr_id:'90071992547409933',ts:1791449377000,type:3,content:'[图片]'};
  const result=await media.enrichEventMedia({wechat_files_root:root,wechat_account_wxid:'wxid_fixture'},event,
    {local_id:42,msg_svr_id:event.msg_svr_id,create_time:1791449377,local_type:3,message_content:'[图片]'});
  const row=JSON.parse(fs.readFileSync(path.join(root,'media/manifest.jsonl'),'utf8').trim());
  assert.equal(result.media_message_key,'fixture@chatroom|42|1791449377|90071992547409933');
  assert.equal(row.message_key,result.media_message_key);
  assert.equal(row.status,'pending');
  assert.equal(row.vision_state,'waiting_media');
  assert.equal(row.image_hash,'0123456789abcdef0123456789abcdef');
  assert.equal(row.attachment_failure_reason,'media-resolve-ENOENT');
  assert.match(row.media_error,/source cache disappeared/);
});

test('account discovery failure still leaves an exact pending manifest row', async () => {
  const event={talker:'missing-account@chatroom',local_id:7,msg_svr_id:'9001',ts:1791449377000,type:3,content:'[图片]'};
  const result=await media.enrichEventMedia({wechat_files_root:root,wechat_account_wxid:'wxid_missing'},event,
    {local_id:7,server_id:event.msg_svr_id,create_time:1791449377,local_type:3,message_content:'[图片]'});
  assert.equal(result.media_status,'no_account_dir');
  const rows=fs.readFileSync(path.join(root,'media/manifest.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
  const row=rows.find(item=>item.message_key==='missing-account@chatroom|7|1791449377|9001');
  assert.ok(row);
  assert.equal(row.status,'pending');
  assert.equal(row.vision_state,'waiting_media');
});
test('unchanged source retries stop after two failures and survive restart', () => {
  const ready=media.imageSourceCheckReady;
  assert.equal(ready({signature:'bytes',attempts:1,next_at:10},'bytes',11),true);
  const exhausted=JSON.parse(JSON.stringify({signature:'bytes',attempts:2}));
  assert.equal(ready(exhausted,'bytes',999999),false);
  assert.equal(ready({signature:'bytes',done:true,middle_metadata_version:2},'bytes',11),true);
  assert.equal(ready({signature:'bytes',done:true,middle_metadata_version:3},'bytes',11),false);
  assert.equal(ready({signature:'bytes',next_at:20},'bytes',11),false);
});
test('legacy image registration never takes over native download paths', async () => {
  const registration=fixture('wechat-pc-media.js', `
    module.exports.calls = [];
    hookRequest = async (cfg, endpoint, body) => {
      module.exports.calls.push({endpoint,body});
      return {ret:0};
    };
  `);
  const talker='registration@chatroom', time=1794273188;
  const content='<msg><img cdnmidimgurl="fixture-middle-fileid" aeskey="fixture-key" /></msg>';
  // Raw DB rows and persisted manifest rows enter through different callers.
  for (const [localId, stamp] of [[1515,{message_create_time:time}],
      [1516,{create_time:time}], [1517,{createTime:time}],
      [1518,{create_time:time,message_create_time:time-100}]]) {
    const row={local_id:localId,...stamp,original_content:content,vision_attempts:2,
      status:'pending',vision_state:'repair_required'};
    const before=JSON.stringify(row);
    await registration.preRegisterImageCdnPending({},talker,row);
    assert.equal(registration.calls.length,0);
    assert.equal(JSON.stringify(row),before);
  }
  // Deduplication must distinguish manifest messages with the same local ID.
  await registration.preRegisterImageCdnPending({},talker,
    {local_id:1515,message_create_time:time+1,original_content:content});
  assert.equal(registration.calls.length,0);
});
test('a middle label with thumbnail bytes does not stop native source acquisition', () => {
  const local=path.join(root,'identity.jpg');
  fs.writeFileSync(local,'fixture');
  const validMiddle=path.join(root,'valid-middle.png');
  fs.writeFileSync(validMiddle,Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=','base64'));
  const row={id:'identity',source:'pc-hook',kind:'image',talker:'fixture',
    image_hash:'a'.repeat(32),status:'pending',canonical_file:local,
    captured_tier:'middle',file_sha:'thumbnail',middle_sha256:'thumbnail',
    thumbnail_sha256:'thumbnail',vision_attempts:2,vision_state:'repair_required'};
  assert.equal(media.selectPassiveImageCandidates([row]).length,1);
  assert.equal(media.selectPassiveImageCandidates([{...row,
    file:validMiddle,canonical_file:validMiddle,
    file_sha:'native-middle',middle_sha256:'native-middle'}]).length,0);
  assert.equal(row.vision_attempts,2);
});

test('corrupt middle manifest bytes do not reuse the completed prescreen', async () => {
  const repairGate=fixture('wechat-pc-media.js', `
    getFilesRoot = async () => WORKSPACE_WECHAT;
    findAccountDir = () => WORKSPACE_WECHAT;
    triggerImageCdnDownload = async () => {};
    fetchMessageResources = async () => [];
    materializeImage = async () => {
      module.exports.materializeCalled = true;
      return {ok:false,middle_pending:true,reason:'waiting_native_middle_cache'};
    };
  `);
  const messageKey='corrupt-middle@chatroom|99|1794273188|90071992547409933';
  const corrupt=path.join(root,'corrupt-middle.jpg');
  fs.writeFileSync(corrupt,'fixture');
  repairGate.appendManifest({id:messageKey,message_key:messageKey,talker:'corrupt-middle@chatroom',
    local_id:99,ts:1794273188000,server_id:'90071992547409933',kind:'image',status:'pending',
    file:corrupt,canonical_file:corrupt,file_sha:'d'.repeat(64),middle_sha256:'d'.repeat(64),
    captured_tier:'middle',middle_pending:false,vision_state:'retry'});
  const event={talker:'corrupt-middle@chatroom',local_id:99,msg_svr_id:'90071992547409933',
    ts:1794273188000,type:3,content:'[图片]'};
  const enriched=await repairGate.enrichEventMedia({},event,
    {local_id:99,msg_svr_id:'90071992547409933',create_time:1794273188,local_type:3,message_content:'[图片]'});
  assert.equal(repairGate.materializeCalled,true);
  assert.notEqual(enriched.media_method,'reuse_completed_prescreen');
  assert.equal(enriched.media_status,'waiting_native_middle_cache');
});

test('durable postprocess retry remains eligible after coarse screening is complete', () => {
  const local=path.join(root,'durable-retry.jpg');
  fs.writeFileSync(local,'fixture');
  const row={id:'durable-retry',source:'pc-hook',kind:'image',talker:'fixture',
    image_hash:'b'.repeat(32),status:'done',canonical_file:local,
    captured_tier:'thumbnail',file_sha:'thumb-sha',thumbnail_sha256:'thumb-sha',
    middle_pending:true,durable_retry_source:true,summary:'coarse result',
    summary_confidence:0.95,screening_decision:'summary_complete',vision_state:'done'};
  assert.equal(media.selectPassiveImageCandidates([row]).length, 1);
  assert.equal(media.selectPassiveImageCandidates([row])[0].id, 'durable-retry');
});

test('passive decoding of identical thumbnail bytes never promotes or dispatches them', async () => {
  const recovery=fixture('wechat-pc-media.js', `
    getFilesRoot = async () => WORKSPACE_WECHAT;
    findAccountDir = () => WORKSPACE_WECHAT;
    readImageDemands = () => [];
    preRegisterImageCdnPending = async () => {};
    resolveImageAttachPaths = (account, talker, hash) => ({extraWsl:path.join(account, hash+'.dat')});
    resolveImageCacheTempPath = () => null;
    decodeViaPythonAsync = async (src, dst) => {fs.copyFileSync(src,dst);return {ok:true,out:dst};};
    isCompleteRasterImage = () => true;
    rasterContentSimilarity = () => 1;
    triggerDistill = () => {throw new Error('thumbnail must not start inference');};
    module.exports.recover = retryImageSources;
  `);
  const hash='f'.repeat(32),id='identical-thumbnail';
  const source=path.join(root,hash+'.dat');
  const bytes=Buffer.alloc(100,9);
  fs.writeFileSync(source,bytes);
  const sha=require('node:crypto').createHash('sha256').update(bytes).digest('hex');
  const old={id,message_key:id,kind:'image',source:'pc-hook',talker:'fixture',image_hash:hash,
    status:'pending',captured_tier:'thumbnail',file_sha:sha,thumbnail_sha256:sha,
    vision_attempts:2,vision_state:'repair_required',vision_last_error:'table-row-mapping-incomplete'};
  recovery.appendManifest(old);
  const rows=new Map([[id,old]]),now=Date.now();
  await recovery.recover({},rows,now,true);
  const upgraded=await recovery.recover({},rows,now+2000,true);
  assert.equal(upgraded.length,0);
  const persisted=fs.readFileSync(path.join(root,'media/manifest.jsonl'),'utf8')
    .trim().split('\n').map(JSON.parse).find(row=>row.id===id);
  assert.equal(persisted.captured_tier,'thumbnail');
  assert.equal(persisted.middle_sha256,undefined);
  assert.equal(persisted.vision_attempts,2);
  assert.equal(persisted.vision_state,'repair_required');
  assert.equal(persisted.vision_last_error,old.vision_last_error);
  const check=JSON.parse(fs.readFileSync(path.join(root,'state/image-source-checks.json'),'utf8'))[id+'|'+source];
  assert.equal(check.attempts,1);
  assert.equal(recovery.imageSourceCheckReady(check,check.signature,now+4000),false);
});
test('recovered middle bytes reuse an accepted message without reopening its budget', () => {
  const ingest=fixture('wechat-ingest.js','\nschedulePostprocessWorker = () => {};');
  const event={talker:'fixture@chatroom',local_id:42,msg_svr_id:'90071992547409933',ts:1791449377000,media_kind:'image',type:3,content:'[图片]'};
  const initial=ingest.enqueuePostprocess(event);
  assert.equal(initial.job.event.media_message_key_inferred,true);
  initial.job.status='retry';initial.job.retry_exhausted=true;initial.job.attempts=2;
  const recovered=ingest.enqueuePostprocess({...event,media_recovered:true,
    media_message_key:'fixture@chatroom|42|1791449377|90071992547409933',media_file_sha256:'a'.repeat(64)});
  assert.equal(recovered.duplicate,true);
  assert.equal(recovered.job.id,initial.job.id);
  assert.equal(recovered.job.status,'retry');
  assert.equal(recovered.job.attempts,2);
});

test('passive source upgrades preserve inference attempts and dispatch verified new bytes', async () => {
  const recovery=fixture('wechat-pc-media.js', `
    getFilesRoot = async () => WORKSPACE_WECHAT;
    findAccountDir = () => WORKSPACE_WECHAT;
    readImageDemands = () => [];
    selectPassiveImageCandidates = rows => [...rows];
    resolveImageAttachPaths = (account, talker, hash) => ({extraWsl:path.join(account, hash+'.dat')});
    resolveImageCacheTempPath = () => null;
    decodeViaPythonAsync = async (src, dst) => {fs.copyFileSync(src,dst);return {ok:true,out:dst};};
    isCompleteRasterImage = () => true;
    rasterContentSimilarity = () => 1;
    module.exports.dispatched = [];
    triggerDistill = (...args) => module.exports.dispatched.push(args);
    module.exports.recover = retryImageSources;
  `);
  fs.mkdirSync(path.join(root,'media/inbox'),{recursive:true});
  for (const attempts of [1,2,3]) {
    const hash=String(attempts).repeat(32), id='source-budget-'+attempts;
    fs.writeFileSync(path.join(root,hash+'.dat'),Buffer.alloc(100,attempts));
    const old={id,message_key:id,kind:'image',source:'pc-hook',talker:'fixture',image_hash:hash,
      status:'pending',captured_tier:'thumbnail',file_sha:'previous-'+attempts,
      vision_attempts:attempts,vision_last_error:'image-inference-repair-required',
      vision_last_attempt_at:'2026-11-09T00:00:00Z',
      vision_state:attempts>=2?'repair_required':'retry'};
    recovery.appendManifest(old);
    const rows=new Map([[id,old]]), now=Date.now();
    await recovery.recover({},rows,now,true);
    const dispatchedBefore=recovery.dispatched.length;
    const recovered=await recovery.recover({},rows,now+2000,true);
    const row=fs.readFileSync(path.join(root,'media/manifest.jsonl'),'utf8')
      .trim().split('\n').map(JSON.parse).find(row=>row.id===id);
    assert.equal(row.captured_tier,'middle');
    assert.equal(row.vision_attempts,attempts);
    assert.equal(row.vision_last_error,old.vision_last_error);
    assert.equal(row.vision_last_attempt_at,old.vision_last_attempt_at);
    assert.equal(row.status,'pending');
    // Source evidence is dispatched once even when the old source budget is exhausted.
    assert.equal(recovered.length,1);
    assert.equal(recovery.dispatched.length-dispatchedBefore,1);
    assert.equal(recovery.dispatched.at(-1).length, 0);
    if (attempts>=2) assert.equal(row.vision_state,'repair_required');
    // A delayed resolver snapshot must not restore its older inference budget.
    recovery.appendManifest({...row,vision_attempts:0});
    const persisted=fs.readFileSync(path.join(root,'media/manifest.jsonl'),'utf8')
      .trim().split('\n').map(JSON.parse).find(row=>row.id===id);
    assert.equal(persisted.vision_attempts,attempts);
  }
});

test('foreground images leave download ownership to WeChat under every legacy flag', async () => {
  const media = fixture('wechat-pc-media.js', `
    module.exports.calls = [];
    hookRequest = async (...args) => {module.exports.calls.push(args);return {ret:202};};
    getFilesRoot = async () => {throw new Error('must not enter active download pipeline');};
    autoHdDownloadPipeline = async () => {throw new Error('must not invoke legacy HD pipeline');};
    module.exports.trigger = triggerImageCdnDownload;
  `);
  const row = {
    message_content:'<msg><img cdnmidimgurl="fixture-middle" aeskey="fixture-key" /></msg>',
    packed_info_data:'', local_id:42, create_time:1791449377,
    vision_attempts:2,
  };
  const before=JSON.stringify(row);
  for (const cfg of [{}, {cdn_native_trigger:false},
      {cdn_native_trigger:true,cdn_direct_invoke:true,cdn_auto_switch:true}]) {
    await media.trigger(cfg, 'fixture@chatroom', row);
    assert.equal(media.calls.length,0);
    assert.equal(JSON.stringify(row),before);
  }
});
