// ── App initialisation ────────────────────────────────────────────────────────

window.onload = async function () {
    // Initialise the database backend first so loadTheme can read from IndexedDB
    await DBManager.init();

    // loadTheme() now reads settings via DBManager directly; still wrapped
    // in try/catch so a settings-load failure can't halt the rest of
    // onload before initSidebarChrome() runs.
    try {
        await loadTheme();
    } catch (e) {
        console.error('loadTheme failed:', e);
    }
    if (typeof initSidebarChrome === 'function') await initSidebarChrome();
    if (typeof initNavigation === 'function') await initNavigation();

    // Dashboard is the default active view and showView() is never called
    // for the initial load, so it's rendered directly here.
    if (typeof renderDashboard === 'function') {
        try {
            await renderDashboard();
        } catch (e) {
            console.error('renderDashboard failed:', e);
        }
    }

    const versionDisplay = document.getElementById('appVersionDisplay');
    if (versionDisplay) {
        versionDisplay.textContent = CONSTANTS.APP_VERSION;
    }
};

// ── View routing ──────────────────────────────────────────────────────────────

// Six real views only (Phase 3 — placeholder content). buttonElement is the
// clicked <li class="nav-item"> to highlight; per-view rendering (Books
// Read/To Be Read/My Library lists, Dashboard cards, Statistics charts)
// arrives in Phase 5/7/8 as each view is built out for real.
function showView(viewName, buttonElement) {
    clearMessage();

    document.querySelectorAll('.view').forEach(view => view.classList.remove('active'));

    const target = document.getElementById(viewName + 'View');
    if (target) target.classList.add('active');

    if (typeof updateHamburgerContextualSection === 'function') {
        updateHamburgerContextualSection(viewName);
    }

    // Re-fetches every time a collection view becomes active, rather than
    // caching at this layer — reads are cheap locally and a second cache
    // on top of DBManager's own is one more thing to keep in sync. Not
    // awaited: showView() stays synchronous for its existing callers
    // (nav click handlers); each view's load() handles its own errors.
    if (viewName === CONSTANTS.VIEWS.CONSUMED && typeof ConsumedView !== 'undefined') {
        ConsumedView.load('consumedView');
    } else if (viewName === CONSTANTS.VIEWS.QUEUED && typeof QueuedView !== 'undefined') {
        QueuedView.load('queuedView');
    } else if (viewName === CONSTANTS.VIEWS.OWNED && typeof OwnedView !== 'undefined') {
        OwnedView.load('ownedView');
    } else if (viewName === 'tags' && typeof TagsView !== 'undefined') {
        TagsView.load('tagsView');
    } else if (viewName === CONSTANTS.VIEWS.DASHBOARD && typeof renderDashboard === 'function') {
        renderDashboard();
    }
}

// ── Message area ──────────────────────────────────────────────────────────────

let _messageDismissTimer = null;
const MESSAGE_AUTO_DISMISS_MS = 60000;

function showMessage(text, type = CONSTANTS.MESSAGE_TYPES.INFO) {
    const messageArea = document.getElementById('messageArea');
    const timestamp = new Date().toLocaleString('en-US', {
        hour12: false,
        hour:   '2-digit',
        minute: '2-digit',
        second: '2-digit'
    });
    messageArea.textContent = `[${timestamp}] ${text}`;
    messageArea.style.borderLeftColor =
        type === CONSTANTS.MESSAGE_TYPES.ERROR   ? '#dc3545' :
        type === CONSTANTS.MESSAGE_TYPES.SUCCESS  ? '#28a745' : '#667eea';

    // Every message auto-dismisses after 60s. Only one timer is ever live —
    // clearing before setting means a new message restarts the clock rather
    // than stacking a second dismiss behind the first.
    if (_messageDismissTimer) clearTimeout(_messageDismissTimer);
    _messageDismissTimer = setTimeout(() => {
        messageArea.textContent = '';
        _messageDismissTimer = null;
    }, MESSAGE_AUTO_DISMISS_MS);
}

function clearMessage() {
    if (_messageDismissTimer) {
        clearTimeout(_messageDismissTimer);
        _messageDismissTimer = null;
    }
    const messageArea = document.getElementById('messageArea');
    messageArea.textContent = '';
}

// ── Date helpers ──────────────────────────────────────────────────────────────

