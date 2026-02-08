"use strict";

// === Configuration ===
const LIMITS = {
  "youtube.com": 1200,  // 20 minutes in seconds
  "reddit.com": 900     // 15 minutes in seconds
};
const WINDOW_MS = 3 * 60 * 60 * 1000; // 3 hours in ms
const PERSIST_INTERVAL = 5000;         // Save to storage every 5s
const CLEANUP_INTERVAL = 5 * 60 * 1000; // Prune old segments every 5 min
const GAP_THRESHOLD = 5000;            // 5s gap = machine sleep detected
const TICK_INTERVAL = 1000;            // 1s tick

// === State ===
// segments: { "youtube.com": [{start, end}, ...], "reddit.com": [{start, end}, ...] }
let segments = { "youtube.com": [], "reddit.com": [] };
let activeTabId = null;
let activeTabDomain = null; // normalized domain of active tab, or null
let activeTabUrl = null;
let windowFocused = true;
let currentSegment = null;  // {domain, start, end} for the ongoing tracking segment
let youtubeVideoSegment = null; // {domain: "youtube.com", start, end} for background video play
let youtubePlayingTabIds = new Set(); // tab IDs with playing YouTube videos
let lastTickTime = Date.now();
let dirty = false; // whether segments need persisting

// === Init ===
let initResolve;
const initPromise = new Promise(resolve => { initResolve = resolve; });

async function initialize() {
  try {
    const result = await browser.storage.local.get("segments");
    if (result.segments) {
      segments = result.segments;
      // Ensure both keys exist
      if (!segments["youtube.com"]) segments["youtube.com"] = [];
      if (!segments["reddit.com"]) segments["reddit.com"] = [];
    }
    pruneOldSegments();
  } catch (e) {
    console.error("Failed to load segments from storage:", e);
  }

  // Seed active tab state
  try {
    const tabs = await browser.tabs.query({ active: true, currentWindow: true });
    if (tabs.length > 0) {
      activeTabId = tabs[0].id;
      activeTabUrl = tabs[0].url || null;
      activeTabDomain = normalizeDomain(tabs[0].url);
    }
  } catch (e) {
    console.error("Failed to query active tab:", e);
  }

  // Check window focus
  try {
    const win = await browser.windows.getLastFocused();
    windowFocused = win.focused;
  } catch (e) {
    // Assume focused
  }

  maybeStartSegment();
  initResolve();
}

initialize();

// === Domain Normalization ===
function normalizeDomain(url) {
  if (!url) return null;
  try {
    const hostname = new URL(url).hostname;
    if (hostname === "youtube.com" || hostname.endsWith(".youtube.com")) {
      return "youtube.com";
    }
    if (hostname === "reddit.com" || hostname.endsWith(".reddit.com")) {
      return "reddit.com";
    }
  } catch (e) {
    // Invalid URL
  }
  return null;
}

// === Shorts URL Detection ===
function isShortsUrl(url) {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    const hostname = parsed.hostname;
    if (hostname !== "youtube.com" && !hostname.endsWith(".youtube.com")) {
      return false;
    }
    const path = parsed.pathname;
    // Match: /shorts, /shorts/*, /feed/shorts, /@*/shorts, /channel/*/shorts, /c/*/shorts, /user/*/shorts
    if (/^\/shorts(\/|$)/.test(path)) return true;
    if (/^\/feed\/shorts(\/|$)/.test(path)) return true;
    if (/^\/@[^/]+\/shorts(\/|$)/.test(path)) return true;
    if (/^\/(channel|c|user)\/[^/]+\/shorts(\/|$)/.test(path)) return true;
  } catch (e) {
    // Invalid URL
  }
  return false;
}

