"use strict";

function formatTime(seconds) {
  const s = Math.max(0, Math.round(seconds));
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${m}:${String(sec).padStart(2, "0")}`;
}

function updateUI() {
  browser.runtime.sendMessage({ type: "getStatus" }).then(status => {
    updateSite("youtube", status["youtube.com"]);
    updateSite("reddit", status["reddit.com"]);
  }).catch(() => {
    // Extension context may be invalid
  });
}

function updateSite(prefix, info) {
  if (!info) return;

  const timeEl = document.getElementById(`${prefix}-time`);
  const barEl = document.getElementById(`${prefix}-bar`);
  const statusEl = document.getElementById(`${prefix}-status`);

  const usage = info.usageSeconds;
  const limit = info.limitSeconds;
  const pct = Math.min(100, (usage / limit) * 100);

  timeEl.textContent = `${formatTime(usage)} / ${formatTime(limit)}`;

  barEl.style.width = `${pct}%`;
  barEl.classList.remove("yellow", "red");
  if (pct >= 100) {
    barEl.classList.add("red");
  } else if (pct >= 75) {
    barEl.classList.add("yellow");
  }

  if (info.exceeded) {
    statusEl.classList.add("exceeded");
    if (info.cooldownEnd) {
      const remaining = (info.cooldownEnd - Date.now()) / 1000;
      statusEl.textContent = `Limit reached \u2014 available in ${formatTime(remaining)}`;
    } else {
      statusEl.textContent = "Limit reached";
    }
  } else {
    statusEl.classList.remove("exceeded");
    const remaining = limit - usage;
    statusEl.textContent = `${formatTime(remaining)} remaining`;
  }
}

updateUI();
setInterval(updateUI, 1000);
