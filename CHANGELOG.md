# v1.0.9 beta.3 (source trial, not released)

- Total VOD transfer concurrency choices are now 3 / 6 / 8 / 12, default 6; remove the old six-transfer runtime clamp. Existing 3/6/8/12 choices are preserved; removed 1/2/4 choices become 6. Parallel playback remains enabled by default, with automatic preference saving.
- Windows Edge live checks confirmed cache hits in a room with 2–3 viewers, but buffer depth and duplicate requests still need improvement. After the user enabled HDR output, both supplied VOD samples selected HDR/HEVC and produced cache hits; the low-view long-video sample showed about 3.4–5.0 MB/s during one 30-second capture with no failed requests or HTTP 429. Higher concurrency performance has not yet been measured.

- External Edge inspection of live room 1890519304 found bare relative playlist URLs while player requests inherited the playlist signature, causing zero cache hits. Relative segment/init URLs now inherit that query; explicit queries remain unchanged. Added signed-playlist browser regression.
- Default to mainland-first and enable parallel playback with a one-time settings migration; later changes remain saved. Live selection also prefers validated mainland hosts, with original-node fallback when mainland candidates cannot serve the signed stream.
- Reset a track's shared cache pool with its cache when switching qualities. Display the active video quality/codec, including HDR/HEVC. HDR metadata/byte-path tests do not validate HDR display output: the external Edge sample exposed a server HDR track but reported no active HDR display and selected ordinary 4K.

- Add a separate live.bilibili.com module for recognized, unencrypted fMP4 HLS playlists. Prefetch only already-announced segments (roughly eight seconds, segment-aligned), share Fetch/XHR cache entries, and cap transfers at four with two background prefetch jobs. A delayed request may use one backup copy; cancel the loser.
- Probe live-specific CDN candidates with 2 KiB samples before use. Repeated failures exclude a CDN for the current stream; failed acceleration falls back to the original request. VOD CDN presets are not used for live media.
- Optional direct-CDN preference suppresses known live P2P SDK entry points. Separate live enable/prefetch/direct settings and bilingual panel; FLV, encrypted, byte-range and unrecognized formats stay native. Worker-only requests are not intercepted.
- 38 unit tests and mocked live/HDR browser integrations passed. Current live/HDR changes have no fresh macOS validation. The live design and candidate hosts were informed by Bilibili-thread-ripper (cf4b2047aaba5103380d33e59854977900d0bef9); implementation is separate.

# v1.0.8 beta (prerelease)

- beta.7: English / Simplified Chinese panel with an autosaved **EN / 中** switch. Translates settings, live status, scan results, validation messages and accessibility labels without restarting downloads. Bilingual release notes and installation instructions.
- beta.7：新增 **EN / 中** 切换，语言自动保存；设置、实时状态、测速结果、错误提示与无障碍标签支持中英双语，切换不重启下载；补充双语发布与安装说明。

- beta.6: preload duration changes no longer abort in-flight work or evict downloaded future bytes; range-based cancellation now requires an actual seek. Disabling preload stops new scheduling while existing chunks finish. Regression checks shrink, disable and expand without re-downloading cached data.
- beta.5: continuous preload slider movement with nearest-30-second snapping on release; dragging only previews, without saving settings or cancelling downloads. Unchanged values do not restart work; arrow keys move one full step.
- beta.4: add an autosaved 0–300 second preload slider (30-second steps, default 300); zero disables proactive fetching but retains native/player-request downloads. Split playback/prefetch scheduling with a shared concurrency ceiling and lend idle slots; use 512 KiB pieces. Fresh installs default to six transfers; existing user concurrency settings are preserved. Two consecutive CDN failures quarantine that host for the current video session; cancellation is excluded, and all-host failure allows one recovery attempt per minute. Strict-host mode remains strict.
- beta.3: include sub-256-KiB player ranges in the shared queue. Live beta.2 testing of BV1Ysht6UEXe exposed audio-sized requests bypassing deduplication; the new simulated Fetch/XHR overlap test also includes a 100,000-byte request. beta.3 live verification remains pending extension reload.
- beta.2: share in-flight byte intervals between prefetch and parallel Fetch/XHR; reuse cached subranges, preserve completed pieces immediately, and share one bounded transfer queue. Cancelling one consumer does not cancel another consumer's shared download.
- Reduce manual scan samples from 2 MiB to at most 128 KiB per CDN. These are small-sample estimates, not sustained-speed guarantees.
- Resume validated partial Range bodies across CDN retries; prefetch schedules cache holes instead of downloading cached parts again. Skip cooling-down CDNs during failover and cancel stalled response readers.
- Regression coverage includes failed-fetch failover, partial-body continuation, mismatched file totals, scan traffic, near-playback rescue and repeated refresh recovery. These are simulated tests, not authenticated live playback measurements.
- Keep the five-minute preload; add an opt-in, bounded multi-Range path for uncached player Fetch/XHR requests. Reassemble only verified byte ranges and fall back to the native request on failure.
- Add mainland CDN candidates and Auto / Overseas-first / Mainland-first selection. Availability still depends on each video's signed URL and CORS response.
- The multi-Range approach was informed by [Bilibili-thread-ripper](https://github.com/MrTangLuyao/Bilibili-thread-ripper); this implementation is separate and does not import its code.
- Mocked Chrome checks cover parallel Fetch/XHR, native fallback, aborted XHR, and existing preload behavior. Real authenticated playback remains to be validated.

# v1.0.7

- 新增粉色猫头小电视 Logo，适配扩展列表及工具栏的 16/32/48/128 像素图标。
- macOS 已通过用户实测验证，更新中英文兼容说明；Windows/macOS 继续使用同一个安装包。

- 当前播放位置后 25 秒内的数据块下载拖延时，在同一预取并发名额内取消并接力备用 CDN：连续无数据 3 秒或单次总耗时 6 秒触发。固定线路模式不换线。
- 短视频跳转后优先缓存当前位置及之后，再补齐已播放部分；仍以整段缓存为目标。
- 不增加预取并发或缓存预算，不拦截/取消已经发出的播放器原生请求。
- 模拟 20 秒视频播放位置 15 秒、关键块无响应的情况，约 3 秒开始备用线路并完成缓存。真实用户案例待验证。

# v1.0.6

- 正式界面移除「只测香港」和「复制诊断」按钮及对应事件处理。
- 保留「测试各线路」、香港候选节点和主动选线，预加载策略未变。

# v1.0.5

首个公开发布版本：Bili CDN & Preload。

- Windows/macOS 通用 Chrome/Edge Manifest V3 扩展包。
- 五分钟目标缓存、音视频并行预取、真实缓存命中。
- 缓存余量不足或增长偏慢时主动探索其它 CDN，双样本确认、平滑评分及切换间隔。
- 修复其它视频的 playurl 信息清空当前音轨的问题。
- 并发数及内存上限自动保存。
- 外部点击收起面板，原生全屏隐藏入口。

Windows 开发环境测试已通过；macOS 尚未实机验证。请下载通用 ZIP，解压后通过浏览器开发者模式加载。详细安装步骤与限制见 README。
