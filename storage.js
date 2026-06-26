'use strict';
/* ==========================================================================
   storage.js — IndexedDB wrapper + progress sync
   Exposes a global `DB` namespace with movies / progress / settings APIs.
   Falls back to a tiny localStorage shim if IndexedDB is unavailable so the
   rest of the app never has to know which backend it is talking to.
   ========================================================================== */

const DB_NAME = 'CinemaVaultDB';
const DB_VERSION = 1;
const STORE_MOVIES = 'movies';
const STORE_PROGRESS = 'progress';
const STORE_SETTINGS = 'settings';

let _db = null;
let _useFallback = false;

/* ---- localStorage fallback (used only if indexedDB is unsupported) ---- */
const _fallback = {
  _read(key) {
    try { return JSON.parse(localStorage.getItem(key)) || {}; }
    catch (e) { return {}; }
  },
  _write(key, val) {
    try { localStorage.setItem(key, JSON.stringify(val)); }
    catch (e) { console.warn('CinemaVault: localStorage write failed', e.message); }
  }
};

/* ---------------------------------------------------------------------- */
/* Core open / upgrade                                                    */
/* ---------------------------------------------------------------------- */
function openDatabase() {
  return new Promise((resolve, reject) => {
    if (!('indexedDB' in window)) {
      _useFallback = true;
      console.warn('CinemaVault: IndexedDB unavailable, using localStorage fallback');
      resolve(null);
      return;
    }

    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = (event) => {
      const db = event.target.result;

      if (!db.objectStoreNames.contains(STORE_MOVIES)) {
        const movieStore = db.createObjectStore(STORE_MOVIES, { keyPath: 'id' });
        movieStore.createIndex('title', 'title', { unique: false });
        movieStore.createIndex('genre', 'genre', { unique: false, multiEntry: true });
        movieStore.createIndex('addedAt', 'addedAt', { unique: false });
      }

      if (!db.objectStoreNames.contains(STORE_PROGRESS)) {
        const progressStore = db.createObjectStore(STORE_PROGRESS, { keyPath: 'movieId' });
        progressStore.createIndex('updatedAt', 'updatedAt', { unique: false });
      }

      if (!db.objectStoreNames.contains(STORE_SETTINGS)) {
        db.createObjectStore(STORE_SETTINGS, { keyPath: 'key' });
      }
    };

    req.onsuccess = (event) => {
      _db = event.target.result;
      resolve(_db);
    };

    req.onerror = (event) => {
      console.error('CinemaVault: failed to open IndexedDB', event.target.error);
      _useFallback = true;
      resolve(null);
    };
  });
}

