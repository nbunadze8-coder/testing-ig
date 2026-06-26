'use strict';
/* ==========================================================================
   pwa.js — Service worker registration, install prompt, update notifications
   ========================================================================== */

const PWA = (() => {
  let deferredPrompt = null;
  let registration = null;

  /* ---------------------------------------------------------------- */
  /* Service worker registration                                       */
  /* ---------------------------------------------------------------- */

  function register() {
    if (!('serviceWorker' in navigator)) {
      console.warn('CinemaVault: Service Workers are unsupported here — the app still works, just without offline caching.');
      return;
    }

    window.addEventListener('load', () => {
      navigator.serviceWorker.register('./sw.js').then((reg) => {
        registration = reg;
        console.log('CinemaVault: service worker registered at scope', reg.scope);

        reg.addEventListener('updatefound', () => {
          const installing = reg.installing;
          if (!installing) return;
          installing.addEventListener('statechange', () => {
            // A new SW finished installing while an old one is already controlling
            // the page — that means there's an update waiting, not a first install.
            if (installing.state === 'installed' && navigator.serviceWorker.controller) {
              notifyUpdate(reg);
            }
          });
        });
      }).catch((err) => {
        console.warn('CinemaVault: service worker registration failed —', err.message);
      });

      // Reload exactly once after the new SW takes control, so the update applies.
      let hasReloaded = false;
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (hasReloaded) return;
        hasReloaded = true;
        window.location.reload();
      });
    });
  }

  /* ---------------------------------------------------------------- */
  /* Install prompt (Android/desktop "beforeinstallprompt")            */
  /* ---------------------------------------------------------------- */

  function setupInstallPrompt() {
    if (checkInstalled()) return;

    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault();
      deferredPrompt = e;
      showBanner();
    });

    window.addEventListener('appinstalled', () => {
      deferredPrompt = null;
      hideBanner();
      if (window.UI) UI.toast('CinemaVault installed — find it on your home screen.', 'success');
    });

    const installBtn = document.getElementById('btn-install');
    const dismissBtn = document.getElementById('btn-dismiss-install');
    if (installBtn) installBtn.addEventListener('click', install);
    if (dismissBtn) dismissBtn.addEventListener('click', hideBanner);
  }

  function showBanner() {
    const banner = document.getElementById('install-banner');
    if (banner) banner.classList.remove('hidden');
  }

  function hideBanner() {
    const banner = document.getElementById('install-banner');
    if (banner) banner.classList.add('hidden');
  }

  async function install() {
    if (!deferredPrompt) return;
    deferredPrompt.prompt();
    const choice = await deferredPrompt.userChoice;
    if (choice.outcome === 'accepted') hideBanner();
    deferredPrompt = null;
  }

  function checkInstalled() {
    return window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
  }

  /* ---------------------------------------------------------------- */
  /* Update notification                                                */
  /* ---------------------------------------------------------------- */

  function notifyUpdate(reg) {
    if (!window.UI) return;
    UI.toast('Update available — tap to refresh', 'info', 10000, () => {
      if (reg.waiting) reg.waiting.postMessage({ action: 'skipWaiting' });
    });
  }

  return {
    register,
    setupInstallPrompt,
    install,
    checkInstalled,
    notifyUpdate,
    get deferredPrompt() { return deferredPrompt; }
  };
})();

window.PWA = PWA;