// Extracts the year from a Finished date string, handling both current
// (YYYY-MM-DD) and legacy (DD-MMM-YYYY) storage formats. Returns null for
// anything that isn't exactly 4 digits or falls outside a plausible range —
// an unbounded/malformed year here can otherwise drive a fill-loop into
// billions of iterations (COLLECTYX-SEC-28). Callers already handle a
// falsy year.
const MIN_PLAUSIBLE_YEAR = 1000;
const MAX_PLAUSIBLE_YEAR = 2200;

function getYearFromFinishedDate(finishedDate) {
    if (!finishedDate) return null;
    const parts = finishedDate.split('-');
    const yearStr = parts[0].length === 4 ? parts[0] : parts[2];
    if (!yearStr || !/^\d{4}$/.test(yearStr)) return null;
    const year = parseInt(yearStr, 10);
    if (year < MIN_PLAUSIBLE_YEAR || year > MAX_PLAUSIBLE_YEAR) return null;
    return year;
}

/**
 * Validates a MM/DD/YYYY date input on blur.
 * Shows an error toast and clears the field if invalid.
 */
function validateDateInput(input) {
    const value = input.value.trim();
    if (!value) return; // Empty is allowed — required fields handled by form validation

    const match = value.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (!match) {
        showMessage('Invalid date format — please use MM/DD/YYYY', CONSTANTS.MESSAGE_TYPES.ERROR);
        input.value = '';
        return;
    }

    const m = parseInt(match[1]);
    const d = parseInt(match[2]);
    const y = parseInt(match[3]);

    if (m < 1 || m > 12) {
        showMessage('Invalid month — must be between 01 and 12', CONSTANTS.MESSAGE_TYPES.ERROR);
        input.value = '';
        return;
    }

    const daysInMonth = new Date(y, m, 0).getDate();
    if (d < 1 || d > daysInMonth) {
        showMessage(`Invalid day — must be between 01 and ${daysInMonth} for the given month`, CONSTANTS.MESSAGE_TYPES.ERROR);
        input.value = '';
        return;
    }

    if (y < 1000 || y > 2100) {
        showMessage('Invalid year — must be between 1000 and 2100', CONSTANTS.MESSAGE_TYPES.ERROR);
        input.value = '';
        return;
    }
}

function dateFromStorage(storageDate) {
    if (!storageDate) return '';
    try {
        // Handle DD-MMM-YYYY legacy format (e.g., "15-Jan-2024")
        if (storageDate.includes('-') && storageDate.split('-')[1].length === 3) {
            const parts     = storageDate.split('-');
            const day       = parseInt(parts[0]);
            const monthAbbr = parts[1];
            const year      = parseInt(parts[2]);
            const months    = ['Jan','Feb','Mar','Apr','May','Jun',
                               'Jul','Aug','Sep','Oct','Nov','Dec'];
            const monthNum  = months.indexOf(monthAbbr);
            if (monthNum !== -1) {
                return `${String(monthNum + 1).padStart(2,'0')}/${String(day).padStart(2,'0')}/${year}`;
            }
        }
        // Handle YYYY-MM-DD format
        if (/^\d{4}-\d{2}-\d{2}$/.test(storageDate)) {
            const [year, month, day] = storageDate.split('-');
            return `${month}/${day}/${year}`;
        }
        return '';
    } catch (e) {
        return '';
    }
}

