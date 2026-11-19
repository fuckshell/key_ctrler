const assert = require('node:assert/strict');
const {test} = require('node:test');
const http = require('node:http'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const {enqueueRecoveredFiles, processRecoveredFileQueue} = require('../wechat-pc-bridge');

test('real recovered queue preserves image source provenance through its HTTP payload', async()=>{
 const root = fs.mkdtempSync(path.join(os.tmpdir(),'recovered-tier-'));
 const received=[];
 const server=http.createServer((req,res)=>{
  let body='';req.on('data',chunk=>body+=chunk);req.on('end',()=>{
   received.push(JSON.parse(body));res.writeHead(202,{'Content-Type':'application/json'});
   res.end(JSON.stringify({accepted:true,request_id:'test-original-operation'}));
  });
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 try {
  const cfg={state_file:path.join(root,'state.json'),ingest_url:`http://127.0.0.1:${server.address().port}/v1/wechat/event`};
  for(const tier of ['thumbnail','middle']) {
   const sha=(tier==='thumbnail'?'a':'b').repeat(64);
   const row={id:`talker|${tier}`,talker:'talker',local_id:42,ts:1700000000,kind:'image',
    file_sha:sha,file:'/test/image.jpg',canonical_file:'/test/original.jpg',captured_tier:tier,
    thumbnail_sha256:'a'.repeat(64),middle_sha256:tier==='middle'?sha:null,
    middle_pending:tier==='thumbnail',status:'retry',image_hash:'c'.repeat(32)};
   const state={};enqueueRecoveredFiles(cfg,state,[row]);
   await processRecoveredFileQueue(cfg,state);
   const event=received.at(-1);
   assert.equal(event.media_captured_tier,tier);
   assert.equal(event.media_thumbnail_sha256,row.thumbnail_sha256);
   assert.equal(event.media_middle_sha256,row.middle_sha256);
   assert.equal(event.media_middle_pending,row.middle_pending);
   assert.equal(event.media_status,row.status);
   assert.equal(event.media_image_hash,row.image_hash);
   assert.equal(event.media_file_sha256,sha);
   assert.equal(event.media_message_key,row.id);
   assert.equal(state.recovered_file_postprocess[0].request_id,'test-original-operation');
  }
 } finally {await new Promise(resolve=>server.close(resolve));fs.rmSync(root,{recursive:true,force:true});}
});
