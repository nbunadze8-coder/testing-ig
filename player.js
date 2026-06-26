'use strict';
/* ==========================================================================
   player.js — Video player engine + custom controls
   Supports 5 source kinds: mp4 (native <video>), hls (video + hls.js),
   youtube (IFrame API), vimeo (Player SDK), iframe (generic, limited control).
   ========================================================================== */

const Player = (() => {
  const SAVE_INTERVAL_MS = 15000;
  const HLS_CDN = 'https://cdn.jsdelivr.net/npm/hls.js@latest/dist/hls.min.js';
  const YT_API_SRC = 'https://www.youtube.com/iframe_api';
  const VIMEO_API_SRC = 'https://player.vimeo.com/api/player.js';
  const speedOptions = [0.5, 0.75, 1, 1.25, 1.5, 2];

  let movie = null;
  let kind = null;            // 'native' | 'youtube' | 'vimeo' | 'iframe'
  let videoEl = null;
  let iframeEl = null;
  let hlsInstance = null;
  let ytPlayer = null;
  let vimeoPlayer = null;
  let ytPollTimer = null;
  let saveTimer = null;
  let hideTimer = null;
  let touchStartX = null;

  let currentTime = 0;
  let duration = 0;
  let isPlaying = false;
  let muted = false;
  let speedIndex = 2; // default 1x

  const els = {};
  const _scriptPromises = {};

  /* ---------------------------------------------------------------- */
  /* DOM caching + one-time wiring                                     */
  /* ---------------------------------------------------------------- */

  function cacheEls() {
    els.modal = document.getElementById('player-modal');
    els.wrapper = document.getElementById('player-wrapper');
    els.controls = document.getElementById('player-controls');
    els.progressFill = document.getElementById('progress-fill');
    els.progressBuffered = document.getElementById('progress-buffered');
    els.progressRange = document.getElementById('progress-range');
    els.btnPlay = document.getElementById('btn-play');
    els.btnRewind = document.getElementById('btn-rewind');
    els.btnForward = document.getElementById('btn-forward');
    els.btnMute = document.getElementById('btn-mute');
    els.volumeRange = document.getElementById('volume-range');
    els.timeDisplay = document.getElementById('time-display');
    els.btnSpeed = document.getElementById('btn-speed');
    els.btnPip = document.getElementById('btn-pip');
    els.btnFullscreen = document.getElementById('btn-fullscreen');
    els.btnClose = document.getElementById('btn-close-player');
    els.nowTitle = document.getElementById('now-playing-title');
    els.nowMeta = document.getElementById('now-playing-meta');
    els.btnSkip = document.getElementById('btn-skip');
  }

  // Called once from App.init(). Binds every static control — open()/close()
  // only ever touch the *contents* of #player-wrapper, never re-bind listeners.
  function init() {
    cacheEls();
    if (!els.modal) return;

    on(els.btnPlay, 'click', togglePlay);
    on(els.btnRewind, 'click', () => rewind(10));
    on(els.btnForward, 'click', () => forward(30));
    on(els.btnMute, 'click', toggleMute);
    on(els.volumeRange, 'input', (e) => setVolume(parseFloat(e.target.value)));
    on(els.btnSpeed, 'click', () => cycleSpeed(1));
    on(els.btnPip, 'click', togglePiP);
    on(els.btnFullscreen, 'click', toggleFullscreen);
    on(els.btnClose, 'click', close);
    on(els.btnSkip, 'click', () => { forward(85); els.btnSkip.classList.add('hidden'); });

    on(els.progressRange, 'input', (e) => seekTo(parseFloat(e.target.value) / 100));

    on(els.modal, 'mousemove', showControls);
    on(els.modal, 'touchstart', (e) => { showControls(); touchStartX = e.touches[0].clientX; }, { passive: true });
    on(els.modal, 'touchend', handleSwipeEnd, { passive: true });

    document.addEventListener('keydown', handleKeyboard);
    document.addEventListener('visibilitychange', () => { if (document.hidden && movie) saveProgress(); });
    window.addEventListener('beforeunload', () => { if (movie) saveProgress(); });
  }

  function on(el, evt, handler, opts) { if (el) el.addEventListener(evt, handler, opts); }

  /* ---------------------------------------------------------------- */
  /* Open / close                                                       */
  /* ---------------------------------------------------------------- */

  async function open(movieObj, startPosition) {
    if (!els.modal) cacheEls();
    if (!els.modal || !movieObj) return;
    teardown();

    movie = movieObj;
    currentTime = startPosition || 0;
    duration = 0;
    isPlaying = false;
    muted = false;
    speedIndex = 2;

    els.modal.classList.remove('hidden', 'controls-hidden', 'paused');
    document.body.style.overflow = 'hidden';

    if (els.nowTitle) els.nowTitle.textContent = movie.title || 'Untitled';
    if (els.nowMeta) els.nowMeta.textContent = [movie.year, (movie.genre || []).join(', ')].filter(Boolean).join(' · ');
    if (els.btnSpeed) els.btnSpeed.textContent = '1×';
    if (els.btnSkip) els.btnSkip.classList.add('hidden');
    resetControlAvailability();

    if (!navigator.onLine && movie.videoType !== 'iframe') {
      showError("You're offline — streaming this needs an internet connection. Everything else in CinemaVault still works.");
      return;
    }

    // Resolve a resume point: an explicit startPosition (e.g. "Resume" button)
    // always wins; otherwise fall back to the saved position if autoResume is on.
    let resumeFrom = startPosition || 0;
    if (!resumeFrom) {
      const autoResume = await DB.settings.get('autoResume');
      if (autoResume) {
        const existing = await DB.progress.get(movie.id);
        if (existing && existing.position > 5 && !existing.completed) resumeFrom = existing.position;
      }
    }

    switch (movie.videoType) {
      case 'hls': buildNativeVideo(resumeFrom, true); break;
      case 'youtube': buildYouTube(resumeFrom); break;
      case 'vimeo': buildVimeo(resumeFrom); break;
      case 'iframe': buildGenericIframe(); break;
      default: buildNativeVideo(resumeFrom, false); break; // mp4
    }

    if (resumeFrom > 1) UI.toast(`Resumed from ${formatTime(resumeFrom)}`, 'info');

    clearInterval(saveTimer);
    saveTimer = setInterval(() => { if (isPlaying) saveProgress(); }, SAVE_INTERVAL_MS);

    showControls();
  }

  function close() {
    if (movie) saveProgress();
    quietPause();
    clearInterval(saveTimer);
    clearTimeout(hideTimer);
    teardown();
    if (els.modal) els.modal.classList.add('hidden');
    document.body.style.overflow = '';
    if (document.fullscreenElement) { (document.exitFullscreen || function () {}).call(document); }
    movie = null;
  }

  function quietPause() {
    try {
      if (kind === 'native' && videoEl) videoEl.pause();
      else if (kind === 'youtube' && ytPlayer && ytPlayer.pauseVideo) ytPlayer.pauseVideo();
      else if (kind === 'vimeo' && vimeoPlayer) vimeoPlayer.pause();
    } catch (e) { /* player may already be torn down */ }
  }

  function teardown() {
    clearInterval(ytPollTimer);
    if (videoEl) { videoEl.removeAttribute('src'); try { videoEl.load(); } catch (e) {} videoEl = null; }
    if (hlsInstance) { hlsInstance.destroy(); hlsInstance = null; }
    if (ytPlayer) { try { ytPlayer.destroy(); } catch (e) {} ytPlayer = null; }
    if (vimeoPlayer) { try { vimeoPlayer.unload(); } catch (e) {} vimeoPlayer = null; }
    iframeEl = null;
    if (els.wrapper) els.wrapper.innerHTML = '';
    kind = null;
  }

  /* ---------------------------------------------------------------- */
  /* Source builders                                                    */
  /* ---------------------------------------------------------------- */

  function buildNativeVideo(startPosition, isHls) {
    els.wrapper.innerHTML = '<div class="spinner" id="player-spinner"></div>';
    videoEl = document.createElement('video');
    videoEl.setAttribute('playsinline', '');
    videoEl.setAttribute('webkit-playsinline', '');
    videoEl.controls = false;
    videoEl.preload = 'metadata';
    videoEl.volume = 1;
    els.wrapper.appendChild(videoEl);
    kind = 'native';

    if (isHls) {
      loadScriptOnce(HLS_CDN, 'hls').then(() => {
        if (window.Hls && window.Hls.isSupported()) {
          hlsInstance = new window.Hls();
          hlsInstance.loadSource(movie.videoUrl);
          hlsInstance.attachMedia(videoEl);
        } else if (videoEl.canPlayType('application/vnd.apple.mpegurl')) {
          videoEl.src = movie.videoUrl; // Safari has native HLS support
        } else {
          showError('HLS playback is not supported in this browser.');
          return;
        }
        attachNativeListeners(startPosition);
      }).catch(() => showError('Could not load the HLS playback engine. Check your connection.'));
    } else {
      videoEl.src = movie.videoUrl;
      attachNativeListeners(startPosition);
    }
  }

  function attachNativeListeners(startPosition) {
    const removeSpinner = () => { const s = document.getElementById('player-spinner'); if (s) s.remove(); };

    videoEl.addEventListener('loadedmetadata', () => {
      duration = videoEl.duration || 0;
      if (startPosition > 0 && startPosition < duration) videoEl.currentTime = startPosition;
      currentTime = videoEl.currentTime;
      updateProgressUI();
    });
    videoEl.addEventListener('loadeddata', removeSpinner, { once: true });
    videoEl.addEventListener('timeupdate', () => {
      currentTime = videoEl.currentTime;
      updateProgressUI();
      handleSkipIntroVisibility();
    });
    videoEl.addEventListener('play', () => { isPlaying = true; updatePlayButtonIcon(); els.modal.classList.remove('paused'); });
    videoEl.addEventListener('pause', () => { isPlaying = false; updatePlayButtonIcon(); els.modal.classList.add('paused'); saveProgress(); });
    videoEl.addEventListener('ended', handleEnded);
    videoEl.addEventListener('volumechange', () => { muted = videoEl.muted || videoEl.volume === 0; updateMuteIcon(); });
    videoEl.addEventListener('error', () => { removeSpinner(); showError('This video could not be loaded — the source link may be broken or blocked by CORS.'); });

    videoEl.play().then(() => { isPlaying = true; updatePlayButtonIcon(); }).catch(() => {
      isPlaying = false; updatePlayButtonIcon(); // autoplay blocked — user presses play manually
    });
  }

  function buildYouTube(startPosition) {
    const id = extractYouTubeId(movie.videoUrl);
    if (!id) { showError("Could not read a YouTube video ID from this movie's URL."); return; }
    kind = 'youtube';
    els.wrapper.innerHTML = '<div id="yt-player-target"></div>';

    loadScriptOnce(YT_API_SRC, 'yt').then(waitForYT).then(() => {
      ytPlayer = new window.YT.Player('yt-player-target', {
        videoId: id,
        playerVars: { autoplay: 1, controls: 0, rel: 0, modestbranding: 1, enablejsapi: 1, playsinline: 1 },
        events: {
          onReady: () => {
            duration = ytPlayer.getDuration() || 0;
            if (startPosition > 0) ytPlayer.seekTo(startPosition, true);
            ytPlayer.playVideo();
            isPlaying = true;
            updatePlayButtonIcon();
            clearInterval(ytPollTimer);
            ytPollTimer = setInterval(() => {
              if (!ytPlayer) return;
              currentTime = ytPlayer.getCurrentTime() || 0;
              duration = ytPlayer.getDuration() || duration;
              updateProgressUI();
              handleSkipIntroVisibility();
            }, 500);
          },
          onStateChange: (e) => {
            isPlaying = e.data === window.YT.PlayerState.PLAYING;
            updatePlayButtonIcon();
            els.modal.classList.toggle('paused', !isPlaying);
            if (e.data === window.YT.PlayerState.ENDED) handleEnded();
          },
          onError: () => showError("This YouTube video can't be played here — it may be embed-restricted by its owner.")
        }
      });
    }).catch(() => showError('Could not load the YouTube player. Check your connection.'));
  }

  function buildVimeo(startPosition) {
    const id = extractVimeoId(movie.videoUrl);
    if (!id) { showError("Could not read a Vimeo video ID from this movie's URL."); return; }
    kind = 'vimeo';
    iframeEl = document.createElement('iframe');
    iframeEl.src = `https://player.vimeo.com/video/${id}?autoplay=1&controls=0&playsinline=1`;
    iframeEl.setAttribute('allow', 'autoplay; fullscreen; picture-in-picture');
    iframeEl.setAttribute('allowfullscreen', '');
    els.wrapper.innerHTML = '';
    els.wrapper.appendChild(iframeEl);

    loadScriptOnce(VIMEO_API_SRC, 'vimeo').then(() => {
      vimeoPlayer = new window.Vimeo.Player(iframeEl);
      vimeoPlayer.getDuration().then((d) => { duration = d || 0; });
      if (startPosition > 0) vimeoPlayer.setCurrentTime(startPosition).catch(() => {});
      vimeoPlayer.play().then(() => { isPlaying = true; updatePlayButtonIcon(); }).catch(() => {});
      vimeoPlayer.on('timeupdate', (data) => {
        currentTime = data.seconds; duration = data.duration || duration;
        updateProgressUI(); handleSkipIntroVisibility();
      });
      vimeoPlayer.on('play', () => { isPlaying = true; updatePlayButtonIcon(); els.modal.classList.remove('paused'); });
      vimeoPlayer.on('pause', () => { isPlaying = false; updatePlayButtonIcon(); els.modal.classList.add('paused'); saveProgress(); });
      vimeoPlayer.on('ended', handleEnded);
    }).catch(() => showError('Could not load the Vimeo player. Check your connection.'));
  }

  function buildGenericIframe() {
    kind = 'iframe';
    iframeEl = document.createElement('iframe');
    iframeEl.src = movie.videoUrl;
    iframeEl.setAttribute('allow', 'autoplay; fullscreen; picture-in-picture');
    iframeEl.setAttribute('allowfullscreen', '');
    els.wrapper.innerHTML = '';
    els.wrapper.appendChild(iframeEl);
    UI.toast('This source plays in its own embedded player — playback, seek, and volume controls are limited.', 'info');
  }

  function showError(message) {
    if (!els.wrapper) return;
    els.wrapper.innerHTML = `<div class="player-error"><div class="err-icon">⚠</div><p>${escapeHtml(message)}</p></div>`;
  }

  /* ---------------------------------------------------------------- */
  /* Playback controls (dispatch across the 4 backends)                */
  /* ---------------------------------------------------------------- */

  function play() {
    if (kind === 'native' && videoEl) videoEl.play().catch(() => {});
    else if (kind === 'youtube' && ytPlayer) ytPlayer.playVideo();
    else if (kind === 'vimeo' && vimeoPlayer) vimeoPlayer.play().catch(() => {});
    isPlaying = true;
    updatePlayButtonIcon();
    if (els.modal) els.modal.classList.remove('paused');
    showControls();
  }

  function pause() {
    if (kind === 'native' && videoEl) videoEl.pause();
    else if (kind === 'youtube' && ytPlayer) ytPlayer.pauseVideo();
    else if (kind === 'vimeo' && vimeoPlayer) vimeoPlayer.pause().catch(() => {});
    isPlaying = false;
    updatePlayButtonIcon();
    if (els.modal) els.modal.classList.add('paused');
    saveProgress();
  }

  function togglePlay() { isPlaying ? pause() : play(); }

  function seek(seconds) {
    seconds = Math.max(0, duration ? Math.min(duration, seconds) : seconds);
    if (kind === 'native' && videoEl) videoEl.currentTime = seconds;
    else if (kind === 'youtube' && ytPlayer) ytPlayer.seekTo(seconds, true);
    else if (kind === 'vimeo' && vimeoPlayer) vimeoPlayer.setCurrentTime(seconds).catch(() => {});
    currentTime = seconds;
    updateProgressUI();
    saveProgress();
  }

  function seekTo(fraction) { seek(fraction * duration); }
  function rewind(seconds = 10) { seek(currentTime - seconds); }
  function forward(seconds = 30) { seek(currentTime + seconds); }

  function setVolume(level) {
    level = Math.max(0, Math.min(1, level));
    if (kind === 'native' && videoEl) videoEl.volume = level;
    else if (kind === 'youtube' && ytPlayer) ytPlayer.setVolume(level * 100);
    else if (kind === 'vimeo' && vimeoPlayer) vimeoPlayer.setVolume(level).catch(() => {});
    if (els.volumeRange) els.volumeRange.value = level;
    muted = level === 0;
    updateMuteIcon();
  }

  function getVolume() {
    if (kind === 'native' && videoEl) return videoEl.muted ? 0 : videoEl.volume;
    return els.volumeRange ? parseFloat(els.volumeRange.value) : 1;
  }

  function toggleMute() {
    if (kind === 'native' && videoEl) { videoEl.muted = !videoEl.muted; muted = videoEl.muted; updateMuteIcon(); }
    else if (kind === 'youtube' && ytPlayer) { muted ? ytPlayer.unMute() : ytPlayer.mute(); muted = !muted; updateMuteIcon(); }
    else if (kind === 'vimeo' && vimeoPlayer) {
      vimeoPlayer.getVolume().then((v) => {
        const next = v > 0 ? 0 : 1;
        vimeoPlayer.setVolume(next);
        muted = next === 0;
        updateMuteIcon();
      });
    }
  }

  function cycleSpeed(dir = 1) {
    speedIndex = (speedIndex + dir + speedOptions.length) % speedOptions.length;
    const rate = speedOptions[speedIndex];
    if (kind === 'native' && videoEl) videoEl.playbackRate = rate;
    else if (kind === 'youtube' && ytPlayer) ytPlayer.setPlaybackRate(rate);
    else if (kind === 'vimeo' && vimeoPlayer && vimeoPlayer.setPlaybackRate) vimeoPlayer.setPlaybackRate(rate).catch(() => {});
    if (els.btnSpeed) els.btnSpeed.textContent = rate + '×';
  }

  function toggleFullscreen() {
    if (!els.modal) return;
    if (!document.fullscreenElement) {
      const req = els.modal.requestFullscreen || els.modal.webkitRequestFullscreen;
      if (req) req.call(els.modal);
    } else {
      const exit = document.exitFullscreen || document.webkitExitFullscreen;
      if (exit) exit.call(document);
    }
  }

  function togglePiP() {
    if (kind !== 'native' || !videoEl) {
      UI.toast('Picture-in-Picture only works with direct video files (MP4/HLS).', 'info');
      return;
    }
    if (document.pictureInPictureElement) {
      document.exitPictureInPicture().catch(() => {});
    } else if (videoEl.requestPictureInPicture) {
      videoEl.requestPictureInPicture().catch(() => UI.toast('Picture-in-Picture is not available right now.', 'error'));
    }
  }

  /* ---------------------------------------------------------------- */
  /* Progress persistence + UI sync                                    */
  /* ---------------------------------------------------------------- */

  async function saveProgress() {
    if (!movie || !duration) return;
    await DB.progress.save(movie.id, currentTime, duration);
  }

  function updateProgressUI() {
    const pct = duration > 0 ? (currentTime / duration) * 100 : 0;
    if (els.progressFill) els.progressFill.style.width = pct + '%';
    if (els.progressRange) els.progressRange.value = pct;
    if (els.timeDisplay) els.timeDisplay.textContent = `${formatTime(currentTime)} / ${formatTime(duration)}`;
    if (kind === 'native' && videoEl && videoEl.buffered && videoEl.buffered.length) {
      const bufferedEnd = videoEl.buffered.end(videoEl.buffered.length - 1);
      const bufPct = duration > 0 ? (bufferedEnd / duration) * 100 : 0;
      if (els.progressBuffered) els.progressBuffered.style.width = bufPct + '%';
    }
  }

  function handleSkipIntroVisibility() {
    if (!els.btnSkip) return;
    const show = duration > 300 && currentTime > 3 && currentTime < 90;
    els.btnSkip.classList.toggle('hidden', !show);
  }

  async function handleEnded() {
    isPlaying = false;
    updatePlayButtonIcon();
    if (movie) await DB.progress.save(movie.id, duration, duration); // marks completed (≥95%)
    UI.toast('Playback finished', 'info');
  }

  function updatePlayButtonIcon() { if (els.btnPlay) els.btnPlay.textContent = isPlaying ? '⏸' : '▶'; }
  function updateMuteIcon() { if (els.btnMute) els.btnMute.textContent = muted ? '🔇' : '🔊'; }

  function formatTime(seconds) {
    seconds = Math.max(0, Math.floor(seconds || 0));
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    const mm = h > 0 ? String(m).padStart(2, '0') : String(m);
    const ss = String(s).padStart(2, '0');
    return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
  }

  function escapeHtml(str) {
    return String(str == null ? '' : str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  /* ---------------------------------------------------------------- */
  /* Controls auto-hide                                                */
  /* ---------------------------------------------------------------- */

  function showControls() {
    if (!els.modal) return;
    els.modal.classList.remove('controls-hidden');
    clearTimeout(hideTimer);
    if (isPlaying) hideTimer = setTimeout(hideControls, 3000);
  }

  function hideControls() {
    if (isPlaying && els.modal) els.modal.classList.add('controls-hidden');
  }

  function resetControlAvailability() {
    const limited = movie.videoType === 'iframe';
    [els.btnRewind, els.btnForward, els.volumeRange, els.btnMute, els.btnSpeed, els.btnPip, els.progressRange].forEach((el) => {
      if (!el) return;
      el.disabled = limited;
      el.style.opacity = limited ? '0.35' : '';
      el.style.pointerEvents = limited ? 'none' : '';
    });
  }

  /* ---------------------------------------------------------------- */
  /* Keyboard + touch                                                   */
  /* ---------------------------------------------------------------- */

  function handleKeyboard(e) {
    if (!els.modal || els.modal.classList.contains('hidden')) return;
    const tag = (e.target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea') return;

    if (/^[0-9]$/.test(e.key)) { seekTo(parseInt(e.key, 10) / 10); showControls(); return; }

    switch (e.key) {
      case ' ': case 'k': e.preventDefault(); togglePlay(); break;
      case 'ArrowLeft': case 'j': rewind(10); break;
      case 'ArrowRight': case 'l': forward(30); break;
      case 'ArrowUp': e.preventDefault(); setVolume(getVolume() + 0.1); break;
      case 'ArrowDown': e.preventDefault(); setVolume(getVolume() - 0.1); break;
      case 'm': toggleMute(); break;
      case 'f': toggleFullscreen(); break;
      case 'p': togglePiP(); break;
      case 'Escape': close(); break;
      case '<': case ',': cycleSpeed(-1); break;
      case '>': case '.': cycleSpeed(1); break;
      default: return;
    }
    showControls();
  }

  function handleSwipeEnd(e) {
    if (touchStartX == null) return;
    const dx = e.changedTouches[0].clientX - touchStartX;
    if (Math.abs(dx) > 60) { dx > 0 ? forward(30) : rewind(10); }
    touchStartX = null;
  }

  /* ---------------------------------------------------------------- */
  /* URL parsing helpers                                                */
  /* ---------------------------------------------------------------- */

  function extractYouTubeId(url) {
    try {
      const u = new URL(url);
      if (u.hostname.includes('youtu.be')) return u.pathname.slice(1).split('/')[0] || null;
      if (u.searchParams.get('v')) return u.searchParams.get('v');
      const m = u.pathname.match(/\/(embed|shorts)\/([^/?]+)/);
      return m ? m[2] : null;
    } catch (e) { return null; }
  }

  function extractVimeoId(url) {
    try {
      const u = new URL(url);
      const m = u.pathname.match(/(\d{6,})/);
      return m ? m[1] : null;
    } catch (e) { return null; }
  }

  function loadScriptOnce(src, key) {
    if (_scriptPromises[key]) return _scriptPromises[key];
    _scriptPromises[key] = new Promise((resolve, reject) => {
      if (document.querySelector(`script[data-cv-script="${key}"]`)) { resolve(); return; }
      const script = document.createElement('script');
      script.src = src;
      script.async = true;
      script.dataset.cvScript = key;
      script.onload = () => resolve();
      script.onerror = () => reject(new Error('Failed to load ' + src));
      document.head.appendChild(script);
    });
    return _scriptPromises[key];
  }

  function waitForYT() {
    return new Promise((resolve) => {
      if (window.YT && window.YT.Player) { resolve(); return; }
      const prev = window.onYouTubeIframeAPIReady;
      window.onYouTubeIframeAPIReady = () => { if (prev) prev(); resolve(); };
    });
  }

  return {
    init, open, close, play, pause, togglePlay, seek, seekTo, rewind, forward,
    setVolume, toggleMute, cycleSpeed, toggleFullscreen, togglePiP,
    saveProgress, updateProgressUI, showControls, hideControls, handleKeyboard,
    get isOpen() { return !!(els.modal && !els.modal.classList.contains('hidden')); }
  };
})();

window.Player = Player;
