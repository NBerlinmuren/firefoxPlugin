"use strict";

// Monitors YouTube video play/pause state and reports to background script.
// This allows the background to track YouTube usage even when the tab is not focused.

(function () {
  let currentVideo = null;
  let reportedPlaying = false;

  function sendState(playing) {
    if (playing === reportedPlaying) return;
    reportedPlaying = playing;
    browser.runtime.sendMessage({ type: "youtubeVideoState", playing }).catch(() => {});
  }

  function onPlay() { sendState(true); }
  function onPause() { sendState(false); }
  function onEnded() { sendState(false); }

  function attachToVideo(video) {
    if (video === currentVideo) return;
    detachFromVideo();
    currentVideo = video;
    video.addEventListener("play", onPlay);
    video.addEventListener("playing", onPlay);
    video.addEventListener("pause", onPause);
    video.addEventListener("ended", onEnded);
    video.addEventListener("emptied", onPause);

    // Report current state immediately
    sendState(!video.paused && !video.ended);
  }

  function detachFromVideo() {
    if (!currentVideo) return;
    currentVideo.removeEventListener("play", onPlay);
    currentVideo.removeEventListener("playing", onPlay);
    currentVideo.removeEventListener("pause", onPause);
    currentVideo.removeEventListener("ended", onEnded);
    currentVideo.removeEventListener("emptied", onPause);
    currentVideo = null;
    sendState(false);
  }

  function findAndAttach() {
    const video = document.querySelector("video.html5-main-video")
      || document.querySelector("#movie_player video")
      || document.querySelector("video");
    if (video) {
      attachToVideo(video);
    }
  }

  findAndAttach();

  // Watch for video element additions (YouTube SPA navigation, lazy loading)
  const observer = new MutationObserver(findAndAttach);
  observer.observe(document.documentElement, { childList: true, subtree: true });

  // Report not playing on page unload
  window.addEventListener("beforeunload", () => {
    sendState(false);
  });
})();
