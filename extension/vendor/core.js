(function installBiliCdnCore(root) {
  "use strict";

  const QUALITY_LABELS = Object.freeze({
    127: "8K",
    126: "Dolby Vision",
    125: "HDR",
    120: "4K",
    116: "1080P60",
    112: "1080P+",
    80: "1080P",
    74: "720P60",
    64: "720P",
    32: "480P",
    16: "360P"
  });

  const PCDN_SUFFIXES = Object.freeze([
    ".szbdyd.com",
    ".mountaintoys.cn",
    ".nexusedgeio.com",
    ".ahdohpiechei.com"
  ]);
  const KNOWN_PCDN_HOSTS = Object.freeze(new Set([
    "upos-sz-mirror14b.bilivideo.com"
  ]));

  function displayQualityLabel(representation, quality) {
    const width = Number(representation?.width || 0);
    const height = Number(representation?.height || 0);
    if (width >= 7000 || height >= 4000) return "8K";
    if (width >= 3800 || height >= 2100) return "4K";
    return QUALITY_LABELS[quality] || `QN ${quality}`;
  }

  function displayFeatures(quality) {
    if (Number(quality) === 126) return ["Dolby Vision"];
    if (Number(quality) === 125) return ["HDR"];
    return [];
  }

  function safeUrl(value) {
    if (typeof value !== "string" || !value.startsWith("https://")) return null;
    try {
      return new URL(value);
    } catch {
      return null;
    }
  }

  function unique(values) {
    return [...new Set(values.filter(Boolean))];
  }

  function isIpv4Host(host) {
    const parts = String(host || "").split(".");
    return parts.length === 4 && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
  }

  function classifyCdnRoute(value) {
    const input = value instanceof URL
      ? value
      : safeUrl(typeof value === "object" ? value?.url : value);
    if (!input) return { deprioritized: false, kind: "unknown", reasons: ["invalid-url"] };

    const host = input.hostname.toLowerCase();
    const firstLabel = host.split(".")[0] || "";
    const mcdnHost = /\.mcdn\.bilivideo\.(?:com|cn|net)$/i.test(host);
    const mcdnQuery = String(input.searchParams.get("os") || "").toLowerCase() === "mcdn";
    const reasons = [];
    if (mcdnHost) reasons.push("mcdn-host");
    if (mcdnQuery) reasons.push("mcdn-query");
    if (isIpv4Host(host)) reasons.push("ip-host");
    if (KNOWN_PCDN_HOSTS.has(host)) reasons.push("known-pcdn-host");
    if (PCDN_SUFFIXES.some((suffix) => host.endsWith(suffix))) reasons.push("known-pcdn-suffix");
    if (firstLabel.startsWith("upos-") && firstLabel.includes("302")) reasons.push("redirect-pcdn-host");
    if (input.port && input.port !== "443") reasons.push("non-standard-port");

    const deprioritized = reasons.length > 0;
    const official = [
      ".bilivideo.com",
      ".bilivideo.cn",
      ".akamaized.net",
      ".gcdn.co",
      ".hdslb.com"
    ].some((suffix) => host === suffix.slice(1) || host.endsWith(suffix));
    return {
      deprioritized,
      kind: mcdnHost || mcdnQuery ? "mcdn" : deprioritized ? "pcdn" : official ? "official" : "unknown",
      reasons
    };
  }

  function routeRiskOf(candidate) {
    if (candidate?.url) return classifyCdnRoute(candidate.url);
    const existing = candidate?.routeRisk;
    return existing && typeof existing === "object"
      ? existing
      : classifyCdnRoute(candidate);
  }

  function isDeprioritizedCandidate(candidate) {
    return routeRiskOf(candidate).deprioritized === true;
  }

  function prioritizeCdnCandidates(candidates, preferredHost = "") {
    const list = Array.isArray(candidates) ? candidates.filter((candidate) => candidate?.host) : [];
    const regular = list.filter((candidate) => !isDeprioritizedCandidate(candidate));
    const deprioritized = list.filter(isDeprioritizedCandidate);
    const promote = (items) => [
      ...items.filter((candidate) => candidate.host === preferredHost),
      ...items.filter((candidate) => candidate.host !== preferredHost)
    ];
    return regular.length
      ? [...promote(regular), ...deprioritized]
      : promote(deprioritized);
  }

  function createCandidate(url, isPrimary) {
    const parsed = safeUrl(url);
    if (!parsed) return null;
    return {
      host: parsed.hostname,
      isPrimary: Boolean(isPrimary),
      label: cdnLabel(parsed.hostname),
      routeRisk: classifyCdnRoute(parsed),
      url
    };
  }

  function chooseRouteHost(currentHost, explicitPreference, candidates) {
    const allowed = Array.isArray(candidates) && candidates.some((candidate) => candidate?.host === explicitPreference);
    return explicitPreference && allowed ? explicitPreference : currentHost;
  }

  function chooseRouteHostWithCooldown(currentHost, explicitPreference, candidates, coolingHosts) {
    const list = Array.isArray(candidates) ? candidates.filter((candidate) => candidate?.host) : [];
    const allowedHosts = new Set(list.map((candidate) => candidate.host));
    const cooling = new Set(Array.isArray(coolingHosts) ? coolingHosts : []);
    const preferred = chooseRouteHost(currentHost, explicitPreference, list);
    if (!explicitPreference || !allowedHosts.has(explicitPreference) || !cooling.has(preferred)) return preferred;

    if (allowedHosts.has(currentHost) && !cooling.has(currentHost)) return currentHost;
    const healthyAlternate = list.find((candidate) => !cooling.has(candidate.host));
    if (healthyAlternate) return healthyAlternate.host;

    // If every candidate is cooling down, stop forcing a route and let the
    // player's own requested fallback through. This avoids an infinite ping-pong.
    return allowedHosts.has(currentHost) ? currentHost : preferred;
  }

  function readUrlSet(representation) {
    if (!representation || typeof representation !== "object") return [];
    const base = representation.baseUrl || representation.base_url;
    const backups = representation.backupUrl || representation.backup_url || [];
    return unique([base, ...(Array.isArray(backups) ? backups : [])]).filter(safeUrl);
  }

  function readSegmentBase(representation) {
    const value = representation?.segmentBase || representation?.segment_base;
    if (!value || typeof value !== "object") return null;
    const initialization = String(value.Initialization || value.initialization || "");
    const indexRange = String(value.indexRange || value.index_range || "");
    if (!/^\d+-\d+$/.test(initialization) || !/^\d+-\d+$/.test(indexRange)) return null;
    return { initialization, indexRange };
  }

  function findDashPayload(payload) {
    if (!payload || typeof payload !== "object") return null;
    const candidates = [
      payload,
      payload.data,
      payload.result,
      payload.data && payload.data.data,
      payload.result && payload.result.data
    ].filter(Boolean);

    for (const container of candidates) {
      if (container.dash && Array.isArray(container.dash.video)) {
        const quality = Number(container.quality || container.qn || container.dash.video[0]?.id || 0);
        return { container, dash: container.dash, quality };
      }
    }
    return null;
  }

  function videoKeyFromUrl(pageUrl) {
    const match = String(pageUrl || "").match(/\/video\/(BV[0-9A-Za-z]+)/i);
    return match ? match[1] : "unknown-video";
  }

  function cdnLabel(host) {
    const value = String(host || "").toLowerCase();
    if (value.includes("akamaized") || value.includes("akam")) return "Akamai";
    if (value.includes("mirrorcos") || value.includes("cosov")) return "COSOV";
    if (value.includes("mcdn")) return "Bili MCDN";
    if (value.includes("hw") || value.includes("huawei")) return "Huawei Cloud";
    if (value.includes("gcdn")) return "Gcore";
    if (value.includes("bilivideo")) return "Bili CDN";
    return "CDN";
  }

  function representationRank(representation, quality) {
    const qualityMatch = Number(representation.id) === Number(quality) ? 1 : 0;
    const hostCount = unique(readUrlSet(representation).map((url) => safeUrl(url)?.hostname)).length;
    const bandwidth = Number(representation.bandwidth || representation.band_width || 0);
    return qualityMatch * 1e15 + hostCount * 1e12 + bandwidth;
  }

  function extractProbePlan(payload, pageUrl) {
    const found = findDashPayload(payload);
    if (!found) return null;
    const videos = found.dash.video.filter((item) => readUrlSet(item).length);
    if (!videos.length) return null;

    const representative = [...videos].sort(
      (a, b) => representationRank(b, found.quality) - representationRank(a, found.quality)
    )[0];
    const urls = readUrlSet(representative);
    const candidates = [];
    const seenHosts = new Set();

    for (const url of urls) {
      const parsed = safeUrl(url);
      if (!parsed || seenHosts.has(parsed.hostname)) continue;
      seenHosts.add(parsed.hostname);
      candidates.push(createCandidate(url, candidates.length === 0));
    }

    const currentPrimary = candidates[0]?.host || null;
    const prioritizedCandidates = prioritizeCdnCandidates(candidates);

    const videoKey = videoKeyFromUrl(pageUrl);
    const quality = found.quality;
    const signature = [
      videoKey,
      quality,
      representative.codecs || "unknown-codec",
      ...prioritizedCandidates.map((candidate) => candidate.host).sort()
    ].join("|");

    return {
      bandwidth: Number(representative.bandwidth || representative.band_width || 0),
      candidates: prioritizedCandidates,
      codec: representative.codecs || "unknown",
      currentPrimary,
      features: displayFeatures(quality),
      height: Number(representative.height || 0),
      quality,
      qualityLabel: displayQualityLabel(representative, quality),
      signature,
      videoKey,
      width: Number(representative.width || 0)
    };
  }

  function extractMediaRoutes(payload, pageUrl) {
    const found = findDashPayload(payload);
    if (!found) return null;
    const routes = [];
    for (const [kind, representations] of [
      ["video", found.dash.video || []],
      ["audio", found.dash.audio || []]
    ]) {
      for (const representation of representations) {
        const urls = readUrlSet(representation);
        if (!urls.length) continue;
        routes.push({
          bandwidth: Number(representation.bandwidth || representation.band_width || 0),
          codec: representation.codecs || "unknown",
          height: Number(representation.height || 0),
          id: Number(representation.id || 0),
          kind,
          segmentBase: readSegmentBase(representation),
          urls: urls.map((url) => ({
            host: safeUrl(url)?.hostname || "",
            url
          })).filter((item) => item.host),
          width: Number(representation.width || 0)
        });
      }
    }
    return {
      quality: found.quality,
      routes,
      videoKey: videoKeyFromUrl(pageUrl)
    };
  }

  function createProbePlanFromRoute(routePlan, route, currentHost) {
    if (!routePlan?.videoKey || route?.kind !== "video" || !Array.isArray(route.urls)) return null;
    const candidates = [];
    const seenHosts = new Set();
    for (const item of route.urls) {
      const parsed = safeUrl(item?.url);
      if (!parsed || seenHosts.has(parsed.hostname)) continue;
      seenHosts.add(parsed.hostname);
      candidates.push(createCandidate(parsed.href, candidates.length === 0));
    }
    if (!candidates.length) return null;

    const prioritizedCandidates = prioritizeCdnCandidates(candidates, currentHost);

    const quality = Number(route.id || 0);
    const mediaPath = safeUrl(route.urls[0]?.url)?.pathname || "unknown-media";
    const activeHost = candidates.some((candidate) => candidate.host === currentHost)
      ? currentHost
      : candidates[0].host;
    const signature = [
      routePlan.videoKey,
      quality,
      route.codec || "unknown-codec",
      route.width || 0,
      route.height || 0,
      mediaPath,
      ...prioritizedCandidates.map((candidate) => candidate.host).sort()
    ].join("|");

    return {
      bandwidth: Number(route.bandwidth || 0),
      candidates: prioritizedCandidates,
      codec: route.codec || "unknown",
      currentPrimary: activeHost,
      features: displayFeatures(quality),
      height: Number(route.height || 0),
      mediaPath,
      quality,
      qualityLabel: displayQualityLabel(route, quality),
      segmentBase: route.segmentBase || null,
      signature,
      videoKey: routePlan.videoKey,
      width: Number(route.width || 0)
    };
  }

  function matchRouteUrl(route, requestUrl) {
    const requested = safeUrl(requestUrl);
    if (!requested || !Array.isArray(route?.urls)) return null;

    const exact = route.urls.find((item) => safeUrl(item?.url)?.href === requested.href);
    if (exact) return { current: exact, exact: true, route };

    const sameResource = route.urls.find((item) => {
      const candidate = safeUrl(item?.url);
      return candidate &&
        candidate.hostname === requested.hostname &&
        candidate.pathname === requested.pathname;
    });
    if (!sameResource) return null;

    const observedCurrent = { ...sameResource, url: requested.href };
    return {
      current: observedCurrent,
      exact: false,
      route: {
        ...route,
        urls: route.urls.map((item) => item === sameResource ? observedCurrent : item)
      }
    };
  }

  function findObservedVideoRoute(routePlan, observedUrls, decodedWidth, decodedHeight) {
    if (!Array.isArray(routePlan?.routes)) return null;
    const width = Number(decodedWidth || 0);
    const height = Number(decodedHeight || 0);
    if (!width || !height) return null;
    const observed = (Array.isArray(observedUrls) ? observedUrls : [])
      .map((value) => safeUrl(value)?.href)
      .filter(Boolean);
    if (!observed.length) return null;

    for (const route of routePlan.routes) {
      if (route?.kind !== "video") continue;
      if (Math.abs(Number(route.width || 0) - width) > 2 ||
          Math.abs(Number(route.height || 0) - height) > 2) continue;
      for (const observedUrl of observed) {
        const match = matchRouteUrl(route, observedUrl);
        if (match) return { currentHost: match.current.host, route: match.route };
      }
    }
    return null;
  }

  function resolveRouteUrl(routePlan, requestUrl, preferredHost) {
    const requested = safeUrl(requestUrl);
    if (!requested || !preferredHost || !Array.isArray(routePlan?.routes)) {
      return { changed: false, host: requested?.hostname || null, url: requestUrl };
    }
    for (const route of routePlan.routes) {
      const match = matchRouteUrl(route, requested.href);
      if (!match) continue;
      const { current, route: observedRoute } = match;
      const preferred = observedRoute.urls.find((item) => item.host === preferredHost);
      if (!preferred) return { changed: false, host: current.host, route: observedRoute, url: requested.href };
      return {
        changed: preferred.url !== requested.href,
        host: preferred.host,
        originalHost: current.host,
        originalUrl: requested.href,
        route: observedRoute,
        url: preferred.url
      };
    }
    return { changed: false, host: requested.hostname, url: requested.href };
  }

  function parseByteRange(value) {
    const match = String(value || "").match(/^(?:bytes=)?(\d+)-(\d+)$/i);
    if (!match) return null;
    const start = Number(match[1]);
    const end = Number(match[2]);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start) return null;
    return { start, end };
  }

  function byteRangesOverlap(left, right) {
    const a = typeof left === "string" ? parseByteRange(left) : left;
    const b = typeof right === "string" ? parseByteRange(right) : right;
    if (!a || !b) return false;
    return a.start <= b.end && b.start <= a.end;
  }

  function filterRangesAfterObserved(items, observedRange) {
    const observed = parseByteRange(observedRange);
    if (!observed) return Array.isArray(items) ? items.slice() : [];
    return (Array.isArray(items) ? items : []).filter((item) => {
      const range = parseByteRange(item?.range);
      return range && range.start > observed.end;
    });
  }

  function readUint64(view, offset) {
    const high = view.getUint32(offset);
    const low = view.getUint32(offset + 4);
    const value = high * 0x100000000 + low;
    return Number.isSafeInteger(value) ? value : NaN;
  }

  function parseSidx(buffer, absoluteStart = 0) {
    const bytes = buffer instanceof ArrayBuffer
      ? buffer
      : ArrayBuffer.isView(buffer)
        ? buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength)
        : null;
    if (!bytes || bytes.byteLength < 32) return null;
    const view = new DataView(bytes);
    let offset = 0;
    while (offset + 8 <= view.byteLength) {
      let size = view.getUint32(offset);
      const type = String.fromCharCode(
        view.getUint8(offset + 4), view.getUint8(offset + 5),
        view.getUint8(offset + 6), view.getUint8(offset + 7)
      );
      let headerSize = 8;
      if (size === 1) {
        if (offset + 16 > view.byteLength) return null;
        size = readUint64(view, offset + 8);
        headerSize = 16;
      } else if (size === 0) {
        size = view.byteLength - offset;
      }
      if (!Number.isSafeInteger(size) || size < headerSize || offset + size > view.byteLength) return null;
      if (type !== "sidx") {
        offset += size;
        continue;
      }

      const fullBox = offset + headerSize;
      const version = view.getUint8(fullBox);
      const timescale = view.getUint32(fullBox + 8);
      if (!timescale || (version !== 0 && version !== 1)) return null;
      let cursor = fullBox + 12;
      const earliestPresentationTime = version === 0 ? view.getUint32(cursor) : readUint64(view, cursor);
      cursor += version === 0 ? 4 : 8;
      const firstOffset = version === 0 ? view.getUint32(cursor) : readUint64(view, cursor);
      cursor += version === 0 ? 4 : 8;
      cursor += 2;
      if (cursor + 2 > offset + size) return null;
      const referenceCount = view.getUint16(cursor);
      cursor += 2;
      let byteStart = Number(absoluteStart) + offset + size + firstOffset;
      let timeStart = earliestPresentationTime / timescale;
      const segments = [];
      for (let index = 0; index < referenceCount; index += 1) {
        if (cursor + 12 > offset + size) return null;
        const typeAndSize = view.getUint32(cursor);
        const referenceType = typeAndSize >>> 31;
        const referencedSize = typeAndSize & 0x7fffffff;
        const subsegmentDuration = view.getUint32(cursor + 4);
        cursor += 12;
        if (referenceType !== 0 || !referencedSize || !subsegmentDuration) return null;
        const duration = subsegmentDuration / timescale;
        segments.push({
          duration,
          end: byteStart + referencedSize - 1,
          endTime: timeStart + duration,
          index,
          start: byteStart,
          startTime: timeStart
        });
        byteStart += referencedSize;
        timeStart += duration;
      }
      return {
        earliestPresentationTime: earliestPresentationTime / timescale,
        firstOffset,
        referenceCount,
        segments,
        timescale
      };
    }
    return null;
  }

  function upcomingSegments(index, anchorTime, count = 5) {
    const segments = Array.isArray(index?.segments) ? index.segments : [];
    const anchor = Math.max(0, Number(anchorTime) || 0);
    const limit = Math.max(1, Math.min(12, Number(count) || 5));
    return segments
      .filter((segment) => Number(segment.endTime || 0) > anchor + 0.05)
      .slice(0, limit);
  }

  function upcomingSegmentsAfterRange(index, observedRange, count = 5) {
    const segments = Array.isArray(index?.segments) ? index.segments : [];
    const range = typeof observedRange === "string" ? parseByteRange(observedRange) : observedRange;
    const limit = Math.max(1, Math.min(12, Number(count) || 5));
    if (!range) return [];
    return segments.filter((segment) => segment.start > range.end).slice(0, limit);
  }

  function filterSegmentsBeyond(items, anchorTime, observedRange) {
    const anchor = Math.max(0, Number(anchorTime) || 0);
    const observed = parseByteRange(observedRange);
    return (Array.isArray(items) ? items : []).filter((segment) => {
      const startTime = Number(segment?.startTime);
      const segmentRange = parseByteRange(segment?.range);
      const byteStart = Number.isFinite(Number(segment?.start))
        ? Number(segment.start)
        : Number(segmentRange?.start);
      const startsAfterBuffer = !Number.isFinite(startTime) || startTime >= anchor - 0.05;
      const startsAfterRequest = !observed || (Number.isFinite(byteStart) && byteStart > observed.end);
      return startsAfterBuffer && startsAfterRequest;
    });
  }

  function upcomingSegmentsBeyond(index, anchorTime, observedRange, count = 5) {
    const limit = Math.max(1, Math.min(12, Number(count) || 5));
    return filterSegmentsBeyond(index?.segments, anchorTime, observedRange).slice(0, limit);
  }

  function harmonicMean(values) {
    const positives = values.filter((value) => Number.isFinite(value) && value > 0);
    if (!positives.length) return 0;
    return positives.length / positives.reduce((sum, value) => sum + 1 / value, 0);
  }

  function scoreProbeResult(result) {
    const samples = Array.isArray(result?.samples) ? result.samples : [];
    const successes = samples.filter((sample) => sample.ok && Number.isFinite(sample.mbps));
    const failures = samples.length - successes.length;
    if (!successes.length) {
      return { ...result, failures, harmonicMbps: 0, minMbps: 0, score: -10000 };
    }
    const speeds = successes.map((sample) => sample.mbps);
    const minMbps = Math.min(...speeds);
    const harmonicMbps = harmonicMean(speeds);
    const averageTtfb = successes.reduce((sum, sample) => sum + (sample.ttfbMs || 0), 0) / successes.length;
    const score = minMbps * 0.72 + harmonicMbps * 0.28 - failures * 80 - averageTtfb / 500;
    return {
      ...result,
      failures,
      harmonicMbps,
      minMbps,
      score
    };
  }

  function rankProbeResults(results) {
    const scored = (Array.isArray(results) ? results : []).map(scoreProbeResult);
    const hasRegularSuccess = scored.some((result) =>
      !isDeprioritizedCandidate(result) && result.samples?.some((sample) => sample.ok)
    );
    return scored.sort((a, b) => {
      if (hasRegularSuccess) {
        const riskDelta = Number(isDeprioritizedCandidate(a)) - Number(isDeprioritizedCandidate(b));
        if (riskDelta) return riskDelta;
      }
      return b.score - a.score;
    });
  }

  function chooseAutomaticRoute(results, plan, currentHost, options = {}) {
    const ranked = Array.isArray(results) ? results : [];
    const winner = ranked[0];
    const requiredMbps = Math.max(0.5, Number(plan?.bandwidth || 0) / 1_000_000);
    const safeRatio = Math.max(1, Number(options.safeRatio || 1.2));
    const advantageRatio = Math.max(1, Number(options.advantageRatio || 1.5));
    const minimumAdvantageMbps = Math.max(0, Number(options.minimumAdvantageMbps || 10));
    if (!winner || winner.score <= -10000 || !winner.samples?.some((sample) => sample.ok)) {
      return { host: null, reason: "no-viable-winner" };
    }
    if (Number(winner.failures || 0) > 1 || Number(winner.minMbps || 0) < requiredMbps * safeRatio) {
      return { host: null, reason: "winner-not-safe", winnerHost: winner.host };
    }
    if (winner.host === currentHost) {
      return options.pinCurrentBest === true
        ? { host: winner.host, reason: "pin-current-best", winnerHost: winner.host }
        : { host: null, reason: "current-best", winnerHost: winner.host };
    }

    const current = ranked.find((result) => result.host === currentHost) || ranked[1];
    const currentMbps = Math.max(0, Number(current?.minMbps || 0));
    const winnerMbps = Math.max(0, Number(winner.minMbps || 0));
    const ratio = currentMbps > 0 ? winnerMbps / currentMbps : Infinity;
    const failureAdvantage = Number(winner.failures || 0) < Number(current?.failures || 0);
    const speedAdvantage = ratio >= advantageRatio && winnerMbps - currentMbps >= minimumAdvantageMbps;
    if (!failureAdvantage && !speedAdvantage) {
      return { host: null, ratio, reason: "advantage-too-small", winnerHost: winner.host };
    }
    return {
      host: winner.host,
      ratio,
      reason: failureAdvantage ? "fewer-failures" : "clear-speed-advantage",
      winnerHost: winner.host
    };
  }

  root.BiliCdnCore = Object.freeze({
    QUALITY_LABELS,
    byteRangesOverlap,
    cdnLabel,
    classifyCdnRoute,
    chooseRouteHost,
    chooseRouteHostWithCooldown,
    chooseAutomaticRoute,
    createProbePlanFromRoute,
    extractMediaRoutes,
    extractProbePlan,
    filterSegmentsBeyond,
    filterRangesAfterObserved,
    findObservedVideoRoute,
    findDashPayload,
    matchRouteUrl,
    isDeprioritizedCandidate,
    rankProbeResults,
    parseByteRange,
    parseSidx,
    prioritizeCdnCandidates,
    readUrlSet,
    readSegmentBase,
    resolveRouteUrl,
    safeUrl,
    scoreProbeResult,
    upcomingSegments,
    upcomingSegmentsAfterRange,
    upcomingSegmentsBeyond,
    videoKeyFromUrl
  });
})(globalThis);
