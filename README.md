# Bili CDN & Preload

English | [简体中文](README.zh-CN.md)

Smoother Bilibili playback overseas with adaptive CDN selection and proactive video caching. Built for international students, overseas workers, and Chinese communities abroad.

## Features

- **Preload ahead:** choose Bilibili's default buffering or up to 5 minutes ahead; default is 5 minutes.
- **English / 中文:** switch with **EN / 中** in the panel header; your choice is saved.
- **Adapt before stalls:** explore alternative CDNs when buffer headroom or growth is low.
- **Download in parallel:** separate audio/video caching, adjustable concurrency and memory limits, saved automatically.
- **See real results:** live download speed, continuous cache coverage, and player cache hits.

## Install

**[Download the latest release](https://github.com/JialaoLiu/Bili-CDN-Preload/releases/latest)** — one ZIP for Chrome and Edge on Windows and macOS.

**[Try v1.0.8 beta.7](https://github.com/JialaoLiu/Bili-CDN-Preload/releases/tag/v1.0.8-beta.7)** for the bilingual panel, adjustable preload and shared downloads.

1. Extract the ZIP and keep the folder.
2. Open `chrome://extensions` or `edge://extensions`, then enable **Developer mode**.
3. Click **Load unpacked** and select the folder directly containing `manifest.json`.
4. Disable conflicting Bilibili CDN scripts/extensions, refresh your video, and click **Bili CDN & Preload** in the bottom-right corner.

To update, replace the files, reload the extension, and refresh Bilibili. No automatic updates. The beta panel supports English and Simplified Chinese.

## Compatibility & privacy

Windows tested; macOS verified through user testing. Both platforms use the same extension package. Use a current Chrome or Edge release.

Designed for desktop Bilibili DASH videos. Playback still depends on available CDN bandwidth and your account's access. No VPN or region unlocking.

No telemetry or remote backend. Settings stay in localStorage. The beta uses page memory plus a local IndexedDB cache (up to 128 MiB, 30-minute expiry) for refresh recovery. Default memory budget: 1 GiB.

## Development

No build step. Load `extension/` directly. Run tests with Node.js 20+:

```sh
node --test tests/core.test.cjs tests/adaptive.test.cjs tests/i18n.test.cjs
```

[Report an issue](https://github.com/JialaoLiu/Bili-CDN-Preload/issues) with your browser, region, video link, quality, and a screenshot of the cache panel.

## Credits

[MIT](LICENSE). Includes MIT-licensed DASH/SIDX and XHR components from [Bili Pilot](https://github.com/siwei-yuan/bili-pilot); original notices are in [vendor/LICENSE](extension/vendor/LICENSE). Independent project, not affiliated with Bilibili.
