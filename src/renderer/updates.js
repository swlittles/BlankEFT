'use strict';
/* global S, toast, escapeHtml */
// Update status: a top-bar button when a new version is ready, and an "Updates" section in Settings.
(function () {
  let st = null;

  function render() {
    const btn = document.getElementById('update-btn');
    if (btn) {
      const ready = st?.state === 'ready';
      btn.hidden = !ready;
      if (ready) {
        btn.textContent = `⬆ Update to v${st.latest}`;
        btn.title = `Version ${st.latest} is downloaded. Click to restart into it (your progress is saved first). It also installs by itself next time you close the app.`;
      }
    }
    const box = document.getElementById('update-settings');
    if (box) box.innerHTML = settingsHtml();
  }

  function settingsHtml() {
    if (!st) return '';
    const when = st.checkedAt ? ` · checked ${new Date(st.checkedAt).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}` : '';
    let line;
    if (!st.supported) line = 'Updates only work in the installed app (from the GitHub Releases page). This copy won’t update itself.';
    else if (st.state === 'checking') line = 'Checking GitHub for a new version…';
    else if (st.state === 'downloading') line = `Downloading v${escapeHtml(st.latest || '')}… ${st.percent ?? 0}%`;
    else if (st.state === 'ready') line = `v${escapeHtml(st.latest)} is ready. Restart to use it, or it installs when you close the app.`;
    else if (st.state === 'latest') line = `You have the latest version${when}.`;
    else if (st.state === 'error') line = `Couldn’t check for updates: ${escapeHtml(st.error || 'unknown error')}${when}`;
    else line = 'Checks GitHub for new versions on start and every 2 hours.';
    const btn =
      st.state === 'ready'
        ? '<button data-update="install">Restart and update</button>'
        : st.supported
          ? `<button data-update="check" ${st.state === 'checking' || st.state === 'downloading' ? 'disabled' : ''}>Check for updates</button>`
          : '';
    return `<div class="kv"><span>Version</span><code>${escapeHtml(st.version)}</code></div>
      <p class="muted small">${line}</p>${btn}
      <p class="muted small"><a href="#" data-link="https://github.com/swlittles/BlankEFT/releases">Release notes on GitHub</a></p>`;
  }

  function onClick(e) {
    const b = e.target.closest('[data-update]');
    if (!b) return;
    if (b.dataset.update === 'check') window.tqm.checkUpdate();
    if (b.dataset.update === 'install') window.tqm.installUpdate();
  }

  async function init() {
    window.tqm.on('update', (s) => {
      st = s;
      render();
    });
    document.getElementById('update-btn')?.addEventListener('click', () => window.tqm.installUpdate());
    document.addEventListener('click', onClick);
    // the Settings tab is redrawn from scratch: put the Updates section back each time
    const settings = document.getElementById('tab-settings');
    if (settings) {
      new MutationObserver(() => {
        if (!document.getElementById('update-settings')) {
          const sec = document.createElement('div');
          sec.innerHTML = '<h3>Updates</h3><div id="update-settings"></div>';
          settings.prepend(...sec.childNodes);
          render();
        }
      }).observe(settings, { childList: true });
    }
    st = await window.tqm.getUpdate();
    render();
  }

  window.Updates = { init, show: (v) => toast?.(`Version ${v} is ready. Restart to update, or it installs when you close the app.`, 'ok', { label: 'Restart now', ms: 15000, onClick: () => window.tqm.installUpdate() }) };
  document.addEventListener('DOMContentLoaded', init);
})();
