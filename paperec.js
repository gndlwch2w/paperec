// ==UserScript==
// @name         paperec
// @description  Paper recommendation and rating system for papers.cool
// @namespace    http://tampermonkey.net/
// @version      1.0.2
// @author       Chisheng Chen
// @match        https://papers.cool/arxiv/*
// @match        https://papers.cool/venue/*
// @license      MIT License
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  const PAPERS_KEY = 'paperec_papers';
  const DEBUG_KEY = 'paperec_debug';
  const SETTINGS_KEY = 'paperec_settings';
  const TOAST_ROOT_ID = 'paperec-toast-root';
  const CONTROL_BAR_ID = 'app-bar-paperec';
  const CONTROL_BAR_BUTTON_ID = 'app-bar-paperec-btn';
  const PAPEREC_SERVER = 'https://113.55.8.157:8765';
  const DEFAULT_SETTINGS = Object.freeze({
    recommendationEnabled: true,
    serverUrl: PAPEREC_SERVER,
  });

  // Enable via: localStorage.setItem('paperec_debug','1') then reload,
  // or at runtime: window.paperecDebug(true)
  let debugEnabled = localStorage.getItem(DEBUG_KEY) === '1';
  let storageWriteWarned = false;
  let settingsWriteWarned = false;
  let controlBarUi = null;
  const log = (...args) => debugEnabled && console.log('[Paperec]', ...args);
  const warn = (...args) => debugEnabled && console.warn('[Paperec]', ...args);

  function getToastRoot() {
    let root = document.getElementById(TOAST_ROOT_ID);
    if (root) return root;
    root = document.createElement('div');
    root.id = TOAST_ROOT_ID;
    root.style.cssText = [
      'position: fixed',
      'top: 14px',
      'right: 14px',
      'z-index: 2147483647',
      'display: flex',
      'flex-direction: column',
      'gap: 8px',
      'max-width: min(280px, calc(100vw - 28px))',
      'pointer-events: none',
    ].join(';');
    document.body.appendChild(root);
    return root;
  }

  function toast(message, type = 'info', duration = 4200) {
    if (!message) return;

    const colors = {
      info: '#1f2937',
      success: '#166534',
      warning: '#92400e',
      error: '#991b1b',
    };

    const item = document.createElement('div');
    const messageText = String(message);
    item.textContent = messageText;
    item.title = messageText;
    item.style.cssText = [
      `background: ${colors[type] || colors.info}`,
      'color: #fff',
      'padding: 10px 12px',
      'border-radius: 8px',
      'box-shadow: 0 8px 20px rgba(0, 0, 0, 0.28)',
      'font-size: 13px',
      'line-height: 1.45',
      'opacity: 0',
      'transform: translateY(-4px)',
      'transition: opacity 0.18s ease, transform 0.18s ease',
      'max-width: 100%',
      'white-space: nowrap',
      'overflow: hidden',
      'text-overflow: ellipsis',
      'pointer-events: auto',
    ].join(';');

    const root = getToastRoot();
    root.appendChild(item);
    requestAnimationFrame(() => {
      item.style.opacity = '1';
      item.style.transform = 'translateY(0)';
    });

    const close = () => {
      item.style.opacity = '0';
      item.style.transform = 'translateY(-4px)';
      setTimeout(() => item.remove(), 180);
    };

    setTimeout(close, Math.max(900, duration));
  }

  /**
   * Toggle debug mode at runtime. Call window.paperecDebug(true/false) 
   */
  window.paperecDebug = function (enable) {
    debugEnabled = enable !== false;
    localStorage.setItem(DEBUG_KEY, debugEnabled ? '1' : '0');
    console.log(`[Paperec] debug ${debugEnabled ? 'ON' : 'OFF'} (persisted)`);
    if (debugEnabled) {
      console.log('[Paperec] current ratings:', window.paperecRatings);
      const paperDivs = document.querySelectorAll('div.papers > div');
      console.log(`[Paperec] paper divs on page: ${paperDivs.length}`);
      paperDivs.forEach((div, i) => {
        const h2 = div.querySelector('h2.title');
        const id = getPaperIdFromDiv(div);
        const hasWidget = !!(h2 && h2.querySelector('.paper-rating'));
        console.log(`  [${i}] id=${id ?? '(none)'} h2=${!!h2} widget=${hasWidget}`);
      });
    }
  };

  function readJson(key) {
    try {
      const value = JSON.parse(localStorage.getItem(key) || '{}');
      return value && typeof value === 'object' ? value : {};
    } catch (_) {
      return {};
    }
  }

  function normalizeServerUrl(url) {
    const normalized = String(url || '').trim().replace(/\/+$/, '');
    return normalized || PAPEREC_SERVER;
  }

  function isHttpUrl(value) {
    try {
      const parsed = new URL(value);
      return parsed.protocol === 'http:' || parsed.protocol === 'https:';
    } catch (_) {
      return false;
    }
  }

  function normalizeSettings(settings = {}) {
    return {
      recommendationEnabled: settings.recommendationEnabled !== false,
      serverUrl: normalizeServerUrl(settings.serverUrl),
    };
  }

  function getCurrentSettings() {
    return normalizeSettings(window.paperecSettings || DEFAULT_SETTINGS);
  }

  function getConfiguredServerUrl() {
    return getCurrentSettings().serverUrl;
  }

  function saveSettings(patch = {}) {
    const next = normalizeSettings({
      ...getCurrentSettings(),
      ...patch,
    });
    window.paperecSettings = next;
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(next));
      settingsWriteWarned = false;
    } catch (error) {
      if (!settingsWriteWarned) {
        settingsWriteWarned = true;
        console.warn('[Paperec] failed to persist settings', error);
        toast('Cannot persist Paperec settings to localStorage', 'warning', 3600);
      }
    }
    return next;
  }

  function isValidRating(value) {
    return Number.isInteger(value) && value >= 1 && value <= 5;
  }

  function nowUtcTimestamp() {
    return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  }

  function normalizeRankedIds(rankedIds) {
    const rankedOrder = [];
    const rankedSeen = new Set();
    if (!Array.isArray(rankedIds)) return rankedOrder;

    rankedIds.forEach((id) => {
      const normalized = id == null ? '' : String(id).trim();
      if (!normalized || rankedSeen.has(normalized)) return;
      rankedSeen.add(normalized);
      rankedOrder.push(normalized);
    });

    return rankedOrder;
  }

  function normalizePaperMeta(meta = {}) {
    return {
      title: typeof meta.title === 'string' ? meta.title : '',
      url: typeof meta.url === 'string' ? meta.url : '',
      authors: Array.isArray(meta.authors) ? meta.authors.filter(Boolean) : [],
      abstract: typeof meta.abstract === 'string' ? meta.abstract : '',
      date: typeof meta.date === 'string' ? meta.date : '',
      rating: isValidRating(meta.rating) ? meta.rating : null,
    };
  }

  function syncRatingsFromMeta() {
    // Keep a derived ratings map for backward-compatible helpers/UI logic.
    window.paperecRatings = Object.fromEntries(
      Object.entries(window.paperMeta)
        .filter(([, meta]) => isValidRating(meta.rating))
        .map(([id, meta]) => [id, meta.rating])
    );
  }

  window.paperecSettings = normalizeSettings(readJson(SETTINGS_KEY));

  window.paperMeta = readJson(PAPERS_KEY);
  Object.keys(window.paperMeta).forEach((paperId) => {
    window.paperMeta[paperId] = normalizePaperMeta(window.paperMeta[paperId]);
  });

  function getPersistedPaperMeta() {
    const persisted = {};
    Object.entries(window.paperMeta).forEach(([paperId, rawMeta]) => {
      const meta = normalizePaperMeta(rawMeta);
      if (!isValidRating(meta.rating)) return;
      persisted[paperId] = meta;
    });
    return persisted;
  }

  function savePaperMeta() {
    syncRatingsFromMeta();
    try {
      localStorage.setItem(PAPERS_KEY, JSON.stringify(getPersistedPaperMeta()));
      storageWriteWarned = false;
    } catch (error) {
      if (!storageWriteWarned) {
        storageWriteWarned = true;
        console.warn('[Paperec] failed to persist ratings to localStorage', error);
        toast('Cannot persist ratings in localStorage, page features still work in this session', 'warning', 4200);
      }
    }
    refreshControlBarUi();
  }

  syncRatingsFromMeta();
  savePaperMeta();
  log('loaded paper meta from storage:', Object.keys(window.paperMeta).length, 'entries');
  log('loaded ratings from merged meta:', window.paperRatings);

  /**
   * Extract structured metadata from a paper <div>.
   * Returns { title, url, authors, abstract }.
   */
  function extractPaperMeta(div) {
    const h2 = div.querySelector('h2.title');

    // Title text
    const titleLink = h2 && h2.querySelector('a.title-link');
    const title = titleLink ? titleLink.textContent.trim() : (h2 ? h2.textContent.trim() : '');

    // Original paper URL — first <a> in h2 that doesn't go to papers.cool
    const externalLink = h2 && [...h2.querySelectorAll('a')].find(
      (a) => a.href && !a.href.includes('papers.cool') && !a.href.startsWith('#')
    );
    const url = externalLink ? externalLink.href : '';

    // Authors — links pointing to Google search
    const authors = [...div.querySelectorAll('a[href*="google.com/search"]')]
      .map((a) => a.textContent.trim())
      .filter(Boolean);

    // Abstract — collect <p> elements in the div that are not the author line
    // and not the "Subject:" line at the bottom
    const paragraphs = [...div.querySelectorAll('p.summary')].filter((p) => {
      const t = p.textContent.trim();
      return t && !t.startsWith('Subject:') && !t.startsWith('Authors:');
    });
    // If no <p>, fall back to all text inside div minus h2 text
    let abstract = paragraphs.map((p) => p.textContent.trim()).join(' ').trim();
    if (!abstract) {
      const clone = div.cloneNode(true);
      const cloneH2 = clone.querySelector('h2.title');
      if (cloneH2) cloneH2.remove();
      abstract = clone.textContent.replace(/\s+/g, ' ').trim();
    }

    return { title, url, authors, abstract };
  }

  /**
   * Extract paper ID from a paper <div>.
   * Looks for the first <a> in h2.title whose href matches papers.cool/venue/...
   * and extracts the trailing segment, e.g. "31974@AAAI".
   */
  function getPaperIdFromDiv(div) {
    const h2 = div.querySelector('h2.title');
    if (!h2) {
      warn('getPaperIdFromDiv: no h2.title found in div', div);
      return null;
    }
    const link = h2.querySelector('a.title-link');
    if (!link) {
      warn('getPaperIdFromDiv: no papers.cool/venue/ link found in h2 or div', h2 ? h2.textContent.trim().slice(0, 60) : '(no h2)');
      return null;
    }
    const id = link.id;
    log('getPaperIdFromDiv:', id, '← href:', link.href);
    return id;
  }

  /**
   * Render (or re-render) the star rating widget at the end of the given h2.
   */
  function renderStars(paperId, h2) {
    const existing = h2.querySelector('.paper-rating');
    if (existing) existing.remove();

    const container = document.createElement('span');
    container.className = 'paper-rating';
    container.style.cssText = 'margin-left: 10px; white-space: nowrap; user-select: none;';

    const stars = [];

    function updateColors(hoverScore) {
      const effective = hoverScore != null ? hoverScore : (window.paperMeta[paperId]?.rating || 0);
      stars.forEach((s, idx) => {
        const filled = idx < effective;
        s.textContent = filled ? '★' : '☆';
        s.style.color = filled ? '#f0a500' : '#bbb';
      });
    }

    for (let i = 1; i <= 5; i++) {
      const star = document.createElement('a');
      star.href = '#';
      star.title = `${i} stars`;
      star.dataset.score = i;
      star.style.cssText = [
        'font-size: 1.05em',
        'text-decoration: none',
        'cursor: pointer',
        'padding: 0 1px',
        'transition: color 0.1s',
      ].join(';');

      star.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const score = parseInt(star.dataset.score, 10);
        if (!window.paperMeta[paperId]) {
          window.paperMeta[paperId] = normalizePaperMeta();
        }
        // Clicking the already-active score clears the rating
        if (window.paperMeta[paperId].rating === score) {
          log(`click: clearing rating for ${paperId}`);
          window.paperMeta[paperId].rating = null;
          window.paperMeta[paperId].date = nowUtcTimestamp();
        } else {
          log(`click: set ${paperId} = ${score}`);
          window.paperMeta[paperId].rating = score;
          window.paperMeta[paperId].date = nowUtcTimestamp();
        }
        savePaperMeta();
        updateColors(null);
      });

      star.addEventListener('mouseenter', () => updateColors(i));

      stars.push(star);
      container.appendChild(star);
    }

    container.addEventListener('mouseleave', () => updateColors(null));

    updateColors(null);
    h2.appendChild(container);
    log(`renderStars: injected for ${paperId}`);
  }

  /**
   * Scan all paper divs and inject the rating widget where missing.
   */
  function initPapers() {
    const divs = document.querySelectorAll('div.papers > div');
    log(`initPapers: scanning ${divs.length} paper div(s)`);
    let newCount = 0;
    let metaChanged = false;
    divs.forEach((div) => {
      const h2 = div.querySelector('h2.title');
      if (!h2) return;
      if (h2.querySelector('.paper-rating')) return; // already injected

      const paperId = getPaperIdFromDiv(div);
      if (!paperId) return;

      // Always update meta with the latest content from the page
      const prev = normalizePaperMeta(window.paperMeta[paperId]);
      window.paperMeta[paperId] = {
        ...prev,
        ...extractPaperMeta(div),
        date: prev.date,
        rating: prev.rating,
      };
      metaChanged = true;
      log('cached meta for', paperId, window.paperMeta[paperId].title);

      renderStars(paperId, h2);
      newCount++;
    });
    if (metaChanged) savePaperMeta();
    if (newCount > 0) log(`initPapers: injected ${newCount} new widget(s)`);
  }

  function getPaperContainerState() {
    const container = document.querySelector('div.papers');
    const divMap = new Map();

    if (container) {
      container.querySelectorAll(':scope > div').forEach((div) => {
        const link = div.querySelector('h2.title a.title-link');
        if (link && link.id) divMap.set(link.id, div);
      });
    }

    return {
      container,
      divMap,
      ids: [...divMap.keys()],
    };
  }

  function getCurrentPaperIds() {
    return getPaperContainerState().ids;
  }

  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  /**
   * Clear all stored ratings and metadata.
   */
  window.clearPaperData = function () {
    window.paperMeta = {};
    syncRatingsFromMeta();
    localStorage.removeItem(PAPERS_KEY);
    refreshControlBarUi();
    console.log('[Paperec] paper meta cleared');
  };

  /**
   * Export only the raw paper metadata cache (no scores).
   */
  window.exportPaperMeta = function () {
    downloadBlob(
      new Blob([JSON.stringify(window.paperMeta, null, 2)], { type: 'application/json' }),
      'paperec_meta.json'
    );
    return window.paperMeta;
  };

  function getRatedPaperEntries() {
    return Object.entries(getPersistedPaperMeta())
      .map(([paperId, meta]) => ({
        paperId,
        meta: normalizePaperMeta(meta),
      }))
      .sort((a, b) => {
        const ratingDiff = (b.meta.rating || 0) - (a.meta.rating || 0);
        if (ratingDiff !== 0) return ratingDiff;
        return (b.meta.date || '').localeCompare(a.meta.date || '');
      });
  }

  function exportRatedPapers() {
    const rated = getPersistedPaperMeta();
    const count = Object.keys(rated).length;
    if (!count) {
      toast('No rated papers to export', 'warning', 3200);
      return rated;
    }

    const timestamp = nowUtcTimestamp().replace(/[:]/g, '-');
    downloadBlob(
      new Blob([JSON.stringify(rated, null, 2)], { type: 'application/json' }),
      `paperec_rated_${timestamp}.json`
    );
    toast(`Exported ${count} rated paper(s)`, 'success', 3200);
    return rated;
  }

  window.exportRatedPapers = exportRatedPapers;

  window.getRatedPapers = function () {
    return getRatedPaperEntries().map(({ paperId, meta }) => ({ paperId, ...meta }));
  };

  function createToolbarButton(text, onClick) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = text;
    button.addEventListener('click', onClick);
    return button;
  }

  function setToolbarButtonEnabled(button, enabled) {
    if (!button) return;
    button.disabled = !enabled;
  }

  function updateRecommendToggleButton(button, enabled) {
    if (!button) return;

    button.innerHTML = enabled
      ? '<i class="fa fa-toggle-on"></i> Enabled'
      : '<i class="fa fa-toggle-off"></i> Disabled';
    button.title = enabled ? 'Click to disable recommendations' : 'Click to enable recommendations';
    button.style.color = '#fff';
    button.style.border = 'none';
    button.style.borderRadius = '4px';
    button.style.padding = '6px 10px';
    button.style.minWidth = '116px';
    button.style.backgroundColor = enabled ? '#32a852' : '#d9534f';
  }

  function renderRatedPaperList() {
    if (!controlBarUi) return;

    const entries = getRatedPaperEntries();
    const listRoot = controlBarUi.ratedList;
    listRoot.innerHTML = '';

    if (!entries.length) {
      const empty = document.createElement('p');
      empty.textContent = 'No rated papers yet';
      empty.style.cssText = 'margin: 0; font-size: 14px;';
      listRoot.appendChild(empty);
      return;
    }

    entries.forEach(({ paperId, meta }, idx) => {
      const row = document.createElement('p');
      row.style.cssText = 'margin: 0 0 12px 0; font-size: 14px; font-weight: bold;';

      const index = document.createElement('span');
      index.className = 'i-index';
      index.textContent = `#${idx + 1}`;
      index.style.cssText = 'color: purple; font-weight: bold; padding-right: 3px;';

      const title = document.createElement('a');
      title.className = 'i-title';
      title.href = `#${paperId}`;
      title.textContent = meta.title || paperId;
      title.style.cssText = [
        'display: inline-block',
        'max-width: calc(100% - 60px)',
        'white-space: nowrap',
        'overflow: hidden',
        'text-overflow: ellipsis',
        'vertical-align: bottom',
        'color: #32a852',
      ].join(';');
      if (meta.date) {
        title.title = `${paperId} · ${meta.date}`;
      }

      const rating = document.createElement('span');
      rating.textContent = `★${meta.rating}`;
      rating.style.cssText = 'color: #f0a500; float: right;';

      row.appendChild(index);
      row.appendChild(title);
      row.appendChild(rating);
      listRoot.appendChild(row);
    });
  }

  function refreshControlBarUi() {
    if (!controlBarUi || !controlBarUi.root.isConnected) return;

    const settings = getCurrentSettings();
    const ratedCount = Object.keys(getPersistedPaperMeta()).length;
    controlBarUi.ratedSummary.textContent = `Rated Papers (${ratedCount})`;
    updateRecommendToggleButton(controlBarUi.recommendToggleButton, settings.recommendationEnabled);

    if (document.activeElement !== controlBarUi.serverInput) {
      controlBarUi.serverInput.value = settings.serverUrl;
    }

    renderRatedPaperList();
  }

  function persistServerFromInput() {
    if (!controlBarUi) return false;

    const candidateUrl = normalizeServerUrl(controlBarUi.serverInput.value);
    if (!isHttpUrl(candidateUrl)) {
      toast('Server URL must start with http:// or https://', 'warning', 3600);
      return false;
    }

    const currentServer = getConfiguredServerUrl();
    if (candidateUrl === currentServer) {
      refreshControlBarUi();
      return true;
    }

    saveSettings({ serverUrl: candidateUrl });
    refreshControlBarUi();
    toast(`Server updated: ${candidateUrl}`, 'success', 3200);
    return true;
  }

  function setControlBarPresentation(root, mode) {
    if (mode === 'app-bar') {
      root.classList.add('app-bar-content');
      root.style.cssText = 'display: none;';
      return;
    }

    root.classList.remove('app-bar-content');
    root.style.cssText = [
      'margin: 10px 0 12px',
      'padding: 10px 12px',
      'border: 1px solid #e5e7eb',
      'border-radius: 8px',
      'background: #f8fafc',
      'font-size: 13px',
      'line-height: 1.45',
      'color: #111827',
    ].join(';');
  }

  function createControlBar() {
    const root = document.createElement('div');
    root.id = CONTROL_BAR_ID;
    setControlBarPresentation(root, 'standalone');

    const title = document.createElement('p');
    title.innerHTML = '<strong>Paperec</strong>';

    const recommendToggleButton = createToolbarButton('', () => {
      const nextEnabled = !getCurrentSettings().recommendationEnabled;
      const next = saveSettings({ recommendationEnabled: nextEnabled });
      refreshControlBarUi();
      if (next.recommendationEnabled) {
        toast('Recommendation enabled', 'success', 2800);
        scheduleRefreshReorder('toolbar-toggle');
      } else {
        toast('Recommendation disabled', 'info', 2800);
      }
    });
    updateRecommendToggleButton(recommendToggleButton, getCurrentSettings().recommendationEnabled);

    const exportButton = createToolbarButton('Export Papers', () => {
      exportRatedPapers();
    });
    exportButton.style.minWidth = '116px';

    const ratedSummary = document.createElement('p');
    ratedSummary.textContent = 'Rated Papers (0)';

    const ratedList = document.createElement('div');
    ratedList.className = 'items';
    ratedList.style.cssText = [
      'border: 1px solid #ddd',
      'height: 150px',
      'border-radius: 5px',
      'padding: 8px',
      'overflow-y: auto',
      'box-sizing: border-box',
    ].join(';');

    const serverLabel = document.createElement('p');
    serverLabel.textContent = 'Server';

    const serverInput = document.createElement('input');
    serverInput.type = 'text';
    serverInput.className = 'text-input single-line';
    serverInput.value = getConfiguredServerUrl();
    serverInput.placeholder = 'https://host:port';

    const saveServerButton = createToolbarButton('Save', () => {
      persistServerFromInput();
    });
    saveServerButton.style.minWidth = '116px';
    const resetServerButton = createToolbarButton('Reset', () => {
      saveSettings({ serverUrl: PAPEREC_SERVER });
      refreshControlBarUi();
      toast(`Server reset: ${PAPEREC_SERVER}`, 'info', 3200);
    });
    resetServerButton.style.minWidth = '116px';

    serverInput.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      persistServerFromInput();
      serverInput.blur();
    });
    serverInput.addEventListener('blur', () => {
      persistServerFromInput();
    });

    const allActions = document.createElement('div');
    allActions.className = 'submit';
    allActions.style.gap = '8px';
    allActions.style.marginTop = '16px';

    function wrapActionButton(button) {
      const wrapper = document.createElement('p');
      wrapper.style.justifyContent = 'center';
      wrapper.style.margin = '0';
      wrapper.appendChild(button);
      return wrapper;
    }

    allActions.appendChild(wrapActionButton(recommendToggleButton));
    allActions.appendChild(wrapActionButton(exportButton));
    allActions.appendChild(wrapActionButton(saveServerButton));
    allActions.appendChild(wrapActionButton(resetServerButton));

    root.appendChild(title);
    root.appendChild(ratedSummary);
    root.appendChild(ratedList);
    root.appendChild(serverLabel);
    root.appendChild(serverInput);
    root.appendChild(allActions);

    return {
      root,
      recommendToggleButton,
      ratedSummary,
      ratedList,
      serverInput,
    };
  }

  function syncAppBarButtonLayout(appBar) {
    const buttons = [...appBar.querySelectorAll('a.bar-app')]
      .filter((a) => a.parentElement === appBar);
    if (!buttons.length) return;

    const width = `${(100 / buttons.length).toFixed(4)}%`;
    buttons.forEach((btn) => {
      btn.style.width = width;
    });
  }

  function ensureControlBarButton(appBar) {
    let button = document.getElementById(CONTROL_BAR_BUTTON_ID);
    if (button && button.parentElement !== appBar) {
      button.remove();
      button = null;
    }

    if (!button) {
      button = document.createElement('a');
      button.id = CONTROL_BAR_BUTTON_ID;
      button.className = 'bar-app';
      button.href = '#';
      button.title = 'Paperec';
      button.innerHTML = '<i class="fa fa-compass"></i>';
    }

    if (!button.dataset.paperecBound) {
      button.dataset.paperecBound = '1';
      button.addEventListener('click', (event) => {
        event.preventDefault();
        const panel = document.getElementById(CONTROL_BAR_ID);
        if (!panel) return;

        if (typeof window.toggleApp === 'function') {
          window.toggleApp(CONTROL_BAR_ID, button);
        } else {
          const shouldOpen = panel.style.display === 'none';
          panel.style.display = shouldOpen ? 'block' : 'none';
          button.classList.toggle('active', shouldOpen);
        }

        setTimeout(() => {
          refreshControlBarUi();
        }, 0);
      });
    }

    const configButton = [...appBar.querySelectorAll('a.bar-app')]
      .find((a) => a.parentElement === appBar && a.title === 'Configuration');

    if (configButton) {
      if (button.parentElement !== appBar || button.nextElementSibling !== configButton) {
        appBar.insertBefore(button, configButton);
      }
    } else if (button.parentElement !== appBar) {
      appBar.appendChild(button);
    }

    syncAppBarButtonLayout(appBar);

    return button;
  }

  function getControlBarMountTarget() {
    const appBar = document.getElementById('app-bar');
    if (appBar) {
      return { anchor: appBar, position: 'inside-app-bar' };
    }

    const papers = document.querySelector('div.papers');
    if (papers && papers.parentElement) {
      return { anchor: papers, position: 'before' };
    }

    const main = document.querySelector('main');
    if (main) {
      return { anchor: main, position: 'prepend' };
    }

    return { anchor: document.body, position: 'prepend' };
  }

  function mountControlBar(root) {
    const target = getControlBarMountTarget();
    if (!target || !target.anchor) return;

    const { anchor, position } = target;
    if (position === 'inside-app-bar') {
      setControlBarPresentation(root, 'app-bar');
      const firstAppButton = [...anchor.querySelectorAll('a.bar-app')]
        .find((a) => a.parentElement === anchor);
      if (firstAppButton) {
        if (root.parentElement !== anchor || root.nextElementSibling !== firstAppButton) {
          anchor.insertBefore(root, firstAppButton);
        }
      } else if (root.parentElement !== anchor) {
        anchor.appendChild(root);
      }

      if (controlBarUi) {
        controlBarUi.triggerButton = ensureControlBarButton(anchor);
      }
      return;
    }

    setControlBarPresentation(root, 'standalone');
    const existingButton = document.getElementById(CONTROL_BAR_BUTTON_ID);
    if (existingButton) existingButton.remove();

    if (position === 'before') {
      if (root.nextElementSibling !== anchor) {
        anchor.insertAdjacentElement('beforebegin', root);
      }
      return;
    }

    if (anchor.firstElementChild !== root) {
      anchor.prepend(root);
    }
  }

  function ensureControlBar() {
    if (!controlBarUi || !controlBarUi.root.isConnected) {
      const existing = document.getElementById(CONTROL_BAR_ID);
      if (existing) existing.remove();
      const existingButton = document.getElementById(CONTROL_BAR_BUTTON_ID);
      if (existingButton) existingButton.remove();
      controlBarUi = createControlBar();
    }

    mountControlBar(controlBarUi.root);
    refreshControlBarUi();
    return controlBarUi;
  }

  window.paperecSetServer = function (serverUrl) {
    const normalized = normalizeServerUrl(serverUrl);
    if (!isHttpUrl(normalized)) {
      toast('Server URL must start with http:// or https://', 'warning', 3600);
      return null;
    }
    saveSettings({ serverUrl: normalized });
    refreshControlBarUi();
    return normalized;
  };

  window.paperecGetSettings = function () {
    return { ...getCurrentSettings() };
  };

  // ── Recommendation ────────────────────────────────────────────────────────

  let paperecInFlight = false;
  let frozenOrderedIds = [];
  let queuedCandidateIds = [];
  let queuedPreservePrefix = false;
  let refreshSettleTimer = null;
  const REFRESH_SETTLE_MS = 700;

  function queueCandidateRanking(candidateIds, preservePrefix) {
    const merged = new Set([...queuedCandidateIds, ...candidateIds]);
    queuedCandidateIds = [...merged];
    queuedPreservePrefix = queuedPreservePrefix || preservePrefix;
  }

  function scheduleRefreshReorder(reason = 'mutation') {
    if (refreshSettleTimer) clearTimeout(refreshSettleTimer);

    refreshSettleTimer = setTimeout(() => {
      refreshSettleTimer = null;
      log(`refresh settled (${reason})`);

      initPapers();

      const ratedCorpusCount = Object.keys(getPersistedPaperMeta()).length;
      if (!ratedCorpusCount) {
        log('scheduleRefreshReorder: skip ranking (no rated corpus)');
        return;
      }

      const currentIds = getCurrentPaperIds();
      if (!currentIds.length) return;

      const settings = getCurrentSettings();
      if (!settings.recommendationEnabled) {
        log('scheduleRefreshReorder: recommendation disabled by user setting');
        return;
      }

      const hasFrozenPrefix = frozenOrderedIds.length > 0;
      const candidateIds = hasFrozenPrefix
        ? currentIds.filter((id) => !frozenOrderedIds.includes(id))
        : currentIds;

      if (!candidateIds.length) {
        log('scheduleRefreshReorder: no new candidate papers to rerank');
        return;
      }

      window.paperec(settings.serverUrl, {
        candidateIds,
        preservePrefix: hasFrozenPrefix,
        silentBusy: true,
        silentDisabled: true,
        requestSource: reason,
      });
    }, REFRESH_SETTLE_MS);
  }

  /**
   * Reorder div.papers > div elements.
   * Rated papers appear first (sorted by score desc), then the server-ranked
   * unrated papers, then any remaining papers not in either list.
   */
  function reorderPapers(rankedIds, options = {}) {
    const preservePrefix = options.preservePrefix === true;
    const updateFrozen = options.updateFrozen !== false;

    const { container, divMap, ids: currentIds } = getPaperContainerState();
    if (!container) {
      warn('reorderPapers: div.papers not found');
      return;
    }

    // Normalize/dedupe ranked ids from server payload
    const rankedOrder = normalizeRankedIds(rankedIds);

    const lockedPrefix = preservePrefix
      ? frozenOrderedIds.filter((id) => divMap.has(id))
      : [];
    const lockedSet = new Set(lockedPrefix);
    const sortableIds = currentIds.filter((id) => !lockedSet.has(id));

    // Rated papers first, sorted by score descending
    const ratedSeen = new Set();
    const ratedOrder = Object.entries(window.paperMeta)
      .filter(([, meta]) => isValidRating(meta.rating))
      .sort((a, b) => b[1].rating - a[1].rating)
      .map(([id]) => id)
      .filter((id) => {
        if (lockedSet.has(id) || ratedSeen.has(id) || !divMap.has(id)) return false;
        ratedSeen.add(id);
        return true;
      });

    // Then only ranked-but-unrated papers
    const rankedUnratedOrder = rankedOrder.filter(
      (id) => !lockedSet.has(id) && !ratedSeen.has(id) && divMap.has(id)
    );

    // Build final order: locked prefix → rated → ranked unrated → remaining
    const placed = new Set([...lockedPrefix, ...ratedOrder, ...rankedUnratedOrder]);
    const remaining = sortableIds.filter((id) => !placed.has(id));
    const orderedIds = [...lockedPrefix, ...ratedOrder, ...rankedUnratedOrder, ...remaining];

    if (
      currentIds.length === orderedIds.length
      && currentIds.every((id, idx) => id === orderedIds[idx])
    ) {
      if (updateFrozen) frozenOrderedIds = orderedIds;
      log(
        `reorderPapers: order already up to date (mode=${preservePrefix ? 'tail-only' : 'full'} locked=${lockedPrefix.length} rated=${ratedOrder.length} ranked=${rankedUnratedOrder.length} rest=${remaining.length})`
      );
      return;
    }

    // Re-append in order (missing ids are silently skipped)
    for (const id of orderedIds) {
      const div = divMap.get(id);
      if (div) container.appendChild(div);
    }

    if (updateFrozen) frozenOrderedIds = orderedIds;

    log(
      `reorderPapers: ${orderedIds.length} papers reordered (mode=${preservePrefix ? 'tail-only' : 'full'} locked=${lockedPrefix.length} rated=${ratedOrder.length} ranked=${rankedUnratedOrder.length} rest=${remaining.length} rankedInput=${rankedOrder.length})`
    );
  }

  /**
   * Send candidate papers + rated corpus to /rank_v2, stream progress events,
   * and reorder candidate region when the ranking result arrives.
   */
  window.paperec = async function (serverUrl = getConfiguredServerUrl(), options = {}) {
    const candidateIdsRequested = Array.isArray(options.candidateIds)
      ? normalizeRankedIds(options.candidateIds)
      : getCurrentPaperIds();
    const preservePrefix = options.preservePrefix === true;
    const suppressBusyWarning = options.suppressBusyWarning === true || options.silentBusy === true;
    const suppressDisabledWarning = options.silentDisabled === true;
    const forceRun = options.force === true;
    const requestSource = typeof options.requestSource === 'string' ? options.requestSource : 'manual';
    const settings = getCurrentSettings();
    const effectiveServerUrl = normalizeServerUrl(serverUrl || settings.serverUrl);

    if (!forceRun && !settings.recommendationEnabled) {
      if (!suppressDisabledWarning) {
        const msg = 'Recommendation is disabled in Paperec settings';
        console.warn(`[Paperec] ${msg}`);
        toast(msg, 'warning', 3600);
      }
      return;
    }

    if (!isHttpUrl(effectiveServerUrl)) {
      const msg = `Invalid server URL: ${effectiveServerUrl}`;
      console.error('[Paperec]', msg);
      toast(msg, 'error', 4200);
      return;
    }

    if (paperecInFlight) {
      if (candidateIdsRequested.length > 0) {
        queueCandidateRanking(candidateIdsRequested, preservePrefix);
        log(`paperec busy; queued ${candidateIdsRequested.length} candidate(s) from ${requestSource}`);
      }
      if (!suppressBusyWarning) {
        const msg = 'Recommendation request is already running';
        console.warn(`[Paperec] ${msg}`);
        toast(msg, 'warning');
      }
      return;
    }

    paperecInFlight = true;

    try {
      const corpus = getPersistedPaperMeta();
      const corpusCount = Object.keys(corpus).length;
      if (!corpusCount) {
        const msg = 'No ratings yet, rate some papers first';
        console.warn(`[Paperec] ${msg}`);
        toast(msg, 'warning');
        return;
      }

      const candidate = {};
      candidateIdsRequested.forEach((paperId) => {
        if (!window.paperMeta[paperId]) return;
        candidate[paperId] = normalizePaperMeta(window.paperMeta[paperId]);
      });

      const candidateCount = Object.keys(candidate).length;
      if (!candidateCount) {
        log(`paperec: no valid candidates from ${requestSource}`);
        return;
      }

      const payload = {candidate, corpus};
      const sendingMsg = `Ranking ${candidateCount} candidate(s) with ${corpusCount} rated paper(s)`;
      console.log(`[Paperec] ${sendingMsg}`);
      toast(sendingMsg, 'info', 4200);

      let resp;
      try {
        resp = await fetch(`${effectiveServerUrl}/rank_v2`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
      } catch (err) {
        const msg = `Cannot reach server: ${err && err.message ? err.message : String(err)}`;
        console.error('[Paperec]', msg);
        toast(msg, 'error', 4200);
        return;
      }

      if (!resp.ok) {
        const errorText = await resp.text();
        const msg = `Server error ${resp.status}${errorText ? `: ${errorText}` : ''}`;
        console.error('[Paperec]', msg);
        toast(msg, 'error', 4800);
        return;
      }

      // Read the SSE stream via fetch() ReadableStream
      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let hasAppliedRanking = false;
      const candidateSet = new Set(Object.keys(candidate));

      const applyRanking = (rankedIds, source) => {
        const normalizedRankedIds = normalizeRankedIds(rankedIds)
          .filter((paperId) => candidateSet.has(paperId));
        if (!normalizedRankedIds.length) return false;
        if (hasAppliedRanking) {
          log(`paperRec: ranked IDs from ${source} ignored (already applied)`);
          return true;
        }
        const msg = `Got ${normalizedRankedIds.length} ranked candidate IDs`;
        console.log(`[Paperec] ${msg}`);
        toast(msg, 'success', 4200);
        reorderPapers(normalizedRankedIds, { preservePrefix });
        hasAppliedRanking = true;
        return true;
      };

      const parseEvents = (chunk) => {
        buffer += chunk;
        // SSE events are separated by double newline
        const parts = buffer.split('\n\n');
        buffer = parts.pop(); // last (possibly incomplete) chunk stays
        for (const raw of parts) {
          let eventType = 'message';
          let dataStr = '';
          for (const line of raw.split('\n')) {
            if (line.startsWith('event: ')) eventType = line.slice(7).trim();
            else if (line.startsWith('data: ')) dataStr = line.slice(6).trim();
          }
          if (!dataStr) continue;
          try {
            const data = JSON.parse(dataStr);
            if (eventType === 'progress') {
              if (data && data.msg) {
                console.log(`[Paperec] ${data.msg}`);
                toast(data.msg, 'info', 4200);
              }
              if (data.step === 'ranked') {
                applyRanking(data.ranked_ids, 'progress/ranked');
              }
            } else if (eventType === 'error') {
              const msg = `Server error: ${data.msg}`;
              console.error('[Paperec]', msg);
              toast(msg, 'error', 4800);
            }
          } catch (_) {
            // ignore malformed SSE lines
          }
        }
      };

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        parseEvents(decoder.decode(value, { stream: true }));
      }
      // Flush remaining
      parseEvents(decoder.decode());

      if (!hasAppliedRanking) {
        const msg = 'Stream ended without ranked IDs, page order unchanged';
        console.warn(`[Paperec] ${msg}`);
        toast(msg, 'warning', 4200);
      }
    } finally {
      paperecInFlight = false;

      if (queuedCandidateIds.length > 0) {
        const queuedIds = normalizeRankedIds(queuedCandidateIds);
        const preserveQueuedPrefix = queuedPreservePrefix;
        queuedCandidateIds = [];
        queuedPreservePrefix = false;

        const currentIdSet = new Set(getCurrentPaperIds());
        const runnableIds = queuedIds.filter(
          (paperId) => currentIdSet.has(paperId) && !frozenOrderedIds.includes(paperId)
        );

        if (runnableIds.length > 0) {
          log(`paperec: running queued request for ${runnableIds.length} candidate(s)`);
          setTimeout(() => {
            window.paperec(effectiveServerUrl, {
              candidateIds: runnableIds,
              preservePrefix: preserveQueuedPrefix || frozenOrderedIds.length > 0,
              suppressBusyWarning: true,
              requestSource: 'queued',
            });
          }, 0);
        }
      }
    }
  };

  log('bootstrap: script loaded, debug=' + debugEnabled);
  initPapers();
  ensureControlBar();

  scheduleRefreshReorder('bootstrap');

  // Re-scan when new paper nodes are injected (infinite scroll / group switch)
  const observer = new MutationObserver((mutations) => {
    const shouldEnsureBar = !controlBarUi
      || !controlBarUi.root.isConnected
      || mutations.some((mutation) => {
        if (mutation.type !== 'childList') return false;
        return [...mutation.addedNodes].some((node) => {
          if (!(node instanceof Element)) return false;
          return node.matches('.app-bar, [class*="app-bar"], header, main')
            || !!node.querySelector('.app-bar, [class*="app-bar"], header, main');
        });
      });

    if (shouldEnsureBar) ensureControlBar();

    const shouldRescan = mutations.some((mutation) => {
      if (mutation.type !== 'childList') return false;

      const target = mutation.target;
      if (target instanceof Element && target.matches('div.papers')) {
        return true;
      }

      return [...mutation.addedNodes].some(
        (node) => node instanceof Element && (node.matches('div.papers') || node.querySelector('div.papers'))
      );
    });

    if (!shouldRescan) return;
    scheduleRefreshReorder('dynamic-refresh');
  });
  observer.observe(document.body, { childList: true, subtree: true });
})();
