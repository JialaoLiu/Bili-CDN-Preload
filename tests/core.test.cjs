const {test}=require('node:test');
const assert=require('node:assert/strict');
require('../extension/buffer-core.js');
require('../extension/vendor/core.js');
const C=globalThis.BiliBufferCore;
test('short clips target all bytes even when paused near the end',()=>{
  const segments=Array.from({length:20},(_,i)=>({start:100+i*100,end:199+i*100,startTime:i*10,endTime:i*10+10}));
  assert.deepEqual(C.windowFor(segments,180,200),{startTime:0,endTime:200,start:0,end:2099});
});
test('long clips target exactly five minutes with segment alignment',()=>{
  const segments=Array.from({length:100},(_,i)=>({start:100+i*100,end:199+i*100,startTime:i*10,endTime:i*10+10}));
  assert.deepEqual(C.windowFor(segments,125,1000),{startTime:125,endTime:425,start:1300,end:4399});
});
test('overlapping partial player requests retain data for later requests',()=>{
  const cache=new C.ByteCache(), bytes=Uint8Array.from({length:200},(_,i)=>i);
  cache.put(30,bytes.slice(30,90).buffer);cache.put(0,bytes.slice(0,70).buffer);cache.put(80,bytes.slice(80).buffer);
  assert.equal(cache.bytes,200);assert.deepEqual(new Uint8Array(cache.get(5,195)),bytes.slice(5,196));
  assert.equal(cache.get(0,200),null);assert.deepEqual(new Uint8Array(cache.get(5,195)),bytes.slice(5,196));
});
test('gaps are never passed to MSE as complete bytes',()=>{
  const c=new C.ByteCache();c.put(0,new Uint8Array(10).buffer);c.put(11,new Uint8Array(10).buffer);
  assert.equal(c.get(0,20),null);assert.equal(c.coveredBytes(0,20),20);
});
test('native Akamai signatures are preserved and never used as host-swap donors',()=>{
  const url='https://example.akamaized.net/a.m4s?hdnts=secret';
  assert.deepEqual(C.candidates([url],C.PRESETS,'',false),[url]);
  assert.deepEqual(C.candidates([url],C.PRESETS,C.PRESETS[0],true),[]);
});
test('custom hosts use exact path and query and strict selection never falls back',()=>{
  const url='https://upos-sz-mirrorcosov.bilivideo.com/path.m4s?a=%2f&a=1';
  const list=C.candidates([url],C.PRESETS,'cn-hk-eq-01-03.bilivideo.com',true);
  assert.equal(list.length,1);assert.equal(list[0],'https://cn-hk-eq-01-03.bilivideo.com/path.m4s?a=%2f&a=1');
  for(const h of ['127.0.0.1','example.com','https://evil.com@x.bilivideo.com','x.bilivideo.com/path'])assert.equal(C.host(h),'');
});
test('Range reader verifies status, offsets and complete length',async()=>{
  const good=()=>Promise.resolve(new Response(new Uint8Array([1,2,3]),{status:206,headers:{'content-range':'bytes 5-7/10'}}));
  assert.deepEqual(new Uint8Array((await C.readRange(good,'https://x',5,7)).buffer),new Uint8Array([1,2,3]));
  for(const [status,range,bytes] of [[200,'bytes 5-7/10',3],[206,'bytes 0-2/10',3],[206,'bytes 5-7/10',2]])
    await assert.rejects(C.readRange(()=>Promise.resolve(new Response(new Uint8Array(bytes),{status,headers:{'content-range':range}})),'https://x',5,7));
});
test('requests that stop producing bytes are aborted',async()=>{
  const fake=(_url,options)=>new Promise((resolve,reject)=>{options.signal.addEventListener('abort',()=>reject(new Error('aborted')));});
  await assert.rejects(C.readRange(fake,'https://x',0,10,{idleMs:20,timeoutMs:500}),/aborted/);
});
