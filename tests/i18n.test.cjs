const {test}=require('node:test');
const assert=require('node:assert/strict');
require('../extension/i18n.js');
const {translate}=globalThis.BiliBufferI18n;
test('Chinese remains unchanged and switching does not alter URLs or units',()=>{
  const source='视频：缓存增长正常 · upos-sz-mirrorcos.bilivideo.com';
  assert.equal(translate(source,'zh'),source);
  assert.equal(translate(source,'en'),'Video: Buffer growing normally · upos-sz-mirrorcos.bilivideo.com');
  assert.equal(translate('1.25 MB/s (10.0 Mbps)','en'),'1.25 MB/s (10.0 Mbps)');
});
test('dynamic progress, duration and scan counts are translated',()=>{
  assert.equal(translate('63% · 连续缓存至 2:00 / 目标 5:00','en'),'63% · Buffered through 2:00 / target 5:00');
  assert.equal(translate('2分17秒','en'),'2 min 17 sec');
  assert.equal(translate('正在下载 6 个请求 · 允许故障回退','en'),'Downloading 6 requests · CDN fallback allowed');
  assert.equal(translate('命中 12 次 / 3.5 MB','en'),'Cache hits: 12 / 3.5 MB');
  const scan='当前视频生成 28 条测速候选（预设 28 条；无法生成当前视频地址的线路不会测速） · 每条最多 128 KiB，小块测速仅供参考';
  assert.doesNotMatch(translate(scan,'en'),/[\u3400-\u9fff]/);
});
test('download and validation errors have English messages',()=>{
  for(const text of ['当前视频候选均失败，稍后有限重试','缓存达到内存上限；随播放释放后继续（可提高上限）','Range 不匹配 / HTTP 403','分块不完整 24/100','音轨或文件长度已变化'])
    assert.doesNotMatch(translate(text,'en'),/[\u3400-\u9fff]/);
});
