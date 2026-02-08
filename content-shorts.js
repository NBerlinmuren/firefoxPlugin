"use strict";

// MutationObserver fallback for dynamically added Shorts elements
// that the CSS :has() selectors might not catch.

function isShortsLink(el) {
  if (el.tagName !== "A") return false;
  const href = el.getAttribute("href");
  if (!href) return false;
  return /^\/shorts(\/|$)/.test(href) ||
         /^\/feed\/shorts(\/|$)/.test(href) ||
         /^\/@[^/]+\/shorts(\/|$)/.test(href) ||
         /^\/(channel|c|user)\/[^/]+\/shorts(\/|$)/.test(href);
}

function hideIfShortsContainer(node) {
  if (node.nodeType !== Node.ELEMENT_NODE) return;

  // Check if this element itself is a Shorts link container
  const links = node.querySelectorAll('a[href*="/shorts"]');
  for (const link of links) {
    if (isShortsLink(link)) {
      // Walk up to find the renderer/shelf container to hide
      const container = link.closest(
        "ytd-rich-shelf-renderer, ytd-reel-shelf-renderer, " +
        "ytd-video-renderer, ytd-reel-item-renderer, " +
        "ytd-compact-video-renderer, ytd-grid-video-renderer, " +
        "ytd-guide-entry-renderer, ytd-mini-guide-entry-renderer, " +
        "ytd-notification-renderer"
      );
      if (container) {
        container.style.display = "none";
      }
    }
  }
}

const observer = new MutationObserver(mutations => {
  for (const mutation of mutations) {
    for (const node of mutation.addedNodes) {
      hideIfShortsContainer(node);
    }
  }
});

observer.observe(document.documentElement, {
  childList: true,
  subtree: true
});
