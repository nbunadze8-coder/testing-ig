'use strict';
/* ==========================================================================
   library.js — Library state, rendering, search, filters, CRUD
   ========================================================================== */

const Library = (() => {
  let state = {
    movies: [],
    filtered: [],
    progressMap: {},   // movieId -> progress record
    activeGenres: [],
    sortBy: 'addedAt',
    sortDir: 'desc',
    viewMode: 'grid',
    searchQuery: '',
    loading: true
  };

  /* ---------------------------------------------------------------- */
  /* Helpers                                                           */
  /* ---------------------------------------------------------------- */

  // Deterministic hash so the same title always gets the same fallback color
  function hashString(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      hash = (hash << 5) - hash + str.charCodeAt(i);
      hash |= 0;
    }
    return Math.abs(hash);
  }

  function initials(title) {
    return (title || '?')
      .split(' ')
      .filter(Boolean)
      .slice(0, 2)
      .map((w) => w[0].toUpperCase())
      .join('');
  }

  // Exposed globally so inline onerror= handlers (built by renderCard) can call it
  window.generateFallbackPosterEl = function (imgEl, id, title) {
    const hue = hashString(title || id) % 360;
    const wrapper = imgEl.parentElement;
    imgEl.style.display = 'none';
    if (wrapper && !wrapper.querySelector('.fallback-poster')) {
      const div = document.createElement('div');
      div.className = 'fallback-poster';
      div.setAttribute('aria-hidden', 'true');
      div.style.position = 'absolute';
      div.style.inset = '0';
      div.style.display = 'flex';
      div.style.alignItems = 'center';
      div.style.justifyContent = 'center';
      div.style.fontFamily = "'Bebas Neue', sans-serif";
      div.style.fontSize = '2.2rem';
      div.style.letterSpacing = '0.06em';
      div.style.color = 'rgba(255,255,255,0.85)';
      div.style.background = `linear-gradient(135deg, hsl(${hue},55%,18%) 0%, hsl(${(hue + 40) % 360},65%,28%) 100%)`;
      div.textContent = initials(title);
      wrapper.appendChild(div);
    }
  };

  function escapeHtml(str) {
    return String(str == null ? '' : str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function formatDuration(seconds) {
    if (!seconds) return '—';
    const m = Math.floor(seconds / 60);
    const h = Math.floor(m / 60);
    const mm = m % 60;
    return h > 0 ? `${h}h ${mm}m` : `${mm}m`;
  }

  /* ---------------------------------------------------------------- */
  /* Init / load                                                       */
  /* ---------------------------------------------------------------- */

  async function init() {
    state.loading = true;
    const [allMovies, allProgress] = await Promise.all([DB.movies.getAll(), DB.progress.getAll()]);
    state.movies = allMovies;
    state.progressMap = {};
    allProgress.forEach((p) => { state.progressMap[p.movieId] = p; });
    state.loading = false;
    applyFilters();
  }

  async function refreshProgress() {
    const allProgress = await DB.progress.getAll();
    state.progressMap = {};
    allProgress.forEach((p) => { state.progressMap[p.movieId] = p; });
  }

  /* ---------------------------------------------------------------- */
  /* Filtering / sorting                                               */
  /* ---------------------------------------------------------------- */

  function applyFilters() {
    let list = state.movies.slice();

    if (state.searchQuery) {
      const q = state.searchQuery.toLowerCase();
      list = list.filter((m) => {
        const haystack = [m.title, m.director, ...(m.cast || []), m.description, ...(m.genre || [])]
          .join(' ').toLowerCase();
        return haystack.includes(q);
      });
    }

    if (state.activeGenres.length) {
      list = list.filter((m) => (m.genre || []).some((g) => state.activeGenres.includes(g)));
    }

    list.sort((a, b) => {
      let av, bv;
      switch (state.sortBy) {
        case 'title': av = (a.title || '').toLowerCase(); bv = (b.title || '').toLowerCase(); break;
        case 'year': av = a.year || 0; bv = b.year || 0; break;
        case 'rating': av = a.rating || 0; bv = b.rating || 0; break;
        case 'progress': av = (state.progressMap[a.id] || {}).percent || 0; bv = (state.progressMap[b.id] || {}).percent || 0; break;
        default: av = a.addedAt || 0; bv = b.addedAt || 0;
      }
      if (av < bv) return state.sortDir === 'asc' ? -1 : 1;
      if (av > bv) return state.sortDir === 'asc' ? 1 : -1;
      return 0;
    });

    state.filtered = list;
  }

  function search(query) {
    state.searchQuery = query;
    applyFilters();
  }

  function getGenres() {
    const set = new Set();
    state.movies.forEach((m) => (m.genre || []).forEach((g) => set.add(g)));
    return Array.from(set).sort();
  }

  function getContinueWatching() {
    return state.movies
      .filter((m) => {
        const p = state.progressMap[m.id];
        return p && p.percent > 0 && p.percent < 95;
      })
      .sort((a, b) => state.progressMap[b.id].updatedAt - state.progressMap[a.id].updatedAt);
  }

  function getCompleted() {
    return state.movies.filter((m) => {
      const p = state.progressMap[m.id];
      return p && p.percent >= 95;
    });
  }

  /* ---------------------------------------------------------------- */
  /* Card / list rendering                                             */
  /* ---------------------------------------------------------------- */

  function renderCard(movie, progressRecord) {
    const percent = progressRecord ? progressRecord.percent : 0;
    const completed = progressRecord ? progressRecord.completed : false;
    const genres = (movie.genre || []).slice(0, 2)
      .map((g) => `<span class="genre-badge">${escapeHtml(g)}</span>`).join('');

    return `
      <article class="movie-card" data-id="${escapeHtml(movie.id)}" role="button" tabindex="0" aria-label="Open ${escapeHtml(movie.title)}">
        <div class="card-poster">
          <img src="${escapeHtml(movie.poster || '')}" alt="${escapeHtml(movie.title)} poster" loading="lazy"
               onerror="generateFallbackPosterEl(this, '${escapeHtml(movie.id)}', '${escapeHtml(movie.title)}')">
          <div class="card-overlay">
            <button class="play-btn btn-play-card" aria-label="Play ${escapeHtml(movie.title)}">▶</button>
          </div>
          ${percent > 0 ? `<div class="card-progress-bar"><div class="card-progress-fill" style="width:${percent}%"></div></div>` : ''}
          ${completed ? '<div class="completed-badge" aria-label="Completed">✓</div>' : ''}
        </div>
        <div class="card-info">
          <h3 class="card-title">${escapeHtml(movie.title)}</h3>
          <div class="card-meta">
            <span class="card-year">${escapeHtml(movie.year || '')}</span>
            <span class="card-rating">★ ${escapeHtml(movie.rating != null ? movie.rating.toFixed(1) : '—')}</span>
          </div>
          <div class="card-genres">${genres}</div>
        </div>
      </article>`;
  }

  function renderListItem(movie, progressRecord) {
    const percent = progressRecord ? progressRecord.percent : 0;
    return `
      <div class="movie-list-item" data-id="${escapeHtml(movie.id)}" role="button" tabindex="0" aria-label="Open ${escapeHtml(movie.title)}">
        <div class="list-thumb">
          <img src="${escapeHtml(movie.poster || '')}" alt="" loading="lazy"
               onerror="generateFallbackPosterEl(this, '${escapeHtml(movie.id)}', '${escapeHtml(movie.title)}')">
        </div>
        <div class="list-info">
          <h3 class="card-title">${escapeHtml(movie.title)}</h3>
          <div class="card-meta">
            <span>${escapeHtml(movie.year || '')}</span>
            <span class="card-rating">★ ${escapeHtml(movie.rating != null ? movie.rating.toFixed(1) : '—')}</span>
            <span>${formatDuration(movie.duration)}</span>
          </div>
        </div>
        <div class="list-progress">
          <div class="card-progress-bar" style="position:relative;height:4px;background:rgba(255,255,255,0.12);border-radius:4px;">
            <div class="card-progress-fill" style="width:${percent}%"></div>
          </div>
        </div>
        <button class="ctrl-btn btn-play-card" aria-label="Play ${escapeHtml(movie.title)}">▶</button>
      </div>`;
  }

  function renderGrid(movieList) {
    if (!movieList.length) {
      return `<div class="empty-state">
        <div class="empty-icon">🎬</div>
        <h3>No movies here yet</h3>
        <p>Try a different search, or add a movie of your own.</p>
        <button type="button" class="btn btn-primary btn-add-movie" style="margin-top:16px;">＋ Add a movie</button>
      </div>`;
    }
    return `<div class="movie-grid">${movieList.map((m) => renderCard(m, state.progressMap[m.id])).join('')}</div>`;
  }

  function renderSkeletonGrid(count = 8) {
    const card = `<div class="skeleton-card"><div class="skeleton-poster"></div><div class="skeleton-line" style="width:70%"></div><div class="skeleton-line" style="width:40%"></div></div>`;
    return `<div class="movie-grid">${card.repeat(count)}</div>`;
  }

  function renderListView(movieList) {
    if (!movieList.length) {
      return `<div class="empty-state"><div class="empty-icon">🎬</div><h3>No movies here yet</h3></div>`;
    }
    return `<div class="movie-list">${movieList.map((m) => renderListItem(m, state.progressMap[m.id])).join('')}</div>`;
  }

  /* ---------------------------------------------------------------- */
  /* Full library view                                                 */
  /* ---------------------------------------------------------------- */

  function render(targetEl) {
    const genres = getGenres();
    const genrePills = genres.map((g) => `
      <button class="genre-pill ${state.activeGenres.includes(g) ? 'active' : ''}" data-genre="${escapeHtml(g)}">${escapeHtml(g)}</button>
    `).join('');

    targetEl.innerHTML = `
      <h1 class="section-title display-text">Library</h1>
      <div class="library-toolbar">
        <div class="search-bar">
          <span aria-hidden="true">🔎</span>
          <input type="search" id="library-search" placeholder="Search title, director, cast…" value="${escapeHtml(state.searchQuery)}" aria-label="Search library">
        </div>
        <select class="sort-select" id="library-sort" aria-label="Sort by">
          <option value="addedAt" ${state.sortBy === 'addedAt' ? 'selected' : ''}>Recently added</option>
          <option value="title" ${state.sortBy === 'title' ? 'selected' : ''}>Title</option>
          <option value="year" ${state.sortBy === 'year' ? 'selected' : ''}>Year</option>
          <option value="rating" ${state.sortBy === 'rating' ? 'selected' : ''}>Rating</option>
          <option value="progress" ${state.sortBy === 'progress' ? 'selected' : ''}>Progress</option>
        </select>
        <div class="view-toggle" role="group" aria-label="View mode">
          <button id="view-grid" class="${state.viewMode === 'grid' ? 'active' : ''}" aria-label="Grid view">▦</button>
          <button id="view-list" class="${state.viewMode === 'list' ? 'active' : ''}" aria-label="List view">☰</button>
        </div>
      </div>
      ${genres.length ? `<div class="genre-pills">${genrePills}</div>` : ''}
      <div id="library-results">
        ${state.loading ? renderSkeletonGrid() : (state.viewMode === 'grid' ? renderGrid(state.filtered) : renderListView(state.filtered))}
      </div>
    `;

    wireToolbar(targetEl);
  }

  function reRenderResults(targetEl) {
    const resultsEl = targetEl.querySelector('#library-results');
    if (!resultsEl) return;
    resultsEl.innerHTML = state.viewMode === 'grid' ? renderGrid(state.filtered) : renderListView(state.filtered);
  }

  function wireToolbar(targetEl) {
    const searchInput = targetEl.querySelector('#library-search');
    if (searchInput) {
      let debounceTimer;
      searchInput.addEventListener('input', (e) => {
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
          search(e.target.value);
          reRenderResults(targetEl);
        }, 200);
      });
    }

    const sortSelect = targetEl.querySelector('#library-sort');
    if (sortSelect) {
      sortSelect.addEventListener('change', (e) => {
        state.sortBy = e.target.value;
        applyFilters();
        reRenderResults(targetEl);
      });
    }

    const gridBtn = targetEl.querySelector('#view-grid');
    const listBtn = targetEl.querySelector('#view-list');
    if (gridBtn && listBtn) {
      gridBtn.addEventListener('click', () => {
        state.viewMode = 'grid';
        gridBtn.classList.add('active');
        listBtn.classList.remove('active');
        reRenderResults(targetEl);
      });
      listBtn.addEventListener('click', () => {
        state.viewMode = 'list';
        listBtn.classList.add('active');
        gridBtn.classList.remove('active');
        reRenderResults(targetEl);
      });
    }

    targetEl.querySelectorAll('.genre-pill').forEach((pill) => {
      pill.addEventListener('click', () => {
        const g = pill.dataset.genre;
        const idx = state.activeGenres.indexOf(g);
        if (idx >= 0) state.activeGenres.splice(idx, 1);
        else state.activeGenres.push(g);
        applyFilters();
        render(targetEl);
      });
    });
  }

  /* ---------------------------------------------------------------- */
  /* Detail modal                                                      */
  /* ---------------------------------------------------------------- */

  async function openDetail(movieId) {
    const movie = await DB.movies.get(movieId);
    if (!movie) return;
    const progressRecord = state.progressMap[movieId];
    const modal = document.getElementById('detail-modal');

    modal.innerHTML = `
      <div class="modal-content" role="dialog" aria-modal="true" aria-labelledby="detail-title">
        <div class="modal-header">
          <h2 id="detail-title" class="display-text">${escapeHtml(movie.title)}</h2>
          <button class="modal-close" id="detail-close" aria-label="Close">✕</button>
        </div>
        <div class="modal-body">
          <div class="detail-backdrop">
            <img src="${escapeHtml(movie.backdrop || movie.poster || '')}" alt=""
                 onerror="this.style.display='none'">
          </div>
          <div class="detail-meta-row">
            <span>${escapeHtml(movie.year || '')}</span>
            <span class="card-rating">★ ${escapeHtml(movie.rating != null ? movie.rating.toFixed(1) : '—')}</span>
            <span>${formatDuration(movie.duration)}</span>
            ${movie.director ? `<span>Dir. ${escapeHtml(movie.director)}</span>` : ''}
          </div>
          <div class="detail-genres">${(movie.genre || []).map((g) => `<span class="genre-badge">${escapeHtml(g)}</span>`).join('')}</div>
          <p class="detail-desc">${escapeHtml(movie.description || '')}</p>
          ${progressRecord && progressRecord.percent > 0 ? `<p class="text-secondary" style="margin-bottom:16px;">${progressRecord.percent}% watched${progressRecord.completed ? ' · Completed' : ''}</p>` : ''}
          <div class="detail-actions">
            <button class="btn btn-primary" id="detail-play">▶ ${progressRecord && progressRecord.percent > 0 && progressRecord.percent < 95 ? 'Resume' : 'Play'}</button>
            <button class="btn btn-secondary" id="detail-delete">Remove from library</button>
          </div>
        </div>
      </div>`;

    UI.showModal('detail-modal');

    modal.querySelector('#detail-close').addEventListener('click', () => UI.hideModal('detail-modal'));
    modal.querySelector('#detail-play').addEventListener('click', () => {
      UI.hideModal('detail-modal');
      Player.open(movie, progressRecord ? progressRecord.position : 0);
    });
    modal.querySelector('#detail-delete').addEventListener('click', async () => {
      const ok = await UI.confirm(`Remove "${movie.title}" from your library?`);
      if (ok) {
        await deleteMovie(movieId);
        UI.hideModal('detail-modal');
      }
    });
  }

  /* ---------------------------------------------------------------- */
  /* CRUD                                                               */
  /* ---------------------------------------------------------------- */

  async function deleteMovie(movieId) {
    await DB.movies.delete(movieId);
    state.movies = state.movies.filter((m) => m.id !== movieId);
    applyFilters();
    UI.toast('Removed from library', 'info');
    App.navigate(App.currentView());
  }

  function validateMovieForm(formData) {
    const errors = {};
    if (!formData.title || !formData.title.trim()) errors.title = 'Title is required';
    if (!formData.videoUrl || !formData.videoUrl.trim()) {
      errors.videoUrl = 'A video URL is required';
    } else {
      try { new URL(formData.videoUrl); } catch (e) { errors.videoUrl = 'Enter a valid URL (must include https://)'; }
    }
    if (formData.year && (isNaN(formData.year) || formData.year < 1880 || formData.year > 2100)) {
      errors.year = 'Enter a realistic year';
    }
    return errors;
  }

  async function addMovie(formData) {
    const errors = validateMovieForm(formData);
    if (Object.keys(errors).length) return { ok: false, errors };

    const movie = {
      title: formData.title.trim(),
      year: formData.year ? parseInt(formData.year, 10) : null,
      duration: 0,
      genre: formData.genre ? formData.genre.split(',').map((g) => g.trim()).filter(Boolean) : [],
      rating: null,
      director: '',
      cast: [],
      description: formData.description || '',
      poster: formData.poster || '',
      backdrop: formData.poster || '',
      videoUrl: formData.videoUrl.trim(),
      videoType: formData.videoType || 'mp4',
      tags: [],
      addedAt: Date.now()
    };

    const id = await DB.movies.add(movie);
    movie.id = id;
    state.movies.unshift(movie);
    applyFilters();
    UI.toast(`Added "${movie.title}" to your library`, 'success');
    return { ok: true, movie };
  }

  return {
    init, render, renderGrid, renderCard, renderListItem, applyFilters, search,
    getGenres, openDetail, deleteMovie, addMovie, getContinueWatching, getCompleted,
    refreshProgress, formatDuration,
    get state() { return state; }
  };
})();

window.Library = Library;
