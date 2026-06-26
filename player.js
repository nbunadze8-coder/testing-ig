'use strict';

/**
 * CinemaVault — player.js
 * Video player engine: supports mp4, hls, youtube, vimeo, iframe.
 * Handles controls, progress saving, keyboard shortcuts, PiP.
 */

const Player = (() => {

  /* ─── State ───────────────────────────────────────────────── */
  let videoEl         = null;
  let iframeEl        = null;
  let currentMovie    = null;
  let duration        = 0;
  let isPlaying       = false;
  let isMuted         = false;
  let controlsVisible = true;
  let hideControlsTimer = null;
  let saveTimer       = null;
  let hlsInstance     = null;

  const speedOptions = [0.5, 0.75, 1, 1.25, 1.5, 2];
  let   speedIndex   = 2; // default 1×

  /* ─── DOM refs (resolved on open) ───────────────────────────── */
  const $ = id => document.getElementById(id);

  /* ─── Format time ──────────────────────────────────────────── */
  function _fmt(secs) {
    if (!isFinite(secs) || secs < 0) secs = 0;
    const h = Math.floor(secs / 3600);
    const m = Math.floor((secs % 3600) / 60);
    const s = Math.floor(secs % 60);
    return h > 0
      ? `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`
      : `${m}:${String(s).padStart(2,'0')}`;
  }

  /* ─── Open player ─────────────────────────────────────────── */
  async function open(movie, startPosition) {
    if (!movie || !movie.videoUrl) {
      UI.toast('No video URL provided for this movie', 'error');
      return;
    }

    // Check offline — warn for non-native types
    if (!navigator.onLine && movie.videoType !== 'mp4' && movie.videoType !== 'hls') {
      UI.toast('This video type requires internet access', 'error');
      return;
    }

    currentMovie = movie;
    speedIndex   = 2; // reset speed
    isMuted      = false;

    const modal   = $('player-modal');
    const wrapper = $('player-wrapper');
    wrapper.innerHTML = '';

    // Update now-playing bar
    $('now-playing-title').textContent = movie.title;
    $('now-playing-meta').textContent  = [movie.year, (movie.genre||[]).join(', ')].filter(Boolean).join(' · ');

    modal.classList.remove('hidden');

    // Mount the right element
    try {
      switch (movie.videoType) {
        case 'mp4':   await _mountNative(movie, wrapper, 'video/mp4');  break;
        case 'hls':   await _mountHLS(movie, wrapper);                   break;
        case 'youtube': _mountYouTube(movie, wrapper);                   break;
        case 'vimeo':   _mountVimeo(movie, wrapper);                     break;
        default:        _mountIframe(movie, wrapper);
      }
    } catch (err) {
      console.error('[Player] mount failed:', err);
      _showError(wrapper, err.message);
      return;
    }

    // Seek to saved position if available
    const pos = startPosition != null ? startPosition : 0;
    let autoResume = false;
    try {
      const savedResume = await DB.settings.get('autoResume');
      autoResume = savedResume !== false; // default true
    } catch { autoResume = true; }

    if (!startPosition && autoResume) {
      try {
        const prog = await DB.progress.get(movie.id);
        if (prog && prog.position > 5 && prog.percent < 95) {
          setTimeout(() => {
            seekTo_seconds(prog.position);
            UI.toast(`Resumed from ${_fmt(prog.position)}`, 'info');
          }, 500);
        }
      } catch { /* ignore */ }
    } else if (pos > 0) {
      setTimeout(() => seekTo_seconds(pos), 500);
    }

    // Start autosave
    saveTimer = setInterval(() => { if (isPlaying) saveProgress(); }, 15000);

    // Keyboard handler
    document.addEventListener('keydown', _handleKeyboard);
    document.addEventListener('visibilitychange', _handleVisibility);

    // Controls auto-hide on mouse movement inside player
    const container = modal.querySelector('.player-container');
    container.addEventListener('mousemove', showControls);
    container.addEventListener('touchstart', showControls, { passive: true });
    showControls();
  }

  /* ─── Mount helpers ───────────────────────────────────────── */
  async function _mountNative(movie, wrapper, mimeType) {
    videoEl  = document.createElement('video');
    iframeEl = null;
    videoEl.src = movie.videoUrl;
    videoEl.preload = 'metadata';
    videoEl.playsInline = true;
    videoEl.style.cssText = 'width:100%;height:100%;object-fit:contain;display:block;background:#000';
    wrapper.appendChild(videoEl);

    // Bind native events
    videoEl.addEventListener('loadedmetadata', () => {
      duration = videoEl.duration;
      updateProgressUI();
    });
    videoEl.addEventListener('timeupdate', updateProgressUI);
    videoEl.addEventListener('play',  () => { isPlaying = true;  _updatePlayBtn(); _startProgressAnimation(); });
    videoEl.addEventListener('pause', () => { isPlaying = false; _updatePlayBtn(); saveProgress(); showControls(); });
    videoEl.addEventListener('ended', () => { isPlaying = false; _updatePlayBtn(); saveProgress(); showControls(); });
    videoEl.addEventListener('error', () => _showError(wrapper, 'Video failed to load. The source may be unavailable.'));
    videoEl.addEventListener('progress', _updateBuffered);

    videoEl.play().catch(() => { /* autoplay blocked is fine */ });
  }

  async function _mountHLS(movie, wrapper) {
    // Try native HLS first (Safari)
    videoEl  = document.createElement('video');
    iframeEl = null;
    videoEl.style.cssText = 'width:100%;height:100%;object-fit:contain;display:block;background:#000';
    videoEl.playsInline = true;

    if (videoEl.canPlayType('application/vnd.apple.mpegurl')) {
      videoEl.src = movie.videoUrl;
      wrapper.appendChild(videoEl);
      await _mountNative(movie, wrapper, 'application/vnd.apple.mpegurl');
      return;
    }

    // Load hls.js from CDN
    if (!window.Hls) {
      await new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = 'https://cdn.jsdelivr.net/npm/hls.js@latest/dist/hls.min.js';
        script.onload  = resolve;
        script.onerror = () => reject(new Error('Failed to load hls.js'));
        document.head.appendChild(script);
      });
    }

    if (!window.Hls || !Hls.isSupported()) {
      throw new Error('HLS is not supported in this browser');
    }

    wrapper.appendChild(videoEl);
    hlsInstance = new Hls();
    hlsInstance.loadSource(movie.videoUrl);
    hlsInstance.attachMedia(videoEl);
    hlsInstance.on(Hls.Events.MANIFEST_PARSED, () => videoEl.play().catch(()=>{}));
    hlsInstance.on(Hls.Events.ERROR, (e, data) => {
      if (data.fatal) _showError(wrapper, 'HLS stream error: ' + data.type);
    });

    videoEl.addEventListener('loadedmetadata', () => { duration = videoEl.duration; updateProgressUI(); });
    videoEl.addEventListener('timeupdate', updateProgressUI);
    videoEl.addEventListener('play',  () => { isPlaying = true;  _updatePlayBtn(); });
    videoEl.addEventListener('pause', () => { isPlaying = false; _updatePlayBtn(); saveProgress(); showControls(); });
    videoEl.addEventListener('ended', () => { isPlaying = false; _updatePlayBtn(); saveProgress(); });
    videoEl.addEventListener('progress', _updateBuffered);
  }

  function _mountYouTube(movie, wrapper) {
    videoEl  = null;
    iframeEl = document.createElement('iframe');
    const url = _ytEmbedUrl(movie.videoUrl);
    iframeEl.src = url;
    iframeEl.allow = 'autoplay; fullscreen; picture-in-picture';
    iframeEl.allowFullscreen = true;
    iframeEl.style.cssText = 'width:100%;height:100%;border:none';
    wrapper.appendChild(iframeEl);
    // Native controls for iframes; disable our custom overlay partially
    $('player-controls').style.display = 'none';
    UI.toast('Using YouTube player — limited controls available', 'info');
  }

  function _mountVimeo(movie, wrapper) {
    videoEl  = null;
    iframeEl = document.createElement('iframe');
    const url = _vimeoEmbedUrl(movie.videoUrl);
    iframeEl.src = url;
    iframeEl.allow = 'autoplay; fullscreen; picture-in-picture';
    iframeEl.allowFullscreen = true;
    iframeEl.style.cssText = 'width:100%;height:100%;border:none';
    wrapper.appendChild(iframeEl);
    $('player-controls').style.display = 'none';
    UI.toast('Using Vimeo player — limited controls available', 'info');
  }

  function _mountIframe(movie, wrapper) {
    videoEl  = null;
    iframeEl = document.createElement('iframe');
    iframeEl.src = movie.videoUrl;
    iframeEl.allow = 'autoplay; fullscreen; picture-in-picture';
    iframeEl.allowFullscreen = true;
    iframeEl.style.cssText = 'width:100%;height:100%;border:none';
    wrapper.appendChild(iframeEl);
    $('player-controls').style.display = 'none';
    UI.toast('Generic embed — controls handled by the embedded player', 'info');
  }

  function _ytEmbedUrl(url) {
    let id = '';
    try {
      const u = new URL(url);
      id = u.searchParams.get('v') || u.pathname.split('/').pop();
    } catch { id = url; }
    return `https://www.youtube.com/embed/${id}?enablejsapi=1&autoplay=1`;
  }

  function _vimeoEmbedUrl(url) {
    const m = url.match(/vimeo\.com\/(\d+)/);
    const id = m ? m[1] : url;
    return `https://player.vimeo.com/video/${id}?autoplay=1`;
  }

  function _showError(wrapper, msg) {
    wrapper.innerHTML = `
      <div class="player-error">
        <div class="player-error-icon">⚠️</div>
        <div class="player-error-title">Playback Error</div>
        <div class="player-error-msg">${msg || 'Unable to play this video.'}</div>
        <button class="btn-secondary" onclick="Player.close()" style="margin-top:16px">Close Player</button>
      </div>`;
  }

  /* ─── Close ───────────────────────────────────────────────── */
  function close() {
    saveProgress();
    clearInterval(saveTimer);
    clearTimeout(hideControlsTimer);
    document.removeEventListener('keydown', _handleKeyboard);
    document.removeEventListener('visibilitychange', _handleVisibility);

    if (videoEl) { videoEl.pause(); videoEl.src = ''; videoEl = null; }
    if (hlsInstance) { hlsInstance.destroy(); hlsInstance = null; }
    if (iframeEl) { iframeEl.src = ''; iframeEl = null; }

    const modal = $('player-modal');
    modal.classList.add('hidden');
    $('player-wrapper').innerHTML = '';

    // Restore controls display
    const ctrl = $('player-controls');
    if (ctrl) ctrl.style.display = '';

    // Refresh library progress
    Library.refreshProgress().then(() => {
      if (window.App) window.App.refresh();
    });

    currentMovie = null;
    isPlaying    = false;
    duration     = 0;
  }

  /* ─── Playback controls ───────────────────────────────────── */
  function play()       { if (videoEl) { videoEl.play();  isPlaying = true;  _updatePlayBtn(); } }
  function pause()      { if (videoEl) { videoEl.pause(); isPlaying = false; _updatePlayBtn(); saveProgress(); showControls(); } }
  function togglePlay() { if (isPlaying) pause(); else play(); }

  function seekTo_seconds(secs) {
    if (videoEl) { videoEl.currentTime = Math.max(0, Math.min(secs, duration)); updateProgressUI(); }
  }

  function seekToFraction(frac) {
    seekTo_seconds(frac * duration);
  }

  function rewind(secs = 10) {
    seekTo_seconds((videoEl ? videoEl.currentTime : 0) - secs);
    showControls();
  }

  function forward(secs = 30) {
    seekTo_seconds((videoEl ? videoEl.currentTime : 0) + secs);
    showControls();
  }

  function setVolume(level) {
    if (videoEl) { videoEl.volume = Math.max(0, Math.min(1, level)); }
    const range = $('volume-range');
    if (range) range.value = level;
  }

  function toggleMute() {
    if (!videoEl) return;
    isMuted = !isMuted;
    videoEl.muted = isMuted;
    $('btn-mute').textContent = isMuted ? '🔇' : '🔊';
  }

  function cycleSpeed() {
    speedIndex = (speedIndex + 1) % speedOptions.length;
    const speed = speedOptions[speedIndex];
    if (videoEl) videoEl.playbackRate = speed;
    $('btn-speed').textContent = speed + '×';
  }

  function toggleFullscreen() {
    const el = $('player-modal');
    if (!document.fullscreenElement) {
      el.requestFullscreen().catch(err => console.warn('[Player] fullscreen error:', err));
    } else {
      document.exitFullscreen();
    }
  }

  function togglePiP() {
    if (!videoEl) return;
    if (document.pictureInPictureElement) {
      document.exitPictureInPicture().catch(() => {});
    } else if ('requestPictureInPicture' in videoEl) {
      videoEl.requestPictureInPicture().catch(err =>
        UI.toast('PiP not available: ' + err.message, 'error')
      );
    }
  }

  /* ─── Progress ────────────────────────────────────────────── */
  function saveProgress() {
    if (!currentMovie || !videoEl) return;
    const pos = videoEl.currentTime;
    const dur = videoEl.duration || duration;
    if (!isFinite(dur) || dur <= 0) return;
    DB.progress.save(currentMovie.id, pos, dur).catch(e =>
      console.error('[Player] save progress failed:', e)
    );
  }

  function updateProgressUI() {
    if (!videoEl) return;
    const current  = videoEl.currentTime || 0;
    const total    = videoEl.duration    || 0;
    const fraction = total > 0 ? current / total : 0;

    const fill  = $('progress-fill');
    const range = $('progress-range');
    const time  = $('time-display');

    if (fill)  fill.style.width     = (fraction * 100) + '%';
    if (range) range.value          = fraction * 100;
    if (time)  time.textContent     = `${_fmt(current)} / ${_fmt(total)}`;
    if (!duration && total > 0) duration = total;
  }

  function _updateBuffered() {
    if (!videoEl || !videoEl.buffered.length) return;
    const pct = (videoEl.buffered.end(videoEl.buffered.length - 1) / (videoEl.duration || 1)) * 100;
    const buf = $('progress-buffered');
    if (buf) buf.style.width = pct + '%';
  }

  let _rafId = null;
  function _startProgressAnimation() {
    cancelAnimationFrame(_rafId);
    function tick() {
      updateProgressUI();
      if (isPlaying) _rafId = requestAnimationFrame(tick);
    }
    _rafId = requestAnimationFrame(tick);
  }

  function _updatePlayBtn() {
    const btn = $('btn-play');
    if (btn) btn.textContent = isPlaying ? '⏸' : '▶';
    const container = $('player-modal')?.querySelector('.player-container');
    if (container) container.classList.toggle('playing', isPlaying);
    if (!isPlaying) showControls();
  }

  /* ─── Controls visibility ─────────────────────────────────── */
  function showControls() {
    const container = $('player-modal')?.querySelector('.player-container');
    if (!container) return;
    container.classList.remove('controls-hidden');
    controlsVisible = true;
    clearTimeout(hideControlsTimer);
    if (isPlaying) {
      hideControlsTimer = setTimeout(hideControls, 3000);
    }
  }

  function hideControls() {
    if (!isPlaying) return;
    const container = $('player-modal')?.querySelector('.player-container');
    if (container) container.classList.add('controls-hidden');
    controlsVisible = false;
  }

  /* ─── Keyboard ────────────────────────────────────────────── */
  function _handleKeyboard(e) {
    if (!$('player-modal') || $('player-modal').classList.contains('hidden')) return;
    // Ignore if typing in input
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

    showControls();

    switch (e.key) {
      case ' ':
      case 'k':           e.preventDefault(); togglePlay();            break;
      case 'ArrowLeft':
      case 'j':           e.preventDefault(); rewind(10);              break;
      case 'ArrowRight':
      case 'l':           e.preventDefault(); forward(30);             break;
      case 'ArrowUp':     e.preventDefault(); setVolume((videoEl?.volume||1) + 0.1); break;
      case 'ArrowDown':   e.preventDefault(); setVolume((videoEl?.volume||1) - 0.1); break;
      case 'm':           toggleMute();                                 break;
      case 'f':           toggleFullscreen();                           break;
      case 'p':           togglePiP();                                  break;
      case 'Escape':      close();                                      break;
      case '<':           speedIndex = Math.max(0, speedIndex - 1);
                          if (videoEl) videoEl.playbackRate = speedOptions[speedIndex];
                          $('btn-speed').textContent = speedOptions[speedIndex] + '×';
                          break;
      case '>':           speedIndex = Math.min(speedOptions.length - 1, speedIndex + 1);
                          if (videoEl) videoEl.playbackRate = speedOptions[speedIndex];
                          $('btn-speed').textContent = speedOptions[speedIndex] + '×';
                          break;
      default:
        if (e.key >= '0' && e.key <= '9') {
          e.preventDefault();
          seekToFraction(parseInt(e.key) / 10);
        }
    }
  }

  function _handleVisibility() {
    if (document.hidden) saveProgress();
  }

  /* ─── Bind static control buttons ────────────────────────── */
  function bindControls() {
    $('btn-play')?.addEventListener('click',       togglePlay);
    $('btn-rewind')?.addEventListener('click',     () => rewind(10));
    $('btn-forward')?.addEventListener('click',    () => forward(30));
    $('btn-mute')?.addEventListener('click',       toggleMute);
    $('btn-speed')?.addEventListener('click',      cycleSpeed);
    $('btn-pip')?.addEventListener('click',        togglePiP);
    $('btn-fullscreen')?.addEventListener('click', toggleFullscreen);
    $('btn-close-player')?.addEventListener('click', close);
    $('btn-skip')?.addEventListener('click',       () => forward(85));

    // Progress range
    const range = $('progress-range');
    range?.addEventListener('input',  e => seekToFraction(e.target.value / 100));
    range?.addEventListener('mousedown', () => { if (videoEl) videoEl.pause(); });
    range?.addEventListener('mouseup',   () => { if (isPlaying || videoEl) { videoEl?.play(); showControls(); } });

    // Volume
    $('volume-range')?.addEventListener('input', e => setVolume(parseFloat(e.target.value)));

    // Touch swipe in player (left/right = ±30s)
    let touchStartX = 0;
    const modal = $('player-modal');
    modal?.addEventListener('touchstart', e => { touchStartX = e.touches[0].clientX; }, { passive: true });
    modal?.addEventListener('touchend',   e => {
      const dx = e.changedTouches[0].clientX - touchStartX;
      if (Math.abs(dx) > 50) {
        dx > 0 ? forward(30) : rewind(10);
      }
    });
  }

  /* ─── Public ──────────────────────────────────────────────── */
  return {
    open,
    close,
    play,
    pause,
    togglePlay,
    seekTo: seekTo_seconds,
    seekToFraction,
    rewind,
    forward,
    setVolume,
    toggleMute,
    cycleSpeed,
    toggleFullscreen,
    togglePiP,
    saveProgress,
    updateProgressUI,
    showControls,
    hideControls,
    bindControls,
    get isPlaying() { return isPlaying; },
    get currentMovie() { return currentMovie; }
  };
})();

window.Player = Player;
