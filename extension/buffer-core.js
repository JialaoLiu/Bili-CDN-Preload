(function (root) {
  'use strict';
  const BLOCK = 1024 * 1024;
  const OVERSEAS = [
    'upos-sz-mirrorcosov.bilivideo.com',
    'upos-sz-mirroraliov.bilivideo.com',
    'upos-sz-mirrorhwov.bilivideo.com',
    'cn-hk-eq-01-01.bilivideo.com',
    'cn-hk-eq-01-02.bilivideo.com',
    'cn-hk-eq-01-03.bilivideo.com',
    'cn-hk-eq-01-04.bilivideo.com',
    'cn-hk-eq-01-05.bilivideo.com',
    'cn-hk-eq-01-06.bilivideo.com',
    'cn-hk-eq-01-08.bilivideo.com',
    'cn-hk-eq-01-09.bilivideo.com',
    'cn-hk-eq-01-10.bilivideo.com',
    'cn-hk-eq-01-11.bilivideo.com',
    'cn-hk-eq-01-12.bilivideo.com',
    'cn-hk-eq-01-13.bilivideo.com',
    'cn-hk-eq-01-14.bilivideo.com',
    'cn-hk-eq-bcache-01.bilivideo.com',
    'cn-hk-eq-bcache-03.bilivideo.com'
  ];
  const MAINLAND = [
    'upos-sz-mirrorcos.bilivideo.com',
    'upos-sz-mirrorali.bilivideo.com',
    'upos-sz-mirrorhw.bilivideo.com',
    'upos-sz-mirrorbos.bilivideo.com',
    'upos-sz-mirror08c.bilivideo.com',
    'upos-sz-mirrorbd.bilivideo.com',
    'upos-sz-mirror14b.bilivideo.com',
    'upos-sz-estgoss.bilivideo.com',
    'upos-tf-all-tx.bilivideo.com',
    'upos-tf-all-hw.bilivideo.com'
  ];
  const PRESETS = [...OVERSEAS, ...MAINLAND];
  function host(value) {
    try {
      const u = new URL(value.includes('://') ? value : 'https://' + value);
      return u.protocol === 'https:' && u.hostname.endsWith('.bilivideo.com') &&
        !u.port && !u.username && !u.password && u.pathname === '/' && !u.search && !u.hash
        ? u.hostname : '';
    } catch { return ''; }
  }
  function candidates(urls, extras, preferred, strict) {
    const original = urls.map(x => typeof x === 'string' ? x : x.url).filter(Boolean);
    const donor = original.find(x => {
      try { const u = new URL(x); return u.protocol === 'https:' && u.hostname.endsWith('.bilivideo.com') &&
        !u.port && !u.searchParams.has('hdnts'); } catch { return false; }
    });
    const all = original.slice();
    if (donor) for (const item of extras) {
      const h = host(item);
      if (h) all.push(donor.replace(/^(https:\/\/)[^/]+/, '$1' + h));
    }
    const seen = new Set();
    let result = all.filter(x => {
      const u = new URL(x);
      if (seen.has(u.host)) return false;
      seen.add(u.host); return true;
    });
    if (preferred) result.sort((a,b) => Number(new URL(b).hostname === preferred) - Number(new URL(a).hostname === preferred));
    if (strict && preferred) result = result.filter(x => new URL(x).hostname === preferred);
    return result;
  }
  function range(text, total = 0) {
    const m = /^bytes=(\d+)-(\d*)$/.exec(text || '');
    if (!m) return null;
    const start = Number(m[1]), end = m[2] ? Number(m[2]) : total - 1;
    return Number.isSafeInteger(start) && Number.isSafeInteger(end) && end >= start ? {start,end} : null;
  }
  function windowFor(segments, current, duration, seconds = 300) {
    const startTime = duration <= seconds ? 0 : Math.max(0,current);
    const endTime = Math.min(duration,current + seconds);
    const selected = segments.filter(s => s.endTime > startTime && s.startTime < endTime);
    if (!selected.length) return null;
    return {startTime, endTime, start: startTime === 0 ? 0 : selected[0].start, end: selected.at(-1).end};
  }
  class ByteCache {
    constructor() { this.parts = []; this.bytes = 0; }
    covers(start,end) {
      let cursor = start;
      for (const p of this.parts) {
        if (p.end < cursor) continue;
        if (p.start > cursor) return false;
        cursor = p.end + 1;
        if (cursor > end) return true;
      }
      return false;
    }
    put(start, buffer) {
      const end = start + buffer.byteLength - 1;
      if (!buffer.byteLength || this.covers(start,end)) return;
      // Keep non-overlapping pieces; repeated player ranges do not double memory.
      let cursor = start;
      const additions = [];
      for (const p of this.parts) {
        if (p.end < cursor) continue;
        if (p.start > end) break;
        if (p.start > cursor) additions.push({start:cursor,end:Math.min(end,p.start-1)});
        cursor = Math.max(cursor,p.end+1);
      }
      if (cursor <= end) additions.push({start:cursor,end});
      for (const p of additions) {
        p.buffer = buffer.slice(p.start-start,p.end-start+1);
        this.parts.push(p); this.bytes += p.buffer.byteLength;
      }
      this.parts.sort((a,b) => a.start-b.start);
    }
    get(start,end) {
      if (!this.covers(start,end)) return null;
      const out = new Uint8Array(end-start+1);
      for (const p of this.parts) {
        const a = Math.max(start,p.start), b = Math.min(end,p.end);
        if (b >= a) out.set(new Uint8Array(p.buffer,a-p.start,b-a+1),a-start);
      }
      return out.buffer;
    }
    retain(start,end) {
      this.parts = this.parts.filter(p => p.end >= start && p.start <= end);
      this.bytes = this.parts.reduce((sum,p) => sum+p.buffer.byteLength,0);
    }
    coveredBytes(start,end) {
      return this.parts.reduce((sum,p) => sum+Math.max(0,Math.min(end,p.end)-Math.max(start,p.start)+1),0);
    }
  }
  async function readRange(fetcher,url,start,end,{signal,idleMs=10000,timeoutMs=120000,onProgress,resume={}}={}) {
    // A retry owns this state; only a validated 206 body may advance it.
    if (!resume.buffer) Object.assign(resume,{buffer:new Uint8Array(end-start+1),count:0,start,end});
    if(resume.start!==start || resume.end!==end)throw new Error('续传范围不匹配');
    const requestStart=start+resume.count;
    const controller = new AbortController();
    const abort = () => controller.abort(signal?.reason);
    if (signal?.aborted) abort(); else signal?.addEventListener('abort',abort,{once:true});
    let idle;
    const touch = () => { clearTimeout(idle); idle=setTimeout(() => controller.abort('连续无数据'),idleMs); };
    const hard=setTimeout(() => controller.abort('请求超时'),timeoutMs);
    touch();
    try {
      if(controller.signal.aborted)throw controller.signal.reason || new Error('已取消');
      if(requestStart>end)return {buffer:resume.buffer.buffer,total:resume.total,type:resume.type};
      const response=await fetcher(url,{headers:{Range:`bytes=${requestStart}-${end}`},credentials:'omit',cache:'no-store',signal:controller.signal});
      const m=/^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get('content-range') || '');
      if (response.status!==206 || !m || +m[1]!==requestStart || +m[2]!==end || +m[3]<=end || (resume.total && resume.total!==+m[3])) {
        try { await response.body?.cancel(); } catch {}
        throw new Error(`Range 不匹配 / HTTP ${response.status}`);
      }
      resume.total=+m[3];resume.type=response.headers.get('content-type') || 'video/mp4';
      const buffer=resume.buffer;
      const reader=response.body.getReader();
      const cancelReader=()=>{void reader.cancel(controller.signal.reason).catch(()=>{});};
      controller.signal.addEventListener('abort',cancelReader,{once:true});
      if(controller.signal.aborted)cancelReader();
      try {
        while (true) {
          const {done,value}=await reader.read();
          if(controller.signal.aborted)throw new Error(String(controller.signal.reason || '已取消'));
          if (done) break;
          touch();
          if (resume.count+value.byteLength>buffer.length) throw new Error('返回数据超过 Range');
          buffer.set(value,resume.count); resume.count+=value.byteLength; onProgress?.(value.byteLength);
        }
      } finally { controller.signal.removeEventListener('abort',cancelReader);try { await reader.cancel(); } catch {} reader.releaseLock(); }
      if (resume.count!==buffer.length) throw new Error(`分块不完整 ${resume.count}/${buffer.length}`);
      return {buffer:buffer.buffer,total:+m[3],type:response.headers.get('content-type') || 'video/mp4'};
    } finally {clearTimeout(idle);clearTimeout(hard);signal?.removeEventListener('abort',abort);}
  }
  // One bounded player request can use several independent HTTP Range requests.
  // This is separate from the rolling five-minute prefetch queue.
  async function readParallelRange(fetcher,urls,start,end,{signal,parts=3,deadlineMs=7500,read=readRange,onPiece,onFailure}={}) {
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end<start || !urls.length) throw new RangeError('无效媒体范围');
    const length=end-start+1;
    const count=Math.min(Math.max(1,Math.trunc(parts)||1),Math.ceil(length/(256*1024)));
    const sizes=Array.from({length:count},(_,i)=>Math.floor(length/count)+(i<length%count?1:0));
    const pieces=[];
    let position=start;
    for(const size of sizes){pieces.push({start:position,end:position+size-1});position+=size;}
    const controller=new AbortController();
    const cancel=()=>controller.abort(signal?.reason);
    if(signal?.aborted)cancel();else signal?.addEventListener('abort',cancel,{once:true});
    const deadline=setTimeout(()=>controller.abort(new DOMException('多路下载超时','TimeoutError')),deadlineMs);
    try {
      const result=await Promise.all(pieces.map(async(piece,index)=>{
        let error;
        const resume={};
        for(let attempt=0;attempt<Math.min(urls.length,3);attempt++){
          if(controller.signal.aborted)throw controller.signal.reason || new DOMException('已取消','AbortError');
          const url=urls[(index+attempt)%urls.length];
          const began=performance.now();
          try{
            const data=await read(fetcher,url,piece.start,piece.end,{signal:controller.signal,idleMs:4000,timeoutMs:15000,resume});
            if(data.buffer.byteLength!==piece.end-piece.start+1 || !Number.isSafeInteger(data.total) || data.total<=end)throw new Error('分块校验失败');
            onPiece?.({url,start:piece.start,end:piece.end,bytes:data.buffer.byteLength,ms:Math.max(1,performance.now()-began)});
            return data;
          }catch(e){
            if(controller.signal.aborted)throw controller.signal.reason || e;
            onFailure?.({url,error:e});
            error=e;
          }
        }
        throw error || new Error('没有可用线路');
      })).catch(error=>{controller.abort(error);throw error;});
      const total=result[0].total;
      if(result.some(item=>item.total!==total))throw new Error('不同线路返回的文件长度不一致');
      const merged=new Uint8Array(length);
      let offset=0;
      for(const item of result){merged.set(new Uint8Array(item.buffer),offset);offset+=item.buffer.byteLength;}
      return {buffer:merged.buffer,total,type:result[0].type};
    } finally {clearTimeout(deadline);signal?.removeEventListener('abort',cancel);}
  }
  class RequestGate {
    constructor(limit){this.limit=limit;this.active=0;this.queue=[];this.executing=new Set();}
    run(work,signal,priority={kind:'playback'}){
      return new Promise((resolve,reject)=>{
        const job={work,signal,resolve,reject,priority};
        job.abort=()=>{const i=this.queue.indexOf(job);if(i>=0){this.queue.splice(i,1);reject(signal.reason||new Error('已取消'));}};
        if(signal.aborted){reject(signal.reason||new Error('已取消'));return;}
        signal.addEventListener('abort',job.abort,{once:true});this.queue.push(job);this.pump();
      });
    }
    pump(){
      while(this.active<this.limit() && this.queue.length){
        const foreground=this.queue.findIndex(j=>j.priority.kind==='playback');
        const background=this.queue.findIndex(j=>j.priority.kind!=='playback');
        const activeBackground=[...this.executing].filter(j=>j.priority.kind!=='playback').length;
        const reserve=Math.max(1,Math.floor(this.limit()/3));
        // With both queues waiting, retain background progress but prioritize playback.
        const index=foreground<0?background:background<0?foreground:this.limit()===1?(this.lastKind==='playback'?background:foreground):activeBackground<reserve?background:foreground;
        const j=this.queue.splice(index,1)[0];j.signal.removeEventListener('abort',j.abort);this.active++;this.executing.add(j);
        this.lastKind=j.priority.kind;
        Promise.resolve().then(()=>{if(j.signal.aborted)throw j.signal.reason||new Error('已取消');return j.work();})
          .then(j.resolve,j.reject).finally(()=>{this.active--;this.executing.delete(j);this.pump();});
      }
    }
  }
  // One pool per exact media track; CDN hosts are not cache identities.
  // Reserve intervals synchronously so Fetch, XHR and prefetch can share them.
  class RangePool {
    constructor(cache,load){this.cache=cache;this.load=load;this.pending=[];}
    async get(start,end,{signal,kind='playback'}={}){
      if(signal?.aborted)throw signal.reason||new Error('已取消');
      const outer=signal,controller=new AbortController();
      const cancel=()=>controller.abort(outer.reason);
      outer?.addEventListener('abort',cancel,{once:true});signal=controller.signal;
      try{
      const pieces=[];let cursor=start;
      while(cursor<=end){
        const cached=this.cache.parts.find(p=>p.start<=cursor&&p.end>=cursor);
        if(cached){const stop=Math.min(end,cached.end);pieces.push(Promise.resolve({start:cursor,buffer:cached.buffer.slice(cursor-cached.start,stop-cached.start+1)}));cursor=stop+1;continue;}
        let job=this.pending.find(p=>p.start<=cursor&&p.end>=cursor&&!p.controller.signal.aborted);
        let stop;
        if(job){stop=Math.min(end,job.end);if(kind==='playback')job.priority.kind='playback';}
        else{
          stop=Math.min(end,cursor+512*1024-1);
          for(const p of [...this.cache.parts,...this.pending.filter(p=>!p.controller.signal.aborted)])if(p.start>cursor)stop=Math.min(stop,p.start-1);
          job={start:cursor,end:stop,controller:new AbortController(),users:0,priority:{kind}};this.pending.push(job);
          const owned=job;
          job.promise=Promise.resolve().then(()=>this.load(owned.start,owned.end,owned.controller.signal,owned.priority)).then(data=>{
            if(data.buffer.byteLength!==owned.end-owned.start+1)throw new Error('共享分块长度不匹配');
            return data;
          }).finally(()=>{const i=this.pending.indexOf(owned);if(i>=0)this.pending.splice(i,1);});
        }
        const from=cursor,to=stop,shared=job;shared.users++;
        pieces.push(new Promise((resolve,reject)=>{
          let done=false;
          const finish=(error,data)=>{if(done)return;done=true;signal?.removeEventListener('abort',abort);shared.users--;if(!shared.users)shared.controller.abort('无剩余使用者');if(error)reject(error);else resolve({start:from,buffer:data.buffer.slice(from-shared.start,to-shared.start+1)});};
          const abort=()=>finish(signal.reason||new Error('已取消'));
          signal?.addEventListener('abort',abort,{once:true});
          shared.promise.then(data=>finish(null,data),error=>finish(error));
          if(signal?.aborted)abort();
        }));
        cursor=stop+1;
      }
      const results=await Promise.all(pieces),buffer=new Uint8Array(end-start+1);
      for(const p of results)buffer.set(new Uint8Array(p.buffer),p.start-start);
      return {buffer:buffer.buffer};
      }finally{outer?.removeEventListener('abort',cancel);controller.abort('请求结束');}
    }
  }
  root.BiliBufferCore={BLOCK,PRESETS,OVERSEAS,MAINLAND,host,candidates,range,windowFor,ByteCache,readRange,readParallelRange,RangePool,RequestGate};
})(globalThis);
