(function(root){
  'use strict';
  // Candidate fMP4 hosts documented by Bilibili-thread-ripper. They must pass
  // a probe for this stream; VOD CDN presets are deliberately not reused.
  const HOSTS=['d1--cn-gotcha204.bilivideo.com','d1--cn-gotcha208.bilivideo.com','d1--ov-gotcha208.bilivideo.com','d1--ov-gotcha208b.bilivideo.com'];
  function liveUrl(value){
    try{const u=new URL(value);return u.protocol==='https:' && !u.username && !u.password && !u.port && /(?:^|\.)bilivideo\.(com|cn|net)$/.test(u.hostname) && u.pathname.includes('/live-bvc/')?u:null;}catch{return null;}
  }
  const key=value=>{const u=liveUrl(value);return u?u.pathname+u.search:'';};
  const swap=(value,host)=>{const u=new URL(value);u.hostname=host;return u.href;};
  function mediaAddress(uri,playlist){
    const base=new URL(playlist),url=new URL(uri,base);
    // Bilibili's player carries the playlist signature to bare relative segments.
    // Explicit segment queries (including an explicit empty query) remain intact.
    if(!/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(uri)&&!uri.includes('?')&&url.origin===base.origin)url.search=base.search;
    return url.href;
  }
  function parsePlaylist(text,url){
    if(!liveUrl(url) || !String(text).trimStart().startsWith('#EXTM3U'))return null;
    // Pass through encrypted, partial, byte-range, master and TS playlists.
    if(/#EXT-X-(?:STREAM-INF|KEY|SESSION-KEY|BYTERANGE|PART:|I-FRAMES-ONLY)/.test(text))return null;
    let map='',duration=0,sequence=0;const segments=[];
    for(const raw of String(text).split(/\r?\n/)){
      const line=raw.trim();
      if(line.startsWith('#EXT-X-MAP:')){if(/BYTERANGE=/.test(line))return null;const uri=/URI="([^"]+)"/.exec(line)?.[1];if(!uri)return null;map=mediaAddress(uri,url);}
      else if(line.startsWith('#EXT-X-MEDIA-SEQUENCE:'))sequence=Number(line.split(':')[1]);
      else if(line.startsWith('#EXTINF:'))duration=Number(line.slice(8).split(',')[0]);
      else if(line && !line.startsWith('#')){
        const segment=mediaAddress(line,url);
        if(!liveUrl(segment)||!new URL(segment).pathname.endsWith('.m4s')||!Number.isFinite(duration)||duration<=0)return null;
        segments.push({url:segment,duration,sequence:sequence++});duration=0;
      }
    }
    if(!map||!liveUrl(map)||!segments.length||segments.length>128)return null;
    const directory=new URL(url).pathname.replace(/[^/]+$/,'');
    if([map,...segments.map(s=>s.url)].some(s=>new URL(s).pathname.replace(/[^/]+$/,'')!==directory))return null;
    return {map,segments,directory};
  }
  function mp4(bytes){return bytes.byteLength>=8 && ['ftyp','styp','moof','sidx','moov'].includes(String.fromCharCode(...new Uint8Array(bytes,4,4)));}
  function cancelled(signal){if(signal?.aborted)throw signal.reason||new DOMException('Cancelled','AbortError');}
  function waitFor(promise,signal){
    if(!signal)return promise;
    return new Promise((resolve,reject)=>{
      const abort=()=>reject(signal.reason||new DOMException('Cancelled','AbortError'));
      if(signal.aborted){abort();return;}
      signal.addEventListener('abort',abort,{once:true});
      promise.then(resolve,reject).finally(()=>signal.removeEventListener('abort',abort));
    });
  }
  class LiveSession{
    constructor(fetcher,playlist,parsed,{candidates=HOSTS,region='mainland',hedgeMs=450,timeoutMs=7000,idleMs=2500,onChange=()=>{}}={}){
      this.fetcher=fetcher;this.playlist=playlist;this.directory=parsed.directory;this.map=parsed.map;
      this.controller=new AbortController();this.gate=new root.BiliBufferCore.RequestGate(()=>4);
      this.cache=new Map();this.hosts=new Map();this.queue=[];this.prefetching=0;this.prefetchEnabled=true;
      this.hedgeMs=hedgeMs;this.timeoutMs=timeoutMs;this.idleMs=idleMs;this.onChange=onChange;this.region=region;
      this.stats={bytes:0,hits:0,hitBytes:0,hedges:0,failed:0,active:0,lastHost:'',error:''};
      this.origin=new URL(playlist).hostname;this.hosts.set(this.origin,{proven:true,failures:0,ms:Infinity});
      // The same live host family may expose a mainland sibling. Treat it only
      // as a candidate: its signature/range probe must succeed before selection.
      if(candidates===HOSTS && /^d\d+--ov-gotcha\d+[a-z]?\.bilivideo\.com$/.test(this.origin))candidates=[this.origin.replace('--ov-','--cn-'),...candidates];
      for(const host of candidates)if(host!==this.origin && liveUrl(`https://${host}/live-bvc/x.m4s`))this.hosts.set(host,{proven:false,failures:0,ms:Infinity});
      this.update(parsed);this.probing=false;
    }
    dispose(){this.controller.abort(new DOMException('Live stream changed','AbortError'));this.queue=[];this.cache.clear();}
    update(parsed){this.announced=new Map([parsed.map,...parsed.segments.map(s=>s.url)].map(u=>[key(u),u]));this.segments=parsed.segments;this.prune();}
    prune(){
      let bytes=0;const now=Date.now();
      for(const [k,item]of this.cache){if(item.data && k!==key(this.map) && (now-item.at>30000 || !this.announced.has(k)))this.cache.delete(k);else bytes+=item.data?.buffer.byteLength||0;}
      for(const [k,item]of this.cache){if(this.cache.size<=32 && bytes<=64*1024*1024)break;if(item.data && k!==key(this.map)){bytes-=item.data.buffer.byteLength;this.cache.delete(k);}}
    }
    async read(url,signal,probe=false){
      const controller=new AbortController(),relay=()=>controller.abort(signal.reason);
      signal.addEventListener('abort',relay,{once:true});if(signal.aborted)relay();
      let idle,reader,total=0;const chunks=[];
      const touch=()=>{clearTimeout(idle);idle=setTimeout(()=>controller.abort(new Error('直播分片无数据')),this.idleMs);};
      const hard=setTimeout(()=>controller.abort(new Error('直播分片超时')),this.timeoutMs);touch();
      this.stats.active++;this.onChange();
      try{
        cancelled(controller.signal);
        const response=await this.fetcher(url,{signal:controller.signal,credentials:'omit',cache:'no-store',headers:probe?{Range:'bytes=0-2047'}:{}});
        const range=/^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get('content-range')||'');
        const declared=Number(response.headers.get('content-length'));
        if((response.status!==200&&response.status!==206) || (response.status===206&&(!range||+range[1]!==0||(!probe&&+range[2]+1!==+range[3]))) || (probe&&(response.status!==206||+range[2]!==2047))){await response.body?.cancel();throw new Error(`HTTP ${response.status} / 直播分片范围不匹配`);}
        if(declared>8*1024*1024){await response.body?.cancel();throw new Error('直播分片超过大小限制');}
        reader=response.body?.getReader();if(!reader)throw new Error('直播分片为空');
        const stop=()=>{void reader.cancel().catch(()=>{});};controller.signal.addEventListener('abort',stop,{once:true});
        if(controller.signal.aborted)stop();
        try{
          while(true){const {done,value}=await reader.read();cancelled(controller.signal);if(done)break;touch();total+=value.byteLength;this.stats.bytes+=value.byteLength;if(total>(probe?2048:8*1024*1024))throw new Error('直播分片超过大小限制');chunks.push(value);}
        }finally{controller.signal.removeEventListener('abort',stop);}
        if(!total || (declared>0&&total!==declared) || (range&&total!==+range[2]+1))throw new Error('直播分片不完整');
        const output=new Uint8Array(total);let offset=0;for(const chunk of chunks){output.set(chunk,offset);offset+=chunk.byteLength;}
        if(!mp4(output.buffer))throw new Error('直播分片格式不支持');
        return {buffer:output.buffer,type:response.headers.get('content-type')||'video/mp4'};
      }finally{clearTimeout(idle);clearTimeout(hard);signal.removeEventListener('abort',relay);try{await reader?.cancel();}catch{}this.stats.active--;this.onChange();}
    }
    async probe(sample){
      if(this.probing)return;this.probing=true;
      // Small, sequential signature/availability checks, not full-copy races.
      for(const [host,state]of this.hosts){
        if(state.proven||state.failures>=2||this.controller.signal.aborted)continue;
        const began=performance.now();
        try{await this.gate.run(()=>this.read(swap(sample,host),this.controller.signal,true),this.controller.signal,{kind:'prefetch'});state.proven=true;state.ms=performance.now()-began;}
        catch{if(!this.controller.signal.aborted)state.failures=2;}
      }
    }
    async download(url,priority){
      const rank=host=>this.region==='mainland'?(host.includes('--cn-')?0:1):this.region==='overseas'?(host.includes('--ov-')?0:1):0;
      const hosts=[...this.hosts].filter(([,s])=>s.proven&&s.failures<2).sort((a,b)=>rank(a[0])-rank(b[0])||a[1].ms-b[1].ms).slice(0,2);
      if(!hosts.length)throw new Error('当前直播没有可用 CDN');
      const controllers=hosts.map(()=>new AbortController());
      const abort=()=>controllers.forEach(c=>c.abort(this.controller.signal.reason));
      this.controller.signal.addEventListener('abort',abort,{once:true});
      if(this.controller.signal.aborted)abort();
      let failedFirst;const firstFailure=new Promise(resolve=>{failedFirst=resolve;});let hedgeTimer;
      const attempts=hosts.map(async([host,state],index)=>{
        if(index){await Promise.race([firstFailure,new Promise(resolve=>{hedgeTimer=setTimeout(resolve,this.hedgeMs);})]);cancelled(controllers[index].signal);this.stats.hedges++;}
        const began=performance.now();
        try{
          const result=await this.gate.run(()=>this.read(swap(url,host),controllers[index].signal),controllers[index].signal,priority);
          state.ms=Number.isFinite(state.ms)?state.ms*0.7+(performance.now()-began)*0.3:performance.now()-began;
          state.failures=0;this.stats.lastHost=host;return result;
        }catch(e){if(!controllers[index].signal.aborted){state.failures++;this.stats.failed++;}if(!index)failedFirst();throw e;}
      });
      try{return await Promise.any(attempts);}catch(error){throw error.errors?.at(-1)||error;}
      finally{clearTimeout(hedgeTimer);failedFirst();controllers.forEach(c=>c.abort(new DOMException('Duplicate stopped','AbortError')));this.controller.signal.removeEventListener('abort',abort);}
    }
    get(url,{signal,prefetch=false}={}){
      const k=key(url);if(!this.announced.has(k))return Promise.reject(new Error('直播分片不在当前列表中'));
      cancelled(this.controller.signal);cancelled(signal);
      let item=this.cache.get(k);const existed=Boolean(item);
      if(!item){
        item={at:Date.now(),priority:{kind:prefetch?'prefetch':'playback'},data:null};this.cache.set(k,item);
        item.promise=this.download(this.announced.get(k),item.priority).then(data=>{item.data=data;this.prune();this.stats.error='';return data;}).catch(error=>{if(this.cache.get(k)===item)this.cache.delete(k);if(!this.controller.signal.aborted)this.stats.error=String(error.message||error);throw error;});
      }else if(!prefetch)item.priority.kind='playback';
      return waitFor(item.promise,signal).then(data=>{if(!prefetch&&existed){this.stats.hits++;this.stats.hitBytes+=data.buffer.byteLength;}return data;});
    }
    prefetch(){
      if(!this.prefetchEnabled)return;
      // Target about 8 seconds, aligned to whole announced segments; never guess future URLs.
      let seconds=0;const tail=[];for(const s of [...this.segments].reverse()){if(seconds>=8)break;tail.unshift(s.url);seconds+=s.duration;}
      this.queue=[this.map,...tail].filter(url=>!this.cache.has(key(url)));
      this.pump();
    }
    pump(){
      while(this.prefetchEnabled&&!this.controller.signal.aborted&&this.prefetching<2&&this.queue.length){
        const url=this.queue.shift();if(!this.announced.has(key(url))||this.cache.has(key(url)))continue;
        this.prefetching++;this.get(url,{prefetch:true}).catch(()=>{}).finally(()=>{this.prefetching--;this.pump();this.onChange();});
      }
    }
  }
  root.BiliLiveCore={HOSTS,liveUrl,key,swap,parsePlaylist,mp4,waitFor,LiveSession};
})(globalThis);
