'use strict';

/**
 * CinemaVault — library.js
 * Manages the movie collection state and all library view rendering.
 */

const Library = (() => {

  /* ─── State ───────────────────────────────────────────────── */
  let state = {
    movies:       [],
    filtered:     [],
    activeGenres: [],
    sortBy:       'addedAt',
    sortDir:      'desc',
    viewMode:     'grid',
    searchQuery:  '',
    loading:      true,
    progressMap:  {}   // { movieId: progressRecord }
  };

  /* ─── Colour seeder for fallback posters ─────────────────── */
  const POSTER_PALETTES = [
    ['#1a0a10','#5c1a1a'],['#0a101a','#1a3a5c'],
    ['#0a1a10','#1a5c2a'],['#1a1a0a','#5c5c1a'],
    ['#1a0a1a','#4a1a5c'],['#0a1a1a','#1a4a5c'],
  ];

  function titleHash(str) {
    let h = 0;
    for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) >>> 0;
    return h;
  }

  function fallbackPosterStyle(id, title) {
    const h = titleHash(id || title);
    const [from, to] = POSTER_PALETTES[h % POSTER_PALETTES.length];
    return `background: linear-gradient(135deg, ${from} 0%, ${to} 100%);`;
  }

  /** Returns initials (up to 2 chars) from title */
  function titleInitials(title) {
    return (title || '?')
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map(w => w[0].toUpperCase())
      .join('');
  }

  /* ─── Init ────────────────────────────────────────────────── */
  async function init() {
    state.loading = true;
    try {
      const [movieList, progressList] = await Promise.all([
        DB.movies.getAll(),
        DB.progress.getAll()
      ]);
      state.movies = movieList;
      state.progressMap = {};
      progressList.forEach(p => { state.progressMap[p.movieId] = p; });
      state.loading = false;
      applyFilters();
    } catch (err) {
      console.error('[Library] init failed:', err);
      state.loading = false;
    }
  }

  /** Refresh only the progress map (called after playback) */
  async function refreshProgress() {
    const list = await DB.progress.getAll();
    state.progressMap = {};
    list.forEach(p => { state.progressMap[p.movieId] = p; });
  }

  /* ─── Filter / Sort ───────────────────────────────────────── */
  function applyFilters() {
    let list = [...state.movies];

    // Genre filter
    if (state.activeGenres.length > 0) {
      list = list.filter(m =>
        state.activeGenres.every(g => (m.genre || []).includes(g))
      );
    }

    // Search
    if (state.searchQuery) {
      const q = state.searchQuery.toLowerCase();
      list = list.filter(m =>
        (m.title || '').toLowerCase().includes(q) ||
        (m.director || '').toLowerCase().includes(q) ||
        (m.description || '').toLowerCase().includes(q) ||
        (m.cast || []).join(' ').toLowerCase().includes(q)
      );
    }

    // Sort
    list.sort((a, b) => {
      let va, vb;
      switch (state.sortBy) {
        case 'title':    va = a.title || '';    vb = b.title || '';    break;
        case 'year':     va = a.year || 0;      vb = b.year || 0;      break;
        case 'rating':   va = a.rating || 0;    vb = b.rating || 0;    break;
        case 'progress':
          va = (state.progressMap[a.id] || {}).percent || 0;
          vb = (state.progressMap[b.id] || {}).percent || 0;
          break;
        default: // addedAt
          va = a.addedAt || 0;
          vb = b.addedAt || 0;
      }
      if (typeof va === 'string') return state.sortDir === 'asc' ? va.localeCompare(vb) : vb.localeCompare(va);
      return state.sortDir === 'asc' ? va - vb : vb - va;
    });

    state.filtered = list;
  }

  function search(query) {
    state.searchQuery = query;
    applyFilters();
  }

  function toggleGenre(genre) {
    const idx = state.activeGenres.indexOf(genre);
    if (idx >= 0) state.activeGenres.splice(idx, 1);
    else state.activeGenres.push(genre);
    applyFilters();
  }

  function setSort(field, dir) {
    state.sortBy  = field || state.sortBy;
    state.sortDir = dir   || state.sortDir;
    applyFilters();
  }

  function setViewMode(mode) { state.viewMode = mode; }

  /* ─── Genre list ──────────────────────────────────────────── */
  function getGenres() {
    const set = new Set();
    state.movies.forEach(m => (m.genre || []).forEach(g => set.add(g)));
    return [...set].sort();
  }

  /* ─── Continue Watching ───────────────────────────────────── */
  function getContinueWatching() {
    return Object.values(state.progressMap)
      .filter(p => p.percent > 0 && p.percent < 95)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map(p => state.movies.find(m => m.id === p.movieId))
      .filter(Boolean);
  }

  /* ─── Card rendering ─────────────────────────────────────── */
  function renderCard(movie, prog) {
    const percent   = prog ? prog.percent : 0;
    const completed = prog && prog.percent >= 95;
    const posterStyle = fallbackPosterStyle(movie.id, movie.title);
    const initials    = titleInitials(movie.title);
    const genreBadges = (movie.genre || []).slice(0, 2)
      .map(g => `<span class="genre-badge">${g}</span>`).join('');

    return `
      <article class="movie-card" data-id="${movie.id}" role="button" tabindex="0" aria-label="${movie.title}">
        <div class="card-poster">
          ${movie.poster
            ? `<img src="${movie.poster}" alt="${movie.title} poster" loading="lazy"
                    onerror="this.parentNode.innerHTML='<div class=\\'card-poster-fallback\\' style=\\'${posterStyle}\\'><div class=\\'poster-initials\\'>${initials}</div><div class=\\'poster-year\\'>${movie.year || ''}</div></div>'">`
            : `<div class="card-poster-fallback" style="${posterStyle}">
                 <div class="poster-initials">${initials}</div>
                 <div class="poster-year">${movie.year || ''}</div>
               </div>`
          }
          <div class="card-overlay">
            <button class="play-btn" data-id="${movie.id}" aria-label="Play ${movie.title}">▶</button>
          </div>
          <div class="card-progress-bar">
            <div class="card-progress-fill" style="width:${percent}%"></div>
          </div>
          ${completed ? '<div class="completed-badge" aria-label="Completed">✓</div>' : ''}
        </div>
        <div class="card-info">
          <h3 class="card-title">${movie.title}</h3>
          <div class="card-meta">
            <span class="card-year">${movie.year || ''}</span>
            ${movie.rating ? `<span class="card-rating">★ ${movie.rating}</span>` : ''}
          </div>
          <div class="card-genres">${genreBadges}</div>
        </div>
      </article>`;
  }

  function renderListItem(movie, prog) {
    const percent = prog ? prog.percent : 0;
    return `
      <div class="movie-list-item" data-id="${movie.id}" role="button" tabindex="0" aria-label="${movie.title}">
        ${movie.poster
          ? `<img class="list-thumb" src="${movie.poster}" alt="${movie.title}" loading="lazy" onerror="this.style.background='${fallbackPosterStyle(movie.id, movie.title).replace('background:','').trim()};background-size:cover'">`
          : `<div class="list-thumb" style="${fallbackPosterStyle(movie.id, movie.title)}"></div>`}
        <div class="list-info">
          <div class="list-title">${movie.title}</div>
          <div class="list-meta">${movie.year || ''} · ${(movie.genre || []).join(', ')} ${movie.rating ? '· ★ ' + movie.rating : ''}</div>
          ${percent > 0 ? `<div class="list-progress"><div class="list-progress-fill" style="width:${percent}%"></div></div>` : ''}
        </div>
        <button class="play-btn" data-id="${movie.id}" style="width:40px;height:40px;font-size:16px;flex-shrink:0" aria-label="Play ${movie.title}">▶</button>
      </div>`;
  }

  function renderGrid(movies) {
    if (!movies.length) {
      return `<div class="empty-state">
        <div class="empty-icon">🎞</div>
        <div class="empty-title">No Movies Found</div>
        <div class="empty-sub">Try a different search or filter, or add some movies to your library.</div>
      </div>`;
    }
    if (state.viewMode === 'list') {
      return `<div class="movies-list">${movies.map(m => renderListItem(m, state.progressMap[m.id])).join('')}</div>`;
    }
    return `<div class="movies-grid">${movies.map(m => renderCard(m, state.progressMap[m.id])).join('')}</div>`;
  }

  /* ─── Skeleton loader ─────────────────────────────────────── */
  function renderSkeleton(count = 8) {
    return `<div class="movies-grid">${Array(count).fill(0).map(() =>
      `<div class="movie-card">
         <div class="card-poster skeleton skeleton-card"></div>
         <div class="card-info">
           <div class="skeleton skeleton-title"></div>
           <div class="skeleton skeleton-meta"></div>
         </div>
       </div>`
    ).join('')}</div>`;
  }

  /* ─── Library view HTML ───────────────────────────────────── */
  function render(targetEl) {
    const genres = getGenres();
    const genrePills = genres.map(g => `
      <span class="genre-pill ${state.activeGenres.includes(g) ? 'active' : ''}"
            data-genre="${g}" role="button" tabindex="0">${g}</span>`).join('');

    targetEl.innerHTML = `
      <div class="view-library">
        <div class="library-header">
          <h1 class="library-title">Library</h1>
          <div class="search-bar">
            <span class="search-icon">🔍</span>
            <input type="search" class="search-input" id="library-search"
                   placeholder="Search titles, directors…" value="${state.searchQuery}"
                   aria-label="Search movies">
          </div>
        </div>
        <div class="library-controls">
          <div class="genre-pills" id="genre-pills">${genrePills}</div>
          <select class="sort-select" id="sort-select" aria-label="Sort movies">
            <option value="addedAt" ${state.sortBy==='addedAt'?'selected':''}>Recently Added</option>
            <option value="title"   ${state.sortBy==='title'?'selected':''}>Title A–Z</option>
            <option value="year"    ${state.sortBy==='year'?'selected':''}>Year</option>
            <option value="rating"  ${state.sortBy==='rating'?'selected':''}>Rating</option>
            <option value="progress" ${state.sortBy==='progress'?'selected':''}>Progress</option>
          </select>
          <div class="view-toggle" role="group" aria-label="View mode">
            <button class="view-btn ${state.viewMode==='grid'?'active':''}" data-view-mode="grid" aria-label="Grid view">⊞</button>
            <button class="view-btn ${state.viewMode==='list'?'active':''}" data-view-mode="list" aria-label="List view">☰</button>
          </div>
          <span class="result-count" aria-live="polite">${state.filtered.length} movie${state.filtered.length !== 1 ? 's' : ''}</span>
        </div>
        <div id="library-grid-container">
          ${state.loading ? renderSkeleton() : renderGrid(state.filtered)}
        </div>
      </div>`;

    _bindLibraryEvents(targetEl);
  }

  function _bindLibraryEvents(el) {
    // Search
    const searchEl = el.querySelector('#library-search');
    if (searchEl) {
      let debounceTimer;
      searchEl.addEventListener('input', e => {
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
          search(e.target.value);
          _refreshGrid(el);
        }, 250);
      });
    }

    // Genre pills
    el.querySelector('#genre-pills')?.addEventListener('click', e => {
      const pill = e.target.closest('[data-genre]');
      if (!pill) return;
      toggleGenre(pill.dataset.genre);
      _refreshGrid(el);
      // Update pill active state
      el.querySelectorAll('.genre-pill').forEach(p => {
        p.classList.toggle('active', state.activeGenres.includes(p.dataset.genre));
      });
      el.querySelector('.result-count').textContent =
        `${state.filtered.length} movie${state.filtered.length !== 1 ? 's' : ''}`;
    });

    // Sort
    el.querySelector('#sort-select')?.addEventListener('change', e => {
      setSort(e.target.value);
      _refreshGrid(el);
    });

    // View mode
    el.querySelectorAll('[data-view-mode]').forEach(btn => {
      btn.addEventListener('click', () => {
        setViewMode(btn.dataset.viewMode);
        el.querySelectorAll('[data-view-mode]').forEach(b =>
          b.classList.toggle('active', b === btn));
        _refreshGrid(el);
      });
    });
  }

  function _refreshGrid(el) {
    const container = el.querySelector('#library-grid-container');
    if (container) container.innerHTML = renderGrid(state.filtered);
    const count = el.querySelector('.result-count');
    if (count) count.textContent = `${state.filtered.length} movie${state.filtered.length !== 1 ? 's' : ''}`;
  }

  /* ─── Detail Modal ────────────────────────────────────────── */
  async function openDetail(movieId) {
    const movie = await DB.movies.get(movieId);
    if (!movie) return;
    const prog = state.progressMap[movieId];
    const percent = prog ? prog.percent : 0;

    const modal = document.getElementById('detail-modal');
    modal.innerHTML = `
      <div class="modal-overlay" role="dialog" aria-modal="true" aria-label="${movie.title}">
        <div class="modal-box" id="detail-modal-box" tabindex="-1">
          ${movie.backdrop || movie.poster
            ? `<img class="detail-backdrop" src="${movie.backdrop || movie.poster}" alt="" role="presentation"
                    onerror="this.style.display='none'">`
            : `<div style="height:80px;background:${fallbackPosterStyle(movie.id, movie.title).replace('background:','').trim()};border-radius:16px 16px 0 0"></div>`}
          <div class="detail-poster-row">
            ${movie.poster
              ? `<img class="detail-poster" src="${movie.poster}" alt="${movie.title} poster"
                      onerror="this.style.background='${fallbackPosterStyle(movie.id, movie.title).replace('background:','').trim()};background-size:cover'">`
              : `<div class="detail-poster" style="${fallbackPosterStyle(movie.id, movie.title)}"></div>`}
            <div class="detail-info">
              <h2 class="detail-title">${movie.title}</h2>
              <div class="detail-meta">
                <span>${movie.year || ''}</span>
                ${movie.rating ? `<span class="detail-rating">★ ${movie.rating}</span>` : ''}
                ${movie.director ? `<span>Dir. ${movie.director}</span>` : ''}
                ${movie.duration ? `<span>${_formatDuration(movie.duration)}</span>` : ''}
              </div>
              <div class="card-genres">${(movie.genre||[]).map(g=>`<span class="genre-badge">${g}</span>`).join('')}</div>
            </div>
          </div>
          ${percent > 0 ? `
            <div class="detail-progress">
              <div class="detail-progress-label">Progress — ${percent}%</div>
              <div class="detail-progress-bar"><div class="detail-progress-fill" style="width:${percent}%"></div></div>
            </div>` : ''}
          ${movie.description ? `<p class="detail-description">${movie.description}</p>` : ''}
          <div class="detail-actions">
            <button class="btn-primary" id="detail-play-btn" data-id="${movie.id}">▶ Play</button>
            ${prog ? `<button class="btn-secondary" id="detail-reset-btn" data-id="${movie.id}">↺ Reset Progress</button>` : ''}
            <button class="btn-danger" id="detail-delete-btn" data-id="${movie.id}">🗑 Delete</button>
            <button class="btn-secondary modal-close-btn" style="margin-left:auto">✕ Close</button>
          </div>
        </div>
      </div>`;

    modal.classList.remove('hidden');

    // Focus trap
    const box = modal.querySelector('#detail-modal-box');
    box.focus();

    modal.querySelector('#detail-play-btn').addEventListener('click', () => {
      closeDetail();
      window.Player.open(movie, prog ? prog.position : 0);
    });

    modal.querySelector('#detail-delete-btn').addEventListener('click', async () => {
      const ok = await window.UI.confirm(`Delete "${movie.title}" from your library?`);
      if (ok) {
        await deleteMovie(movie.id);
        closeDetail();
        UI.toast(`"${movie.title}" removed`, 'info');
        // Re-render current view
        if (window.App) window.App.refresh();
      }
    });

    modal.querySelector('#detail-reset-btn')?.addEventListener('click', async () => {
      await DB.progress.clear(movie.id);
      delete state.progressMap[movie.id];
      closeDetail();
      UI.toast('Progress reset', 'info');
    });

    modal.querySelector('.modal-close-btn').addEventListener('click', closeDetail);
    modal.querySelector('.modal-overlay').addEventListener('click', e => {
      if (e.target === e.currentTarget) closeDetail();
    });

    // Keyboard close
    modal._keyHandler = (e) => { if (e.key === 'Escape') closeDetail(); };
    document.addEventListener('keydown', modal._keyHandler);
  }

  function closeDetail() {
    const modal = document.getElementById('detail-modal');
    if (modal._keyHandler) document.removeEventListener('keydown', modal._keyHandler);
    modal.classList.add('hidden');
    modal.innerHTML = '';
  }

  /* ─── Add Movie ───────────────────────────────────────────── */
  async function addMovie(formData) {
    const id = 'mv_' + Date.now();
    const movie = {
      id,
      title:       formData.title.trim(),
      year:        parseInt(formData.year) || new Date().getFullYear(),
      duration:    parseInt(formData.duration) || 0,
      genre:       formData.genre ? formData.genre.split(',').map(s=>s.trim()).filter(Boolean) : [],
      rating:      parseFloat(formData.rating) || 0,
      director:    formData.director || '',
      cast:        [],
      description: formData.description || '',
      poster:      formData.poster || '',
      backdrop:    '',
      videoUrl:    formData.videoUrl.trim(),
      videoType:   formData.videoType || 'mp4',
      tags:        [],
      addedAt:     Date.now()
    };
    await DB.movies.add(movie);
    state.movies.unshift(movie);
    applyFilters();
    return movie;
  }

  /* ─── Delete Movie ────────────────────────────────────────── */
  async function deleteMovie(movieId) {
    await Promise.all([DB.movies.delete(movieId), DB.progress.clear(movieId)]);
    state.movies = state.movies.filter(m => m.id !== movieId);
    delete state.progressMap[movieId];
    applyFilters();
  }

  /* ─── Helpers ─────────────────────────────────────────────── */
  function _formatDuration(secs) {
    const h = Math.floor(secs / 3600);
    const m = Math.floor((secs % 3600) / 60);
    return h > 0 ? `${h}h ${m}m` : `${m}m`;
  }

  /* ─── Public ──────────────────────────────────────────────── */
  return {
    init,
    render,
    renderCard,
    renderGrid,
    renderListItem,
    renderSkeleton,
    applyFilters,
    search,
    toggleGenre,
    setSort,
    setViewMode,
    getGenres,
    openDetail,
    closeDetail,
    addMovie,
    deleteMovie,
    getContinueWatching,
    refreshProgress,
    get state() { return state; }
  };
})();

window.Library = Library;
