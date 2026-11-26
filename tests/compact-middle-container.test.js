const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { middleContainer, verifiedCompactMiddle } = require('../wechat-pc-media');

test('inspect exact compact containers by bytes, including a WXGF with a JPEG suffix', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'middle-container-'));
  t.after(() => fs.rmSync(dir, {recursive:true, force:true}));
  const dat = path.join(dir,'example.dat'), copy = path.join(dir,'copy.middle.jpg');
  const thumb = path.join(dir,'example_t.dat');
  fs.writeFileSync(copy, Buffer.from('wxgf0000'));
  fs.writeFileSync(dat, Buffer.from('070856320807', 'hex'));
  fs.copyFileSync(dat, thumb);
  assert.equal(middleContainer(dat,dat,copy), true);
  assert.equal(middleContainer(copy,dat,copy), true);
  assert.equal(middleContainer(thumb,dat,copy), false);
  for (const bytes of [Buffer.from('wxg'), Buffer.from('ffd8ffe00000','hex')]) {
    fs.writeFileSync(copy, bytes);
    assert.equal(middleContainer(copy,dat,copy), false);
  }
});

test('small container requires higher resolution and positive content verification', () => {
  const thumb = {width:100,height:150}, larger = {width:300,height:450};
  assert.equal(verifiedCompactMiddle(thumb, larger, 0.96), true);
  for (const [dims,score] of [[thumb,1],[larger,0.5],[larger,null],[null,1]]) {
    assert.equal(verifiedCompactMiddle(thumb, dims, score), false);
  }
});