/* Generic promise wrapper around a single IDB request */
function promisifyRequest(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function getStore(name, mode = 'readonly') {
  return _db.transaction(name, mode).objectStore(name);
}

/* ---------------------------------------------------------------------- */
/* Movies API                                                             */
/* ---------------------------------------------------------------------- */
const movies = {
  async getAll() {
    if (_useFallback) {
      const data = _fallback._read('cv_movies');
      return Object.values(data);
    }
    return promisifyRequest(getStore(STORE_MOVIES).getAll());
  },

  async get(id) {
    if (_useFallback) {
      const data = _fallback._read('cv_movies');
      return data[id] || null;
    }
    return promisifyRequest(getStore(STORE_MOVIES).get(id)) || null;
  },

  async add(movie) {
    if (!movie.id) movie.id = 'mv_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
    if (!movie.addedAt) movie.addedAt = Date.now();

    if (_useFallback) {
      const data = _fallback._read('cv_movies');
      data[movie.id] = movie;
      _fallback._write('cv_movies', data);
      return movie.id;
    }
    await promisifyRequest(getStore(STORE_MOVIES, 'readwrite').add(movie));
    return movie.id;
  },

  async update(id, changes) {
    const existing = await movies.get(id);
    if (!existing) throw new Error('Movie not found: ' + id);
    const updated = Object.assign({}, existing, changes, { id });

    if (_useFallback) {
      const data = _fallback._read('cv_movies');
      data[id] = updated;
      _fallback._write('cv_movies', data);
      return;
    }
    await promisifyRequest(getStore(STORE_MOVIES, 'readwrite').put(updated));
  },

  async delete(id) {
    if (_useFallback) {
      const data = _fallback._read('cv_movies');
      delete data[id];
      _fallback._write('cv_movies', data);
      return;
    }
    await promisifyRequest(getStore(STORE_MOVIES, 'readwrite').delete(id));
  },

  async search(query) {
    const all = await movies.getAll();
    const q = (query || '').toLowerCase().trim();
    if (!q) return all;
    return all.filter((m) => {
      const haystack = [
        m.title, m.director,
        ...(Array.isArray(m.cast) ? m.cast : []),
        m.description,
        ...(Array.isArray(m.genre) ? m.genre : [])
      ].join(' ').toLowerCase();
      return haystack.includes(q);
    });
  }
};

/* ---------------------------------------------------------------------- */
/* Progress API                                                           */
/* ---------------------------------------------------------------------- */
const progress = {
  async get(movieId) {
    if (_useFallback) {
      const data = _fallback._read('cv_progress');
      return data[movieId] || null;
    }
    const result = await promisifyRequest(getStore(STORE_PROGRESS).get(movieId));
    return result || null;
  },

  async save(movieId, position, duration) {
    const percent = duration > 0 ? Math.min(100, Math.round((position / duration) * 100)) : 0;
    const record = {
      movieId,
      position,
      duration,
      percent,
      completed: percent >= 95,
      updatedAt: Date.now()
    };

    if (_useFallback) {
      const data = _fallback._read('cv_progress');
      data[movieId] = record;
      _fallback._write('cv_progress', data);
      return record;
    }
    await promisifyRequest(getStore(STORE_PROGRESS, 'readwrite').put(record));
    return record;
  },

  async clear(movieId) {
    if (_useFallback) {
      const data = _fallback._read('cv_progress');
      delete data[movieId];
      _fallback._write('cv_progress', data);
      return;
    }
    await promisifyRequest(getStore(STORE_PROGRESS, 'readwrite').delete(movieId));
  },

  async getAll() {
    if (_useFallback) {
      return Object.values(_fallback._read('cv_progress'));
    }
    return promisifyRequest(getStore(STORE_PROGRESS).getAll());
  },

  async clearAll() {
    if (_useFallback) {
      _fallback._write('cv_progress', {});
      return;
    }
    await promisifyRequest(getStore(STORE_PROGRESS, 'readwrite').clear());
  }
};

/* ---------------------------------------------------------------------- */
/* Settings API                                                           */
/* ---------------------------------------------------------------------- */
const DEFAULT_SETTINGS = {
  autoplayNext: false,
  autoResume: true,
  hoverControlsOnly: false
};

const settings = {
  async get(key) {
    if (_useFallback) {
      const data = _fallback._read('cv_settings');
      return key in data ? data[key] : DEFAULT_SETTINGS[key];
    }
    const result = await promisifyRequest(getStore(STORE_SETTINGS).get(key));
    return result ? result.value : DEFAULT_SETTINGS[key];
  },

  async set(key, value) {
    if (_useFallback) {
      const data = _fallback._read('cv_settings');
      data[key] = value;
      _fallback._write('cv_settings', data);
      return;
    }
    await promisifyRequest(getStore(STORE_SETTINGS, 'readwrite').put({ key, value }));
  },

  async getAll() {
    let stored = {};
    if (_useFallback) {
      stored = _fallback._read('cv_settings');
    } else {
      const rows = await promisifyRequest(getStore(STORE_SETTINGS).getAll());
      rows.forEach((row) => { stored[row.key] = row.value; });
    }
    return Object.assign({}, DEFAULT_SETTINGS, stored);
  }
};

/* ---------------------------------------------------------------------- */
/* Top-level DB namespace                                                  */
/* ---------------------------------------------------------------------- */
const DB = {
  movies,
  progress,
  settings,

  async init() {
    await openDatabase();
    const existing = await movies.getAll();
    if (existing.length === 0) {
      await DB.seedFromJson('./movies.json');
    }
    return true;
  },

  async seedFromJson(url) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const seedMovies = await res.json();
      for (const movie of seedMovies) {
        movie.addedAt = movie.addedAt || Date.now();
        if (_useFallback) {
          const data = _fallback._read('cv_movies');
          data[movie.id] = movie;
          _fallback._write('cv_movies', data);
        } else {
          await promisifyRequest(getStore(STORE_MOVIES, 'readwrite').put(movie));
        }
      }
      console.log('CinemaVault: seeded library with', seedMovies.length, 'movies');
    } catch (err) {
      console.warn('CinemaVault: could not seed movies.json —', err.message);
    }
  },

  async exportLibrary() {
    const allMovies = await movies.getAll();
    const allSettings = await settings.getAll();
    return JSON.stringify({ movies: allMovies, settings: allSettings, exportedAt: Date.now() }, null, 2);
  },

  async importLibrary(jsonString) {
    const parsed = JSON.parse(jsonString);
    const incoming = Array.isArray(parsed) ? parsed : (parsed.movies || []);
    if (!Array.isArray(incoming)) throw new Error('Invalid library file: expected an array of movies');

    // Clear existing movies (progress records are intentionally kept)
    if (_useFallback) {
      _fallback._write('cv_movies', {});
    } else {
      await promisifyRequest(getStore(STORE_MOVIES, 'readwrite').clear());
    }

    for (const movie of incoming) {
      movie.addedAt = movie.addedAt || Date.now();
      if (!movie.id) movie.id = 'mv_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
      if (_useFallback) {
        const data = _fallback._read('cv_movies');
        data[movie.id] = movie;
        _fallback._write('cv_movies', data);
      } else {
        await promisifyRequest(getStore(STORE_MOVIES, 'readwrite').put(movie));
      }
    }
    return incoming.length;
  },

  async clearAll() {
    if (_useFallback) {
      _fallback._write('cv_movies', {});
      _fallback._write('cv_progress', {});
      _fallback._write('cv_settings', {});
      return;
    }
    await promisifyRequest(getStore(STORE_MOVIES, 'readwrite').clear());
    await promisifyRequest(getStore(STORE_PROGRESS, 'readwrite').clear());
    await promisifyRequest(getStore(STORE_SETTINGS, 'readwrite').clear());
  }
};

window.DB = DB;
