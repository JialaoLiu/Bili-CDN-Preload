(function (root) {
  'use strict';
  const BLOCK = 1024 * 1024;
  const PRESETS = [
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
    'cn-hk-eq-bcache-03.bilivideo.com',
    'upos-sz-mirrorcos.bilivideo.com',
    'upos-sz-mirrorali.bilivideo.com',
    'upos-sz-mirrorhw.bilivideo.com',
    'upos-tf-all-tx.bilivideo.com',
    'upos-tf-all-hw.bilivideo.com'
  ];
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
  async function readRange(fetcher,url,start,end,{signal,idleMs=10000,timeoutMs=120000,onProgress}={}) {
    const controller = new AbortController();
    const abort = () => controller.abort(signal?.reason);
    if (signal?.aborted) abort(); else signal?.addEventListener('abort',abort,{once:true});
    let idle;
    const touch = () => { clearTimeout(idle); idle=setTimeout(() => controller.abort('连续无数据'),idleMs); };
    const hard=setTimeout(() => controller.abort('请求超时'),timeoutMs);
    touch();
    try {
      const response=await fetcher(url,{headers:{Range:`bytes=${start}-${end}`},credentials:'omit',cache:'no-store',signal:controller.signal});
      const m=/^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get('content-range') || '');
      if (response.status!==206 || !m || +m[1]!==start || +m[2]!==end || +m[3]<=end) {
        try { await response.body?.cancel(); } catch {}
        throw new Error(`Range 不匹配 / HTTP ${response.status}`);
      }
      const buffer=new Uint8Array(end-start+1);
      const reader=response.body.getReader();
      let count=0;
      try {
        while (true) {
          const {done,value}=await reader.read();
          if (done) break;
          touch();
          if (count+value.byteLength>buffer.length) throw new Error('返回数据超过 Range');
          buffer.set(value,count); count+=value.byteLength; onProgress?.(value.byteLength);
        }
      } finally { try { await reader.cancel(); } catch {} reader.releaseLock(); }
      if (count!==buffer.length) throw new Error(`分块不完整 ${count}/${buffer.length}`);
      return {buffer:buffer.buffer,total:+m[3],type:response.headers.get('content-type') || 'video/mp4'};
    } finally {clearTimeout(idle);clearTimeout(hard);signal?.removeEventListener('abort',abort);}
  }
  root.BiliBufferCore={BLOCK,PRESETS,host,candidates,range,windowFor,ByteCache,readRange};
})(globalThis);
