// ── Sidebar chrome ────────────────────────────────────────────────────────────
// Theme dropdown, font-size stepper, nav list + routing trigger, hamburger
// menu (Global section + contextual section).

const SIDEBAR_CONSTANTS = {
    THEME_LABELS: {
        'css/themes/nordic.css': 'Nordic',
        'css/themes/dark.css': 'Dark',
        'css/themes/light.css': 'Light',
        'css/themes/matrix.css': 'Matrix',
        'css/themes/flat.css': 'Flat'
    },
    FONT_SIZE: {
        DEFAULT: 16,
        STEP: 1,
        MIN: 8,
        MAX: 30,
        // Base px value a legacy percentage was computed against (100% =
        // 16px, the browser default this app never used to pin). Only
        // used by resolveFontSizePx()'s one-time legacy conversion below.
        LEGACY_PERCENT_BASE_PX: 16
    },
    // Fixed nav entries plus their fallback labels. Queued/Consumed/Owned
    // labels are overridden at runtime from media_types (design doc §4.1,
    // confirmed) when available; these are just the defaults if that
    // lookup fails.
    NAV_ITEMS: [
        { view: 'dashboard', label: 'Dashboard' },
        { view: 'queued', label: 'To Be Read' },
        { view: 'consumed', label: 'Books Read' },
        { view: 'owned', label: 'My Library' },
        { view: 'tags', label: 'Tags' }
    ],
    // Views that get a contextual hamburger section (design doc §4.2) —
    // the three collection views. Dashboard/Tags/Statistics get none.
    HAMBURGER_CONTEXTUAL_VIEWS: ['queued', 'consumed', 'owned']
};

// Called from core.js's window.onload, after loadTheme() so DBManager is
// already initialised and the theme link's href already reflects the
// stored setting.
//
// Settings are read and written through DBManager.getSettings()/
// saveSettings() — the documented surface (design doc §6.1). DOM wiring
// runs first and unconditionally, so a settings-load failure can't prevent
// the dropdown/stepper from being interactive.
async function initSidebarChrome() {
    syncThemeDropdownLabel();
    wireThemeDropdownItems();
    wireSidebarChromeEvents();
    renderSidebarVersion();

    let settings = {};
    try {
        settings = await DBManager.getSettings() || {};
    } catch (e) {
        console.error('initSidebarChrome: could not load settings', e);
    }
    applyFontSize(settings.fontSize || SIDEBAR_CONSTANTS.FONT_SIZE.DEFAULT);

    // CollectionView reads this synchronously (list/modal date formatting
    // happens on every render, not worth an async fetch each time) — same
    // settings object already fetched above, no extra DBManager call.
    if (typeof CollectionView !== 'undefined') {
        CollectionView._dateFormatCache = settings.dateFormat || DateUtils.DEFAULT_FORMAT;
    }
}

// Replaces the inline onclick attributes these controls used to carry.
// Tauri injects script hashes into script-src, which per CSP3 nullifies
// 'unsafe-inline' there, so inline handlers never execute in the release
// build (issue #15).
function wireSidebarChromeEvents() {
    const hamburgerBtn = document.getElementById('hamburger-btn');
    if (hamburgerBtn) hamburgerBtn.addEventListener('click', toggleHamburgerMenu);

    // One delegated listener covers both the static Global items and the
    // contextual section, which is re-rendered on every view change.
    const hamburgerMenu = document.getElementById('hamburgerMenu');
    if (hamburgerMenu) hamburgerMenu.addEventListener('click', handleHamburgerMenuClick);

    const themeTrigger = document.getElementById('theme-dropdown-trigger');
    if (themeTrigger) themeTrigger.addEventListener('click', toggleThemeDropdown);

    const fontDown = document.getElementById('font-size-down');
    if (fontDown) fontDown.addEventListener('click', () => adjustFontSize(-1));

    const fontUp = document.getElementById('font-size-up');
    if (fontUp) fontUp.addEventListener('click', () => adjustFontSize(1));
}

function renderSidebarVersion() {
    const el = document.getElementById('sidebarVersionFooter');
    if (!el) return;
    el.textContent = `v${CONSTANTS.APP_VERSION} d${CONSTANTS.DB.VERSION}`;
}

function wireThemeDropdownItems() {
    document.querySelectorAll('.theme-dropdown-item').forEach(item => {
        item.addEventListener('click', () => {
            const themePath = item.getAttribute('data-theme');
            selectTheme(themePath, item.textContent);
        });
    });

    document.addEventListener('click', (event) => {
        const dropdown = document.getElementById('theme-dropdown');
        if (dropdown && !dropdown.contains(event.target)) {
            closeThemeDropdown();
        }
    });
}