// === Rolling Window Calculation ===
function getUsageSeconds(domain) {
  const now = Date.now();
  const windowStart = now - WINDOW_MS;
  let total = 0;

  const domainSegments = segments[domain] || [];
  for (const seg of domainSegments) {
    const overlapStart = Math.max(seg.start, windowStart);
    const overlapEnd = Math.min(seg.end, now);
    if (overlapEnd > overlapStart) {
      total += overlapEnd - overlapStart;
    }
  }

  // Include current active segment if it matches this domain
  if (currentSegment && currentSegment.domain === domain) {
    const overlapStart = Math.max(currentSegment.start, windowStart);
    const overlapEnd = Math.min(currentSegment.end, now);
    if (overlapEnd > overlapStart) {
      total += overlapEnd - overlapStart;
    }
  }

  // Include YouTube video segment (background video play tracking)
  if (domain === "youtube.com" && youtubeVideoSegment) {
    const overlapStart = Math.max(youtubeVideoSegment.start, windowStart);
    const overlapEnd = Math.min(youtubeVideoSegment.end, now);
    if (overlapEnd > overlapStart) {
      total += overlapEnd - overlapStart;
    }
  }

  return total / 1000;
}

function isLimitExceeded(domain) {
  if (!LIMITS[domain]) return false;
  return getUsageSeconds(domain) >= LIMITS[domain];
}

// === Cooldown Calculation ===
// When limit is exceeded, compute when enough old usage will age out of the 3h window
function getCooldownEnd(domain) {
  const limit = LIMITS[domain];
  if (!limit) return null;

  const now = Date.now();
  const windowStart = now - WINDOW_MS;

  // Collect all segments (including current) sorted by start time
  let allSegs = [...(segments[domain] || [])];
  if (currentSegment && currentSegment.domain === domain) {
    allSegs.push({ start: currentSegment.start, end: currentSegment.end });
  }
  if (domain === "youtube.com" && youtubeVideoSegment) {
    allSegs.push({ start: youtubeVideoSegment.start, end: youtubeVideoSegment.end });
  }
  allSegs = allSegs.filter(s => s.end > windowStart);
  allSegs.sort((a, b) => a.start - b.start);

  const usage = getUsageSeconds(domain);
  if (usage < limit) return null; // Not exceeded

  // We need to shed (usage - limit + 1) seconds of usage for the limit to no longer be exceeded
  // Segments age out as the window slides forward. The earliest segments leave first.
  let excessMs = (usage - limit) * 1000 + 1000; // +1s buffer

  for (const seg of allSegs) {
    const segInWindow = Math.min(seg.end, now) - Math.max(seg.start, windowStart);
    if (segInWindow <= 0) continue;

    if (segInWindow >= excessMs) {
      // This segment partially ages out. The cooldown ends when the window slides
      // past enough of this segment.
      const ageOutPoint = Math.max(seg.start, windowStart) + excessMs;
      return ageOutPoint + WINDOW_MS;
    }
    excessMs -= segInWindow;
  }

  // Shouldn't reach here, but fallback
  return now + WINDOW_MS;
}

// === Segment Management ===
function maybeStartSegment() {
  if (currentSegment) return; // Already tracking

  if (windowFocused && activeTabDomain && LIMITS[activeTabDomain]) {
    // Don't start tracking if limit is already exceeded
    if (isLimitExceeded(activeTabDomain)) return;

    const now = Date.now();
    currentSegment = { domain: activeTabDomain, start: now, end: now };
  }
}

function finalizeSegment() {
  if (!currentSegment) return;
  // Only store if segment has meaningful duration (> 100ms)
  if (currentSegment.end - currentSegment.start > 100) {
    segments[currentSegment.domain].push({
      start: currentSegment.start,
      end: currentSegment.end
    });
    dirty = true;
  }
  currentSegment = null;
}

// === YouTube Video Segment (play-based, independent of focus) ===
function maybeStartYoutubeVideoSegment() {
  if (youtubeVideoSegment) return; // Already tracking
  if (youtubePlayingTabIds.size === 0) return; // No video playing
  // Don't use this if currentSegment is already tracking YouTube (avoid double-counting)
  if (currentSegment && currentSegment.domain === "youtube.com") return;
  if (isLimitExceeded("youtube.com")) return;

  const now = Date.now();
  youtubeVideoSegment = { domain: "youtube.com", start: now, end: now };
}

function finalizeYoutubeVideoSegment() {
  if (!youtubeVideoSegment) return;
  if (youtubeVideoSegment.end - youtubeVideoSegment.start > 100) {
    segments["youtube.com"].push({
      start: youtubeVideoSegment.start,
      end: youtubeVideoSegment.end
    });
    dirty = true;
  }
  youtubeVideoSegment = null;
}

