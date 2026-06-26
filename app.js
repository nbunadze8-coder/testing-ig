'use strict';
/* ==========================================================================
   app.js — App controller, view router, UI helpers, global event wiring
   ========================================================================== */

function escapeHtml(str) {
  return String(str == null ? '' : str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/* ============================================================================
   UI — toasts, modals, online indicator, confirm dialogs
   ============================================================================ */
const UI = (() => {
  let toastSeq = 0;
  const focusTrapHandlers = new Map();

  function toast(message, type = 'info', duration = 3000, onClick) {
    const container = document.getElementById('toast-container');
    if (!container) return;
    const el = document.createElement('div');
    el.className = `toast ${type}`;
    el.id = 'toast-' + (++toastSeq);
    el.setAttribute('role', 'status');
    el.textContent = message;
    if (onClick) {
      el.style.cursor = 'pointer';
      el.title = 'Click to apply';
      el.addEventListener('click', () => { onClick(); dismissToast(el); });
    }
    container.appendChild(el);
    setTimeout(() => dismissToast(el), duration);
  }

  function dismissToast(el) {
    if (!el || !el.parentElement) return;
    el.classList.add('leaving');
    setTimeout(() => el.remove(), 200);
  }

  function showModal(id) {
    const modal = document.getElementById(id);
    if (!modal) return;
    modal.classList.remove('hidden');
    focusTrapHandlers.set(id, trapFocus(modal));
  }

  function hideModal(id) {
    const modal = document.getElementById(id);
    if (modal) modal.classList.add('hidden');
    const handler = focusTrapHandlers.get(id);
    if (handler) { document.removeEventListener('keydown', handler); focusTrapHandlers.delete(id); }
  }

  function trapFocus(modal) {
    const focusable = () => Array.from(modal.querySelectorAll('button, input, select, textarea, [tabindex]')).filter((el) => !el.disabled);
    const first = focusable()[0];
    if (first) first.focus();

    function handler(e) {
      if (e.key === 'Escape') { hideModal(modal.id); return; }
      if (e.key !== 'Tab') return;
      const list = focusable();
      if (!list.length) return;
      const f = list[0], l = list[list.length - 1];
      if (e.shiftKey && document.activeElement === f) { e.preventDefault(); l.focus(); }
      else if (!e.shiftKey && document.activeElement === l) { e.preventDefault(); f.focus(); }
    }
    document.addEventListener('keydown', handler);
    return handler;
  }

  function setOnlineStatus(isOnline) {
    const dot = document.querySelector('#offline-indicator .dot');
    const label = document.getElementById('online-status');
    if (dot) dot.classList.toggle('offline', !isOnline);
    if (label) label.textContent = isOnline ? 'Online' : 'Offline';
  }

  function setLoading(element, isLoading) {
    if (!element) return;
    element.style.opacity = isLoading ? '0.5' : '';
    element.setAttribute('aria-busy', isLoading ? 'true' : 'false');
  }

  let confirmModal = null;
  function confirm(message) {
    return new Promise((resolve) => {
      if (!confirmModal) confirmModal = buildConfirmModal();
      confirmModal.querySelector('.confirm-message').textContent = message;
      confirmModal.classList.remove('hidden');
      const yes = confirmModal.querySelector('.confirm-yes');
      const no = confirmModal.querySelector('.confirm-no');

      function cleanup(result) {
        confirmModal.classList.add('hidden');
        yes.removeEventListener('click', onYes);
        no.removeEventListener('click', onNo);
        resolve(result);
      }
      function onYes() { cleanup(true); }
      function onNo() { cleanup(false); }
      yes.addEventListener('click', onYes);
      no.addEventListener('click', onNo);
    });
  }

  function buildConfirmModal() {
    const modal = document.createElement('div');
    modal.id = 'confirm-modal';
    modal.className = 'modal hidden';
    modal.innerHTML = `
      <div class="modal-content" role="dialog" aria-modal="true" style="max-width:400px;">
        <div class="modal-body">
          <p class="confirm-message" style="margin-bottom:20px;"></p>
          <div class="detail-actions">
            <button type="button" class="btn btn-primary confirm-yes">Yes, continue</button>
            <button type="button" class="btn btn-secondary confirm-no">Cancel</button>
          </div>
        </div>
      </div>`;
    document.body.appendChild(modal);
    return modal;
  }

  return { toast, showModal, hideModal, setOnlineStatus, setLoading, confirm };
})();

window.UI = UI;

/* ============================================================================
   App — router + view renderers + global wiring
   ============================================================================ */
const App = (() => {
  const NAV_ITEMS = [
    { view: 'home', label: 'Home', icon: '🏠' },
    { view: 'library', label: 'Library', icon: '🎞' },
    { view: 'continue', label: 'Continue', icon: '▶' },
    { view: 'add', label: 'Add', icon: '＋' },
    { view: 'settings', label: 'Settings', icon: '⚙' }
  ];
  const VALID_VIEWS = NAV_ITEMS.map((n) => n.view);
  const VIDEO_TYPES = ['mp4', 'hls', 'youtube', 'vimeo', 'iframe'];

  let current = 'home';
  let mainEl = null;
  let bottomNavEl = null;

  /* ---------------------------------------------------------------- */
  /* Init                                                                */
  /* ---------------------------------------------------------------- */

  async function init() {
    mainEl = document.getElementById('main-content');
    bottomNavEl = document.getElementById('bottom-nav');

    renderBottomNav();
    wireSidebarNav();
    wireHamburger();
    wireGlobalDelegation();

    await DB.init();
    Player.init();
    PWA.register();
    PWA.setupInstallPrompt();
    await Library.init();

    UI.setOnlineStatus(navigator.onLine);
    window.addEventListener('online', () => { UI.setOnlineStatus(true); UI.toast('Back online — streaming is available again.', 'success'); });
    window.addEventListener('offline', () => { UI.setOnlineStatus(false); UI.toast("You're offline — everything you've already saved still works.", 'info'); });

    document.addEventListener('keydown', (e) => {
      if (Player.isOpen) return; // the player owns the keyboard while it's open
      if (e.key === '/' && !['INPUT', 'TEXTAREA'].includes(document.activeElement.tagName)) {
        e.preventDefault();
        navigate('library');
        setTimeout(() => { const s = document.getElementById('library-search'); if (s) s.focus(); }, 30);
      }
    });

    const params = new URLSearchParams(window.location.search);
    const fromHash = window.location.hash ? window.location.hash.slice(1) : null;
    const initial = params.get('section') || fromHash || 'home';
    navigate(VALID_VIEWS.includes(initial) ? initial : 'home');
  }

  /* ---------------------------------------------------------------- */
  /* Router                                                             */
  /* ---------------------------------------------------------------- */

  function navigate(view) {
    if (!VALID_VIEWS.includes(view)) view = 'home';
    current = view;

    document.querySelectorAll('#sidebar .nav-links li').forEach((li) => li.classList.toggle('active', li.dataset.view === view));
    if (bottomNavEl) bottomNavEl.querySelectorAll('.bottom-nav-item').forEach((el) => el.classList.toggle('active', el.dataset.view === view));
    history.replaceState(null, '', '#' + view);

    if (!mainEl) return;
    switch (view) {
      case 'library': Library.render(mainEl); break;
      case 'continue': renderContinue(mainEl); break;
      case 'add': renderAdd(mainEl); break;
      case 'settings': renderSettings(mainEl); break;
      default: renderHome(mainEl);
    }
    mainEl.scrollTop = 0;
  }

  function currentView() { return current; }

  /* ---------------------------------------------------------------- */
  /* Nav wiring                                                         */
  /* ---------------------------------------------------------------- */

  function renderBottomNav() {
    if (!bottomNavEl) return;
    bottomNavEl.innerHTML = NAV_ITEMS.map((n) => `
      <button type="button" class="bottom-nav-item" data-view="${n.view}" aria-label="${n.label}">
        <span aria-hidden="true">${n.icon}</span><span>${n.label}</span>
      </button>`).join('');
  }

  function wireSidebarNav() {
    document.querySelectorAll('#sidebar .nav-links li').forEach((li) => {
      li.addEventListener('click', () => navigate(li.dataset.view));
      li.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); navigate(li.dataset.view); } });
    });
    if (bottomNavEl) {
      bottomNavEl.addEventListener('click', (e) => {
        const btn = e.target.closest('.bottom-nav-item');
        if (btn) navigate(btn.dataset.view);
      });
    }
  }

  function wireHamburger() {
    const btn = document.getElementById('hamburger');
    if (!btn) return;
    btn.addEventListener('click', () => {
      navigate('library');
      setTimeout(() => { const s = document.getElementById('library-search'); if (s) s.focus(); }, 30);
    });
  }

  /* ---------------------------------------------------------------- */
  /* Global event delegation                                           */
  /* ---------------------------------------------------------------- */

  function wireGlobalDelegation() {
    document.addEventListener('click', (e) => {
      const addBtn = e.target.closest('.btn-add-movie');
      if (addBtn) { openAddModal(); return; }

      const playBtn = e.target.closest('.play-btn, .btn-play-card');
      if (playBtn) {
        e.stopPropagation();
        const card = playBtn.closest('[data-id]');
        if (card) openMovieAndPlay(card.dataset.id);
        return;
      }

      const navTarget = e.target.closest('[data-view]');
      if (navTarget && !navTarget.closest('#sidebar') && !navTarget.closest('#bottom-nav')) {
        navigate(navTarget.dataset.view);
        return;
      }

      const genreJump = e.target.closest('[data-genre-jump]');
      if (genreJump) {
        Library.state.activeGenres = [genreJump.dataset.genreJump];
        Library.applyFilters();
        navigate('library');
        return;
      }

      const card = e.target.closest('.movie-card, .movie-list-item');
      if (card && card.dataset.id) { Library.openDetail(card.dataset.id); return; }
    });

    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      const card = e.target.closest && e.target.closest('.movie-card, .movie-list-item');
      if (card && document.activeElement === card) { e.preventDefault(); Library.openDetail(card.dataset.id); }
    });
  }

  async function openMovieAndPlay(movieId) {
    const movie = await DB.movies.get(movieId);
    if (!movie) return;
    const progress = await DB.progress.get(movieId);
    Player.open(movie, progress && progress.percent > 0 && progress.percent < 95 ? progress.position : 0);
  }

  /* ---------------------------------------------------------------- */
  /* Home view                                                          */
  /* ---------------------------------------------------------------- */

  function renderHome(target) {
    const continuing = Library.getContinueWatching();
    const recent = Library.state.movies.slice().sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0)).slice(0, 8);
    const genres = Library.getGenres().slice(0, 10);

    target.innerHTML = `
      <section class="hero-section">
        <h1 class="hero-headline display-text">YOUR CINEMA, <span class="accent">OFFLINE.</span></h1>
        <p class="hero-sub">Add any streaming link, MP4, or embed — CinemaVault keeps your library, posters, and progress saved right on this device, so it's all here even without a connection.</p>
        <div class="hero-actions">
          <button type="button" class="btn btn-primary" data-view="add">＋ Add a movie</button>
          <button type="button" class="btn btn-secondary" data-view="library">Browse library</button>
        </div>
      </section>

      ${continuing.length ? `
      <div class="section-block">
        <div class="section-header"><h2 class="section-title">Continue Watching</h2><a class="view-all-link" data-view="continue" href="#continue">View all</a></div>
        <div class="scroll-row">${continuing.slice(0, 10).map((m) => Library.renderCard(m, Library.state.progressMap[m.id])).join('')}</div>
      </div>` : ''}

      <div class="section-block">
        <div class="section-header"><h2 class="section-title">Recently Added</h2><a class="view-all-link" data-view="library" href="#library">View all</a></div>
        ${recent.length
          ? `<div class="movie-grid">${recent.map((m) => Library.renderCard(m, Library.state.progressMap[m.id])).join('')}</div>`
          : `<div class="empty-state"><div class="empty-icon">🎬</div><h3>Your library is empty</h3><p>Add your first movie to get started.</p>
              <button type="button" class="btn btn-primary btn-add-movie" style="margin-top:16px;">＋ Add a movie</button></div>`}
      </div>

      ${genres.length ? `
      <div class="section-block">
        <div class="section-header"><h2 class="section-title">By Genre</h2></div>
        <div class="genre-pills">${genres.map((g) => `<button type="button" class="genre-pill" data-genre-jump="${escapeHtml(g)}">${escapeHtml(g)}</button>`).join('')}</div>
      </div>` : ''}
    `;
  }

  /* ---------------------------------------------------------------- */
  /* Continue Watching view                                            */
  /* ---------------------------------------------------------------- */

  function renderContinue(target) {
    const list = Library.getContinueWatching();
    target.innerHTML = `
      <h1 class="section-title display-text">Continue Watching</h1>
      ${list.length
        ? `<div class="movie-grid">${list.map((m) => Library.renderCard(m, Library.state.progressMap[m.id])).join('')}</div>`
        : `<div class="empty-state"><div class="empty-icon">▶</div><h3>Nothing in progress</h3><p>Movies you start watching will show up here.</p></div>`}
    `;
  }

  /* ---------------------------------------------------------------- */
  /* Add Movie — shared form (used by both the full view and the modal) */
  /* ---------------------------------------------------------------- */

  function addFormHTML(prefix) {
    return `
      <form class="form-card" novalidate>
        <div class="form-group">
          <label for="${prefix}-title">Title</label>
          <input id="${prefix}-title" name="title" type="text" required>
          <div class="field-error hidden" data-error-for="title"></div>
        </div>
        <div class="form-group">
          <label for="${prefix}-url">Video URL</label>
          <input id="${prefix}-url" name="videoUrl" type="url" placeholder="https://…" required>
          <div class="field-hint">Direct MP4/HLS links, or a YouTube/Vimeo page link.</div>
          <div class="field-error hidden" data-error-for="videoUrl"></div>
        </div>
        <div class="form-group">
          <label>Source type</label>
          <div class="type-pills" data-type-pills>
            ${VIDEO_TYPES.map((t, i) => `<button type="button" class="type-pill ${i === 0 ? 'active' : ''}" data-type="${t}">${t.toUpperCase()}</button>`).join('')}
          </div>
          <input type="hidden" name="videoType" data-type-value value="mp4">
        </div>
        <div class="form-group">
          <label for="${prefix}-poster">Poster URL (optional)</label>
          <input id="${prefix}-poster" name="poster" type="url" placeholder="https://…">
        </div>
        <div class="form-group">
          <label for="${prefix}-year">Year (optional)</label>
          <input id="${prefix}-year" name="year" type="number" min="1880" max="2100">
          <div class="field-error hidden" data-error-for="year"></div>
        </div>
        <div class="form-group">
          <label for="${prefix}-genre">Genre (optional, comma-separated)</label>
          <input id="${prefix}-genre" name="genre" type="text" placeholder="Drama, Thriller">
        </div>
        <div class="form-group">
          <label for="${prefix}-desc">Description (optional)</label>
          <textarea id="${prefix}-desc" name="description" rows="3"></textarea>
        </div>
        <button type="submit" class="btn btn-primary">＋ Add to library</button>
      </form>`;
  }

  function wireAddForm(root, afterSuccess) {
    const pills = root.querySelectorAll('.type-pill');
    const typeValue = root.querySelector('[data-type-value]');
    pills.forEach((p) => p.addEventListener('click', () => {
      pills.forEach((x) => x.classList.remove('active'));
      p.classList.add('active');
      typeValue.value = p.dataset.type;
    }));

    const form = root.querySelector('form');
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      root.querySelectorAll('.field-error').forEach((el) => { el.classList.add('hidden'); el.textContent = ''; });
      const data = Object.fromEntries(new FormData(form).entries());
      const result = await Library.addMovie(data);
      if (result.ok) {
        form.reset();
        pills.forEach((x, i) => x.classList.toggle('active', i === 0));
        typeValue.value = 'mp4';
        afterSuccess();
      } else {
        Object.entries(result.errors).forEach(([field, msg]) => {
          const el = root.querySelector(`[data-error-for="${field}"]`);
          if (el) { el.textContent = msg; el.classList.remove('hidden'); }
        });
      }
    });
  }

  function renderAdd(target) {
    target.innerHTML = `<h1 class="section-title display-text">Add a Movie</h1>${addFormHTML('f')}`;
    wireAddForm(target, () => navigate('library'));
  }

  function openAddModal() {
    const modal = document.getElementById('add-modal');
    if (!modal) return;
    modal.innerHTML = `
      <div class="modal-content" role="dialog" aria-modal="true" aria-labelledby="add-modal-title">
        <div class="modal-header">
          <h2 id="add-modal-title" class="display-text">Add a Movie</h2>
          <button type="button" class="modal-close" id="add-modal-close" aria-label="Close">✕</button>
        </div>
        <div class="modal-body">${addFormHTML('m')}</div>
      </div>`;
    UI.showModal('add-modal');
    modal.querySelector('#add-modal-close').addEventListener('click', () => UI.hideModal('add-modal'));
    wireAddForm(modal.querySelector('.modal-body'), () => {
      UI.hideModal('add-modal');
      navigate('library');
    });
  }

  /* ---------------------------------------------------------------- */
  /* Settings view                                                      */
  /* ---------------------------------------------------------------- */

  async function renderSettings(target) {
    const settings = await DB.settings.getAll();
    const installed = PWA.checkInstalled();

    target.innerHTML = `
      <h1 class="section-title display-text">Settings</h1>

      <div class="form-card">
        <div class="settings-row">
          <div><div class="settings-label">Autoplay next</div><div class="settings-desc">Reserved for future episodic libraries — there's no "next" item yet in a flat movie list.</div></div>
          <label class="switch"><input type="checkbox" id="set-autoplay" ${settings.autoplayNext ? 'checked' : ''}><span class="slider"></span></label>
        </div>
        <div class="settings-row">
          <div><div class="settings-label">Resume from last position</div><div class="settings-desc">Jump back to where you left off when you reopen a movie.</div></div>
          <label class="switch"><input type="checkbox" id="set-resume" ${settings.autoResume ? 'checked' : ''}><span class="slider"></span></label>
        </div>
        <div class="settings-row">
          <div><div class="settings-label">Show controls on hover only</div><div class="settings-desc">Hide the player controls immediately unless your cursor is moving.</div></div>
          <label class="switch"><input type="checkbox" id="set-hover" ${settings.hoverControlsOnly ? 'checked' : ''}><span class="slider"></span></label>
        </div>
      </div>

      <div class="form-card" style="margin-top:24px;">
        <div class="settings-row">
          <div><div class="settings-label">Export library</div><div class="settings-desc">Download all movies and settings as a JSON file.</div></div>
          <button type="button" class="btn btn-secondary" id="btn-export">Export</button>
        </div>
        <div class="settings-row">
          <div><div class="settings-label">Import library</div><div class="settings-desc">Replace your movies from a previously exported JSON file.</div></div>
          <label class="btn btn-secondary" style="cursor:pointer;">Choose file<input type="file" accept="application/json" id="btn-import" class="hidden"></label>
        </div>
        <div class="settings-row">
          <div><div class="settings-label">Clear all progress</div><div class="settings-desc">Reset watch progress on every movie in your library.</div></div>
          <button type="button" class="btn btn-danger" id="btn-clear-progress">Clear progress</button>
        </div>
        <div class="settings-row">
          <div><div class="settings-label">Clear cache</div><div class="settings-desc">Remove offline-cached app files. They'll be re-downloaded next time you're online.</div></div>
          <button type="button" class="btn btn-danger" id="btn-clear-cache">Clear cache</button>
        </div>
      </div>

      <div class="form-card" style="margin-top:24px;">
        <div class="settings-row">
          <div><div class="settings-label">Install CinemaVault</div><div class="settings-desc">${installed ? 'Already installed on this device.' : 'Add CinemaVault to your home screen for quick, offline access.'}</div></div>
          ${installed ? '' : '<button type="button" class="btn btn-primary" id="btn-install-settings">Install</button>'}
        </div>
      </div>
    `;

    target.querySelector('#set-autoplay').addEventListener('change', (e) => DB.settings.set('autoplayNext', e.target.checked));
    target.querySelector('#set-resume').addEventListener('change', (e) => DB.settings.set('autoResume', e.target.checked));
    target.querySelector('#set-hover').addEventListener('change', (e) => DB.settings.set('hoverControlsOnly', e.target.checked));

    target.querySelector('#btn-export').addEventListener('click', async () => {
      const json = await DB.exportLibrary();
      const blob = new Blob([json], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = 'cinemavault-library.json';
      document.body.appendChild(a); a.click(); a.remove();
      URL.revokeObjectURL(url);
      UI.toast('Library exported', 'success');
    });

    target.querySelector('#btn-import').addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      try {
        const text = await file.text();
        const count = await DB.importLibrary(text);
        await Library.init();
        UI.toast(`Imported ${count} movie${count === 1 ? '' : 's'}`, 'success');
        navigate('library');
      } catch (err) {
        UI.toast('Import failed: ' + err.message, 'error');
      }
      e.target.value = '';
    });

    target.querySelector('#btn-clear-progress').addEventListener('click', async () => {
      const ok = await UI.confirm('Clear watch progress for every movie? This cannot be undone.');
      if (!ok) return;
      await DB.progress.clearAll();
      await Library.refreshProgress();
      UI.toast('Progress cleared', 'success');
    });

    target.querySelector('#btn-clear-cache').addEventListener('click', async () => {
      const ok = await UI.confirm('Clear offline-cached app files?');
      if (!ok) return;
      if ('caches' in window) {
        const keys = await caches.keys();
        await Promise.all(keys.map((k) => caches.delete(k)));
      }
      UI.toast('Cache cleared — refresh to re-download app files', 'success');
    });

    const installBtn = target.querySelector('#btn-install-settings');
    if (installBtn) installBtn.addEventListener('click', () => PWA.install());
  }

  return { init, navigate, currentView };
})();

window.App = App;

document.addEventListener('DOMContentLoaded', () => { App.init(); });
