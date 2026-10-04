# Bili CDN & Preload

[English](README.md) | 简体中文

给留子、海外工作者及华侨华人用的 Bilibili 播放优化扩展：主动优选 CDN、提前缓存视频，减少海外看 B 站时的频繁缓冲。

## 功能

- **提前缓存：**从 B 站默认缓冲到提前五分钟可调，默认五分钟。
- **中英双语：**点击面板右上角 **EN / 中** 切换，语言选择自动保存。
- **主动选线：**缓存余量不足或增长偏慢时，提前试探其它 CDN，不等卡住才处理。
- **并行下载：**点播总并发可选 3 / 6 / 8 / 12，默认 6；播放请求并行默认开启，线路默认大陆优先，设置自动保存。
- **真实进度：**显示实际下载速度、连续缓存范围和播放器缓存命中。

## 安装

**[下载最新版本](https://github.com/JialaoLiu/Bili-CDN-Preload/releases/latest)** — Windows/macOS 的 Chrome、Edge 使用同一个 ZIP。

**1.0.9 正式版**包含双语面板、可调预加载、共享下载和直播独立设置。

1. 解压 ZIP，保留解压后的文件夹。
2. 打开 `chrome://extensions` 或 `edge://extensions`，开启「开发者模式」。
3. 点击「加载已解压的扩展」，选择直接包含 `manifest.json` 的文件夹。
4. 停用有冲突的 B 站 CDN 脚本或扩展，刷新视频，点击右下角 **Bili CDN & Preload**。

更新时替换文件、重新加载扩展，再刷新 B 站页面。暂不支持自动更新。

## 兼容与隐私

Windows 已实测，macOS 已通过用户实测验证，两个平台使用同一个扩展包。建议使用当前版本的 Chrome 或 Edge。

适用于桌面 B 站 DASH 点播，实际效果取决于 CDN 带宽与账号访问权限。不是 VPN，也不提供地区解锁。

无遥测、无远端后台。设置保存在 localStorage。视频使用页面内存和本地 IndexedDB 缓存（最多 128 MiB、30 分钟过期）恢复刷新前的数据，默认内存预算为 1 GiB。

## 开发与反馈

### 直播支持

源码新增 `live.bilibili.com` 独立模块：对已识别的 fMP4 HLS 直播预取已生成的分片，Fetch/XHR 共用缓存，慢请求有限尝试备用 CDN，并可选择避开已知 P2P SDK。保留 B 站原生播放器和弹幕。直播不能下载主播尚未播出的内容，不使用点播的五分钟滑条。

FLV、加密、字节范围、未识别及仅在 Worker 中发出的流不接管。Windows Edge 实测确认 2～3 位观众的直播间已有缓存命中，但仍有低缓冲和重复分片请求；点播也已验证实际 HDR/HEVC 播放。这些有限测试尚不能证明 8、12 并发的性能。设计和候选节点参考 [Bilibili-thread-ripper](https://github.com/MrTangLuyao/Bilibili-thread-ripper)。

无需构建，直接加载 `extension/`。Node.js 20+ 可运行测试：

```sh
node --test tests/core.test.cjs tests/adaptive.test.cjs tests/i18n.test.cjs tests/live.test.cjs
```

遇到问题请[提交 Issue](https://github.com/JialaoLiu/Bili-CDN-Preload/issues)，附上浏览器、所在地区、视频链接、画质及缓存面板截图。

## 致谢

[MIT 许可](LICENSE)。使用了 [Bili Pilot](https://github.com/siwei-yuan/bili-pilot) 的 MIT 授权 DASH/SIDX 解析与 XHR 组件，原版权声明见 [vendor/LICENSE](extension/vendor/LICENSE)。本项目与哔哩哔哩官方无隶属关系。
