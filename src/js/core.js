// ── App initialisation ────────────────────────────────────────────────────────

let tagsChipController = null;
let editTagsChipController = null;
let myLibraryAddTagsChipController = null;
let myLibraryEditTagsChipController = null;

window.onload = async function () {
    // Initialise the database backend first so loadTheme can read from IndexedDB
    await DBManager.init();

    // One-time migration from old localStorage blob if present
    await migrateFromLocalStorage();

    await loadTheme();

    // Load all collections into memory
    await loadData();
    await loadReadingListData();
    await loadMyLibraryData();

    // Assign IDs to any records that predate the id field
    await migrateExistingBooks();
    await migrateReadingListItems();
    await migrateMyLibraryItems();

    populateCategorySelects();
    renderReadBooks();
    renderDashboard();

    tagsChipController = initTagChipInput({
        input: 'tagsInput', suggestions: 'tagsSuggestions', chipRow: 'tagsChipRow', hidden: 'tags'
    });
    editTagsChipController = initTagChipInput({
        input: 'editTagsInput', suggestions: 'editTagsSuggestions', chipRow: 'editTagsChipRow', hidden: 'editTags'
    });
    myLibraryAddTagsChipController = initTagChipInput({
        input: 'myLibraryAddTagsInput', suggestions: 'myLibraryAddTagsSuggestions', chipRow: 'myLibraryAddTagsChipRow', hidden: 'myLibraryAddTags'
    });
    myLibraryEditTagsChipController = initTagChipInput({
        input: 'myLibraryEditTagsInput', suggestions: 'myLibraryEditTagsSuggestions', chipRow: 'myLibraryEditTagsChipRow', hidden: 'myLibraryEditTags'
    });

    const versionDisplay = document.getElementById('appVersionDisplay');
    if (versionDisplay) {
        versionDisplay.textContent = CONSTANTS.APP_VERSION;
    }
};

// ── View routing ──────────────────────────────────────────────────────────────

function showView(viewName, buttonElement) {
    document.querySelectorAll('.view').forEach(view => view.classList.remove('active'));
    document.querySelectorAll('.nav-btn').forEach(btn => btn.classList.remove('active'));

    document.getElementById(viewName + 'View').classList.add('active');
    if (buttonElement) {
        buttonElement.classList.add('active');
    }

    populateCategorySelects();

    if (viewName === CONSTANTS.VIEWS.DASHBOARD) {
        renderDashboard();
    } else if (viewName === CONSTANTS.VIEWS.ENTER_FINISHED) {
        if (tagsChipController) tagsChipController.setTags([]);
    } else if (viewName === CONSTANTS.VIEWS.REVIEW) {
        renderReadBooks();
    } else if (viewName === CONSTANTS.VIEWS.STATISTICS) {
        renderStatistics();
    } else if (viewName === CONSTANTS.VIEWS.SETTINGS) {
        loadSettings();
    } else if (viewName === CONSTANTS.VIEWS.TO_READ) {
        renderReadingList();
    } else if (viewName === CONSTANTS.VIEWS.MY_LIBRARY) {
        populateMyLibraryCategorySelects();
        populateMyLibraryBookshelfSelects();
        renderMyLibrary();
    }
}

// ── Message area ──────────────────────────────────────────────────────────────

let _errorDismissTimer = null;

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

    // Auto-dismiss error messages after 5 seconds
    if (_errorDismissTimer) clearTimeout(_errorDismissTimer);
    if (type === CONSTANTS.MESSAGE_TYPES.ERROR) {
        _errorDismissTimer = setTimeout(() => {
            messageArea.textContent = '';
            _errorDismissTimer = null;
        }, 5000);
    }
}

function clearMessage() {
    if (_errorDismissTimer) {
        clearTimeout(_errorDismissTimer);
        _errorDismissTimer = null;
    }
    const messageArea = document.getElementById('messageArea');
    // Only clear if it's currently showing an error (red border)
    if (messageArea.style.borderLeftColor === 'rgb(220, 53, 69)') {
        messageArea.textContent = '';
    }
}

// ── Date helpers ──────────────────────────────────────────────────────────────

