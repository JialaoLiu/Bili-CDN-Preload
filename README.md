# Bili CDN & Preload

Adaptive CDN Selection & Video Caching

面向海外留学生、海外工作者及华侨华人的 Bilibili 网页播放优化扩展。通过主动 CDN 优选、音视频并行预加载与持续缓存，改善海外观看时加载缓慢、频繁缓冲的问题。

## 下载与安装 / Windows & macOS

从 [Releases](https://github.com/JialaoLiu/Bili-CDN-Preload/releases/latest) 下载 `Bili-CDN-Preload-v1.0.5-Chrome-Edge.zip`。Windows 与 macOS（Intel / Apple Silicon）使用同一个包，无需 EXE、DMG 或 Node.js。

1. 解压 ZIP，并把文件夹放在长期保留的位置。
2. Chrome 打开 `chrome://extensions`；Edge 打开 `edge://extensions`。
3. 开启「开发者模式 / Developer mode」。
4. 点击「加载已解压的扩展 / Load unpacked」，选择解压后包含 `manifest.json` 的目录。
5. 停用其它会改写 B 站媒体请求的 CDN 扩展或脚本，刷新 B 站视频页面。
6. 点击页面右下角 **Bili CDN & Preload**。

从源码安装时选择仓库的 `extension` 目录。更新时替换扩展文件，去扩展管理页点击「重新加载」，再刷新视频页面。本发布未上架浏览器商店，也不提供自动更新。

参考：[Chrome 安装说明](https://developer.chrome.com/docs/extensions/get-started/tutorial/hello-world#load-unpacked)、[Edge 安装说明](https://learn.microsoft.com/en-us/microsoft-edge/extensions/getting-started/extension-sideloading)。

## 功能

- 不超过五分钟的视频预取整段；更长的视频维持当前位置之后五分钟的目标窗口。
- 音视频分开预取，暂停播放也继续下载，真实缓存可响应播放器的 Fetch/XHR Range 请求。
- 默认三路并发；并行数与内存上限选择后立即保存。
- 提前观察缓存余量与增长，使用实际待下载分块探测其它 CDN；至少两次有效样本、平滑评分与切换间隔避免反复跳线。
- 自动试探最多同时一路，计入用户设置的并发上限；固定线路模式不自动换线。
- 内置海外、香港及其它候选域名，支持自定义与手动测速。候选不代表一定可用。
- 展示实际预取速度、连续缓存范围及播放器缓存命中；不将短时测速称作“保底带宽”。
- 面板外点击、Esc 收起；原生全屏隐藏入口与面板。

## 平台与验证

| 平台 | Chrome / Edge |
| --- | --- |
| Windows | 已验证 Chrome 模拟播放器及 Edge 实际扩展加载、普通 B 站视频播放 |
| macOS Intel / Apple Silicon | 使用相同 Manifest V3 包；无 Windows 专用代码，尚未实机验证 |

建议使用当前稳定版 Chrome 或 Edge；清单最低 Chromium 版本为 111。Safari、Firefox、手机浏览器不属于本发布的支持范围。

适用于桌面 B 站 DASH 点播。直播、DRM、无可读 sidx 索引的媒体未验证。画质与内容访问遵循当前账号权限；本扩展不是 VPN 或地区解锁工具。若所有候选的持续吞吐不足，无法保证五分钟缓存或完全无卡顿。

缓存保存在当前页面内存中，刷新/关闭页面后释放。默认媒体缓存预算 1 GiB，不等于整个浏览器的内存上限。原生播放器灰条仅表示已经交付播放器的数据，请结合扩展缓存进度和命中计数判断。

## 隐私与诊断

没有遥测、远端后台或第三方分析。设置保存在 B 站当前浏览器配置的 localStorage；清除站点数据会清除设置。为播放而访问 B 站提供或用户选择的 CDN。诊断包含媒体文件标识、节点域名与下载状态，不包含 Cookie 或完整带签名媒体 URL；分享前仍请自行检查。

## 开发测试

无需构建即可加载 `extension/`。本地测试需 Node.js 20+：

```sh
node --test tests/core.test.cjs tests/adaptive.test.cjs
```

核心测试覆盖时间窗口、Range 完整性、缓存缺口、签名地址处理、超时、主动探测与防抖。另已在开发环境进行模拟浏览器回归：短视频全缓存、长视频窗口与跳转、其他视频信息不干扰当前播放、缓存回放、设置持久化，以及慢线路不报错时主动选择其它候选。未将这些测试称作所有网络、画质和平台的实测。

## 致谢与许可

采用 [Bili Pilot](https://github.com/siwei-yuan/bili-pilot) 的 MIT 授权 DASH/SIDX 解析及 XHR 缓存适配器，原版权声明保留于 `extension/vendor/LICENSE`。调度、主动选线、缓存管理及界面由本项目实现。项目以 MIT 许可发布，见 [LICENSE](LICENSE)。本项目为独立第三方工具，与哔哩哔哩官方无隶属关系。