// ── Navigation ────────────────────────────────────────────────────────────────
// Called from core.js's window.onload, after initSidebarChrome(). Runs
// before renderDashboard() so nav stays interactive regardless of its
// outcome.
async function initNavigation() {
    let labels = {};
    try {
        const types = await DBManager.getAllMediaTypes();
        labels = (types && types[0]) || {};
    } catch (e) {
        console.error('initNavigation: could not load media_types (using fallback labels)', e);
    }

    // Mutate the shared object in place — MediaLabels (core.js) is read by
    // the three collection modals/views too, so this one fetch covers both.
    if (typeof MediaLabels !== 'undefined') {
        if (labels.ConsumedLabel) MediaLabels.ConsumedLabel = labels.ConsumedLabel;
        if (labels.QueuedLabel) MediaLabels.QueuedLabel = labels.QueuedLabel;
        if (labels.OwnedLabel) MediaLabels.OwnedLabel = labels.OwnedLabel;
    }

    const list = document.getElementById('sidebarNavList');
    if (!list) return;
    list.innerHTML = '';

    SIDEBAR_CONSTANTS.NAV_ITEMS.forEach((item) => {
        const label =
            item.view === 'queued' ? (labels.QueuedLabel || item.label) :
            item.view === 'consumed' ? (labels.ConsumedLabel || item.label) :
            item.view === 'owned' ? (labels.OwnedLabel || item.label) :
            item.label;

        const li = document.createElement('li');
        li.className = 'nav-item';
        li.textContent = label;
        li.dataset.view = item.view;
        li.addEventListener('click', () => showView(item.view, li));
        list.appendChild(li);
    });

    updateHamburgerContextualSection(SIDEBAR_CONSTANTS.NAV_ITEMS[0].view);
}

// ── Theme dropdown ───────────────────────────────────────────────────────────

function syncThemeDropdownLabel() {
    const themeLink = document.getElementById('themeLink');
    const label = document.getElementById('theme-dropdown-label');
    if (!themeLink || !label) return;

    const match = Object.keys(SIDEBAR_CONSTANTS.THEME_LABELS)
        .find(path => themeLink.href.includes(path));
    label.textContent = match ? SIDEBAR_CONSTANTS.THEME_LABELS[match] : 'Dark';
}

function toggleThemeDropdown() {
    const menu = document.getElementById('theme-dropdown-menu');
    if (menu) menu.classList.toggle('open');
}

function closeThemeDropdown() {
    const menu = document.getElementById('theme-dropdown-menu');
    if (menu) menu.classList.remove('open');
}

// changeTheme() (core.js) sets the href synchronously before it awaits
// settings persistence, so the visual switch happens regardless. Caught
// here so the label and dropdown still close if persistence fails — the
// choice just won't survive a reload.
async function selectTheme(themePath, label) {
    try {
        await changeTheme(themePath);
    } catch (e) {
        console.error('selectTheme: theme applied but not persisted', e);
    }
    const labelEl = document.getElementById('theme-dropdown-label');
    if (labelEl) labelEl.textContent = label;
    closeThemeDropdown();
}

// ── Font-size stepper ─────────────────────────────────────────────────────────

// Pixel-based font-size stepper (8-30px). Previously stored/applied as a
// percentage (70-150%); the two ranges never overlap, so a stored value
// above the new MAX is unambiguously a leftover percentage from before
// this change — converted once here, then persisted as real px on the
// next stepper click. No settings-schema version bump needed.
function resolveFontSizePx(raw) {
    const n = Number(raw);
    if (!n || isNaN(n)) return SIDEBAR_CONSTANTS.FONT_SIZE.DEFAULT;
    if (n > SIDEBAR_CONSTANTS.FONT_SIZE.MAX) {
        return Math.round((n / 100) * SIDEBAR_CONSTANTS.FONT_SIZE.LEGACY_PERCENT_BASE_PX);
    }
    return n;
}

function applyFontSize(pct) {
    // adjustFontSize() already clamps before saving, but a value read
    // straight from settings (restore, corrupted DB, direct edit) skips
    // that write-side clamp and reaches here raw — clamp on read too so an
    // out-of-range value can't drive document.documentElement's font-size
    // CSS sink arbitrarily (CTX-SEC-111 / #61).
    const clamped = Math.min(
        SIDEBAR_CONSTANTS.FONT_SIZE.MAX,
        Math.max(SIDEBAR_CONSTANTS.FONT_SIZE.MIN, resolveFontSizePx(pct))
    );
    document.documentElement.style.fontSize = clamped + 'px';
    const valueEl = document.getElementById('font-size-value');
    if (valueEl) valueEl.textContent = clamped + 'px';
}