// Extracts the year from a Finished date string, handling both current
// (YYYY-MM-DD) and legacy (DD-MMM-YYYY) storage formats.
function getYearFromFinishedDate(finishedDate) {
    if (!finishedDate) return null;
    const parts = finishedDate.split('-');
    const year = parts[0].length === 4 ? parts[0] : parts[2];
    return parseInt(year);
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

// ── Confirmation dialog ──────────────────────────────────────────────────────

// Tauri's global confirm() wrapper calls a command that no longer exists in
// this plugin version (see Issue 44); message() with OkCancel buttons is
// the working equivalent. Falls back to native confirm() in the web build.
async function confirmDialog(msg) {
    if (typeof window.__TAURI__ !== 'undefined') {
        const result = await window.__TAURI__.dialog.message(msg, { title: 'Scriptum', buttons: 'OkCancel' });
        return result === 'Ok';
    }
    return confirm(msg);
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

// ── ID generation ─────────────────────────────────────────────────────────────

function generateBookId() {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) {
        return crypto.randomUUID();
    }
    return 'book_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
}

// ── Theme ─────────────────────────────────────────────────────────────────────

async function loadTheme() {
    const settings = await loadSettingsFromDB() || {};
    const theme = settings.displayTheme
        ? sanitiseThemePath(settings.displayTheme)
        : CONSTANTS.THEMES.NORDIC_DARK;
    document.getElementById('themeLink').href = theme;
}

async function changeTheme(themePath) {
    const themeLink = document.getElementById('themeLink');
    themeLink.href = themePath;
    const current = await loadSettingsFromDB() || {};
    await saveSettingsToDB({ ...current, displayTheme: themePath });

    if (document.getElementById('statisticsView').classList.contains('active')) {
        if (typeof destroyCharts === 'function') destroyCharts();
        renderStatistics();
    }
}

function getThemeColors() {
    const themeLink = document.getElementById('themeLink');
    const current   = themeLink.href;

    if (current.includes('nordic-dark')) {
        return { primary: '#0077be', secondary: '#ff6b35', tertiary: '#7b68ee', background: '#2e3440' };
    } else if (current.includes('nordic-light')) {
        return { primary: '#5e81ac', secondary: '#d08770', tertiary: '#b48ead', background: '#eceff4' };
    } else if (current.includes('matrix')) {
        return { primary: '#00ff00', secondary: '#ffff00', tertiary: '#00ffff', background: '#000000' };
    }
    return { primary: '#4a90e2', secondary: '#f5a623', tertiary: '#bd10e0', background: '#0f0f0f' };
}

// ── Settings ──────────────────────────────────────────────────────────────────

async function loadSettings() {
    setTimeout(async () => {
        const pagesInput = document.getElementById('dailyReadingPages');
        const folderInput = document.getElementById('backupFolder');
        const browseBtn = document.getElementById('backupFolderBrowseBtn');
        const clearBtn = document.getElementById('backupFolderClearBtn');
        const isTauri = typeof window.__TAURI__ !== 'undefined';
        if (pagesInput) {
            const settings = await loadSettingsFromDB() || {};
            pagesInput.value = settings.dailyReadingPages || '';
            if (folderInput) {
                if (isTauri) {
                    folderInput.value = settings.backupFolder || '';
                } else {
                    folderInput.value = '';
                    folderInput.placeholder = 'User downloads folder';
                    folderInput.disabled = true;
                }
            }
        }
        if (browseBtn) browseBtn.style.display = isTauri ? '' : 'none';
        if (clearBtn) clearBtn.style.display = isTauri ? '' : 'none';
    }, 50);
}

async function saveSettings(event) {
    event.preventDefault();
    const formData = new FormData(event.target);
    const dailyReadingPages = formData.get('dailyReadingPages');
    const backupFolder = document.getElementById('backupFolder').value || null;
    const current = await loadSettingsFromDB() || {};
    await saveSettingsToDB({
        ...current,
        dailyReadingPages: dailyReadingPages ? parseInt(dailyReadingPages) : null,
        backupFolder: backupFolder
    });
    showMessage('Settings saved successfully', CONSTANTS.MESSAGE_TYPES.SUCCESS);
    showView('dashboard', document.querySelector('[onclick*="dashboard"]'));
}

function resetSettings() {
    document.getElementById('dailyReadingPages').value = '';
    document.getElementById('backupFolder').value = '';
    showMessage('Settings reset to defaults. Click Save to apply.', CONSTANTS.MESSAGE_TYPES.INFO);
}

async function selectBackupFolder() {
    if (typeof window.__TAURI__ !== 'undefined') {
        try {
            const selected = await window.__TAURI_PLUGIN_DIALOG__.open({
                directory: true,
                multiple: false,
                title: 'Select Backup Folder'
            });
            if (selected) {
                document.getElementById('backupFolder').value = selected;
            }
        } catch (e) {
            console.error('selectBackupFolder error:', e);
            showMessage('Could not open folder picker: ' + (e.message || JSON.stringify(e)), CONSTANTS.MESSAGE_TYPES.ERROR);
        }
    } else {
        showMessage('Folder picker is only available in the desktop app', CONSTANTS.MESSAGE_TYPES.INFO);
    }
}

function clearBackupFolder() {
    document.getElementById('backupFolder').value = '';
}
