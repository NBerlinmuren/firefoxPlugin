# CLAUDE.md

## Project Overview

Firefox extension that blocks YouTube Shorts and limits time on YouTube (20 min) and Reddit (15 min) per rolling 3-hour window.

## Architecture

- **background.js** — Authoritative time tracker. Manages time segments, enforces limits via webRequest blocking, SPA navigation detection, and tab redirection. Tracks YouTube separately: focus-based (`currentSegment`) for active tab, play-based (`youtubeVideoSegment`) for background video playback.
- **content-youtube-video.js** — Monitors YouTube `<video>` element play/pause state, reports to background script.
- **content-shorts.js** / **content-shorts.css** — Hides YouTube Shorts elements in the DOM.
- **content-limit.js** — Backup enforcement: polls background every 5s and redirects if limit exceeded.
- **popup.js** / **popup.html** — Browser action popup showing usage/remaining time.
- **blocked.js** / **blocked.html** — Blocked page UI.

## Release Process

Every push to `master` triggers the GitHub Actions workflow (`.github/workflows/release.yml`) which signs the extension via Mozilla AMO and creates a GitHub Release.

**IMPORTANT: Bump the version in `manifest.json` whenever making changes that will be pushed.** AMO rejects uploads with a version that already exists. The version must be incremented before pushing to avoid CI failure.

## Key Technical Details

- Manifest V2 (Firefox)
- Uses `browser.*` APIs (not `chrome.*`)
- Background script is persistent (`"persistent": true`)
- Time tracking uses millisecond-precision segments with a 3-hour rolling window