function dateToStorage(userDate) {
    if (!userDate) return '';
    // Accept MM/DD/YYYY input and convert to YYYY-MM-DD for storage
    const match = userDate.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (match) {
        const [, month, day, year] = match;
        // Basic range validation
        const m = parseInt(month), d = parseInt(day), y = parseInt(year);
        if (m < 1 || m > 12 || d < 1 || d > 31 || y < 1000) return '';
        return `${year}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
    }
    // Already YYYY-MM-DD (e.g. from import) — pass through
    if (/^\d{4}-\d{2}-\d{2}$/.test(userDate)) return userDate;
    return '';
}

// ── HTML escaping ─────────────────────────────────────────────────────────────

// Escapes user/imported data before interpolation into innerHTML. Does not
// affect trusted, developer-authored template markup around it.
function escapeHtml(str) {
    if (str === null || str === undefined) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

// ── Author formatting ─────────────────────────────────────────────────────────

// Combines surname/given-name into a single display string, omitting the
// separating comma when only one part is present (rather than producing
// "Twain," or ", Mark").
function formatAuthorName(surname, given) {
    const s = (surname || '').trim();
    const g = (given || '').trim();
    if (s && g) return `${s}, ${g}`;
    return s || g;
}

// Inverse of formatAuthorName — splits a stored "Surname, Given" string
// back into its two parts for repopulating an Edit form. A name with no
// comma (only surname or only given was ever entered) is treated as
// surname-only, matching formatAuthorName's own fallback behavior.
function splitAuthorName(combined) {
    const value = (combined || '').trim();
    if (!value) return { surname: '', given: '' };
    const commaIndex = value.indexOf(',');
    if (commaIndex === -1) return { surname: value, given: '' };
    return {
        surname: value.slice(0, commaIndex).trim(),
        given: value.slice(commaIndex + 1).trim()
    };
}

// Display-only inverse of splitAuthorName — reverses a stored
// "Surname, Given" string to "Given Surname" for rendering (row lists,
// dashboard cards). Entry forms keep collecting Given/Surname as two
// separate fields via splitAuthorName above and are unaffected; this
// never touches storage. Formerly private to QueuedDiscovery
// (queued-view.js) as _authorGivenFirst() — promoted here so every
// author-displaying row/card shares one implementation instead of
// re-deriving the same reversal (#88).
function authorGivenFirst(name) {
    if (!name) return '';
    const { given, surname } = splitAuthorName(name);
    return [given, surname].filter(Boolean).join(' ');
}

// ── media_types labels ──────────────────────────────────────────────────────
// Shared by sidebar nav and the three collection modals/views so there's
// one fetch, one source of truth. Defaults here are the fallback if the
// fetch in sidebar.js's initNavigation() fails; that function overwrites
// these in place once real data loads.
const MediaLabels = {
    ConsumedLabel: 'Books Read',
    QueuedLabel: 'To Be Read',
    OwnedLabel: 'My Library',

    todayISO() {
        const d = new Date();
        const y = d.getFullYear();
        const m = String(d.getMonth() + 1).padStart(2, '0');
        const day = String(d.getDate()).padStart(2, '0');
        return `${y}-${m}-${day}`;
    }
};

// ── ID generation ─────────────────────────────────────────────────────────────

function generateBookId() {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) {
        return crypto.randomUUID();
    }
    return 'book_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
}

// ── Theme ─────────────────────────────────────────────────────────────────────

// Whitelists a stored theme path against the known set before it's used as
// a <link href>. Guards against a corrupted or stale settings value, and
// fixes a real bug: this was referenced but never defined, so loadTheme()
// threw on every load where a theme had actually been saved — caught
// silently by window.onload's try/catch, leaving whatever the static HTML
// default happened to be rather than the user's chosen theme.
function sanitiseThemePath(path) {
    const known = Object.keys(CONSTANTS.THEMES).map(k => CONSTANTS.THEMES[k]);
    return known.includes(path) ? path : CONSTANTS.THEMES.NORDIC;
}

async function loadTheme() {
    const settings = await DBManager.getSettings() || {};
    const theme = settings.displayTheme
        ? sanitiseThemePath(settings.displayTheme)
        : CONSTANTS.THEMES.NORDIC;
    document.getElementById('themeLink').href = theme;
}

async function changeTheme(themePath) {
    const themeLink = document.getElementById('themeLink');
    themeLink.href = themePath;

    // The stylesheet loads asynchronously — reading --chart1/--chart2 (or
    // re-rendering charts) immediately after setting href can still see
    // the previous theme's CSS until the new stylesheet finishes loading.
    // A short timeout backstops browsers that don't fire 'load' when href
    // is set to an already-cached or unchanged value, so this can never
    // block indefinitely (#82).
    await new Promise((resolve) => {
        let settled = false;
        const done = () => {
            if (settled) return;
            settled = true;
            themeLink.removeEventListener('load', done);
            themeLink.removeEventListener('error', done);
            resolve();
        };
        themeLink.addEventListener('load', done);
        themeLink.addEventListener('error', done);
        setTimeout(done, 300);
    });

    let current = {};
    let loaded = true;
    try {
        current = await DBManager.getSettings() || {};
    } catch (e) {
        console.error('changeTheme: could not load settings', e);
        loaded = false;
    }
    // Same rule as sidebar.js's adjustFontSize (CTX-SEC-110 / #60): a
    // failed load means `current` is an empty stand-in, not the real
    // settings object. The visual theme switch above still applies;
    // persistence is skipped so other stored settings aren't blanked.
    if (loaded) {
        try {
            await DBManager.saveSettings({ ...current, displayTheme: themePath });
        } catch (e) {
            console.error('changeTheme: could not save settings', e);
        }
    }

    // Dashboard's two Chart.js charts (Reading Goals, Yearly Statistics)
    // bake their colors into each dataset at construction time — Chart.js
    // doesn't watch CSS variables, so nothing updates until something
    // explicitly rebuilds the chart. Full renderDashboard() rather than a
    // targeted per-chart call — same helper settings.js's
    // _refreshActiveView() already uses after a Settings save, so any
    // future dashboard chart is covered by this same call without
    // needing its own wire-up later (#82).
    const dashboardView = document.getElementById('dashboardView');
    if (dashboardView && dashboardView.classList.contains('active') && typeof renderDashboard === 'function') {
        try {
            await renderDashboard();
        } catch (e) {
            console.error('changeTheme: could not re-render dashboard', e);
        }
    }
}

function getThemeColors() {
    const themeLink = document.getElementById('themeLink');
    const current   = themeLink.href;

    let base;
    if (current.includes('nordic.css')) {
        base = { primary: '#88c0d0', secondary: '#ebcb8b', tertiary: '#a3be8c', background: '#2e3440' };
    } else if (current.includes('dark.css')) {
        base = { primary: '#4fc3f7', secondary: '#ffa726', tertiary: '#66bb6a', background: '#1a1f2e' };
    } else if (current.includes('light.css')) {
        base = { primary: '#0d6efd', secondary: '#fd7e14', tertiary: '#198754', background: '#f8f9fa' };
    } else if (current.includes('matrix.css')) {
        base = { primary: '#00ff00', secondary: '#ffff00', tertiary: '#00ffff', background: '#000000' };
    } else if (current.includes('flat.css')) {
        base = { primary: '#d4982e', secondary: '#72a85a', tertiary: '#c04848', background: '#4e4035' };
    } else {
        base = { primary: '#4a90e2', secondary: '#f5a623', tertiary: '#bd10e0', background: '#0f0f0f' };
    }

    // chart1/chart2 (#82) are read live from the active theme's own CSS
    // custom properties, not a third hardcoded copy like base above —
    // base itself already had one real-world drift (matrix's hardcoded
    // secondary here is yellow; matrix.css's actual --secondary-color is
    // an unrelated dark green never used for charts — two different
    // values under the same name, no connection between them). Falls
    // back to base.primary/secondary if a theme file predates --chart1/
    // --chart2 (e.g. a cached stylesheet from before this fix).
    const rootStyle = getComputedStyle(document.documentElement);
    const chart1 = rootStyle.getPropertyValue('--chart1').trim() || base.primary;
    const chart2 = rootStyle.getPropertyValue('--chart2').trim() || base.secondary;

    return { ...base, chart1, chart2 };
}

// ── Settings ──────────────────────────────────────────────────────────────────
// loadSettings()/saveSettings()/resetSettings()/selectBackupFolder()/
// clearBackupFolder() removed — they targeted settingsView, which no longer
// exists. Settings is a modal (confirmed decision); Phase 10 builds it with
// its own implementation rather than adapting these.

// core.js's declarations are read as globals throughout the rest of the
// app (e.g. escapeHtml in every *-view.js row renderer, MediaLabels in
// every modal) — module scope no longer leaks these automatically, so
// every one used outside this file is attached explicitly (#66 /
// CTX-SEC-116).
window.showView = showView;
window.showMessage = showMessage;
window.clearMessage = clearMessage;
window.getYearFromFinishedDate = getYearFromFinishedDate;
window.validateDateInput = validateDateInput;
window.dateFromStorage = dateFromStorage;
window.dateToStorage = dateToStorage;
window.escapeHtml = escapeHtml;
window.formatAuthorName = formatAuthorName;
window.splitAuthorName = splitAuthorName;
window.authorGivenFirst = authorGivenFirst;
window.MediaLabels = MediaLabels;
window.generateBookId = generateBookId;
window.sanitiseThemePath = sanitiseThemePath;
window.loadTheme = loadTheme;
window.changeTheme = changeTheme;
window.getThemeColors = getThemeColors;
