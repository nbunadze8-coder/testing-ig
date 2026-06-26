# 🎬 CinemaVault

**Your movies. Offline. Always.**

CinemaVault is a premium, dark-cinema-themed Progressive Web App for watching your own collection of streaming links, MP4 files, HLS streams, and YouTube/Vimeo embeds — with a custom player, watch-progress tracking, and full offline support for everything except the actual video stream. It's pure HTML/CSS/vanilla JS: no build step, no framework, no backend. Host it for free on GitHub Pages and it just works.

---

## Features

- 🎞 Personal movie library stored locally in IndexedDB — works fully offline
- ▶ Custom cinematic video player supporting MP4, HLS (via hls.js), YouTube, Vimeo, and generic iframe embeds
- ⏱ Automatic watch-progress tracking with resume-from-last-position
- 🔍 Live search, genre filters, and sorting (title / year / rating / progress / recently added)
- 📱 Installable PWA with offline app shell, install prompt, and update notifications
- ⌨️ Full keyboard shortcuts and touch swipe gestures in the player
- 📤 Export/import your library as a JSON file
- ♿ Keyboard-accessible throughout, with focus-trapped modals and a skip-to-content link
- 🌙 Premium dark cinema design language with red accent glow, film grain, and smooth transitions

---

## Folder Structure

```
/
├── index.html              ← Main SPA shell
├── manifest.json           ← PWA manifest
├── sw.js                   ← Service worker (offline + caching)
├── movies.json             ← Sample movie library data
├── css/
│   └── styles.css          ← All styles
├── js/
│   ├── app.js               ← App controller, router, UI helpers
│   ├── player.js            ← Video player engine + controls
│   ├── library.js           ← Library CRUD, search, filters
│   ├── storage.js           ← IndexedDB wrapper + progress
│   └── pwa.js                ← Service worker registration + install prompt
├── icons/
│   └── icon-gen-instructions.txt
└── README.md
```

---

## Step 1: Clone / Download

Download or clone this folder however you got it (zip, git clone, etc.) and keep the folder structure intact — the app expects `css/`, `js/`, and `icons/` to sit right next to `index.html`.

## Step 2: Add Your Icons

The manifest expects `icons/icon-192.png` and `icons/icon-512.png`, which aren't included as binary files in this build. Open **`icons/icon-gen-instructions.txt`** — it has a ready-to-use SVG and three different ways to turn it into PNGs (a CLI tool, Inkscape, or a free web converter). Drop the two exported PNGs into the `icons/` folder.

## Step 3: Customize `movies.json`

Each entry in the array follows this shape:

| Field | Type | Notes |
|---|---|---|
| `id` | string | Unique ID, e.g. `mv_013` |
| `title` | string | |
| `year` | number | |
| `duration` | number | Seconds |
| `genre` | string[] | |
| `rating` | number | Out of 10 |
| `director` | string | |
| `cast` | string[] | |
| `description` | string | |
| `poster` | string (URL) | Portrait poster image |
| `backdrop` | string (URL) | Landscape hero image, shown in the detail modal |
| `videoUrl` | string (URL) | The actual video/stream source |
| `videoType` | `"mp4" \| "hls" \| "iframe" \| "youtube" \| "vimeo"` | Determines which player engine is used |
| `tags` | string[] | Free-form, not currently surfaced in the UI |

You can edit this file directly, or just use the **Add Movie** screen in the app — anything added there is saved to IndexedDB, not back to this file.

## Step 4: Deploy to GitHub Pages

1. Push this folder to a GitHub repository.
2. Go to your repo's **Settings → Pages**.
3. Under **Source**, choose **Deploy from a branch**, pick branch `main` and folder `/ (root)`, then **Save**.
4. Wait about a minute, then visit `https://yourusername.github.io/your-repo-name/`.

> ⚠️ **Subfolder warning:** If your site is served from a subfolder (e.g. `/cinemavault/` instead of the domain root), update `start_url` and `scope` in `manifest.json` to match (e.g. `"./index.html"` and `"./"` already work for any relative path, but double-check them if you renamed things). The service worker's cache scope is tied to the folder `sw.js` is served from, so don't move it without updating the registration path in `js/pwa.js`.

## Step 5: Install as a PWA

- **Chrome / Edge (desktop or Android):** look for the install icon in the address bar, or use the in-app install banner that appears automatically.
- **iOS Safari:** tap the Share button → **Add to Home Screen**. (iOS doesn't support the automatic install banner.)

---

## Adding Movies

Use the **＋ Add Movie** screen (or the quick-add button shown wherever your library is empty). You'll need:
- A **title**
- A **video URL** — a direct `.mp4`/`.m3u8` link, or a YouTube/Vimeo page URL
- A **source type** — pick the pill that matches your URL (MP4, HLS, YouTube, Vimeo, or generic Iframe)
- Optional poster URL, year, genres, and description

If you skip the poster, CinemaVault generates a colored placeholder using the movie's title.

---

## Offline Behavior

| Works offline | Needs internet |
|---|---|
| Browsing your library, search, filters | Actually streaming/playing any video |
| Viewing posters/backdrops you've already loaded once | Loading a poster you've never seen before |
| Watch progress, settings, export/import | YouTube/Vimeo embeds (always need their own servers) |
| The whole app shell (HTML/CSS/JS) after the first visit | |

If you try to play something while offline, CinemaVault shows a toast explaining why instead of failing silently.

---

## Keyboard Shortcuts

| Key | Action |
|---|---|
| `Space` / `K` | Play / Pause |
| `←` / `J` | Rewind 10s |
| `→` / `L` | Forward 30s |
| `↑` | Volume up 10% |
| `↓` | Volume down 10% |
| `M` | Toggle mute |
| `F` | Toggle fullscreen |
| `P` | Toggle Picture-in-Picture |
| `0`–`9` | Seek to 0%–90% of the movie |
| `Esc` | Close player |
| `,` / `<` | Decrease playback speed |
| `.` / `>` | Increase playback speed |
| `/` (outside the player) | Jump to library search |

On touch devices, swipe left/right anywhere on the player to rewind/forward.

---

## Customization

- **Colors, fonts, spacing:** all defined as CSS custom properties at the top of `css/styles.css` (`:root { --accent: #e50914; ... }`). Change a variable once and it updates everywhere.
- **Fonts:** swap the Google Fonts `<link>` in `index.html` and update `--font-display` / `--font-body` in `styles.css`.
- **Default library:** edit `movies.json` — it's only used to seed an empty library on first run, so existing users won't see changes until they clear their data.

---

## Known Limitations

- **CORS:** some video hosts block cross-origin `<video>` playback entirely. The sample library only uses CORS-friendly sources (Google's public test bucket); your own links may need to come from a host that sets the right CORS headers.
- **YouTube / Vimeo:** these always stream from their own servers — there's no offline mode for embeds, regardless of what CinemaVault caches.
- **HLS:** requires loading `hls.js` from a CDN the first time you play an `.m3u8` stream, so that one library needs to be cached or online at least once.
- **No real backend:** everything lives in your browser's IndexedDB. Clearing site data (or switching browsers/devices) means starting your library over, unless you've exported it first.

---

## License

MIT — do whatever you'd like with this.