function enforceYoutubeLimitAllTabs() {
  const blockedUrl = getBlockedUrl("timelimit", "youtube.com");
  browser.tabs.query({ url: "*://*.youtube.com/*" }).then(tabs => {
    for (const tab of tabs) {
      browser.tabs.update(tab.id, { url: blockedUrl }).catch(() => {});
    }
  }).catch(() => {});
  youtubePlayingTabIds.clear();
}

// === Tick (runs every 1s) ===
function tick() {
  const now = Date.now();
  const elapsed = now - lastTickTime;
  const isGap = elapsed > GAP_THRESHOLD;

  if (currentSegment) {
    if (isGap) {
      currentSegment.end = lastTickTime;
      finalizeSegment();
    } else {
      currentSegment.end = now;
      if (isLimitExceeded(currentSegment.domain)) {
        const domain = currentSegment.domain;
        finalizeSegment();
        enforceLimit(domain);
      }
    }
  }

  if (youtubeVideoSegment) {
    if (isGap) {
      youtubeVideoSegment.end = lastTickTime;
      finalizeYoutubeVideoSegment();
    } else {
      youtubeVideoSegment.end = now;
      if (isLimitExceeded("youtube.com")) {
        finalizeYoutubeVideoSegment();
        enforceYoutubeLimitAllTabs();
      }
    }
  }

  lastTickTime = now;

  if (isGap) {
    maybeStartSegment();
    maybeStartYoutubeVideoSegment();
  }
}

// === Enforcement ===
function getBlockedUrl(reason, domain) {
  return browser.runtime.getURL("blocked.html") +
    `?reason=${encodeURIComponent(reason)}` +
    (domain ? `&domain=${encodeURIComponent(domain)}` : "");
}

function enforceLimit(domain) {
  if (!activeTabId || !activeTabUrl) return;
  // Verify active tab is actually on this domain
  if (normalizeDomain(activeTabUrl) !== domain) return;

  const blockedUrl = getBlockedUrl("timelimit", domain);
  browser.tabs.update(activeTabId, { url: blockedUrl }).catch(() => {});
}

// === webRequest Blocking ===
// Registered synchronously at load time for startup race safety
browser.webRequest.onBeforeRequest.addListener(
  function (details) {
    // Return a promise that waits for init
    return initPromise.then(() => {
      const url = details.url;

      // Block Shorts URLs
      if (isShortsUrl(url)) {
        return { redirectUrl: getBlockedUrl("shorts") };
      }

      // Block if time limit exceeded
      const domain = normalizeDomain(url);
      if (domain && isLimitExceeded(domain)) {
        return { redirectUrl: getBlockedUrl("timelimit", domain) };
      }

      return {};
    });
  },
  { urls: ["*://*.youtube.com/*", "*://*.reddit.com/*"], types: ["main_frame"] },
  ["blocking"]
);

// === SPA Navigation Detection ===
browser.webNavigation.onHistoryStateUpdated.addListener(details => {
  // Only process top-frame navigations
  if (details.frameId !== 0) return;

  const url = details.url;

  // Block Shorts SPA navigation
  if (isShortsUrl(url)) {
    const blockedUrl = getBlockedUrl("shorts");
    browser.tabs.update(details.tabId, { url: blockedUrl }).catch(() => {});
    return;
  }

  // Block if time limit exceeded
  const domain = normalizeDomain(url);
  if (domain && isLimitExceeded(domain)) {
    const blockedUrl = getBlockedUrl("timelimit", domain);
    browser.tabs.update(details.tabId, { url: blockedUrl }).catch(() => {});
    return;
  }

  // Update active tab URL if this is the active tab
  if (details.tabId === activeTabId) {
    const oldDomain = activeTabDomain;
    activeTabUrl = url;
    activeTabDomain = domain;

    if (oldDomain !== domain) {
      finalizeSegment();
      maybeStartSegment();
    }
  }
});

