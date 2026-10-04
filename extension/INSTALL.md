# Bili CDN & Preload — v1.0.9

## Live streams / 直播

On a numeric Bilibili live-room page, open **Bili CDN & Preload · Live**. Live acceleration, announced-segment prefetch and direct-CDN preference have separate switches. Only recognized, unencrypted fMP4 HLS Fetch/XHR streams are supported; FLV, byte-range, encrypted and worker-only requests stay native. Reload after changing the P2P setting to fully apply it. Live buffering is limited to content already produced by the broadcaster. Low-viewer-room checks confirmed cache hits, while thin buffers and duplicate requests remain.

在 B 站直播间点击 **Bili CDN & Preload · Live**。直播加速、预取已生成分片、优先直连 CDN 各有独立开关。仅支持已识别且未加密的 fMP4 HLS Fetch/XHR 流；FLV、字节范围、加密以及 Worker 内部请求沿用原生播放。修改 P2P 选项后刷新页面才能完全生效。直播只能缓存主播已经生成的内容；低人气房间已确认缓存命中，但仍有低缓冲和重复请求。

## English

1. Extract the ZIP and keep the folder. Windows and macOS use the same Chrome/Edge package.
2. Open `chrome://extensions` or `edge://extensions`, enable Developer mode, and choose **Load unpacked**.
3. Select the folder directly containing `manifest.json`. Disable conflicting Bilibili media/CDN extensions, then refresh the video.
4. Open **Bili CDN & Preload** at the bottom right. Use **EN / 中** in the panel header to switch languages; your choice is saved.

Drag the preload slider freely and release to snap to 30-second steps. Far left disables extra prefetch, not Bilibili's own buffering. The default is five minutes. Changing the target or language does not restart playback or discard cached future data.

For updates, replace the files in your existing extension folder, reload the extension, and refresh video tabs. VOD transfer choices are 3 / 6 / 8 / 12, default 6; parallel playback is enabled and mainland CDNs preferred by default. Windows Edge live and HDR/HEVC playback were checked. Earlier versions received user macOS validation; this version has no fresh macOS performance test.

## 简体中文

1. 解压 ZIP 并保留文件夹。Windows/macOS 的 Chrome、Edge 使用同一个安装包。
2. 打开 `chrome://extensions` 或 `edge://extensions`，启用开发者模式，选择「加载已解压的扩展」。
3. 选择直接包含 `manifest.json` 的文件夹。停用有冲突的 B 站媒体/CDN 扩展，再刷新视频。
4. 点击右下角 **Bili CDN & Preload**；面板右上角 **EN / 中** 可切换语言，并自动保存选择。

预加载滑条可以自由拖动，松手吸附到最近的 30 秒档位。最左侧关闭额外预取，仍保留 B 站自身缓冲；默认提前五分钟。调整时长或语言不会重启播放，也不会丢弃已缓存的后续数据。

更新时替换原扩展目录中的文件，重新加载扩展并刷新视频页面。点播总并发可选 3 / 6 / 8 / 12，默认 6；播放请求并行默认勾选，线路默认大陆优先。Windows Edge 已检查直播与真实 HDR/HEVC 播放；旧版已有用户 macOS 验证，本版尚无新的 macOS 性能实测。