async function adjustFontSize(direction) {
    let current = {};
    let loaded = true;
    try {
        current = await DBManager.getSettings() || {};
    } catch (e) {
        console.error('adjustFontSize: could not load settings', e);
        loaded = false;
    }
    const currentSize = resolveFontSizePx(current.fontSize || SIDEBAR_CONSTANTS.FONT_SIZE.DEFAULT);
    const next = Math.min(
        SIDEBAR_CONSTANTS.FONT_SIZE.MAX,
        Math.max(SIDEBAR_CONSTANTS.FONT_SIZE.MIN, currentSize + direction * SIDEBAR_CONSTANTS.FONT_SIZE.STEP)
    );
    applyFontSize(next);
    // A failed load means `current` is an empty stand-in, not the real
    // settings object — saving onto it would silently blank every other
    // stored setting (CTX-SEC-110 / #60). The visual size change above
    // still applies; only persistence is skipped.
    if (!loaded) return;
    try {
        await DBManager.saveSettings({ ...current, fontSize: next });
    } catch (e) {
        console.error('adjustFontSize: could not save settings', e);
    }
}

// ── Hamburger menu ───────────────────────────────────────────────────────────

function toggleHamburgerMenu() {
    const menu = document.getElementById('hamburgerMenu');
    if (menu) menu.classList.toggle('open');
}

function closeHamburgerMenu() {
    const menu = document.getElementById('hamburgerMenu');
    if (menu) menu.classList.remove('open');
}

document.addEventListener('click', (event) => {
    const container = document.querySelector('.hamburger-container');
    if (container && !container.contains(event.target)) {
        closeHamburgerMenu();
    }
});

// Global section items. Backup/Export/Restore route through
// BackupRestore (backup-restore.js) — same operations Quick Actions
// offered before it was retired in favour of this menu (design doc §4.3).
// Find Duplicates has no implementation (Phase 9, dropped).
function handleHamburgerMenuClick(event) {
    const item = event.target.closest('[data-action]');
    if (!item || !this.contains(item)) return;
    const action = item.dataset.action;
    const collection = item.dataset.collection;
    switch (action) {
        case 'export-csv':
            closeHamburgerMenu();
            CollectionIO.exportCSV(collection);
            break;
        case 'export-json':
            closeHamburgerMenu();
            CollectionIO.exportJSON(collection);
            break;
        case 'import-csv':
            closeHamburgerMenu();
            CollectionIO.triggerImportCSV(collection);
            break;
        default:
            hamburgerAction(action);
    }
}

function hamburgerAction(action) {
    closeHamburgerMenu();
    switch (action) {
        case 'settings':
            SettingsModal.open();
            break;
        case 'backup':
            BackupRestore.backupDatabase();
            break;
        case 'export':
            BackupRestore.exportAllData();
            break;
        case 'restore':
            BackupRestore.showScreen1();
            break;
        case 'isbn-lookup':
            BulkIsbnModal.open();
            break;
        case 'duplicates':
            showMessage('Find Duplicates — coming in a later phase', CONSTANTS.MESSAGE_TYPES.INFO);
            break;
    }
}

// Contextual section — only Books Read/To Be Read/My Library get one
// (design doc §4.2). viewName doubles as the collection key ('consumed'/
// 'queued'/'owned') — CONSTANTS.VIEWS values match COLLECTION_IO_SPEC's
// keys directly, no separate mapping needed.
function updateHamburgerContextualSection(viewName) {
    const section = document.getElementById('hamburgerContextualSection');
    if (!section) return;
    if (!SIDEBAR_CONSTANTS.HAMBURGER_CONTEXTUAL_VIEWS.includes(viewName)) {
        section.innerHTML = '';
        return;
    }
    const label = viewName === 'consumed' ? MediaLabels.ConsumedLabel
        : viewName === 'queued' ? MediaLabels.QueuedLabel
        : MediaLabels.OwnedLabel;
    section.innerHTML = `
        <div class="hamburger-menu-item" data-action="export-csv" data-collection="${viewName}">${escapeHtml(label)} Export CSV</div>
        <div class="hamburger-menu-item" data-action="export-json" data-collection="${viewName}">${escapeHtml(label)} Export JSON</div>
        <div class="hamburger-menu-item" data-action="import-csv" data-collection="${viewName}">${escapeHtml(label)} Import CSV</div>
    `;
}

// initSidebarChrome/initNavigation are called from core.js's window.onload;
// applyFontSize/adjustFontSize/updateHamburgerContextualSection are called
// from settings.js, sidebar's own theme handlers, and core.js's showView().
// Module scope no longer leaks these automatically (#66 / CTX-SEC-116).
window.SIDEBAR_CONSTANTS = SIDEBAR_CONSTANTS;
window.initSidebarChrome = initSidebarChrome;
window.initNavigation = initNavigation;
window.applyFontSize = applyFontSize;
window.adjustFontSize = adjustFontSize;
window.resolveFontSizePx = resolveFontSizePx;
window.updateHamburgerContextualSection = updateHamburgerContextualSection;
