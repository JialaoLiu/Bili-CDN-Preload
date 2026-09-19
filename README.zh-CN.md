# Bili CDN & Preload

[English](README.md) | 简体中文

给留子、海外工作者及华侨华人用的 Bilibili 播放优化扩展：主动优选 CDN、提前缓存视频，减少海外看 B 站时的频繁缓冲。

## 功能

- **提前缓存：**五分钟以内的视频缓存整段，长视频缓存当前位置之后五分钟。
- **主动选线：**缓存余量不足或增长偏慢时，提前试探其它 CDN，不等卡住才处理。
- **并行下载：**音视频分别缓存，并行数和内存上限可调，选完自动保存。
- **真实进度：**显示实际下载速度、连续缓存范围和播放器缓存命中。

## 安装

**[下载最新版本](https://github.com/JialaoLiu/Bili-CDN-Preload/releases/latest)** — Windows/macOS 的 Chrome、Edge 使用同一个 ZIP。

1. 解压 ZIP，保留解压后的文件夹。
2. 打开 `chrome://extensions` 或 `edge://extensions`，开启「开发者模式」。
3. 点击「加载已解压的扩展」，选择其中的 `extension` 文件夹。
4. 停用有冲突的 B 站 CDN 脚本或扩展，刷新视频，点击右下角 **Bili CDN & Preload**。

更新时替换文件、重新加载扩展，再刷新 B 站页面。暂不支持自动更新。

## 兼容与隐私

Windows 已实测；macOS 使用同一套跨平台扩展代码，尚未实机验证。建议使用当前版本的 Chrome 或 Edge。

适用于桌面 B 站 DASH 点播，实际效果取决于 CDN 带宽与账号访问权限。不是 VPN，也不提供地区解锁。

无遥测、无远端后台。设置保存在 localStorage，视频缓存保存在页面内存中，刷新即清除。默认缓存预算为 1 GiB。

## 开发与反馈

无需构建，直接加载 `extension/`。Node.js 20+ 可运行测试：

```sh
node --test tests/core.test.cjs tests/adaptive.test.cjs
```

遇到问题请[提交 Issue](https://github.com/JialaoLiu/Bili-CDN-Preload/issues)，附上浏览器、所在地区、视频画质及面板「复制诊断」的结果。分享前请检查诊断内容。

## 致谢

[MIT 许可](LICENSE)。使用了 [Bili Pilot](https://github.com/siwei-yuan/bili-pilot) 的 MIT 授权 DASH/SIDX 解析与 XHR 组件，原版权声明见 [vendor/LICENSE](extension/vendor/LICENSE)。本项目与哔哩哔哩官方无隶属关系。
