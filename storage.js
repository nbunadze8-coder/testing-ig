'use strict';

/**
 * CinemaVault — storage.js
 * IndexedDB wrapper with localStorage fallback.
 * Exposes window.DB for use by all other modules.
 */

const DB = (() => {
  const DB_NAME    = 'CinemaVaultDB';
  const DB_VERSION = 1;
  let _db = null;

  /* ─── Open / Upgrade ─────────────────────────────────────── */
  function init() {
    return new Promise((resolve, reject) => {
      if (_db) { resolve(_db); return; }

      const req = indexedDB.open(DB_NAME, DB_VERSION);

      req.onupgradeneeded = (e) => {
        const db = e.target.result;

        // movies store
        if (!db.objectStoreNames.contains('movies')) {
          const ms = db.createObjectStore('movies', { keyPath: 'id' });
          ms.createIndex('title',   'title',   { unique: false });
          ms.createIndex('addedAt', 'addedAt', { unique: false });
        }

        // progress store
        if (!db.objectStoreNames.contains('progress')) {
          const ps = db.createObjectStore('progress', { keyPath: 'movieId' });
          ps.createIndex('updatedAt', 'updatedAt', { unique: false });
        }

        // settings store
        if (!db.objectStoreNames.contains('settings')) {
          db.createObjectStore('settings', { keyPath: 'key' });
        }
      };

      req.onsuccess  = (e) => { _db = e.target.result; resolve(_db); };
      req.onerror    = (e) => {
        console.error('[DB] open failed:', e.target.error);
        reject(e.target.error);
      };
    });
  }

  /* ─── Generic transaction helpers ────────────────────────── */
  function tx(storeName, mode = 'readonly') {
    return _db.transaction(storeName, mode).objectStore(storeName);
  }

  function promisifyReq(req) {
    return new Promise((resolve, reject) => {
      req.onsuccess = (e) => resolve(e.target.result);
      req.onerror   = (e) => reject(e.target.error);
    });
  }

  function getAll(storeName) {
    return promisifyReq(tx(storeName).getAll());
  }

  /* ─── Movies ──────────────────────────────────────────────── */
  const movies = {
    getAll() {
      return promisifyReq(tx('movies').getAll())
        .then(list => list.sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0)));
    },

    get(id) {
      return promisifyReq(tx('movies').get(id));
    },

    add(movie) {
      movie.addedAt = movie.addedAt || Date.now();
      return promisifyReq(tx('movies', 'readwrite').put(movie)).then(() => movie.id);
    },

    update(id, changes) {
      return movies.get(id).then(existing => {
        if (!existing) return Promise.reject(new Error(`Movie ${id} not found`));
        const updated = { ...existing, ...changes, id };
        return promisifyReq(tx('movies', 'readwrite').put(updated));
      });
    },

    delete(id) {
      return promisifyReq(tx('movies', 'readwrite').delete(id));
    },

    /** Fuzzy search across title, director, description, cast */
    search(query) {
      const q = query.toLowerCase().trim();
      if (!q) return movies.getAll();
      return movies.getAll().then(list =>
        list.filter(m =>
          (m.title || '').toLowerCase().includes(q) ||
          (m.director || '').toLowerCase().includes(q) ||
          (m.description || '').toLowerCase().includes(q) ||
          (m.cast || []).join(' ').toLowerCase().includes(q) ||
          (m.genre || []).join(' ').toLowerCase().includes(q)
        )
      );
    },

    count() {
      return promisifyReq(tx('movies').count());
    }
  };

  /* ─── Progress ────────────────────────────────────────────── */
  const progress = {
    get(movieId) {
      return promisifyReq(tx('progress').get(movieId));
    },

    /** Save playback position. percent is computed from pos/duration */
    save(movieId, pos, duration) {
      const percent   = duration > 0 ? Math.round((pos / duration) * 100) : 0;
      const completed = percent >= 95;
      const record    = { movieId, position: pos, duration, percent, completed, updatedAt: Date.now() };
      return promisifyReq(tx('progress', 'readwrite').put(record));
    },

    clear(movieId) {
      return promisifyReq(tx('progress', 'readwrite').delete(movieId));
    },

    getAll() {
      return promisifyReq(tx('progress').getAll());
    },

    clearAll() {
      return promisifyReq(tx('progress', 'readwrite').clear());
    }
  };

  /* ─── Settings ────────────────────────────────────────────── */
  const settings = {
    get(key) {
      return promisifyReq(tx('settings').get(key))
        .then(record => record ? record.value : undefined);
    },

    set(key, value) {
      return promisifyReq(tx('settings', 'readwrite').put({ key, value }));
    },

    getAll() {
      return promisifyReq(tx('settings').getAll())
        .then(records => {
          const out = {};
          records.forEach(r => { out[r.key] = r.value; });
          return out;
        });
    }
  };

  /* ─── Seed from movies.json ───────────────────────────────── */
  async function seedFromJson(url) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const list = await res.json();
      const store = tx('movies', 'readwrite');
      const now = Date.now();
      for (let i = 0; i < list.length; i++) {
        const movie = { ...list[i], addedAt: now - i * 1000 };
        await promisifyReq(store.put(movie));
      }
      console.info(`[DB] Seeded ${list.length} movies from ${url}`);
    } catch (err) {
      console.error('[DB] Seed failed:', err.message);
    }
  }

  /* ─── Import / Export ─────────────────────────────────────── */
  async function exportLibrary() {
    const [movieList, settingMap, progressList] = await Promise.all([
      movies.getAll(),
      settings.getAll(),
      progress.getAll()
    ]);
    return JSON.stringify({ movies: movieList, settings: settingMap, progress: progressList }, null, 2);
  }

  async function importLibrary(jsonString) {
    const data = JSON.parse(jsonString);
    if (!Array.isArray(data.movies)) throw new Error('Invalid library format: missing movies array');

    // Clear movies store and re-seed
    await promisifyReq(tx('movies', 'readwrite').clear());
    for (const movie of data.movies) {
      await promisifyReq(tx('movies', 'readwrite').put(movie));
    }

    // Restore settings if present
    if (data.settings && typeof data.settings === 'object') {
      for (const [key, value] of Object.entries(data.settings)) {
        await settings.set(key, value);
      }
    }

    console.info(`[DB] Imported ${data.movies.length} movies`);
  }

  async function clearAll() {
    await promisifyReq(tx('movies',   'readwrite').clear());
    await promisifyReq(tx('progress', 'readwrite').clear());
    await promisifyReq(tx('settings', 'readwrite').clear());
  }

  /* ─── LocalStorage fallback (if IndexedDB unavailable) ────── */
  function localStorageFallback() {
    console.warn('[DB] IndexedDB unavailable, falling back to localStorage');
    const PREFIX = 'cv_';
    const _get = k => { try { return JSON.parse(localStorage.getItem(PREFIX + k)); } catch { return null; } };
    const _set = (k,v) => localStorage.setItem(PREFIX + k, JSON.stringify(v));

    return {
      init: () => Promise.resolve(),
      movies: {
        getAll:  () => Promise.resolve(_get('movies') || []),
        get:     (id) => Promise.resolve((_get('movies') || []).find(m => m.id === id) || null),
        add:     (m)  => { const list = _get('movies') || []; list.unshift(m); _set('movies', list); return Promise.resolve(m.id); },
        update:  (id, c) => { const list = _get('movies') || []; const i = list.findIndex(m => m.id === id); if (i >= 0) list[i] = {...list[i], ...c}; _set('movies', list); return Promise.resolve(); },
        delete:  (id) => { _set('movies', (_get('movies') || []).filter(m => m.id !== id)); return Promise.resolve(); },
        search:  (q)  => Promise.resolve((_get('movies') || []).filter(m => m.title.toLowerCase().includes(q.toLowerCase()))),
        count:   ()   => Promise.resolve((_get('movies') || []).length)
      },
      progress: {
        get:     (id) => Promise.resolve((_get('progress') || {})[id] || null),
        save:    (id, pos, dur) => { const p = _get('progress') || {}; p[id] = {movieId:id, position:pos, duration:dur, percent: dur>0?Math.round(pos/dur*100):0, updatedAt:Date.now()}; _set('progress', p); return Promise.resolve(); },
        clear:   (id) => { const p = _get('progress') || {}; delete p[id]; _set('progress', p); return Promise.resolve(); },
        getAll:  () => Promise.resolve(Object.values(_get('progress') || {})),
        clearAll:() => { _set('progress', {}); return Promise.resolve(); }
      },
      settings: {
        get: (k) => Promise.resolve((_get('settings') || {})[k]),
        set: (k,v) => { const s = _get('settings') || {}; s[k]=v; _set('settings', s); return Promise.resolve(); },
        getAll: () => Promise.resolve(_get('settings') || {})
      },
      exportLibrary,
      importLibrary,
      clearAll: () => { localStorage.removeItem(PREFIX+'movies'); localStorage.removeItem(PREFIX+'progress'); localStorage.removeItem(PREFIX+'settings'); return Promise.resolve(); },
      seedFromJson
    };
  }

  /* ─── Public API ──────────────────────────────────────────── */
  return {
    init: async () => {
      if (!window.indexedDB) {
        Object.assign(window.DB, localStorageFallback());
        return;
      }
      try {
        await init();
        // Seed on first run
        const count = await movies.count();
        if (count === 0) await seedFromJson('./movies.json');
      } catch (err) {
        console.error('[DB] init error:', err);
        Object.assign(window.DB, localStorageFallback());
      }
    },
    movies,
    progress,
    settings,
    exportLibrary,
    importLibrary,
    clearAll,
    seedFromJson
  };
})();

window.DB = DB;
