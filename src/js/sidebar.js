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
        DEFAULT: 100,
        STEP: 10,
        MIN: 80,
        MAX: 150
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
        { view: 'tags', label: 'Tags' },
        { view: 'statistics', label: 'Statistics' }
    ],
    // Views that get a contextual hamburger section (design doc §4.2) —
    // the three collection views. Dashboard/Tags/Statistics get none.
    HAMBURGER_CONTEXTUAL_VIEWS: ['queued', 'consumed', 'owned']
};

// Called from core.js's window.onload, after loadTheme() so DBManager is
// already initialised and the theme link's href already reflects the
// stored setting.
//
// Uses DBManager.getSettings()/saveSettings() directly rather than core.js's
// loadSettingsFromDB()/saveSettingsToDB(), which still route through
// data-manager.js's pre-rewrite generic API (Phase 5). DOM wiring runs
// first and unconditionally, so a settings-load failure can't prevent the
// dropdown/stepper from being interactive.
async function initSidebarChrome() {
    syncThemeDropdownLabel();
    wireThemeDropdownItems();
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
// before the (currently broken, pending Phase 5) data-loading calls so nav
// stays interactive regardless of their outcome.
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
// settings persistence, so the visual switch happens even though that
// persistence call still goes through the not-yet-rewired data-manager.js
// wrapper and will throw (Phase 5 fixes this). Caught here so the label
// and dropdown close regardless — theme choice just won't survive reload
// until then.
async function selectTheme(themePath, label) {
    try {
        await changeTheme(themePath);
    } catch (e) {
        console.error('selectTheme: theme applied but not persisted (data-manager.js settings path is broken pending Phase 5)', e);
    }
    const labelEl = document.getElementById('theme-dropdown-label');
    if (labelEl) labelEl.textContent = label;
    closeThemeDropdown();
}

// ── Font-size stepper ─────────────────────────────────────────────────────────

function applyFontSize(pct) {
    document.documentElement.style.fontSize = pct + '%';
    const valueEl = document.getElementById('font-size-value');
    if (valueEl) valueEl.textContent = pct + '%';
}

async function adjustFontSize(direction) {
    let current = {};
    try {
        current = await DBManager.getSettings() || {};
    } catch (e) {
        console.error('adjustFontSize: could not load settings', e);
    }
    const currentSize = current.fontSize || SIDEBAR_CONSTANTS.FONT_SIZE.DEFAULT;
    const next = Math.min(
        SIDEBAR_CONSTANTS.FONT_SIZE.MAX,
        Math.max(SIDEBAR_CONSTANTS.FONT_SIZE.MIN, currentSize + direction * SIDEBAR_CONSTANTS.FONT_SIZE.STEP)
    );
    applyFontSize(next);
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

// Global section items. Backup/Export/Restore call existing functions
// (file.js/restore.js) — same calls Quick Actions used before it was
// retired in favour of this menu (design doc §4.3). Settings and Find
// Duplicates have no implementation yet (Phase 10, Phase 9).
function hamburgerAction(action) {
    closeHamburgerMenu();
    switch (action) {
        case 'settings':
            showMessage('Settings — coming in a later phase', CONSTANTS.MESSAGE_TYPES.INFO);
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
        <div class="hamburger-menu-item" onclick="closeHamburgerMenu(); CollectionIO.exportCSV('${viewName}')">${escapeHtml(label)} Export CSV</div>
        <div class="hamburger-menu-item" onclick="closeHamburgerMenu(); CollectionIO.exportJSON('${viewName}')">${escapeHtml(label)} Export JSON</div>
        <div class="hamburger-menu-item" onclick="closeHamburgerMenu(); CollectionIO.triggerImportCSV('${viewName}')">${escapeHtml(label)} Import CSV</div>
    `;
}
