(function () {
  'use strict';
  if (globalThis.__BILI_BUFFER_5MIN__) return;
  globalThis.__BILI_BUFFER_5MIN__=true;
  const C=globalThis.BiliBufferCore, parser=globalThis.BiliCdnCore;
  const rawFetch=globalThis.fetch.bind(globalThis), NativeXHR=globalThis.XMLHttpRequest;
  const key='bili-buffer-five-min-v1';
  const defaults={enabled:true,seconds:300,concurrency:6,memory:1024,preferred:'',strict:false,extras:[],region:'mainland',parallelPlayback:true,language:'zh'};
  let settings;
  try {settings={...defaults,...JSON.parse(localStorage.getItem(key)||'{}')};} catch {settings={...defaults};}
  settings.seconds=Number.isFinite(Number(settings.seconds))?Math.max(0,Math.min(300,Math.round(Number(settings.seconds)/30)*30)):300;
  settings.language=settings.language==='en'?'en':'zh';
  settings.concurrency=[3,6,8,12].includes(Number(settings.concurrency))?Number(settings.concurrency):6;
  // Requested one-time default migration; later user changes stay saved.
  if(settings.playbackDefaultsVersion!==1){settings.region='mainland';settings.parallelPlayback=true;settings.playbackDefaultsVersion=1;try{localStorage.setItem(key,JSON.stringify(settings));}catch{}}
  const cdnFailures=new Map();let recoveryAt=0,recoveryTurn=0;
  const tracks=new Map(), active={video:null,audio:null}, running=new Map(), health=new Map();
  const observed=new Map();
  let payloads=0;
  let probeBusy=false,nextProbeAt=0;
  function mediaUrl(url){try{const u=new URL(url,location.href);return ['.bilivideo.com','.bilivideo.cn','.akamaized.net','.gcdn.co','.hdslb.com'].some(s=>u.hostname.endsWith(s))?u:null;}catch{return null;}}
  function observeMedia(url){
    const u=mediaUrl(url);if(!u||! /\.m4s$/i.test(u.pathname))return;
    observed.delete(u.pathname);observed.set(u.pathname,{url:u.href,at:Date.now()});
    if(observed.size>64)observed.delete(observed.keys().next().value);
  }
  let generation=0, pageKey='', timer=0, used=0, hits=0, hitBytes=0, downloaded=0, speed=0, lastBytes=0, lastAt=performance.now();
  let playbackActive=0;
  let parallelSuccess=0,parallelFallback=0;
  let status='等待播放器请求音视频', ui, scanning=false, scanController=null;
  const MAX_NATIVE_CACHE=32*1024*1024;
  const activeTracks=()=>[active.audio,active.video].filter(Boolean);
  const memory=()=>activeTracks().reduce((n,t)=>n+t.cache.bytes,0);
  const maxMemory=()=>Math.max(128,Math.min(2048,Number(settings.memory)||1024))*1024*1024;
  const concurrency=()=>settings.concurrency;
  const mediaGate=new C.RequestGate(concurrency);
  function sharedRange(t,start,end,signal,kind='playback'){
    if(!t.pool)t.pool=new C.RangePool(t.cache,(a,b,sharedSignal,priority)=>mediaGate.run(async()=>{
      const g=generation;
      const data=await obtainNetwork(t,a,b,{signal:sharedSignal},true);
      if(g!==generation || !activeTracks().includes(t) || (t.total&&t.total!==data.total))throw new Error('音轨或文件长度已变化');
      t.total=data.total;keep(t,a,data.buffer);void saveChunk(t,a,data.buffer);
      return data;
    },sharedSignal,priority));
    return t.pool.get(start,end,{signal,kind}).then(data=>({...data,total:t.total,type:t.type}));
  }
  const DISK_LIMIT=128*1024*1024, DISK_TTL=30*60*1000;
  let diskDb, diskWrites=0;
  function openDisk(){
    if(!('indexedDB' in globalThis))return Promise.resolve(null);
    if(!diskDb)diskDb=new Promise(resolve=>{
      let request;
      try{request=indexedDB.open('bili-cdn-preload-buffer',1);}catch{resolve(null);return;}
      request.onupgradeneeded=()=>{
        const store=request.result.createObjectStore('chunks',{keyPath:'key'});
        store.createIndex('track','track');
      };
      request.onsuccess=()=>{const db=request.result;db.onversionchange=()=>db.close();pruneDisk(db);resolve(db);};
      request.onerror=()=>resolve(null);
      request.onblocked=()=>resolve(null);
    });
    return diskDb;
  }
  function pruneDisk(db){
    try{
      const tx=db.transaction('chunks','readwrite'),store=tx.objectStore('chunks'),rows=[];
      let total=0;
      store.openCursor().onsuccess=event=>{
        const cursor=event.target.result;
        if(cursor){const row=cursor.value;rows.push({key:row.key,bytes:row.bytes||0,at:row.at||0});total+=row.bytes||0;cursor.continue();return;}
        rows.sort((a,b)=>a.at-b.at);
        for(const row of rows)if(row.at<Date.now()-DISK_TTL || total>DISK_LIMIT){store.delete(row.key);total-=row.bytes;}
      };
    }catch{}
  }
  async function saveChunk(t,start,buffer){
    if(!t.total || !buffer.byteLength || buffer.byteLength>C.BLOCK)return;
    const db=await openDisk();if(!db)return;
    await new Promise(resolve=>{
      try{
        const tx=db.transaction('chunks','readwrite');
        const track=t.path+'|'+t.total;
        tx.objectStore('chunks').put({key:[track,start],track,start,bytes:buffer.byteLength,buffer,at:Date.now()});
        tx.oncomplete=resolve;tx.onabort=resolve;tx.onerror=resolve;
      }catch{resolve();}
    });
    if(++diskWrites%16===0)pruneDisk(db);
  }
  async function restoreChunks(t,g){
    const db=await openDisk();if(!db)return;
    await new Promise(resolve=>{
      try{
        const tx=db.transaction('chunks','readonly');
        const request=tx.objectStore('chunks').index('track').openCursor(IDBKeyRange.only(t.path+'|'+t.total));
        request.onsuccess=()=>{
          const cursor=request.result;if(!cursor)return;
          const row=cursor.value,buffer=row.buffer;
          if(g===generation && activeTracks().includes(t) && row.at>=Date.now()-DISK_TTL &&
            buffer instanceof ArrayBuffer && buffer.byteLength===row.bytes && row.start>=0 && row.start+row.bytes<=t.total &&
            memory()+row.bytes<=maxMemory())t.cache.put(row.start,buffer);
          cursor.continue();
        };
        tx.oncomplete=resolve;tx.onabort=resolve;tx.onerror=resolve;
      }catch{resolve();}
    });
  }
  function save(){localStorage.setItem(key,JSON.stringify(settings));}
  function video(){return [...document.querySelectorAll('video')].find(v=>v.duration>0) || document.querySelector('video');}
  function reset(){
    scanController?.abort('切换视频');
    generation++; for(const job of running.values())job.controller.abort('切换视频');
    for(const t of activeTracks()){t.cache=new C.ByteCache();t.pool=null;}
    running.clear();active.video=active.audio=null;health.clear();cdnFailures.clear();recoveryAt=recoveryTurn=0;hits=hitBytes=downloaded=lastBytes=0;
    parallelSuccess=parallelFallback=0;
    status='等待新视频';
  }
  function ingest(payload){
    try {
      const found=parser.findDashPayload(payload);
      if(!found)return;
      payloads++;
      const dash=found.dash;
      // Include Dolby and FLAC tracks as well as the standard audio list.
      const audios=[...(dash.audio||[]),...(dash.dolby?.audio||[]),...(dash.flac?.audio?[dash.flac.audio]:[])];
      const plan=parser.extractMediaRoutes({data:{quality:found.quality,dash:{...dash,audio:audios}}},location.href);
      if(!plan?.routes.length)return;
      // Quality/codec/URL variants are not new videos. Keep their exact routes
      // together; _qe1 and non-_qe1 remain separate byte caches, never aliases.
      const contentIds=[...new Set(plan.routes.map(r=>new URL(r.urls[0].url).pathname.match(/\/upgcxcode\/\d+\/\d+\/(\d+)\//)?.[1]).filter(Boolean))].sort();
      const identity=plan.videoKey+'|'+(contentIds.join(',')||new URL(plan.routes[0].urls[0].url).pathname.replace(/[^/]+$/,''));
      for(const route of plan.routes){
        const path=new URL(route.urls[0].url).pathname;
        let t=tracks.get(path);
        if(t){t.urls=route.urls;continue;}
        t={...route,path,identity,adaptive:new globalThis.BiliAdaptive(),cache:new C.ByteCache(),index:null,indexPending:false,indexRetry:0,total:0,
          failures:new Map(),currentHost:route.urls[0].host,need:null,error:'',type:route.kind==='audio'?'audio/mp4':'video/mp4'};
        tracks.set(path,t);
      }
      // A player's load handler can open media requests before our API load handler.
      // Replay only recently observed, exact matching routes; never guess a quality.
      const recent=[...observed.values()].filter(item=>Date.now()-item.at<30000).map(item=>({item,t:match(item.url,false)})).filter(x=>x.t);
      const requestIdentity=recent.at(-1)?.t.identity;
      const latest={};
      for(const {item,t} of recent)if(t.identity===requestIdentity)latest[t.kind]=item.url;
      for(const url of Object.values(latest))match(url);
      // Keep a bounded metadata catalogue for prefetched playurl responses.
      const identities=[...new Set([...tracks.values()].map(t=>t.identity))];
      for(const obsolete of identities.slice(0,-8))if(obsolete!==pageKey)for(const [path,t] of tracks)if(t.identity===obsolete)tracks.delete(path);
    }catch(e){status='读取播放信息失败：'+e.message;}
  }
  function match(url,activate=true){
    try{
      const u=mediaUrl(url);if(!u)return null;
      const t=tracks.get(u.pathname)||[...tracks.values()].find(t=>t.urls.some(x=>new URL(x.url).pathname===u.pathname));
      if(!t)return null;
      if(activate && pageKey!==t.identity){reset();pageKey=t.identity;}
      if(activate && active[t.kind]!==t){
        const previous=active[t.kind];
        if(previous)for(const job of running.values())if(job.track===previous)job.controller.abort('切换音轨或画质');
        if(previous){previous.cache=new C.ByteCache();previous.pool=null;}
        active[t.kind]=t;status='正在建立五分钟缓存';schedule();
      }
      if(activate)t.currentHost=u.hostname;
      return t;
    }catch{return null;}
  }
  function routes(t){
    const presets=settings.region==='mainland'?C.MAINLAND:settings.region==='overseas'?C.OVERSEAS:C.PRESETS;
    let values=C.candidates(t.urls,[...presets,...settings.extras],settings.preferred,settings.strict);
    if(!settings.strict && settings.region!=='auto'){
      const allowed=new Set([...presets,...settings.extras,settings.preferred]);
      const regional=values.filter(url=>allowed.has(new URL(url).hostname));
      if(regional.length)values=regional;
    }
    values.sort((a,b)=>{
      const ha=new URL(a).hostname,hb=new URL(b).hostname,sa=health.get(ha),sb=health.get(hb);
      const coolA=(sa?.until||0)>Date.now(),coolB=(sb?.until||0)>Date.now();
      if(coolA!==coolB)return Number(coolA)-Number(coolB);
      if(settings.preferred)return Number(hb===settings.preferred)-Number(ha===settings.preferred);
      return (sb?.mbps||0)-(sa?.mbps||0);
    });
    if(settings.region==='auto' && !settings.preferred && !settings.strict && !values.slice(0,3).some(url=>C.MAINLAND.includes(new URL(url).hostname))){
      const mainland=values.findIndex(url=>C.MAINLAND.includes(new URL(url).hostname) && (health.get(new URL(url).hostname)?.until||0)<=Date.now());
      if(mainland>2)values.splice(2,0,values.splice(mainland,1)[0]);
    }
    return values;
  }
  function playerUrl(t,original){
    if(!settings.enabled || !t || !settings.preferred)return original;
    return routes(t)[0] || original;
  }
  function cached(t,text){
    if(!settings.enabled||!t)return null;
    const r=C.range(text,t.total);
    if(!r || r.end-r.start+1>64*1024*1024)return null;
    const buffer=t.cache.get(r.start,r.end);
    if(!buffer || !t.total)return null;
    hits++;hitBytes+=buffer.byteLength;
    return {buffer,status:206,statusText:'Partial Content',responseURL:t.urls[0].url,
      headers:{'content-type':t.type,'content-length':String(buffer.byteLength),'content-range':`bytes ${r.start}-${r.end}/${t.total}`}};
  }
  function playbackRange(t,url,text){
    if(!settings.enabled || !settings.parallelPlayback || !t || !mediaUrl(url) || !/\.m4s$/i.test(new URL(url).pathname))return null;
    const r=C.range(text,t.total);
    if(!r || (t.total && r.end>=t.total) || r.end-r.start+1>16*1024*1024)return null;
    return r;
  }
  async function accelerated(t,url,r,signal){
    const candidates=routes(t).slice(0,4);
    if(!candidates.length)throw new Error('没有可用 CDN');
    const currentGeneration=generation;
    playbackActive++;
    try{
      const data=await sharedRange(t,r.start,r.end,signal);
      if((t.total && data.total!==t.total) || currentGeneration!==generation || !activeTracks().includes(t))throw new Error('音轨或文件长度已变化');
      t.total=data.total;
      keep(t,r.start,data.buffer);
      parallelSuccess++;
      return {buffer:data.buffer,status:206,statusText:'Partial Content',responseURL:url,
        headers:{'content-type':data.type,'content-length':String(data.buffer.byteLength),'content-range':`bytes ${r.start}-${r.end}/${data.total}`}};
    }catch(error){if(!signal?.aborted)parallelFallback++;throw error;
    }finally{playbackActive--;schedule();}
  }
  function keep(t,start,buffer){
    if(!settings.enabled||!activeTracks().includes(t))return;
    if(memory()+buffer.byteLength>maxMemory())return;
    t.cache.put(start,buffer);
  }
  function acceptNative(t,statusCode,contentRange,type,buffer){
    if(!t||statusCode!==206 || !(buffer instanceof ArrayBuffer)||buffer.byteLength>MAX_NATIVE_CACHE)return;
    const m=/^bytes (\d+)-(\d+)\/(\d+)$/.exec(contentRange||'');
    if(!m||+m[2]-+m[1]+1!==buffer.byteLength)return;
    t.total=+m[3];t.type=type||t.type;keep(t,+m[1],buffer);schedule();
  }
  function isApi(url){return /\/[^?#]*playurl(?:[/?#]|$)/.test(String(url));}
  // Observe the initial SSR payload, before the Bilibili player consumes it.
  let initial=globalThis.__playinfo__;
  try{
    Object.defineProperty(globalThis,'__playinfo__',{configurable:true,enumerable:true,get:()=>initial,set(value){initial=value;ingest(value);}});
  }catch{}
  if(initial)ingest(initial);
  globalThis.fetch=async function(input,options){
    const url=typeof input==='string'?input:input?.url||String(input);
    const method=String(options?.method||input?.method||'GET').toUpperCase();
    if(method==='GET')observeMedia(url);
    const t=method==='GET'?match(url):null;
    const headers=new Headers(options?.headers || (input instanceof Request?input.headers:undefined));
    const text=headers.get('range')||'';
    const ready=cached(t,text);
    if(ready && !options?.signal?.aborted && !(input instanceof Request && input.signal.aborted))return new Response(ready.buffer,{status:206,headers:ready.headers});
    const r=playbackRange(t,url,text);
    const signal=options?.signal || (input instanceof Request?input.signal:null);
    if(r && method==='GET' && !signal?.aborted && options?.credentials!=='include' && !options?.integrity &&
      !(input instanceof Request && (input.credentials==='include' || input.mode==='no-cors' || input.integrity)) &&
      [...headers.keys()].every(name=>['range','accept'].includes(name))){
      try{const result=await accelerated(t,url,r,signal);return new Response(result.buffer,{status:206,headers:result.headers});}
      catch{if(signal?.aborted)throw signal.reason || new DOMException('已取消','AbortError');}
    }
    const target=playerUrl(t,url);
    const actual=target!==url?(input instanceof Request?new Request(target,input):target):input;
    const response=await rawFetch(actual,options);
    if(isApi(url))response.clone().json().then(ingest).catch(()=>{});
    else if(t && settings.enabled){
      const r=C.range(text,t.total);
      const cr=/^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get('content-range')||'');
      if(response.status===206 && cr && r && +cr[1]===r.start && +cr[2]===r.end && r.end-r.start+1<=MAX_NATIVE_CACHE)response.clone().arrayBuffer().then(buffer=>acceptNative(t,response.status,response.headers.get('content-range'),response.headers.get('content-type'),buffer)).catch(()=>{});
    }
    return response;
  };
  const rawOpen=NativeXHR.prototype.open,rawSend=NativeXHR.prototype.send;
  const meta=new WeakMap();
  NativeXHR.prototype.open=function(method,url,...rest){
    if(String(method).toUpperCase()==='GET')observeMedia(String(url));
    const t=String(method).toUpperCase()==='GET'?match(String(url)):null;
    meta.set(this,{url:String(url),track:t});
    return rawOpen.call(this,method,playerUrl(t,String(url)),...rest);
  };
  NativeXHR.prototype.send=function(body){
    const m=meta.get(this);
    this.addEventListener('load',()=>{
      try{
        if(isApi(m?.url))ingest(this.responseType==='json'?this.response:JSON.parse(this.responseText));
        else if(m && this.responseType==='arraybuffer')acceptNative(m.track||match(m.url),this.status,this.getResponseHeader('content-range'),this.getResponseHeader('content-type'),this.response);
      }catch{}
    },{once:true});
    return rawSend.call(this,body);
  };
  const WrappedXHR=globalThis.BiliCdnCachedXHR.createCachedXMLHttpRequest({NativeXHR,
    resolveCachedRequest({url,range,headers,withCredentials,signal}){
      const t=match(url),response=cached(t,range);
      if(response)return {cachedResponse:response};
      const r=playbackRange(t,url,range);
      if(!r || withCredentials || headers.some(([name])=>!['range','accept'].includes(name.toLowerCase())))return null;
      return {pendingResponse:accelerated(t,url,r,signal).then(cachedResponse=>({cachedResponse}))};
    }});
  if(WrappedXHR)globalThis.XMLHttpRequest=WrappedXHR;
  function urgent(t,start,end){
    const position=Number(video()?.currentTime)||0;
    return t.index?.segments.some(s=>s.endTime>position && s.startTime<position+25 && s.start<=end && s.end>=start);
  }
  async function obtain(t,start,end,controller,adaptive=false){
    if(adaptive)return sharedRange(t,start,end,controller.signal,'prefetch');
    return obtainNetwork(t,start,end,controller,false);
  }
  async function obtainNetwork(t,start,end,controller,adaptive=false){
    let last;
    const resume={};
    let available=routes(t),probeHost='',recovering=false;
    if(!settings.strict){
      const usable=available.filter(url=>(cdnFailures.get(new URL(url).hostname)||0)<2);
      if(usable.length)available=usable;
      else if(available.length && Date.now()>=recoveryAt){recoveryAt=Date.now()+60000;available=[available[recoveryTurn++%available.length]];recovering=true;}
      else throw new Error('当前视频候选均失败，稍后有限重试');
    }
    if(adaptive && !settings.strict){
      const eligible=available.filter(url=>(health.get(new URL(url).hostname)?.until||0)<=Date.now());
      const choice=t.adaptive.choose(eligible.map(url=>new URL(url).hostname),Date.now(),!scanning&&!probeBusy&&Date.now()>=nextProbeAt);
      if(choice){
        available.sort((a,b)=>Number(new URL(b).hostname===choice.host)-Number(new URL(a).hostname===choice.host));
        if(choice.probe){probeHost=choice.host;probeBusy=true;nextProbeAt=Date.now()+6000;}
      }
    }
    if(!available.length)throw new Error('当前轨道无可用候选；固定线路无法生成此视频地址');
    // Retry on future scheduler rounds; one bad CDN must not occupy every worker indefinitely.
    let attempts=0;
    try{for(const url of available){
      if(controller.signal.aborted)throw new Error('已取消');
      const h=new URL(url).hostname, began=performance.now();
      if(!settings.strict && !recovering && (cdnFailures.get(h)||0)>=2)continue;
      if(!settings.strict && (health.get(h)?.until||0)>Date.now())continue;
      if(attempts++>=(settings.strict?1:3))break;
      // Hand off a delayed imminent block in the SAME worker slot. Never race
      // multiple full copies or abort the player's own network requests.
      const attemptController=new AbortController();
      const relayAbort=()=>attemptController.abort(controller.signal.reason);
      controller.signal.addEventListener('abort',relayAbort,{once:true});
      if(controller.signal.aborted)relayAbort();
      let lastProgress=began;
      const rescue=adaptive && !settings.strict ? setInterval(()=>{
        if(urgent(t,start,end) && (performance.now()-lastProgress>=3000 || performance.now()-began>=6000))attemptController.abort('临近播放的数据块过慢，接力备用线路');
      },250):null;
      try{
        const previous=resume.count||0;
        const data=await C.readRange(rawFetch,url,start,end,{resume,signal:attemptController.signal,idleMs:3000,timeoutMs:15000,...(h===probeHost?{timeoutMs:6000}:{}),onProgress:n=>{lastProgress=performance.now();downloaded+=n;}});
        const received=data.buffer.byteLength-previous;
        if(adaptive)t.adaptive.record(h,received,performance.now()-began,Date.now());
        health.set(h,{mbps:received*8/(performance.now()-began)/1000,until:0,error:''});
        cdnFailures.delete(h);
        t.error='';return data;
      }catch(e){
        last=e;if(controller.signal.aborted)throw e;
        cdnFailures.set(h,(cdnFailures.get(h)||0)+1);
        t.adaptive.fail(h);
        health.set(h,{mbps:0,until:Date.now()+30000,error:e.message});
        t.error=h+'：'+e.message;
      }finally{clearInterval(rescue);controller.signal.removeEventListener('abort',relayAbort);}
    }}finally{
      if(probeHost)probeBusy=false;
      // Preserve validated bytes even when all three attempts fail. The next
      // scheduler round requests only holes, not the entire block again.
      if(adaptive && !controller.signal.aborted && resume.count && (!t.total || t.total===resume.total)){
        keep(t,start,resume.buffer.buffer.slice(0,resume.count));
      }
    }
    throw last||new Error('所有候选线路失败');
  }
  async function loadIndex(t){
    if(t.index || t.indexPending || t.indexRetry>Date.now())return;
    const r=C.range('bytes='+t.segmentBase?.indexRange);
    if(!r){t.error='此轨道没有 DASH sidx 索引，无法按时间预取';t.indexRetry=Date.now()+30000;return;}
    t.indexPending=true;
    const g=generation,controller=new AbortController();
    const id=t.path+'|index';running.set(id,{track:t,controller,start:r.start,end:r.end});
    try{
      const data=await obtain(t,r.start,r.end,controller);
      if(g!==generation||!activeTracks().includes(t))return;
      const index=parser.parseSidx(data.buffer,r.start);
      if(!index?.segments.length)throw new Error('无法解析 sidx');
      t.hydrating=true;t.index=index;t.total=data.total;t.type=data.type;keep(t,r.start,data.buffer);
      await restoreChunks(t,g);
    }catch(e){t.error=e.message;t.indexRetry=Date.now()+5000;}
    finally{t.hydrating=false;t.indexPending=false;if(running.get(id)?.controller===controller)running.delete(id);schedule();}
  }
  function schedule(){if(!timer)timer=setTimeout(tick,100);}
  let seekPending=false;
  function plan(t,v){
    if(settings.seconds===0){t.need=null;return null;}
    if(!t.index)return null;
    const duration=Number.isFinite(v?.duration)?v.duration:t.index.segments.at(-1).endTime;
    const need=C.windowFor(t.index.segments,Number(v?.currentTime)||0,duration,settings.seconds);
    t.need=need;
    if(need && duration>settings.seconds){
      // Retain a few seconds behind playback, plus initialization and index data.
      const previous=t.index.segments.find(s=>s.endTime>Math.max(0,(v?.currentTime||0)-15));
      const init=t.cache.get(0,Number(t.segmentBase.indexRange.split('-')[1]));
      // Shortening the target must not discard already downloaded future bytes.
      t.cache.retain(previous?.start||0,Infinity);
      if(init)t.cache.put(0,init);
    }
    return need;
  }
  function nextJob(t){
    const need=t.need;if(!need || t.hydrating)return null;
    const position=Number(video()?.currentTime)||0;
    const current=t.index.segments.find(s=>s.endTime>position);
    const first=Math.floor(need.start/C.BLOCK)*C.BLOCK;
    const anchor=Math.max(first,Math.floor((current?.start||need.start)/C.BLOCK)*C.BLOCK);
    const starts=[];
    for(let start=anchor;start<=need.end;start+=C.BLOCK)starts.push(start);
    // A short video is still fully cached, but played portions no longer outrank
    // the bytes needed immediately after a seek.
    for(let start=first;start<anchor;start+=C.BLOCK)starts.push(start);
    for(const blockStart of starts){
      let start=blockStart,end=Math.min(start+C.BLOCK-1,t.total-1);
      const id=t.path+'|'+blockStart;
      if(running.has(id))continue;
      for(const part of t.cache.parts){
        if(part.end<start)continue;
        if(part.start>start){end=Math.min(end,part.start-1);break;}
        start=part.end+1;
        if(start>end)break;
      }
      if(start>end || (t.failures.get(start)||0)>Date.now())continue;
      const reserved=[...running.values()].reduce((sum,j)=>sum+j.end-j.start+1,0);
      if(memory()+reserved+end-start+1>maxMemory()){status='缓存达到内存上限；随播放释放后继续（可提高上限）';return null;}
      const seg=t.index.segments.find(s=>s.end>=start);
      return {id,track:t,start,end,time:seg?.startTime||0,priority:start<anchor?1:0};
    }
    return null;
  }
  function tick(){
    clearTimeout(timer);timer=0;
    if(!settings.enabled){status='预加载已暂停';render();return;}
    const v=video();
    for(const t of activeTracks()){
      if(settings.seconds>0 && !t.index && running.size<concurrency())loadIndex(t);
      plan(t,v);
      if(t.need){const s=stats(t);t.adaptive.observe(Date.now(),Math.max(0,s.end-(v?.currentTime||0)),v?.currentTime||0,t.cache.covers(t.need.start,t.need.end));}
    }
    // Cancel obsolete work on a seek, without dropping already cached future bytes.
    for(const job of running.values()){
      const need=job.track.need;
      if(!activeTracks().includes(job.track) || (seekPending && need && !job.track.indexPending && (job.end<need.start-C.BLOCK || job.start>need.end+C.BLOCK)))job.controller.abort('跳转到新位置');
    }
    seekPending=false;
    // Do not fill the queue with later blocks while the next playable seconds have a hole.
    const nearGap=activeTracks().some(t=>t.need && stats(t).end<Math.min(t.need.endTime,(v?.currentTime||0)+8));
    const prefetchLimit=nearGap?Math.min(2,concurrency()):concurrency();
    while(settings.seconds>0 && running.size<prefetchLimit){
      const jobs=activeTracks().map(nextJob).filter(Boolean).sort((a,b)=>a.priority-b.priority || a.time-b.time || (a.track.kind==='audio'?-1:1));
      if(!jobs.length)break;
      const job=jobs[0],g=generation;
      job.controller=new AbortController();running.set(job.id,job);
      obtain(job.track,job.start,job.end,job.controller,true).then(data=>{
        if(g!==generation || !activeTracks().includes(job.track))return;
        job.track.total=data.total;keep(job.track,job.start,data.buffer);void saveChunk(job.track,job.start,data.buffer);job.track.failures.delete(job.start);
      }).catch(e=>{
        if(!job.controller.signal.aborted){job.track.error=e.message;job.track.failures.set(job.start,Date.now()+5000);}
      }).finally(()=>{if(running.get(job.id)===job)running.delete(job.id);schedule();});
    }
    used=memory();
    if(running.size)status=`正在下载 ${running.size} 个请求 · ${settings.strict?'固定线路':'允许故障回退'}`;
    else if(activeTracks().length && activeTracks().every(t=>t.need && t.cache.covers(t.need.start,t.need.end)))status='目标范围已缓存，播放后自动向前补齐';
    else if(activeTracks().some(t=>t.error))status='下载失败会自动重试；可在下方测试或切换线路';
    if(settings.seconds===0)status='额外预加载已关闭 · 沿用 B 站自身缓冲';
    render();timer=setTimeout(tick,1000);
  }
  function stats(t){
    if(settings.seconds===0)return {text:'沿用 B 站自身缓冲',percent:0,end:0};
    if(!t?.need)return {text:t?'读取分片索引…':'等待实际音轨请求',percent:0};
    const n=t.need,total=n.end-n.start+1,bytes=t.cache.coveredBytes(n.start,n.end);
    let end=n.startTime;
    for(const s of t.index.segments){
      if(s.endTime<=n.startTime)continue;
      if(s.startTime>=n.endTime)break;
      if(!t.cache.covers(s.start,s.end))break;
      end=Math.min(s.endTime,n.endTime);
    }
    return {end,percent:100*bytes/total,text:`${Math.round(100*bytes/total)}% · 连续缓存至 ${fmt(end)} / 目标 ${fmt(n.endTime)}`};
  }
  function fmt(n){
    const seconds=Math.floor(n),hours=Math.floor(seconds/3600),minutes=Math.floor(seconds%3600/60),tail=String(seconds%60).padStart(2,'0');
    return hours?`${hours}:${String(minutes).padStart(2,'0')}:${tail}`:`${minutes}:${tail}`;
  }
  function render(){
    if(!ui)return;
    const now=performance.now();if(now-lastAt>=1000){speed=(downloaded-lastBytes)*8/(now-lastAt)/1000;lastAt=now;lastBytes=downloaded;}
    ui.getElementById('status').textContent=status;
    const current=active.video;
    const quality=current?.id===125?'HDR 真彩':current?.id===126?'Dolby Vision':current?.height?`${current.height}p`:current?`ID ${current.id}`:'';
    const codec=current?/^hvc|^hev/.test(current.codec)?'HEVC':/^av01/.test(current.codec)?'AV1':/^avc/.test(current.codec)?'AVC':current.codec:'';
    ui.getElementById('trackInfo').textContent=current?`当前视频轨道：${quality} · ${codec}`:'';
    ui.getElementById('adaptive').textContent=settings.strict?'固定线路：不自动探测':activeTracks().map(t=>`${t.kind==='video'?'视频':'音频'}：${t.adaptive.reason}${t.adaptive.champion?' · '+t.adaptive.champion:''}`).join('\n');
    ui.getElementById('summary').textContent=`预缓存${settings.enabled?'已启用':'已暂停'} · ${(speed/8).toFixed(2)} MB/s (${speed.toFixed(1)} Mbps)\n缓存 ${(memory()/1048576).toFixed(0)} / ${settings.memory} MB · 命中 ${hits} 次 / ${(hitBytes/1048576).toFixed(1)} MB\n播放请求并行：${settings.parallelPlayback?'已勾选':'未勾选（预缓存不受影响）'}${playbackActive?' · 处理中 '+playbackActive:''} · 成功 ${parallelSuccess} / 回退 ${parallelFallback}`;
    for(const kind of ['video','audio']){const s=stats(active[kind]);ui.getElementById(kind+'Text').textContent=s.text;ui.getElementById(kind+'Bar').value=s.percent;}
    ui.getElementById('errors').textContent=activeTracks().filter(t=>t.error).map(t=>`${t.kind==='audio'?'音频':'视频'}：${t.error}`).join('\n');
    ui.getElementById('toggle').textContent=settings.enabled?'暂停预加载':'继续预加载';
    const list=ui.getElementById('host');
    const hosts=[...new Set([...activeTracks().flatMap(t=>t.urls.map(x=>x.host)),...C.PRESETS,...settings.extras,settings.preferred].filter(Boolean))];
    if(list.dataset.values!==hosts.join('|')){const selected=list.dataset.values===undefined?settings.preferred:list.value;list.replaceChildren(...['',...hosts].map(h=>{const o=document.createElement('option');o.value=h;o.textContent=h||'自动选择（无固定首选）';return o;}));list.value=selected;list.dataset.values=hosts.join('|');}
    ui.getElementById('strict').disabled=!list.value;
  }
  async function scan(){
    if(scanning){scanController?.abort('停止测速');return;}
    const t=active.video;if(!t?.total){ui.getElementById('results').textContent='请先播放视频，等待分片索引读取完成。';return;}
    scanning=true;scanController=new AbortController();ui.getElementById('scan').textContent='停止测速';ui.getElementById('results').replaceChildren();
    const available=C.candidates(t.urls,[...C.PRESETS,...settings.extras],'',false);
    const info=document.createElement('p');info.className='muted';
    info.textContent=`当前视频生成 ${available.length} 条测速候选（预设 ${C.PRESETS.length} 条；无法生成当前视频地址的线路不会测速）`;
    ui.getElementById('results').append(info);
    const sampleBytes=64*1024;
    info.textContent+=` · 每条最多 128 KiB，小块测速仅供参考`;
    const g=generation;let i=0;
    async function worker(){
      while(i<available.length && g===generation && !scanController.signal.aborted){
        const url=available[i++],h=new URL(url).hostname;
        const start=Math.min(Math.floor((t.need?.start||0)/C.BLOCK)*C.BLOCK,Math.max(0,t.total-C.BLOCK));
        const row=document.createElement('div');row.className='result';row.textContent=h+' · 测试中';ui.getElementById('results').append(row);
        try{
          const speeds=[];
          const next=t.index?.segments.find(s=>s.startTime>=(t.need?.startTime||0)+60);
          const starts=[...new Set([start,Math.min(next?.start ?? start+C.BLOCK,Math.max(0,t.total-sampleBytes))])];
          for(const pos of starts){
            const at=performance.now(),end=Math.min(pos+sampleBytes-1,t.total-1);
            const data=await C.readRange(rawFetch,url,pos,end,{signal:scanController.signal,idleMs:5000,timeoutMs:12000});
            speeds.push(data.buffer.byteLength*8/(performance.now()-at)/1000);keep(t,pos,data.buffer);
          }
          if(g!==generation)return;
          const mbps=Math.min(...speeds);
          health.set(h,{mbps,until:0,error:''});
          row.textContent=h+` · 两处抽样 ${speeds.map(n=>n.toFixed(1)).join(' / ')} Mbps `;
          const button=document.createElement('button');button.textContent='使用';button.onclick=()=>{settings.preferred=h;settings.strict=true;ui.getElementById('host').value=h;ui.getElementById('strict').checked=true;applySettings();};row.append(button);
        }catch(e){if(g!==generation)return;health.set(h,{mbps:0,until:Date.now()+30000,error:e.message});row.textContent=h+' · 不可用 / 超时';}
      }
    }
    await Promise.all([worker(),worker()]);scanning=false;scanController=null;ui.getElementById('scan').textContent='测试各线路';
  }
  function applySettings(){
    const h=ui.getElementById('host').value.trim();
    // Akamai can be selected only when its complete native signed URL exists.
    const nativeHost=activeTracks().some(t=>t.urls.some(x=>x.host===h));
    if(h && !C.host(h) && !nativeHost){ui.getElementById('errors').textContent='请填写 bilivideo.com 下的 HTTPS 域名，不要填 IP、路径或代理订阅链接。';return;}
    const input=ui.getElementById('extras').value.trim().split(/[\s,，;；]+/).filter(Boolean);
    if(input.some(x=>!C.host(x))){ui.getElementById('errors').textContent='批量列表中有无效域名；每行填写一个 bilivideo.com 下的域名。';return;}
    settings.extras=[...new Set(input.map(C.host))];
    settings.preferred=h;settings.strict=Boolean(h)&&ui.getElementById('strict').checked;
    settings.region=ui.getElementById('region').value;
    for(const t of activeTracks())t.adaptive=new globalThis.BiliAdaptive();
    ui.getElementById('strict').checked=settings.strict;ui.getElementById('strict').disabled=!h;
    if(C.host(h) && !C.PRESETS.includes(h) && !settings.extras.includes(h))settings.extras.push(h);
    try{save();ui.getElementById('saved').textContent='已保存 · 刷新或换视频后继续沿用';}
    catch{ui.getElementById('saved').textContent='本次已生效，但站点存储不可用，未能永久保存';}
    for(const job of running.values())job.controller.abort('应用线路设置');
    for(const t of activeTracks()){t.failures.clear();t.indexRetry=0;t.error='';}schedule();
  }
  function installUI(){
    if(ui || !document.body)return;
    const container=document.createElement('div');container.id='bili-buffer-five-min';
    container.style.cssText='position:fixed;right:18px;bottom:78px;z-index:2147483647;';
    ui=container.attachShadow({mode:'open'});
    ui.innerHTML=`<style>
      :host{font:13px system-ui,sans-serif;color:#edf3ff}*{box-sizing:border-box}
      button,input,select,textarea{font:inherit}button{cursor:pointer;border:1px solid #465575;border-radius:7px;padding:7px 10px;background:#253453;color:#fff}button:hover{background:#354969}button:disabled{opacity:.5}
      #badge{background:#176d8b;border-color:#299cc0;box-shadow:0 3px 14px #0004}
      #panel{display:none;background:#142037;border:1px solid #354867;border-radius:13px;padding:16px;width:390px;max-width:calc(100vw - 36px);max-height:75vh;overflow:auto;box-shadow:0 8px 30px #0005;margin-bottom:8px}
      #panel.open{display:block}h3{font-size:16px;margin:0 0 9px}p{margin:8px 0;line-height:1.5}.muted{color:#a8bad4;font-size:12px}
      progress{width:100%;height:12px;accent-color:#35caad}label{display:flex;align-items:center;justify-content:space-between;gap:9px;margin-top:11px}input[type=text]{width:100%;margin:7px 0;padding:8px;background:#0d1729;color:#fff;border:1px solid #465575;border-radius:6px}select{background:#253453;color:#fff;border:1px solid #465575;border-radius:5px;padding:5px}
      .actions{display:flex;gap:7px;flex-wrap:wrap;margin:12px 0}#errors{color:#ffbb97;font-size:11px;white-space:pre-wrap;overflow-wrap:anywhere}.result{font-size:11px;border-bottom:1px solid #354867;padding:7px 0;overflow-wrap:anywhere}.result button{padding:3px 6px}details{border-top:1px solid #354867;padding-top:10px}summary{cursor:pointer}#summary{font-size:11px;white-space:pre-line}textarea{width:100%;height:65px;margin-top:7px;background:#0d1729;color:white;border:1px solid #465575;border-radius:6px;padding:7px}
      :host{color:#242838;font:13px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
      #panel{background:#fcfcff;border:1px solid #e8e8f0;border-radius:20px;padding:20px;width:380px;max-height:78vh;overflow:auto;box-shadow:0 12px 48px #20243a26;scrollbar-width:thin}
      .heading{display:flex;align-items:center;gap:10px;margin-bottom:15px}.mark{display:grid;place-items:center;width:38px;height:38px;border-radius:12px;background:#fb7299;color:white;font-size:23px}.heading h3{margin:0;font-size:16px}.heading small{font-size:11px;color:#777d90}.heading #close{margin-left:auto;padding:4px 9px;font-size:20px;background:#f0f1f5;color:#656b7b}
      #status{background:#fff0f5;color:#9d3659;padding:11px 13px;border-radius:11px;font-weight:600;font-size:12px}
      .muted{color:#697286;font-size:11px}p{line-height:1.65;margin:10px 0}progress{height:8px;border:0;border-radius:8px;overflow:hidden;background:#edf0f4;accent-color:#fb7299}progress::-webkit-progress-bar{background:#edf0f4}progress::-webkit-progress-value{background:linear-gradient(90deg,#fb7299,#e45591);border-radius:8px}
      button{border:0;background:#f1f2f7;color:#48516a;border-radius:9px;font-weight:600;font-size:12px;padding:9px 11px}button:hover{background:#e8eaf2}button:focus-visible,select:focus-visible,textarea:focus-visible{outline:2px solid #da477b;outline-offset:2px}
      #badge{display:block;margin-left:auto;background:#fff;color:#b23b66;border:1px solid #f6ccdb;border-radius:999px;padding:10px 16px;box-shadow:0 4px 18px #23263a1c}#toggle{background:#fb7299;color:white}#toggle:hover{background:#ec608a}
      #summary{background:#f1f4f9;color:#46536b;padding:12px;border-radius:11px;font-variant-numeric:tabular-nums;line-height:1.9}.actions{gap:6px}details{border-color:#e8eaf0;margin-top:15px}summary{color:#505c72;font-weight:600;padding:4px 0}select,textarea{background:#fff;color:#374159;border:1px solid #dce1ea;border-radius:8px}textarea{resize:vertical}label{color:#626d80;font-size:12px}#errors{color:#ad4c2f}.result{border-color:#e8eaf0;color:#58647a}
      #errors:empty,#adaptive:empty,#saved:empty,#trackInfo:empty{display:none}
      .heading>div{flex:1;min-width:0}.heading .mark{flex-shrink:0}.heading h3{font-size:16px}.heading small{display:block;font-size:10px;line-height:1.4}.heading #close{margin-left:0}.heading #language{flex-shrink:0;padding:6px;font-size:11px;white-space:nowrap;font-weight:400}#language[data-language="en"] .lang-en,#language[data-language="zh"] .lang-zh{color:#b23b66;font-weight:700}label>select{min-width:0;max-width:65%}
      #preloadSeconds{width:100%;margin:10px 0 0;accent-color:#fb7299;cursor:pointer}#preloadSeconds:focus-visible{outline:2px solid #da477b;outline-offset:3px}.rangeEnds{display:flex;justify-content:space-between;font-size:11px;color:#777d90;margin-top:3px}
    </style>
    <section id="panel" aria-label="五分钟缓存控制面板"><div class="heading"><span class="mark">↓</span><div><h3>Bili CDN &amp; Preload</h3><small>Adaptive CDN &amp; Video Caching · 1.0.9 beta.3</small></div><button id="language" type="button" data-i18n-skip><span class="lang-en">EN</span> / <span class="lang-zh">中</span></button><button id="close" aria-label="收起面板">×</button></div><p id="status"></p>
    <p id="trackInfo" class="muted"></p><p>视频 <span id="videoText" class="muted"></span></p><progress id="videoBar" max="100" value="0"></progress>
    <p>音频 <span id="audioText" class="muted"></span></p><progress id="audioBar" max="100" value="0"></progress>
    <p id="summary" class="muted"></p><div class="actions"><button id="toggle">暂停预加载</button><button id="scan">测试各线路</button></div>
    <label for="preloadSeconds">提前预加载<output id="preloadValue" for="preloadSeconds"></output></label><input id="preloadSeconds" type="range" min="0" max="300" step="any" aria-describedby="preloadHint"><div class="rangeEnds"><span>B 站默认</span><span>5 分钟</span></div><p id="preloadHint" class="muted">松手吸附到最近的 30 秒档位；最左侧沿用 B 站自身缓冲。</p>
    <p id="adaptive" class="muted" style="overflow-wrap:anywhere;white-space:pre-line"></p>
    <details id="settings"><summary>下载与线路设置</summary><label>线路范围<select id="region"><option value="auto">自动（海外＋大陆）</option><option value="overseas">海外优先</option><option value="mainland">大陆优先</option></select></label><label>首选 CDN<select id="host"></select></label>
    <label><span>仅用首选 CDN（失败不换线）</span><input id="strict" type="checkbox"></label>
    <label>总下载并发上限<select id="concurrency"><option>3</option><option>6</option><option>8</option><option>12</option></select></label><p class="muted">播放优先、预取保留名额；空闲名额可借用，共享数据不重复下载。</p>
    <label><span>播放请求并行下载（可选）</span><input id="parallelPlayback" type="checkbox"></label>
    <label title="浏览器临时缓存，不会预占上限或离线保存">预缓存内存上限<select id="memory"><option value="256">256 MB</option><option value="512">512 MB</option><option value="1024">1 GB</option><option value="2048">2 GB</option></select></label>
    <p class="muted" id="saved" aria-live="polite"></p><label>额外 CDN 候选（每行一个）</label><textarea id="extras" placeholder="cn-hk-eq-01-04.bilivideo.com"></textarea></details>
    <p id="errors"></p><div id="results"></div></section><button id="badge">Bili CDN &amp; Preload</button>`;
    document.body.append(container);
    const localize=globalThis.BiliBufferI18n.attach(ui,()=>settings.language);
    const languageButton=ui.getElementById('language');
    const showLanguage=()=>{languageButton.dataset.language=settings.language;languageButton.setAttribute('aria-label',settings.language==='en'?'切换为中文':'Switch to English');};
    showLanguage();
    languageButton.onclick=()=>{
      settings.language=settings.language==='en'?'zh':'en';showLanguage();
      try{save();ui.getElementById('saved').textContent='已保存 · 刷新或换视频后继续沿用';}catch{ui.getElementById('saved').textContent='本次已生效，但无法保存设置';}
      localize();
    };
    ui.getElementById('host').value=settings.preferred;ui.getElementById('strict').checked=settings.strict;
    ui.getElementById('region').value=settings.region;
    const slider=ui.getElementById('preloadSeconds');slider.value=settings.seconds;
    const snapPreload=()=>Math.max(0,Math.min(300,Math.round(Number(slider.value)/30)*30));
    const showPreload=(seconds=settings.seconds)=>{const text=seconds?`${Math.floor(seconds/60)}分${seconds%60?seconds%60+'秒':''}`:'B 站默认';ui.getElementById('preloadValue').textContent=text;slider.setAttribute('aria-valuetext',text);};
    showPreload();
    // Keep pointer movement continuous. Preview is cheap; commit only on release.
    let preloadPointer=null;
    slider.oninput=()=>showPreload(Math.round(Number(slider.value)));
    const commitPreload=()=>{
      const seconds=snapPreload();slider.value=seconds;showPreload(seconds);
      if(seconds===settings.seconds)return;
      settings.seconds=seconds;
      try{save();ui.getElementById('saved').textContent='已保存 · 刷新或换视频后继续沿用';}catch{ui.getElementById('saved').textContent='本次已生效，但无法保存设置';}
      // Change only future scheduling; finish existing shared requests normally.
      schedule();
    };
    slider.onpointerdown=event=>{preloadPointer=event.pointerId;};
    window.addEventListener('pointerup',event=>{if(event.pointerId===preloadPointer){preloadPointer=null;commitPreload();}});
    slider.onchange=()=>{if(preloadPointer===null)commitPreload();};
    slider.onblur=()=>{if(preloadPointer===null)commitPreload();};
    const cancelPreload=()=>{preloadPointer=null;slider.value=settings.seconds;showPreload();};
    window.addEventListener('pointercancel',event=>{if(event.pointerId===preloadPointer)cancelPreload();});
    window.addEventListener('blur',()=>{if(preloadPointer!==null)cancelPreload();});
    slider.onkeydown=event=>{
      const deltas={ArrowRight:30,ArrowUp:30,ArrowLeft:-30,ArrowDown:-30,PageUp:60,PageDown:-60};
      if(event.key==='Home'||event.key==='End'||event.key in deltas){
        event.preventDefault();slider.value=event.key==='Home'?0:event.key==='End'?300:Math.max(0,Math.min(300,snapPreload()+deltas[event.key]));commitPreload();
      }
    };
    slider.addEventListener('wheel',event=>event.preventDefault(),{passive:false});
    ui.getElementById('parallelPlayback').checked=settings.parallelPlayback;
    ui.getElementById('extras').value=settings.extras.join('\n');
    ui.getElementById('concurrency').value=settings.concurrency;ui.getElementById('memory').value=settings.memory;
    for(const name of ['concurrency','memory'])ui.getElementById(name).onchange=()=>{
      settings[name]=Number(ui.getElementById(name).value);
      try{save();ui.getElementById('saved').textContent='已保存 · 刷新或换视频后继续沿用';}
      catch{ui.getElementById('saved').textContent='本次已生效，但站点存储不可用，未能永久保存';}
      // Do not apply unrelated unsaved CDN edits or interrupt in-flight blocks.
      // A smaller concurrency limit takes effect as current requests finish.
      schedule();
    };
    for(const name of ['region','host','strict'])ui.getElementById(name).onchange=applySettings;
    const extrasField=ui.getElementById('extras');let extrasSaveTimer=0;
    extrasField.oninput=()=>{
      clearTimeout(extrasSaveTimer);
      extrasSaveTimer=setTimeout(()=>{
        const input=extrasField.value.trim().split(/[\s,，;；]+/).filter(Boolean);
        if(input.every(C.host))applySettings();
      },500);
    };
    extrasField.onchange=()=>{clearTimeout(extrasSaveTimer);applySettings();};
    ui.getElementById('parallelPlayback').onchange=()=>{settings.parallelPlayback=ui.getElementById('parallelPlayback').checked;save();schedule();};
    const closePanel=()=>ui.getElementById('panel').classList.remove('open');
    ui.getElementById('badge').onclick=()=>{const panel=ui.getElementById('panel');if(panel.classList.contains('open'))closePanel();else panel.classList.add('open');};
    ui.getElementById('close').onclick=closePanel;
    document.addEventListener('pointerdown',event=>{if(!event.composedPath().includes(container))closePanel();},true);
    document.addEventListener('keydown',event=>{if(event.key==='Escape')closePanel();},true);
    ui.getElementById('toggle').onclick=()=>{settings.enabled=!settings.enabled;save();if(!settings.enabled)for(const job of running.values())job.controller.abort('暂停预取');schedule();};
    ui.getElementById('scan').onclick=()=>scan();
    const syncFullscreen=()=>{closePanel();container.style.display=document.fullscreenElement?'none':'';};
    document.addEventListener('fullscreenchange',syncFullscreen);syncFullscreen();render();
  }
  document.addEventListener('DOMContentLoaded',installUI,{once:true});if(document.body)installUI();
  document.addEventListener('seeking',()=>{seekPending=true;schedule();},true);document.addEventListener('play',schedule,true);document.addEventListener('pause',schedule,true);
  setInterval(()=>{installUI();schedule();},2000);
  schedule();
})();
