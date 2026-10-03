(function(){
  'use strict';
  if(location.hostname!=='live.bilibili.com'||globalThis.__BILI_BUFFER_LIVE__)return;
  globalThis.__BILI_BUFFER_LIVE__=true;
  const L=globalThis.BiliLiveCore,rawFetch=globalThis.fetch.bind(globalThis),NativeXHR=globalThis.XMLHttpRequest;
  const storageKey='bili-buffer-live-v1';let settings;
  try{settings={enabled:true,prefetch:true,direct:true,language:'zh',region:'mainland',...JSON.parse(localStorage.getItem(storageKey)||'{}')};}catch{settings={enabled:true,prefetch:true,direct:true,language:'zh',region:'mainland'};}
  let session=null,latestPlaylist='',room=location.pathname,ui=null,notice='等待直播 HLS 请求',fallbacks=0;
  const tr=(zh,en)=>settings.language==='en'?en:zh;
  const save=()=>{try{localStorage.setItem(storageKey,JSON.stringify(settings));}catch{notice='设置暂未保存';}};
  function reset(){session?.dispose();session=null;latestPlaylist='';fallbacks=0;}
  function checkRoom(){if(room!==location.pathname){room=location.pathname;reset();notice='等待直播 HLS 请求';}}
  const playlist=url=>{const u=L.liveUrl(url);return u&&u.pathname.endsWith('.m3u8');};
  function observePlaylist(url,text,requested){
    if(!settings.enabled||requested!==latestPlaylist)return;
    let parsed;try{parsed=L.parsePlaylist(text,url);}catch{return;}
    if(!parsed){session?.dispose();session=null;notice='当前直播格式未接管，沿用原生播放器';return;}
    const identity=parsed.directory+'|'+new URL(parsed.map).pathname;
    if(!session||session.identity!==identity){session?.dispose();session=new L.LiveSession(rawFetch,url,parsed,{region:settings.region});session.identity=identity;session.room=room;}
    else session.update(parsed);
    notice='直播分片加速已启用';session.prefetchEnabled=settings.prefetch;
    void session.probe(parsed.segments[0].url);session.prefetch();render();
  }
  function responseData(url,data){return {buffer:data.buffer.slice(0),status:200,statusText:'OK',responseURL:url,headers:{'content-type':data.type,'content-length':String(data.buffer.byteLength)}};}
  function suitable(input,options){
    const headers=new Headers(options?.headers||(input instanceof Request?input.headers:undefined));
    return !headers.has('range') && [...headers.keys()].every(h=>h==='accept') && options?.credentials!=='include' && !options?.integrity && options?.mode!=='no-cors' && !(input instanceof Request&&(input.credentials==='include'||input.integrity||input.mode==='no-cors'));
  }
  globalThis.fetch=async function(input,options){
    checkRoom();const url=typeof input==='string'?new URL(input,location.href).href:input instanceof Request?input.url:String(input);
    const method=String(options?.method||(input instanceof Request?input.method:'GET')).toUpperCase();
    if(!settings.enabled||method!=='GET')return rawFetch(input,options);
    if(playlist(url)){
      latestPlaylist=url;
      const response=await rawFetch(input,options);
      if(response.ok)response.clone().text().then(text=>observePlaylist(response.url||url,text,url)).catch(()=>{});
      return response;
    }
    const ctx=session;
    if(ctx?.announced.has(L.key(url))&&suitable(input,options)){
      const signal=options?.signal||(input instanceof Request?input.signal:undefined);
      try{
        const data=await ctx.get(url,{signal});if(ctx!==session)throw new DOMException('Live stream changed','AbortError');
        const cached=responseData(url,data),response=new Response(cached.buffer,{status:200,headers:cached.headers});
        Object.defineProperty(response,'url',{value:url});return response;
      }catch(error){if(signal?.aborted)throw signal.reason||error;if(ctx!==session && (settings.enabled||ctx.room!==location.pathname))throw error;fallbacks++;notice='分片失败，交回原生播放器';}
    }else if(L.liveUrl(url)&&new URL(url).pathname.endsWith('.flv'))notice='FLV 直播沿用原生播放器';
    return rawFetch(input,options);
  };
  // Keep native playlist requests intact; only inspect their successful responses.
  const open=NativeXHR.prototype.open,send=NativeXHR.prototype.send,metadata=new WeakMap();
  NativeXHR.prototype.open=function(method,url,...rest){
    checkRoom();const value=new URL(String(url),location.href).href;
    metadata.set(this,{url:value,observe:settings.enabled&&String(method).toUpperCase()==='GET'&&Boolean(playlist(value))});
    return open.call(this,method,url,...rest);
  };
  NativeXHR.prototype.send=function(body){
    const info=metadata.get(this);if(info?.observe){latestPlaylist=info.url;this.addEventListener('load',()=>{try{if(this.status>=200&&this.status<300&&(this.responseType===''||this.responseType==='text'))observePlaylist(this.responseURL||info.url,this.responseText,info.url);}catch{}},{once:true});}
    return send.call(this,body);
  };
  const Wrapped=globalThis.BiliCdnCachedXHR.createCachedXMLHttpRequest({NativeXHR,resolveWithoutRange:true,
    resolveCachedRequest({url,range,headers,withCredentials,timeout,signal}){
      checkRoom();const ctx=session;
      if(!settings.enabled||!ctx||range||withCredentials||timeout>0||headers.some(([name])=>name.toLowerCase()!=='accept')||!ctx.announced.has(L.key(url)))return null;
      return {pendingResponse:ctx.get(url,{signal}).then(data=>{if(ctx!==session)throw new DOMException('Live stream changed','AbortError');return {cachedResponse:responseData(url,data)};}).catch(error=>{if(!signal?.aborted&&ctx===session){fallbacks++;notice='分片失败，交回原生播放器';}throw error;})};
    }});
  if(Wrapped)globalThis.XMLHttpRequest=Wrapped;

  // Known live P2P SDK entry points. Do not touch WebRTC globally, player controls,
  // chat, or page script loading. Turning this off affects new SDK instances.
  class DirectOnly{on(){return this;}off(){return this;}emit(){return this;}destroy(){}}
  for(const name of ['PCDNLoader','BPP2PSDK','SeederSDK']){
    const descriptor=Object.getOwnPropertyDescriptor(globalThis,name);
    if(descriptor&&(!descriptor.configurable||descriptor.get||descriptor.set))continue;
    let actual=globalThis[name];
    try{Object.defineProperty(globalThis,name,{configurable:true,enumerable:descriptor?.enumerable??true,get(){return settings.enabled&&settings.direct?DirectOnly:actual;},set(value){actual=value;}});}catch{}
  }
  function render(){
    if(!ui)return;
    const s=session?.stats;let ahead=0;
    const video=document.querySelector('video');if(video)for(let i=0;i<video.buffered.length;i++)if(video.buffered.start(i)<=video.currentTime&&video.buffered.end(i)>=video.currentTime)ahead=video.buffered.end(i)-video.currentTime;
    const translations={
      '等待直播 HLS 请求':'Waiting for live HLS requests',
      '当前直播格式未接管，沿用原生播放器':'Unsupported live format; using the native player',
      '直播分片加速已启用':'Live segment acceleration enabled',
      '分片失败，交回原生播放器':'Segment failed; handed back to the native player',
      'FLV 直播沿用原生播放器':'FLV streams use the native player',
      '设置暂未保存':'Settings could not be saved',
      '直播设置已更新，P2P 选项刷新后完全生效':'Live settings saved; reload to fully apply P2P changes'
    };
    ui.getElementById('liveStatus').textContent=settings.enabled?(settings.language==='en'?translations[notice]||notice:notice):tr('直播加速已关闭','Live acceleration off');
    const entries=session?[...session.cache.values()].filter(x=>x.data):[];
    const bytes=entries.reduce((n,x)=>n+x.data.buffer.byteLength,0);
    ui.getElementById('liveStats').textContent=tr(`播放器缓冲 ${ahead.toFixed(1)} 秒\n扩展缓存 ${entries.length} 个分片 / ${(bytes/1048576).toFixed(1)} MB\n累计下载 ${((s?.bytes||0)/1048576).toFixed(1)} MB · 命中 ${s?.hits||0} 次\n备用竞速 ${s?.hedges||0} 次 · 原生回退 ${fallbacks} 次`,
      `Player buffer: ${ahead.toFixed(1)} s\nExtension cache: ${entries.length} segments / ${(bytes/1048576).toFixed(1)} MB\nDownloaded: ${((s?.bytes||0)/1048576).toFixed(1)} MB · Cache hits: ${s?.hits||0}\nBackup attempts: ${s?.hedges||0} · Native fallbacks: ${fallbacks}`);
    ui.getElementById('liveHost').textContent=s?.lastHost||'';
    ui.getElementById('liveError').textContent=globalThis.BiliBufferI18n.translate(s?.error||'',settings.language);
    ui.getElementById('liveLanguage').setAttribute('aria-label',tr('Switch to English','切换为中文'));
  }
  function install(){
    if(ui||!document.body||!/^\/(?:blanc\/)?\d+\/?$/.test(location.pathname))return;
    const host=document.createElement('div');host.id='bili-buffer-live';host.style.cssText='position:fixed;right:18px;bottom:78px;z-index:2147483647';ui=host.attachShadow({mode:'open'});
    ui.innerHTML=`<style>:host{font:13px system-ui;color:#242838}*{box-sizing:border-box}button{border:0;border-radius:9px;padding:8px 10px;background:#f1f2f7;color:#48516a;cursor:pointer;font:inherit}button:focus-visible,input:focus-visible{outline:2px solid #da477b;outline-offset:2px}#livePanel{display:none;width:380px;max-width:calc(100vw - 36px);max-height:78vh;overflow:auto;padding:20px;background:#fcfcff;border:1px solid #e8e8f0;border-radius:20px;box-shadow:0 12px 48px #20243a26;margin-bottom:8px}#livePanel.open{display:block}.heading{display:flex;align-items:center;gap:8px}.heading strong{flex:1;font-size:15px}#liveStatus{background:#fff0f5;color:#9d3659;padding:12px;border-radius:11px}p{line-height:1.65;font-size:12px}#liveStats{white-space:pre-line;background:#f1f4f9;padding:12px;border-radius:11px}label{display:flex;justify-content:space-between;gap:12px;margin:14px 0}input{accent-color:#fb7299}small,#liveHost{color:#697286}#liveHost,#liveError{overflow-wrap:anywhere}#liveError{color:#ad4c2f}#liveBadge{display:block;margin-left:auto;border:1px solid #f6ccdb;color:#b23b66;background:white;border-radius:999px}#liveError:empty,#liveHost:empty{display:none}</style>
      <section id="livePanel" aria-label="直播加速面板"><div class="heading"><strong>Bili CDN &amp; Preload</strong><button id="liveLanguage" data-i18n-skip>EN / 中</button><button id="liveClose" aria-label="收起面板">×</button></div><small>Live · 1.0.9 beta.3</small><p id="liveStatus" data-i18n-skip></p><p id="liveStats" data-i18n-skip></p>
      <label>直播加速<input type="checkbox" id="liveEnabled"></label><label>线路范围<select id="liveRegion"><option value="mainland">大陆优先</option><option value="overseas">海外优先</option><option value="auto">自动（海外＋大陆）</option></select></label><label>预取已生成的直播分片<input type="checkbox" id="livePrefetch"></label><label>优先直连 CDN（避开 P2P）<input type="checkbox" id="liveDirect"></label><p>直播只预取已生成的分片，不会提前下载未来五分钟。FLV、加密及暂未识别的流沿用原生播放器。</p><p id="liveHost"></p><p id="liveError"></p></section><button id="liveBadge">Bili CDN &amp; Preload · Live</button>`;
    document.body.append(host);const localize=globalThis.BiliBufferI18n.attach(ui,()=>settings.language);
    const region=ui.getElementById('liveRegion');region.value=settings.region;region.onchange=()=>{settings.region=region.value;if(session)session.region=settings.region;save();render();};
    for(const [id,key]of [['liveEnabled','enabled'],['livePrefetch','prefetch'],['liveDirect','direct']]){
      const input=ui.getElementById(id);input.checked=settings[key];input.onchange=()=>{settings[key]=input.checked;save();if(key==='enabled'){reset();notice='等待直播 HLS 请求';}if(key==='prefetch'&&session){session.prefetchEnabled=settings.prefetch;if(settings.prefetch)session.prefetch();else session.queue=[];}if(key==='direct')notice='直播设置已更新，P2P 选项刷新后完全生效';render();};
    }
    ui.getElementById('liveLanguage').onclick=()=>{settings.language=settings.language==='en'?'zh':'en';save();render();localize();};
    const close=()=>ui.getElementById('livePanel').classList.remove('open');
    ui.getElementById('liveBadge').onclick=()=>ui.getElementById('livePanel').classList.toggle('open');ui.getElementById('liveClose').onclick=close;
    document.addEventListener('pointerdown',e=>{if(!e.composedPath().includes(host))close();},true);
    document.addEventListener('keydown',e=>{if(e.key==='Escape')close();},true);
    document.addEventListener('fullscreenchange',()=>{close();host.style.display=document.fullscreenElement?'none':'';});render();
  }
  document.addEventListener('DOMContentLoaded',install,{once:true});install();
  setInterval(()=>{checkRoom();install();session?.prune();render();},1000);
  window.addEventListener('pagehide',reset);
})();
