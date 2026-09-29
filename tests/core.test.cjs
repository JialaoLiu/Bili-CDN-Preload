const {test}=require('node:test');
const assert=require('node:assert/strict');
require('../extension/buffer-core.js');
require('../extension/vendor/core.js');
const C=globalThis.BiliBufferCore;
test('mixed queues reserve two of six slots for prefetch and lend idle capacity',async()=>{
  let limit=0;const gate=new C.RequestGate(()=>limit),started=[],release=[];
  const signal=new AbortController().signal;
  const work=kind=>gate.run(()=>new Promise(resolve=>{started.push(kind);release.push(resolve);}),signal,{kind});
  const jobs=[...Array.from({length:6},()=>work('prefetch')),...Array.from({length:6},()=>work('playback'))];
  limit=6;gate.pump();await new Promise(r=>setImmediate(r));
  assert.equal(started.filter(x=>x==='prefetch').length,2);assert.equal(started.filter(x=>x==='playback').length,4);
  for(let i=0;i<3;i++){release.splice(0).forEach(r=>r());await new Promise(r=>setImmediate(r));}
  await Promise.all(jobs);assert.equal(gate.active,0);
});
test('shared ranges deduplicate overlapping prefetch and player requests',async()=>{
  const cache=new C.ByteCache(),calls=[];
  cache.put(0,new Uint8Array(100).buffer);
  const pool=new C.RangePool(cache,async(a,b)=>{
    calls.push([a,b]);await new Promise(r=>setTimeout(r,10));
    const buffer=Uint8Array.from({length:b-a+1},(_,i)=>(a+i)%251).buffer;
    cache.put(a,buffer);return {buffer};
  });
  const result=await Promise.all([pool.get(100,999),pool.get(500,1499),pool.get(100,999)]);
  assert.deepEqual(calls,[[100,999],[1000,1499]]);
  assert.deepEqual(new Uint8Array(result[1].buffer),Uint8Array.from({length:1000},(_,i)=>(500+i)%251));
  await pool.get(0,1499);assert.equal(calls.length,2);
});
test('cancelling one consumer does not cancel another consumer of the same range',async()=>{
  const cache=new C.ByteCache();let cancelled=false;
  const pool=new C.RangePool(cache,async(a,b,signal)=>{
    await new Promise((resolve,reject)=>{const timer=setTimeout(resolve,20);signal.addEventListener('abort',()=>{cancelled=true;clearTimeout(timer);reject(new Error('cancelled'));},{once:true});});
    return {buffer:new Uint8Array(b-a+1).buffer};
  });
  const controller=new AbortController();
  const first=pool.get(0,99,{signal:controller.signal}),second=pool.get(0,99);
  controller.abort(new Error('stop'));
  await assert.rejects(first,/stop/);assert.equal((await second).buffer.byteLength,100);
  // The transport completed before the final subscriber released it.
  assert.equal(pool.pending.length,0);
});
test('global gate caps media transfers and cancels queued jobs',async()=>{
  const gate=new C.RequestGate(()=>2);let active=0,peak=0;
  const controller=new AbortController();
  const jobs=Array.from({length:5},()=>gate.run(async()=>{active++;peak=Math.max(peak,active);await new Promise(r=>setTimeout(r,10));active--;},controller.signal));
  await Promise.all(jobs);assert.equal(peak,2);
});
test('failed fetch changes CDN without downloading parallel copies',async()=>{
  const calls=[];
  const fetcher=async(url,{headers})=>{
    calls.push([url,headers.Range]);
    if(url==='bad')throw new TypeError('Failed to fetch');
    return new Response(new Uint8Array([1,2,3]),{status:206,headers:{'content-range':'bytes 0-2/3'}});
  };
  const result=await C.readParallelRange(fetcher,['bad','good'],0,2,{parts:1});
  assert.deepEqual(calls,[['bad','bytes=0-2'],['good','bytes=0-2']]);
  assert.deepEqual([...new Uint8Array(result.buffer)],[1,2,3]);
});
test('CDN handoff resumes only the missing tail of a validated body',async()=>{
  const calls=[];let bytes=0;
  const fetcher=async(url,{headers})=>{
    calls.push([url,headers.Range]);
    const start=Number(/bytes=(\d+)/.exec(headers.Range)[1]);
    const data=Uint8Array.from({length:url==='bad'?9:10-start},(_,i)=>start+i);
    bytes+=data.length;
    return new Response(data,{status:206,headers:{'content-range':`bytes ${start}-9/10`}});
  };
  const result=await C.readParallelRange(fetcher,['bad','good'],0,9,{parts:1});
  assert.deepEqual(calls,[['bad','bytes=0-9'],['good','bytes=9-9']]);
  assert.equal(bytes,10);
  assert.deepEqual([...new Uint8Array(result.buffer)],[0,1,2,3,4,5,6,7,8,9]);
});
test('resumption rejects a CDN with a different file length',async()=>{
  const resume={};
  await assert.rejects(C.readRange(async()=>new Response(new Uint8Array([1]),{status:206,headers:{'content-range':'bytes 0-2/3'}}),'one',0,2,{resume}));
  await assert.rejects(C.readRange(async()=>new Response(new Uint8Array([2,3]),{status:206,headers:{'content-range':'bytes 1-2/4'}}),'two',0,2,{resume}),/Range/);
  assert.equal(resume.count,1);
});
test('a stalled response body is cancelled and its prefix survives',async()=>{
  const resume={};let cancelled=false;
  const fetcher=async()=>new Response(new ReadableStream({start(c){c.enqueue(new Uint8Array([1]));},cancel(){cancelled=true;}}),{status:206,headers:{'content-range':'bytes 0-2/3'}});
  await assert.rejects(C.readRange(fetcher,'slow',0,2,{resume,idleMs:20,timeoutMs:500}),/连续无数据/);
  assert.equal(cancelled,true);assert.equal(resume.count,1);
});
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
test('mainland and overseas candidate pools are distinct and include source choices',()=>{
  assert.ok(C.MAINLAND.includes('upos-sz-mirrorbos.bilivideo.com'));
  assert.ok(C.OVERSEAS.includes('upos-sz-mirrorcosov.bilivideo.com'));
  assert.equal(new Set(C.PRESETS).size,C.PRESETS.length);
  const source='https://upos-sz-mirrorcosov.bilivideo.com/path.m4s?token=abc';
  assert.ok(C.candidates([source],C.MAINLAND,'',false).some(x=>x.startsWith('https://upos-sz-mirrorbos.bilivideo.com/')));
});
test('parallel reader requests disjoint ranges and reassembles them in byte order',async()=>{
  const calls=[];
  const fetcher=async(url,{headers})=>{
    const [,a,b]=/^bytes=(\d+)-(\d+)$/.exec(headers.Range);
    const start=Number(a),end=Number(b);
    calls.push({url,start,end});
    await new Promise(resolve=>setTimeout(resolve,10-start));
    return new Response(Uint8Array.from({length:end-start+1},(_,i)=>start+i),{status:206,headers:{'content-range':`bytes ${start}-${end}/1048576`}});
  };
  const result=await C.readParallelRange(fetcher,['https://one','https://two','https://three'],0,786431,{parts:3});
  assert.equal(calls.length,3);
  assert.deepEqual(calls.sort((a,b)=>a.start-b.start).map(x=>[x.start,x.end]),[[0,262143],[262144,524287],[524288,786431]]);
  assert.deepEqual(new Uint8Array(result.buffer),Uint8Array.from({length:786432},(_,i)=>i%256));
});
test('parallel reader retries a failed CDN and rejects mixed file totals',async()=>{
  const calls=[];
  const read=async(_fetch,url,start,end)=>{
    calls.push(url);
    if(url==='bad')throw new Error('HTTP 403');
    return {buffer:new Uint8Array(end-start+1).buffer,total:url==='other'?2097152:1048576,type:'video/mp4'};
  };
  const good=await C.readParallelRange(null,['bad','good'],0,511,{parts:1,read});
  assert.equal(good.buffer.byteLength,512);
  assert.deepEqual(calls,['bad','good']);
  await assert.rejects(C.readParallelRange(null,['good','other'],0,524287,{parts:2,read}),/文件长度不一致/);
});
test('parallel reader cancels stalled pieces at its playback deadline',async()=>{
  let cancelled=0;
  const read=(_fetch,_url,_start,_end,{signal})=>new Promise((_resolve,reject)=>{
    signal.addEventListener('abort',()=>{cancelled++;reject(signal.reason);},{once:true});
  });
  await assert.rejects(C.readParallelRange(null,['slow'],0,524287,{parts:2,deadlineMs:20,read}),/超时/);
  assert.equal(cancelled,2);
});
