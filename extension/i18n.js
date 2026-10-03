(function(root){
  'use strict';
  // Presentation only: canonical status/errors stay unchanged in the downloader.
  const messages={
    '当前视频轨道':'Active video track',
    'HDR 真彩':'HDR',
    '直播加速面板':'Live acceleration controls',
    '直播加速':'Live acceleration',
    '预取已生成的直播分片':'Prefetch available live segments',
    '优先直连 CDN（避开 P2P）':'Prefer direct CDN (avoid P2P)',
    '直播只预取已生成的分片，不会提前下载未来五分钟。FLV、加密及暂未识别的流沿用原生播放器。':'Only already-produced segments are prefetched, not five minutes of future live video. FLV, encrypted and unrecognized streams stay with the native player.',
    '直播分片无数据':'No incoming live segment data',
    '直播分片超时':'Live segment timed out',
    '直播分片范围不匹配':'Live segment range mismatch',
    '直播分片超过大小限制':'Live segment exceeds size limit',
    '直播分片为空':'Empty live segment',
    '直播分片不完整':'Incomplete live segment',
    '直播分片格式不支持':'Unsupported live segment format',
    '当前直播没有可用 CDN':'No available CDN for this live stream',
    '直播分片不在当前列表中':'Segment is not in the current live playlist',
    '五分钟缓存控制面板':'Preload controls',
    '收起面板':'Close panel',
    '提前预加载':'Preload ahead',
    'B 站默认':'Bilibili default',
    '5 分钟':'5 min',
    '松手吸附到最近的 30 秒档位；最左侧沿用 B 站自身缓冲。':'Release to snap to 30-second steps. Far left uses Bilibili’s own buffering.',
    '下载与线路设置':'Download & CDN settings',
    '线路范围':'CDN region',
    '自动（海外＋大陆）':'Auto (overseas + mainland)',
    '海外优先':'Overseas first',
    '大陆优先':'Mainland first',
    '首选 CDN':'Preferred CDN',
    '自动选择（无固定首选）':'Auto (no preferred CDN)',
    '仅用首选 CDN（失败不换线）':'Use preferred CDN only (no fallback)',
    '总下载并发上限':'Concurrent transfer limit',
    '播放优先、预取保留名额；空闲名额可借用，共享数据不重复下载。':'Playback gets priority; prefetch keeps capacity. Idle slots and overlapping data are shared.',
    '播放请求并行下载（可选）':'Parallel playback requests (optional)',
    '浏览器临时缓存，不会预占上限或离线保存':'In-browser cache; memory is allocated as needed. Not a full offline download.',
    '预缓存内存上限':'Cache memory limit',
    '额外 CDN 候选（每行一个）':'Extra CDN hosts (one per line)',
    '暂停预加载':'Pause preload',
    '继续预加载':'Resume preload',
    '测试各线路':'Test CDNs',
    '停止测速':'Stop testing',
    '请先播放视频，等待分片索引读取完成。':'Start playback and wait for the segment index to load.',
    '每条最多 128 KiB，小块测速仅供参考':'Up to 128 KiB per CDN; small-sample speeds are estimates only',
    '测试中':'Testing',
    '两处抽样':'Two sample speeds',
    '不可用 / 超时':'Unavailable / timed out',
    '使用':'Use',
    '等待播放器请求音视频':'Waiting for media requests',
    '等待新视频':'Waiting for a new video',
    '正在建立五分钟缓存':'Building the preload buffer',
    '读取播放信息失败':'Could not read playback information',
    '目标范围已缓存，播放后自动向前补齐':'Target cached; extends automatically as playback advances',
    '下载失败会自动重试；可在下方测试或切换线路':'Downloads will retry; test or select another CDN below',
    '额外预加载已关闭 · 沿用 B 站自身缓冲':'Extra preloading is off · Using Bilibili’s own buffering',
    '沿用 B 站自身缓冲':'Using Bilibili’s own buffering',
    '读取分片索引…':'Reading segment index…',
    '等待实际音轨请求':'Waiting for the player’s media request',
    '缓存达到内存上限；随播放释放后继续（可提高上限）':'Cache memory limit reached; resumes as playback frees space',
    '预加载已暂停':'Preloading paused',
    '固定线路：不自动探测':'Fixed CDN: automatic probing off',
    '固定线路':'Fixed CDN',
    '允许故障回退':'CDN fallback allowed',
    '观察缓存增长':'Monitoring buffer growth',
    '目标缓存已完成':'Preload target reached',
    '缓存余量或增长不足，提前探测':'Buffer is low or growing slowly; probing alternatives',
    '缓存增长正常':'Buffer growing normally',
    '连续分片表现更好，已调整线路':'Switched CDN after consistently faster transfers',
    '请填写 bilivideo.com 下的 HTTPS 域名，不要填 IP、路径或代理订阅链接。':'Enter an HTTPS hostname under bilivideo.com, not an IP, path or proxy subscription URL.',
    '批量列表中有无效域名；每行填写一个 bilivideo.com 下的域名。':'Invalid extra CDN. Enter one hostname under bilivideo.com per line.',
    '已保存 · 刷新或换视频后继续沿用':'Saved · Kept after reloads and across videos',
    '本次已生效，但站点存储不可用，未能永久保存':'Applied for now; site storage is unavailable, so settings were not saved',
    '本次已生效，但无法保存设置':'Applied for now, but settings could not be saved',
    '音轨或文件长度已变化':'Media track or file size changed',
    '没有可用 CDN':'No available CDN',
    '当前视频候选均失败，稍后有限重试':'All CDNs failed for this video; limited retries will follow',
    '当前轨道无可用候选；固定线路无法生成此视频地址':'No candidate for this track; the fixed CDN cannot serve this URL',
    '临近播放的数据块过慢，接力备用线路':'An imminent block is too slow; handing off to a backup CDN',
    '所有候选线路失败':'All candidate CDNs failed',
    '此轨道没有 DASH sidx 索引，无法按时间预取':'No DASH sidx index; time-based prefetch is unavailable',
    '无法解析 sidx':'Could not parse sidx',
    '连续无数据':'No incoming data',
    '请求超时':'Request timed out',
    'Range 不匹配':'Range mismatch',
    '返回数据超过 Range':'Response exceeds the requested range',
    '分块不完整':'Incomplete block',
    '续传范围不匹配':'Resume range mismatch',
    '共享分块长度不匹配':'Shared block length mismatch',
    '无剩余使用者':'No remaining consumers',
    '无效媒体范围':'Invalid media range',
    '多路下载超时':'Parallel download timed out',
    '分块校验失败':'Block validation failed',
    '没有可用线路':'No available CDN',
    '不同线路返回的文件长度不一致':'CDNs returned different file sizes',
    '请求结束':'Request finished',
    '已取消':'Cancelled',
    '切换视频':'Video changed',
    '切换音轨或画质':'Track or quality changed',
    '跳转到新位置':'Playback position changed',
    '应用线路设置':'CDN settings changed',
    '暂停预取':'Prefetch paused',
    '连续缓存至':'Buffered through',
    '目标':'target',
    '预缓存已启用':'Preloading enabled',
    '预缓存已暂停':'Preloading paused',
    '播放请求并行':'Parallel playback',
    '未勾选（预缓存不受影响）':'Off (prefetch is unaffected)',
    '已勾选':'On',
    '处理中':'Active',
    '成功':'Completed',
    '回退':'Fallbacks',
    '缓存':'Cache',
    '视频':'Video',
    '音频':'Audio'
  };
  const ordered=Object.entries(messages).sort((a,b)=>b[0].length-a[0].length);
  function translate(text,language){
    if(language!=='en')return text;
    let result=String(text)
      .replace(/正在下载 (\d+) 个请求/g,'Downloading $1 requests')
      .replace(/命中 (\d+) 次/g,'Cache hits: $1')
      .replace(/当前视频生成 (\d+) 条测速候选（预设 (\d+) 条；无法生成当前视频地址的线路不会测速）/g,'$1 test candidates for this video ($2 presets; unsupported URLs are skipped)')
      .replace(/(\d+)分(?:(\d+)秒)?/g,(_,m,s)=>`${m} min${s?' '+s+' sec':''}`);
    for(const [from,to] of ordered)result=result.split(from).join(to);
    return result.replace(/：/g,': ');
  }
  function attach(shadow,getLanguage){
    const texts=new WeakMap(),attributes=new WeakMap();
    function update(){
      const language=getLanguage();
      shadow.host.lang=language==='en'?'en':'zh-CN';
      const walker=document.createTreeWalker(shadow,NodeFilter.SHOW_TEXT);
      while(walker.nextNode()){
        const node=walker.currentNode;
        if(node.parentElement?.closest('style,script,textarea,[data-i18n-skip]'))continue;
        let item=texts.get(node);
        if(!item||node.nodeValue!==item.last)item={source:node.nodeValue};
        item.last=translate(item.source,language);texts.set(node,item);
        if(node.nodeValue!==item.last)node.nodeValue=item.last;
      }
      for(const element of shadow.querySelectorAll('[title],[aria-label],[aria-valuetext],[placeholder]')){
        if(element.closest('[data-i18n-skip]'))continue;
        let items=attributes.get(element);if(!items){items={};attributes.set(element,items);}
        for(const name of ['title','aria-label','aria-valuetext','placeholder']){
          if(!element.hasAttribute(name))continue;
          const current=element.getAttribute(name);let item=items[name];
          if(!item||current!==item.last)item={source:current};
          item.last=translate(item.source,language);items[name]=item;
          if(current!==item.last)element.setAttribute(name,item.last);
        }
      }
    }
    // Observe only our shadow tree. Do not translate the site or rebuild controls.
    const observer=new MutationObserver(update);
    observer.observe(shadow,{subtree:true,childList:true,characterData:true,attributes:true,attributeFilter:['title','aria-label','aria-valuetext','placeholder']});
    update();return update;
  }
  root.BiliBufferI18n={translate,attach};
})(globalThis);
