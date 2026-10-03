const {test}=require('node:test');
const assert=require('node:assert/strict');
require('../extension/buffer-core.js');require('../extension/live-core.js');
const L=globalThis.BiliLiveCore;
const base='https://d1--cn-gotcha204.bilivideo.com/live-bvc/stream/index.m3u8?token=abc';
const text='#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:10\n#EXT-X-MAP:URI="init.mp4?token=abc"\n#EXTINF:1,\n10.m4s?token=abc\n#EXTINF:1,\n11.m4s?token=abc';
const parsed=L.parsePlaylist(text,base);
const media=()=>{const b=Buffer.alloc(4096,7);b.writeUInt32BE(4096);b.write('styp',4);return b;};
const response=()=>new Response(media(),{headers:{'content-type':'video/mp4','content-length':'4096'}});
test('live parser accepts signed relative fMP4 media and preserves query strings',()=>{
  assert.equal(parsed.segments.length,2);assert.equal(parsed.segments[0].sequence,10);
  assert.equal(parsed.map,'https://d1--cn-gotcha204.bilivideo.com/live-bvc/stream/init.mp4?token=abc');
  assert.equal(L.key(parsed.segments[0].url),L.key(L.swap(parsed.segments[0].url,L.HOSTS[1])));
});
test('bare relative live segments inherit the playlist signature used by the real player',()=>{
  const bare=text.replaceAll('?token=abc','');
  const result=L.parsePlaylist(bare,base);
  assert.equal(result.map,parsed.map);
  assert.deepEqual(result.segments,parsed.segments);
  const explicit=L.parsePlaylist(text.replaceAll('?token=abc','?token=other'),base);
  assert(explicit.segments.every(s=>new URL(s.url).search==='?token=other'));
});
test('live parser refuses master, encrypted, byte-range, TS, offsite and partial playlists',()=>{
  for(const bad of [text+'\n#EXT-X-KEY:METHOD=AES-128',text+'\n#EXT-X-BYTERANGE:100@0',text+'\n#EXT-X-PART:DURATION=0.2',text+'\n#EXT-X-STREAM-INF:BANDWIDTH=1',text.replace('10.m4s','10.ts'),text.replace('10.m4s?token=abc','https://example.com/live-bvc/stream/10.m4s'),text.replace('URI="init.mp4?token=abc"','URI="init.mp4",BYTERANGE="10@0"')])assert.equal(L.parsePlaylist(bad,base),null);
  assert.equal(L.liveUrl('https://bilivideo.com.evil.test/live-bvc/1.m4s'),null);
  assert.equal(L.liveUrl('http://d1--cn-gotcha204.bilivideo.com/live-bvc/1.m4s'),null);
});
test('concurrent live consumers share one download and cache ignores CDN hostname',async()=>{
  let calls=0;const s=new L.LiveSession(async()=>{calls++;await new Promise(r=>setTimeout(r,10));return response();},base,parsed,{candidates:[]});
  try{const url=parsed.segments[0].url;const [a,b]=await Promise.all([s.get(url),s.get(L.swap(url,L.HOSTS[1]))]);assert.equal(calls,1);assert.deepEqual(a.buffer,b.buffer);await s.get(url);assert.equal(calls,1);}finally{s.dispose();}
});
test('failed live CDN hands off, repeated failures quarantine it',async()=>{
  const calls=[];const s=new L.LiveSession(async url=>{calls.push(new URL(url).hostname);if(new URL(url).hostname===L.HOSTS[0])throw new TypeError('Failed to fetch');return response();},base,parsed,{candidates:[],hedgeMs:10});
  s.hosts.set(L.HOSTS[1],{proven:true,failures:0,ms:Infinity});
  try{await s.get(parsed.segments[0].url);s.hosts.get(L.HOSTS[0]).ms=0;await s.get(parsed.segments[1].url);assert.equal(s.hosts.get(L.HOSTS[0]).failures,2);await s.get(parsed.map);assert.equal(calls.filter(h=>h===L.HOSTS[0]).length,2);}finally{s.dispose();}
});
test('healthy primary avoids backup copy; slow primary triggers bounded rescue and loser cancellation',async()=>{
  let backups=0,cancelled=0,slow=false;
  const s=new L.LiveSession((url,{signal})=>{
    if(new URL(url).hostname===L.HOSTS[1]){backups++;return Promise.resolve(response());}
    if(!slow)return Promise.resolve(response());
    return new Promise((resolve,reject)=>signal.addEventListener('abort',()=>{cancelled++;reject(signal.reason);},{once:true}));
  },base,parsed,{candidates:[],hedgeMs:20});s.hosts.set(L.HOSTS[1],{proven:true,failures:0,ms:Infinity});
  try{await s.get(parsed.segments[0].url);await new Promise(r=>setTimeout(r,30));assert.equal(backups,0);slow=true;await s.get(parsed.segments[1].url);await new Promise(r=>setImmediate(r));assert.equal(backups,1);assert.equal(cancelled,1);assert.equal(s.hosts.get(L.HOSTS[0]).failures,0);}finally{s.dispose();}
});
test('prefetch downloads only announced segments and can be disabled',async()=>{
  const urls=[];const s=new L.LiveSession(async url=>{urls.push(url);return response();},base,parsed,{candidates:[]});
  try{s.prefetchEnabled=false;s.prefetch();assert.equal(urls.length,0);s.prefetchEnabled=true;s.prefetch();for(let i=0;i<20&&s.cache.size<3;i++)await new Promise(r=>setTimeout(r,5));await Promise.all([...s.cache.values()].map(x=>x.promise));assert.equal(urls.length,3);assert(urls.every(url=>s.announced.has(L.key(url))));assert(!urls.some(u=>u.includes('12.m4s')));}finally{s.dispose();}
});
test('aborting one player wait does not cancel shared prefetch; room disposal cancels the transport',async()=>{
  let release;const s=new L.LiveSession(()=>new Promise(resolve=>{release=()=>resolve(response());}),base,parsed,{candidates:[]});
  try{const controller=new AbortController(),first=s.get(parsed.map,{signal:controller.signal}),second=s.get(parsed.map);controller.abort(new Error('caller cancelled'));await assert.rejects(first,/caller cancelled/);await new Promise(r=>setImmediate(r));release();assert.equal((await second).buffer.byteLength,4096);}finally{s.dispose();}
  let stopped=false;const s2=new L.LiveSession((_url,{signal})=>new Promise((resolve,reject)=>signal.addEventListener('abort',()=>{stopped=true;reject(signal.reason);},{once:true})),base,parsed,{candidates:[]});
  const pending=s2.get(parsed.map);await new Promise(r=>setImmediate(r));s2.dispose();await assert.rejects(pending);assert.equal(stopped,true);
});
test('live reader rejects HTML, truncated and partial responses',async()=>{
  for(const fetcher of [async()=>new Response('<html>error</html>'),async()=>new Response(media(),{headers:{'content-length':'5000'}}),async()=>new Response(media(),{status:206,headers:{'content-range':'bytes 0-4095/8192'}})]){
    const s=new L.LiveSession(fetcher,base,parsed,{candidates:[]});try{await assert.rejects(s.get(parsed.map));}finally{s.dispose();}
  }
});
test('small CDN probes validate range and do not consume full response bodies',async()=>{
  const s=new L.LiveSession(async(url,{headers})=>new Response(media().subarray(0,2048),{status:206,headers:{'content-range':'bytes 0-2047/4096','content-length':'2048'}}),base,parsed,{candidates:[L.HOSTS[1]]});
  try{await s.probe(parsed.segments[0].url);assert.equal(s.hosts.get(L.HOSTS[1]).proven,true);assert.equal(s.stats.bytes,2048);}finally{s.dispose();}
});
test('live body with no more data times out instead of hanging',async()=>{
  let stopped=false;const s=new L.LiveSession(async()=>new Response(new ReadableStream({start(c){c.enqueue(media().subarray(0,16));},cancel(){stopped=true;}})),base,parsed,{candidates:[],idleMs:20,timeoutMs:200});
  try{await assert.rejects(s.get(parsed.map));assert.equal(stopped,true);}finally{s.dispose();}
});
