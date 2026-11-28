const {test}=require('node:test'), assert=require('node:assert/strict'), fs=require('node:fs'), path=require('node:path'), os=require('node:os'), crypto=require('node:crypto');

test('a rejected legacy document screen may inspect existing middle bytes without requesting a download', t=>{
  const base=fs.mkdtempSync(path.join(os.tmpdir(),'middle-mode-'));
  const prev=process.env.WECHAT_WORKSPACE; process.env.WECHAT_WORKSPACE=base;
  t.after(()=>{if(prev===undefined)delete process.env.WECHAT_WORKSPACE;else process.env.WECHAT_WORKSPACE=prev;fs.rmSync(base,{recursive:true,force:true});});
  const {middleSourceMode}=require('../wechat-pc-media');
  const sha='a'.repeat(64), dir=path.join(base,'state/image-inference-budget');fs.mkdirSync(dir,{recursive:true});
  const file=path.join(dir,crypto.createHash('sha256').update(sha).digest('hex')+'.json');
  const row={talker:'fixture',durable_retry_source:true,file_sha:sha,thumbnail_sha256:sha,middle_pending:true,status:'pending',vision_state:'repair_required',vision_last_error:'vision-image:jpg:image-tier-not-ready:retry-limit-2'};
  const coarse={ok:true,provider:'antigravity-subscription',model:'fixture-flash',content_type:'document',screening_decision:'summary_complete',screening_relevance:'irrelevant',evidence:['visible fixture']};
  function record(wait,c){fs.writeFileSync(file,JSON.stringify({waiting_source:wait,last_error:'image-tier-not-ready',coarse_screening:c}));}
  record(false,coarse);assert.equal(middleSourceMode(row,false),'local');
  for(const change of [{durable_retry_source:false},{content_pool:'spam'},{status:'filtered'},{thumbnail_sha256:'b'.repeat(64)},{summary:'already finished'},{vision_last_error:'provider-timeout'}])assert.equal(middleSourceMode({...row,...change},false),'skip');
  record(false,{...coarse,content_type:'photo'});assert.equal(middleSourceMode(row,false),'skip');
  record(true,{...coarse,screening_decision:'needs_detail',screening_relevance:'uncertain'});assert.equal(middleSourceMode(row,false),'acquire');
});
