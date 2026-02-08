"use strict";

// Backup mid-session enforcement: polls background every 5s
// and redirects if the time limit is exceeded.

function checkLimit() {
  browser.runtime.sendMessage({ type: "getStatus" }).then(status => {
    // Determine which domain we're on
    const hostname = window.location.hostname;
    let domain = null;
    if (hostname === "youtube.com" || hostname.endsWith(".youtube.com")) {
      domain = "youtube.com";
    } else if (hostname === "reddit.com" || hostname.endsWith(".reddit.com")) {
      domain = "reddit.com";
    }

    if (!domain || !status[domain]) return;

    if (status[domain].exceeded) {
      const blockedUrl = browser.runtime.getURL("blocked.html") +
        `?reason=timelimit&domain=${encodeURIComponent(domain)}`;
      window.location.href = blockedUrl;
    }
  }).catch(() => {
    // Extension context may be invalid (e.g. extension reloaded)
  });
}

checkLimit();
setInterval(checkLimit, 5000);