// === Tab Tracking ===
browser.tabs.onActivated.addListener(activeInfo => {
  finalizeSegment();
  activeTabId = activeInfo.tabId;

  browser.tabs.get(activeInfo.tabId).then(tab => {
    activeTabUrl = tab.url || null;
    activeTabDomain = normalizeDomain(tab.url);

    if (activeTabDomain === "youtube.com") {
      // Switching TO YouTube: currentSegment takes over, stop video segment
      finalizeYoutubeVideoSegment();
    } else {
      // Switching AWAY from YouTube: start video segment if a video is playing
      maybeStartYoutubeVideoSegment();
    }

    maybeStartSegment();
  }).catch(() => {
    activeTabUrl = null;
    activeTabDomain = null;
    maybeStartYoutubeVideoSegment();
  });
});

browser.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  // Clean up YouTube playing state if a tab navigates away from YouTube
  if (changeInfo.url && youtubePlayingTabIds.has(tabId)) {
    if (normalizeDomain(changeInfo.url) !== "youtube.com") {
      youtubePlayingTabIds.delete(tabId);
      if (youtubePlayingTabIds.size === 0) {
        finalizeYoutubeVideoSegment();
      }
    }
  }

  if (tabId !== activeTabId) return;
  if (!changeInfo.url) return;

  const oldDomain = activeTabDomain;
  activeTabUrl = changeInfo.url;
  activeTabDomain = normalizeDomain(changeInfo.url);

  if (oldDomain !== activeTabDomain) {
    finalizeSegment();
    maybeStartSegment();
  }
});

browser.tabs.onRemoved.addListener(tabId => {
  // Clean up YouTube playing state
  if (youtubePlayingTabIds.delete(tabId) && youtubePlayingTabIds.size === 0) {
    finalizeYoutubeVideoSegment();
  }

  if (tabId !== activeTabId) return;
  finalizeSegment();
  activeTabId = null;
  activeTabUrl = null;
  activeTabDomain = null;
});

browser.windows.onFocusChanged.addListener(windowId => {
  if (windowId === browser.windows.WINDOW_ID_NONE) {
    // Browser lost focus
    windowFocused = false;
    finalizeSegment();
    // If YouTube was focused and a video is playing, switch to video segment
    maybeStartYoutubeVideoSegment();
  } else {
    windowFocused = true;
    // Re-query active tab in the focused window
    browser.tabs.query({ active: true, windowId }).then(tabs => {
      if (tabs.length > 0) {
        activeTabId = tabs[0].id;
        activeTabUrl = tabs[0].url || null;
        activeTabDomain = normalizeDomain(tabs[0].url);
      }
      // If switching to YouTube tab, currentSegment takes over
      if (activeTabDomain === "youtube.com") {
        finalizeYoutubeVideoSegment();
      }
      maybeStartSegment();
    }).catch(() => {});
  }
});

// === Message API ===
browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "youtubeVideoState") {
    const tabId = sender.tab.id;
    if (message.playing) {
      youtubePlayingTabIds.add(tabId);
      maybeStartYoutubeVideoSegment();
    } else {
      youtubePlayingTabIds.delete(tabId);
      if (youtubePlayingTabIds.size === 0) {
        finalizeYoutubeVideoSegment();
      }
    }
    return;
  }

  if (message.type === "getStatus") {
    const status = {};
    for (const domain of Object.keys(LIMITS)) {
      const usage = getUsageSeconds(domain);
      const limit = LIMITS[domain];
      const exceeded = usage >= limit;
      let cooldownEnd = null;
      if (exceeded) {
        cooldownEnd = getCooldownEnd(domain);
      }
      status[domain] = {
        usageSeconds: Math.round(usage),
        limitSeconds: limit,
        exceeded,
        cooldownEnd
      };
    }
    sendResponse(status);
  }
});

// === Persistence ===
function persistSegments() {
  if (!dirty) return;
  dirty = false;
  browser.storage.local.set({ segments }).catch(e => {
    console.error("Failed to persist segments:", e);
    dirty = true; // Retry next cycle
  });
}

// === Cleanup ===
function pruneOldSegments() {
  const cutoff = Date.now() - WINDOW_MS;
  for (const domain of Object.keys(segments)) {
    segments[domain] = segments[domain].filter(seg => seg.end > cutoff);
  }
  dirty = true;
}

// === Timers ===
setInterval(tick, TICK_INTERVAL);
setInterval(persistSegments, PERSIST_INTERVAL);
setInterval(pruneOldSegments, CLEANUP_INTERVAL);
