"use strict";

const VALID_REASONS = ["shorts", "timelimit"];
const VALID_DOMAINS = ["youtube.com", "reddit.com"];

const params = new URLSearchParams(window.location.search);
const reason = VALID_REASONS.includes(params.get("reason")) ? params.get("reason") : "shorts";
const domain = VALID_DOMAINS.includes(params.get("domain")) ? params.get("domain") : null;

const iconEl = document.getElementById("icon");
const titleEl = document.getElementById("title");
const messageEl = document.getElementById("message");
const domainBadgeEl = document.getElementById("domain-badge");
const cooldownEl = document.getElementById("cooldown");
const cooldownLabelEl = document.getElementById("cooldown-label");

function formatTime(seconds) {
  const s = Math.max(0, Math.ceil(seconds));
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${m}:${String(sec).padStart(2, "0")}`;
}

if (reason === "shorts") {
  iconEl.textContent = "\u{1F6AB}";
  titleEl.textContent = "YouTube Shorts Blocked";
  messageEl.textContent = "YouTube Shorts are permanently blocked by your extension.";
} else if (reason === "timelimit") {
  iconEl.textContent = "\u{23F0}";
  titleEl.textContent = "Time Limit Reached";

  if (domain) {
    domainBadgeEl.style.display = "inline-block";
    domainBadgeEl.textContent = domain;
  }

  messageEl.textContent = "You've used your allotted time. Take a break!";
  cooldownEl.style.display = "block";
  cooldownLabelEl.style.display = "block";
  cooldownLabelEl.textContent = "Available again in";

  function updateCooldown() {
    browser.runtime.sendMessage({ type: "getStatus" }).then(status => {
      if (!domain || !status[domain]) return;

      const info = status[domain];
      if (!info.exceeded) {
        cooldownEl.textContent = "Available now!";
        cooldownEl.style.color = "#66bb6a";
        cooldownLabelEl.textContent = "Refresh the page or navigate back";
        return;
      }

      if (info.cooldownEnd) {
        const remaining = (info.cooldownEnd - Date.now()) / 1000;
        cooldownEl.textContent = formatTime(remaining);
      }
    }).catch(() => {
      // Extension context may be invalid
    });
  }

  updateCooldown();
  setInterval(updateCooldown, 1000);
}
