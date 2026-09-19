(function () {
  'use strict';
  if (globalThis.__BILI_BUFFER_5MIN__) return;
  globalThis.__BILI_BUFFER_5MIN__=true;
  const C=globalThis.BiliBufferCore, parser=globalThis.BiliCdnCore;
  const rawFetch=globalThis.fetch.bind(globalThis), NativeXHR=globalThis.XMLHttpRequest;
  const key='bili-buffer-five-min-v1';
  const defaults={enabled:true,seconds:300,concurrency:3,memory:1024,preferred:'',strict:false,extras:[]};
  let settings;
  try {settings={...defaults,...JSON.parse(localStorage.getItem(key)||'{}')};} catch {settings={...defaults};}
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
  let status='等待播放器请求音视频', ui, scanning=false, scanController=null;
  const MAX_NATIVE_CACHE=32*1024*1024;
  const activeTracks=()=>[active.audio,active.video].filter(Boolean);
  const memory=()=>activeTracks().reduce((n,t)=>n+t.cache.bytes,0);
  const maxMemory=()=>Math.max(128,Math.min(2048,Number(settings.memory)||1024))*1024*1024;
  const concurrency=()=>Math.max(1,Math.min(6,Number(settings.concurrency)||3));
  function save(){localStorage.setItem(key,JSON.stringify(settings));}
  function video(){return [...document.querySelectorAll('video')].find(v=>v.duration>0) || document.querySelector('video');}
  function reset(){
    scanController?.abort('切换视频');
    generation++; for(const job of running.values())job.controller.abort('切换视频');
    for(const t of activeTracks())t.cache=new C.ByteCache();
    running.clear();active.video=active.audio=null;health.clear();hits=hitBytes=downloaded=lastBytes=0;
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
        if(previous)previous.cache=new C.ByteCache();
        active[t.kind]=t;status='正在建立五分钟缓存';schedule();
      }
      if(activate)t.currentHost=u.hostname;
      return t;
    }catch{return null;}
  }
  function routes(t){
    const values=C.candidates(t.urls,[...C.PRESETS,...settings.extras],settings.preferred,settings.strict);
    return values.sort((a,b)=>{
      const ha=new URL(a).hostname,hb=new URL(b).hostname,sa=health.get(ha),sb=health.get(hb);
      const coolA=(sa?.until||0)>Date.now(),coolB=(sb?.until||0)>Date.now();
      if(coolA!==coolB)return Number(coolA)-Number(coolB);
      if(settings.preferred)return Number(hb===settings.preferred)-Number(ha===settings.preferred);
      return (sb?.mbps||0)-(sa?.mbps||0);
    });
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
    resolveCachedRequest({url,range}){const response=cached(match(url),range);return response?{cachedResponse:response}:null;}});
  if(WrappedXHR)globalThis.XMLHttpRequest=WrappedXHR;
  async function obtain(t,start,end,controller,adaptive=false){
    let last;
    let available=routes(t),probeHost='';
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
    try{for(const url of available.slice(0,settings.strict?1:3)){
      if(controller.signal.aborted)throw new Error('已取消');
      const h=new URL(url).hostname, began=performance.now();
      try{
        const data=await C.readRange(rawFetch,url,start,end,{signal:controller.signal,...(h===probeHost?{idleMs:3000,timeoutMs:6000}:{}),onProgress:n=>{downloaded+=n;}});
        if(adaptive)t.adaptive.record(h,data.buffer.byteLength,performance.now()-began,Date.now());
        health.set(h,{mbps:data.buffer.byteLength*8/(performance.now()-began)/1000,until:0,error:''});
        t.error='';return data;
      }catch(e){
        last=e;if(controller.signal.aborted)throw e;
        t.adaptive.fail(h);
        health.set(h,{mbps:0,until:Date.now()+30000,error:e.message});
        t.error=h+'：'+e.message;
      }
    }}finally{if(probeHost)probeBusy=false;}
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
      t.index=index;t.total=data.total;t.type=data.type;keep(t,r.start,data.buffer);
    }catch(e){t.error=e.message;t.indexRetry=Date.now()+5000;}
    finally{t.indexPending=false;if(running.get(id)?.controller===controller)running.delete(id);schedule();}
  }
  function schedule(){if(!timer)timer=setTimeout(tick,100);}
  function plan(t,v){
    if(!t.index)return null;
    const duration=Number.isFinite(v?.duration)?v.duration:t.index.segments.at(-1).endTime;
    const need=C.windowFor(t.index.segments,Number(v?.currentTime)||0,duration,settings.seconds);
    t.need=need;
    if(need && duration>settings.seconds){
      // Retain a few seconds behind playback, plus initialization and index data.
      const previous=t.index.segments.find(s=>s.endTime>Math.max(0,(v?.currentTime||0)-15));
      const init=t.cache.get(0,Number(t.segmentBase.indexRange.split('-')[1]));
      t.cache.retain(previous?.start||0,need.end+C.BLOCK);
      if(init)t.cache.put(0,init);
    }
    return need;
  }
  function nextJob(t){
    const need=t.need;if(!need)return null;
    for(let start=Math.floor(need.start/C.BLOCK)*C.BLOCK;start<=need.end;start+=C.BLOCK){
      const end=Math.min(start+C.BLOCK-1,t.total-1);
      const id=t.path+'|'+start;
      if(t.cache.covers(start,end)||running.has(id)||(t.failures.get(start)||0)>Date.now())continue;
      const reserved=[...running.values()].reduce((sum,j)=>sum+j.end-j.start+1,0);
      if(memory()+reserved+end-start+1>maxMemory()){status='缓存达到内存上限；随播放释放后继续（可提高上限）';return null;}
      const seg=t.index.segments.find(s=>s.end>=start);
      return {id,track:t,start,end,time:seg?.startTime||0};
    }
    return null;
  }
  function tick(){
    clearTimeout(timer);timer=0;
    if(!settings.enabled){status='预加载已暂停';render();return;}
    const v=video();
    for(const t of activeTracks()){
      if(!t.index && running.size<concurrency())loadIndex(t);
      plan(t,v);
      if(t.need){const s=stats(t);t.adaptive.observe(Date.now(),Math.max(0,s.end-(v?.currentTime||0)),v?.currentTime||0,t.cache.covers(t.need.start,t.need.end));}
    }
    // Cancel obsolete work on a seek, without dropping already cached future bytes.
    for(const job of running.values()){
      const need=job.track.need;
      if(!activeTracks().includes(job.track) || (need && !job.track.indexPending && (job.end<need.start-C.BLOCK || job.start>need.end+C.BLOCK)))job.controller.abort('跳转到新位置');
    }
    while(running.size<concurrency()){
      const jobs=activeTracks().map(nextJob).filter(Boolean).sort((a,b)=>a.time-b.time || (a.track.kind==='audio'?-1:1));
      if(!jobs.length)break;
      const job=jobs[0],g=generation;
      job.controller=new AbortController();running.set(job.id,job);
      obtain(job.track,job.start,job.end,job.controller,true).then(data=>{
        if(g!==generation || !activeTracks().includes(job.track))return;
        job.track.total=data.total;keep(job.track,job.start,data.buffer);job.track.failures.delete(job.start);
      }).catch(e=>{
        if(!job.controller.signal.aborted){job.track.error=e.message;job.track.failures.set(job.start,Date.now()+5000);}
      }).finally(()=>{if(running.get(job.id)===job)running.delete(job.id);schedule();});
    }
    used=memory();
    if(running.size)status=`正在下载 ${running.size} 个请求 · ${settings.strict?'固定线路':'允许故障回退'}`;
    else if(activeTracks().length && activeTracks().every(t=>t.need && t.cache.covers(t.need.start,t.need.end)))status='目标范围已缓存，播放后自动向前补齐';
    else if(activeTracks().some(t=>t.error))status='下载失败会自动重试；可在下方测试或切换线路';
    render();timer=setTimeout(tick,1000);
  }
  function stats(t){
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
  function fmt(n){return `${Math.floor(n/60)}:${String(Math.floor(n%60)).padStart(2,'0')}`;}
  function render(){
    if(!ui)return;
    const now=performance.now();if(now-lastAt>=1000){speed=(downloaded-lastBytes)*8/(now-lastAt)/1000;lastAt=now;lastBytes=downloaded;}
    ui.getElementById('status').textContent=status;
    ui.getElementById('adaptive').textContent=settings.strict?'固定线路：不自动探测':activeTracks().map(t=>`${t.kind==='video'?'视频':'音频'}：${t.adaptive.reason}${t.adaptive.champion?' · '+t.adaptive.champion:''}`).join('\n');
    ui.getElementById('summary').textContent=`预取实时 ${(speed/8).toFixed(2)} MB/s (${speed.toFixed(1)} Mbps)\n缓存 ${(memory()/1048576).toFixed(0)} / ${settings.memory} MB · 播放器命中 ${hits} 次 (${(hitBytes/1048576).toFixed(1)} MB)`;
    for(const kind of ['video','audio']){const s=stats(active[kind]);ui.getElementById(kind+'Text').textContent=s.text;ui.getElementById(kind+'Bar').value=s.percent;}
    ui.getElementById('errors').textContent=activeTracks().filter(t=>t.error).map(t=>`${t.kind==='audio'?'音频':'视频'}：${t.error}`).join('\n');
    ui.getElementById('toggle').textContent=settings.enabled?'暂停预加载':'继续预加载';
    const list=ui.getElementById('host');
    const hosts=[...new Set([...activeTracks().flatMap(t=>t.urls.map(x=>x.host)),...C.PRESETS,...settings.extras,settings.preferred].filter(Boolean))];
    if(list.dataset.values!==hosts.join('|')){const selected=list.dataset.values===undefined?settings.preferred:list.value;list.replaceChildren(...['',...hosts].map(h=>{const o=document.createElement('option');o.value=h;o.textContent=h||'自动选择（无固定首选）';return o;}));list.value=selected;list.dataset.values=hosts.join('|');}
  }
  async function scan(){
    if(scanning){scanController?.abort('停止测速');return;}
    const t=active.video;if(!t?.total){ui.getElementById('results').textContent='请先播放视频，等待分片索引读取完成。';return;}
    scanning=true;scanController=new AbortController();ui.getElementById('scan').textContent='停止测速';ui.getElementById('results').replaceChildren();
    const available=C.candidates(t.urls,[...C.PRESETS,...settings.extras],'',false);
    const g=generation;let i=0;
    async function worker(){
      while(i<available.length && g===generation && !scanController.signal.aborted){
        const url=available[i++],h=new URL(url).hostname;
        const start=Math.min(Math.floor((t.need?.start||0)/C.BLOCK)*C.BLOCK,Math.max(0,t.total-C.BLOCK));
        const row=document.createElement('div');row.className='result';row.textContent=h+' · 测试中';ui.getElementById('results').append(row);
        try{
          const speeds=[];
          const next=t.index?.segments.find(s=>s.startTime>=(t.need?.startTime||0)+60);
          const starts=[start,Math.min(next?.start ?? start+C.BLOCK,Math.max(0,t.total-C.BLOCK))];
          for(const pos of starts){
            const at=performance.now(),end=Math.min(pos+C.BLOCK-1,t.total-1);
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
    for(const t of activeTracks())t.adaptive=new globalThis.BiliAdaptive();
    ui.getElementById('strict').checked=settings.strict;
    if(C.host(h) && !C.PRESETS.includes(h) && !settings.extras.includes(h))settings.extras.push(h);
    settings.concurrency=+ui.getElementById('concurrency').value;settings.memory=+ui.getElementById('memory').value;
    save();for(const job of running.values())job.controller.abort('应用线路设置');
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
      #panel{background:#fcfcff;border:1px solid #e8e8f0;border-radius:20px;padding:20px;width:380px;box-shadow:0 12px 48px #20243a26;max-height:78vh;scrollbar-width:thin}
      .heading{display:flex;align-items:center;gap:10px;margin-bottom:15px}.mark{display:grid;place-items:center;width:38px;height:38px;border-radius:12px;background:#fb7299;color:white;font-size:23px}.heading h3{margin:0;font-size:16px}.heading small{font-size:11px;color:#777d90}.heading #close{margin-left:auto;padding:4px 9px;font-size:20px;background:#f0f1f5;color:#656b7b}
      #status{background:#fff0f5;color:#9d3659;padding:11px 13px;border-radius:11px;font-weight:600;font-size:12px}
      .muted{color:#697286;font-size:11px}p{line-height:1.65;margin:10px 0}progress{height:8px;border:0;border-radius:8px;overflow:hidden;background:#edf0f4;accent-color:#fb7299}progress::-webkit-progress-bar{background:#edf0f4}progress::-webkit-progress-value{background:linear-gradient(90deg,#fb7299,#e45591);border-radius:8px}
      button{border:0;background:#f1f2f7;color:#48516a;border-radius:9px;font-weight:600;font-size:12px;padding:9px 11px}button:hover{background:#e8eaf2}button:focus-visible,select:focus-visible,textarea:focus-visible{outline:2px solid #da477b;outline-offset:2px}
      #badge{display:block;margin-left:auto;background:#fff;color:#b23b66;border:1px solid #f6ccdb;border-radius:999px;padding:10px 16px;box-shadow:0 4px 18px #23263a1c}#toggle,#apply{background:#fb7299;color:white}#toggle:hover,#apply:hover{background:#ec608a}
      #summary{background:#f1f4f9;color:#46536b;padding:12px;border-radius:11px;font-variant-numeric:tabular-nums;line-height:1.9}.actions{gap:6px}details{border-color:#e8eaf0;margin-top:15px}summary{color:#505c72;font-weight:600;padding:4px 0}select,textarea{background:#fff;color:#374159;border:1px solid #dce1ea;border-radius:8px}textarea{resize:vertical}label{color:#626d80;font-size:12px}#errors{color:#ad4c2f}.result{border-color:#e8eaf0;color:#58647a}
    </style>
    <section id="panel" aria-label="五分钟缓存控制面板"><div class="heading"><span class="mark">↓</span><div><h3>Bili CDN &amp; Preload</h3><small>Adaptive CDN &amp; Video Caching · 1.0.6</small></div><button id="close" aria-label="收起面板">×</button></div><p id="status"></p><p class="muted">短视频整段缓存 · 长视频提前 5 分钟<br>暂停播放，也会继续预加载。</p>
    <p>视频 <span id="videoText" class="muted"></span></p><progress id="videoBar" max="100" value="0"></progress>
    <p>音频 <span id="audioText" class="muted"></span></p><progress id="audioBar" max="100" value="0"></progress>
    <p id="summary" class="muted"></p><div class="actions"><button id="toggle">暂停预加载</button><button id="scan">测试各线路</button></div>
    <p id="adaptive" class="muted" style="overflow-wrap:anywhere;white-space:pre-line"></p>
    <details><summary>下载与线路设置</summary><label>首选 CDN</label><select id="host" style="width:100%;margin-top:7px"></select>
    <label><span>只使用指定线路</span><input id="strict" type="checkbox"></label>
    <label>并行下载数<select id="concurrency"><option>1</option><option>2</option><option>3</option><option>4</option><option>6</option></select></label>
    <label>缓存内存上限<select id="memory"><option value="256">256 MB</option><option value="512">512 MB</option><option value="1024">1 GB</option><option value="2048">2 GB</option></select></label>
    <p class="muted" id="saved" aria-live="polite">并行数与内存上限选完即保存，下次自动沿用。</p>
    <label>批量自定义 CDN（每行一个）</label><textarea id="extras" placeholder="cn-hk-eq-01-04.bilivideo.com"></textarea>
    <div class="actions"><button id="apply">应用设置</button></div>
    <p class="muted">内置 13 个香港 EQ 与 2 个旧 bcache 域名，实际可用性以测试为准。测速是两处完整小块的抽样，不能当作持续速度。上方实时速度仅统计预取下载；预取完成后变为 0 属正常。</p>
    <p class="muted">原生播放器灰条只反映已送入播放器的数据，请看上方真实缓存进度与播放器命中计数。</p></details>
    <p id="errors"></p><div id="results"></div></section><button id="badge">Bili CDN &amp; Preload</button>`;
    document.body.append(container);
    ui.getElementById('host').value=settings.preferred;ui.getElementById('strict').checked=settings.strict;
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
    ui.getElementById('badge').onclick=()=>ui.getElementById('panel').classList.toggle('open');
    const closePanel=()=>ui.getElementById('panel').classList.remove('open');
    ui.getElementById('close').onclick=closePanel;
    document.addEventListener('pointerdown',event=>{if(!event.composedPath().includes(container))closePanel();},true);
    document.addEventListener('keydown',event=>{if(event.key==='Escape')closePanel();},true);
    ui.getElementById('toggle').onclick=()=>{settings.enabled=!settings.enabled;save();if(!settings.enabled)for(const job of running.values())job.controller.abort('暂停预取');schedule();};
    ui.getElementById('apply').onclick=applySettings;ui.getElementById('scan').onclick=()=>scan();
    const syncFullscreen=()=>{closePanel();container.style.display=document.fullscreenElement?'none':'';};
    document.addEventListener('fullscreenchange',syncFullscreen);syncFullscreen();render();
  }
  document.addEventListener('DOMContentLoaded',installUI,{once:true});if(document.body)installUI();
  document.addEventListener('seeking',schedule,true);document.addEventListener('play',schedule,true);document.addEventListener('pause',schedule,true);
  setInterval(()=>{installUI();schedule();},2000);
  schedule();
})();
