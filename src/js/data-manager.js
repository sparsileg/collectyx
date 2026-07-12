/**
 * data-manager.js
 * Unified data persistence layer.
 * All reads and writes go through DBManager — never directly to
 * localStorage, IndexedDB, or Tauri invoke calls.
 */

// ── Global in-memory collections ─────────────────────────────────────────────
// These mirror the active DBManager store and are kept in sync on every
// load/save. All rendering code reads from these arrays.

let books       = [];   // BooksRead
let readingList = [];   // ReadingList
let myLibrary   = [];   // MyLibrary

// ── Initialisation ────────────────────────────────────────────────────────────

/**
 * Migrate data from the old localStorage booksData blob into IndexedDB.
 * Runs once on first launch after the Phase 3 upgrade, then has nothing
 * to do on subsequent launches.
 */
async function migrateFromLocalStorage() {
    const legacy = localStorage.getItem(CONSTANTS.STORAGE_KEYS.BOOKS_DATA);
    if (!legacy) return;
    console.log('Migrating data from localStorage to IndexedDB...');
    try {
        const data = JSON.parse(legacy);
        if (data.BooksRead && data.BooksRead.length > 0) {
            data.BooksRead.forEach(b => { if (!b.id) b.id = generateBookId(); });
            await DBManager.putBulk(CONSTANTS.STORES.BOOKS_READ, data.BooksRead);
        }
        if (data.ReadingList && data.ReadingList.length > 0) {
            data.ReadingList.forEach(b => { if (!b.id) b.id = generateBookId(); });
            await DBManager.putBulk(CONSTANTS.STORES.READING_LIST, data.ReadingList);
        }
        if (data.MyLibrary && data.MyLibrary.length > 0) {
            data.MyLibrary.forEach(b => { if (!b.id) b.id = generateBookId(); });
            await DBManager.putBulk(CONSTANTS.STORES.MY_LIBRARY, data.MyLibrary);
        }
        if (data.Settings) {
            if (data.Settings.displayTheme) {
                data.Settings.displayTheme = sanitiseThemePath(data.Settings.displayTheme);
            }
            await DBManager.put(CONSTANTS.STORES.SETTINGS, {
                id: 'app-settings',
                data: data.Settings
            });
        }
        // Migrate dailyReadingPages from localStorage into settings
        const dailyReadingPages = localStorage.getItem(CONSTANTS.STORAGE_KEYS.DAILY_READING_PAGES);
        if (dailyReadingPages) {
            const current = await loadSettingsFromDB() || {};
            await saveSettingsToDB({ ...current, dailyReadingPages: parseInt(dailyReadingPages) });
            localStorage.removeItem(CONSTANTS.STORAGE_KEYS.DAILY_READING_PAGES);
        }
        // Migrate selectedTheme from localStorage into settings
        const savedTheme = localStorage.getItem(CONSTANTS.STORAGE_KEYS.SELECTED_THEME);
        if (savedTheme) {
            const current = await loadSettingsFromDB() || {};
            await saveSettingsToDB({ ...current, displayTheme: sanitiseThemePath(savedTheme) });
            localStorage.removeItem(CONSTANTS.STORAGE_KEYS.SELECTED_THEME);
        }
        // Migration complete — remove legacy blob
        localStorage.removeItem(CONSTANTS.STORAGE_KEYS.BOOKS_DATA);
        console.log('localStorage migration complete');
    } catch (e) {
        console.error('localStorage migration failed:', e);
    }
}

/**
 * Sanitise a stored theme path to the current expected format.
 * Handles legacy paths from old Electron/localStorage versions.
 */
function sanitiseThemePath(path) {
    if (!path) return CONSTANTS.THEMES.NORDIC_DARK;
    // Map any known legacy path to its current equivalent
    if (path.includes('nordic-dark'))  return CONSTANTS.THEMES.NORDIC_DARK;
    if (path.includes('nordic-light')) return CONSTANTS.THEMES.NORDIC_LIGHT;
    if (path.includes('matrix'))       return CONSTANTS.THEMES.MATRIX_CODE;
    // Unknown — fall back to default
    return CONSTANTS.THEMES.NORDIC_DARK;
}

// ── BooksRead ─────────────────────────────────────────────────────────────────

async function loadData() {
    books = await DBManager.getAll(CONSTANTS.STORES.BOOKS_READ);
}

async function saveData() {
    // Safety check: never overwrite with fewer than 90% of what's currently in SQLite
    const currentCount = await DBManager.getAll(CONSTANTS.STORES.BOOKS_READ).then(r => r.length).catch(() => 0);
    if (currentCount > 10 && books.length < currentCount * 0.9) {
        console.warn(`saveData() blocked — in-memory books (${books.length}) is less than 90% of SQLite count (${currentCount}). Possible data loss prevented.`);
        return false;
    }
    if (books.length === 0) {
        console.warn('saveData() called with empty books array — skipping to prevent data loss');
        return false;
    }
    try {
        await DBManager.replaceAll(CONSTANTS.STORES.BOOKS_READ, books);
        return true;
    } catch (e) {
        console.error('saveData() failed:', e);
        showMessage('Failed to save books: ' + (e.message || e), CONSTANTS.MESSAGE_TYPES.ERROR);
        return false;
    }
}

async function saveBook(book) {
    await DBManager.put(CONSTANTS.STORES.BOOKS_READ, book);
}

async function deleteBook(id) {
    await DBManager.delete(CONSTANTS.STORES.BOOKS_READ, id);
}

// ── ReadingList ───────────────────────────────────────────────────────────────

async function loadReadingListData() {
    readingList = await DBManager.getAll(CONSTANTS.STORES.READING_LIST);
}

async function saveReadingListData() {
    if (readingList.length === 0) {
        console.warn('saveReadingListData() called with empty readingList array — skipping to prevent data loss');
        return false;
    }
    try {
        await DBManager.replaceAll(CONSTANTS.STORES.READING_LIST, readingList);
        return true;
    } catch (e) {
        console.error('saveReadingListData() failed:', e);
        showMessage('Failed to save reading list: ' + (e.message || e), CONSTANTS.MESSAGE_TYPES.ERROR);
        return false;
    }
}

async function saveReadingListItem(item) {
    await DBManager.put(CONSTANTS.STORES.READING_LIST, item);
}

async function deleteReadingListItem(id) {
    await DBManager.delete(CONSTANTS.STORES.READING_LIST, id);
}

// ── MyLibrary ─────────────────────────────────────────────────────────────────

async function loadMyLibraryData() {
    const raw = await DBManager.getAll(CONSTANTS.STORES.MY_LIBRARY);
    myLibrary = raw.map(book => ({
        ...book,
        Tags: typeof book.Tags === 'string' ? JSON.parse(book.Tags) : (book.Tags || []),
    }));
}

async function saveMyLibraryData() {
    if (myLibrary.length === 0) {
        console.warn('saveMyLibraryData() called with empty myLibrary array — skipping to prevent data loss');
        return false;
    }
    try {
        await DBManager.replaceAll(CONSTANTS.STORES.MY_LIBRARY, myLibrary);
        return true;
    } catch (e) {
        console.error('saveMyLibraryData() failed:', e);
        showMessage('Failed to save library: ' + (e.message || e), CONSTANTS.MESSAGE_TYPES.ERROR);
        return false;
    }
}

async function saveMyLibraryBook(book) {
    await DBManager.put(CONSTANTS.STORES.MY_LIBRARY, book);
}

async function deleteMyLibraryBook(id) {
    await DBManager.delete(CONSTANTS.STORES.MY_LIBRARY, id);
}

// ── Settings ──────────────────────────────────────────────────────────────────

async function loadSettingsFromDB() {
    const row = await DBManager.get(CONSTANTS.STORES.SETTINGS, 'app-settings');
    return row ? row.data : null;
}

async function saveSettingsToDB(settingsObj) {
    await DBManager.put(CONSTANTS.STORES.SETTINGS, {
        id: 'app-settings',
        data: settingsObj
    });
}

async function loadCategoriesFromDB() {
    const settings = await loadSettingsFromDB() || {};
    if (settings.categories && Array.isArray(settings.categories)) {
        return settings.categories;
    }
    // First run — seed from BOOK_CATEGORIES and persist
    await saveCategoriesToDB([...BOOK_CATEGORIES].sort());
    return [...BOOK_CATEGORIES].sort();
}

async function saveCategoriesToDB(categoriesArray) {
    const current = await loadSettingsFromDB() || {};
    await saveSettingsToDB({
        ...current,
        categories: categoriesArray
    });
}

// ── Migration helpers ─────────────────────────────────────────────────────────

async function migrateExistingBooks() {
    let migrated = 0;
    books.forEach(book => {
        if (!book.id) {
            book.id = generateBookId();
            migrated++;
        }
    });
    if (migrated > 0) {
        await saveData();
        showMessage(`Migrated ${migrated} books to include unique IDs`, CONSTANTS.MESSAGE_TYPES.INFO);
    }
}

async function migrateReadingListItems() {
    let migrated = 0;
    readingList.forEach(item => {
        if (!item.id) {
            item.id = generateBookId();
            migrated++;
        }
    });
    if (migrated > 0) {
        await saveReadingListData();
    }
}

async function migrateMyLibraryItems() {
    let migrated = 0;
    myLibrary.forEach(item => {
        if (!item.id) {
            item.id = generateBookId();
            migrated++;
        }
    });
    if (migrated > 0) {
        await saveMyLibraryData();
    }
}

// ── Export / Import ───────────────────────────────────────────────────────────

/**
 * Generate the canonical unified export structure.
 * This is the format written to backup files and will be the
 * D1 sync payload in Phase 9.
 */
async function generateUnifiedDatabase() {
    const now = new Date();

    // Calculate tags metadata from myLibrary
    const tagsMetadata = {};
    myLibrary.forEach(book => {
        if (book.Tags && Array.isArray(book.Tags)) {
            book.Tags.forEach(tag => {
                tagsMetadata[tag] = (tagsMetadata[tag] || 0) + 1;
            });
        }
    });

    // Load settings
    const settings = await loadSettingsFromDB() || {};

    return {
        Header: {
            appVersion: CONSTANTS.APP_VERSION,
            timestamp:  now.toISOString()
        },
        BooksRead: books,
        BooksReadInfo: {
            totalBooks: books.length
        },
        ReadingList: readingList,
        ReadingListInfo: {
            totalBooks: readingList.length
        },
        MyLibrary: myLibrary,
        MyLibraryInfo: {
            totalBooks: myLibrary.length
        },
        TagsMetadata: tagsMetadata,
        Settings: {
            ...settings,
            displayTheme:      settings.displayTheme || CONSTANTS.THEMES.NORDIC_DARK,
            dailyReadingPages: settings.dailyReadingPages || null
        }
    };
}

/**
 * Import a unified database object.
 * Validates structure, applies import rules, then writes to DBManager.
 */
async function importUnifiedDatabase(data) {
    try {
        if (!data || typeof data !== 'object') {
            throw new Error('Invalid import file: not a JSON object');
        }

        if (!data.BooksRead && !data.ReadingList && !data.MyLibrary) {
            throw new Error('Invalid import file: no recognised collections found');
        }

        // BooksRead
        if (data.BooksRead && Array.isArray(data.BooksRead)) {
            const prepared = data.BooksRead.map(book => ({
                ...book,
                id: book.id || generateBookId(),
                Pages: book.Pages ? parseInt(book.Pages) || null : null,
                Recommend: book.Recommend === 'Y' || book.Recommend === true  || book.Recommend === 1 ? 1
                         : book.Recommend === 'N' || book.Recommend === false || book.Recommend === 0 ? 0
                         : null,
            }));
            await DBManager.clear(CONSTANTS.STORES.BOOKS_READ);
            await DBManager.putBulk(CONSTANTS.STORES.BOOKS_READ, prepared);
            books = prepared;
        }

        // ReadingList
        if (data.ReadingList && Array.isArray(data.ReadingList)) {
            const prepared = data.ReadingList.map(item => ({
                ...item,
                id: item.id || generateBookId(),
            }));
            await DBManager.clear(CONSTANTS.STORES.READING_LIST);
            await DBManager.putBulk(CONSTANTS.STORES.READING_LIST, prepared);
            readingList = prepared;
        }

        // MyLibrary
        if (data.MyLibrary && Array.isArray(data.MyLibrary)) {
            const prepared = data.MyLibrary.map(book => ({
                ...book,
                id:    book.id || generateBookId(),
                Tags:  JSON.stringify(Array.isArray(book.Tags) ? book.Tags : []),
                Pages: book.Pages ? parseInt(book.Pages) || null : null,
            }));
            await DBManager.clear(CONSTANTS.STORES.MY_LIBRARY);
            await DBManager.putBulk(CONSTANTS.STORES.MY_LIBRARY, prepared);
            myLibrary = prepared;
        }

        // Settings
        if (data.Settings) {
            // Sanitise theme path from any legacy format
            if (data.Settings.displayTheme) {
                const sanitised = sanitiseThemePath(data.Settings.displayTheme);
                data.Settings.displayTheme = sanitised;
                localStorage.setItem(CONSTANTS.STORAGE_KEYS.SELECTED_THEME, sanitised);
                loadTheme();
            }
            await saveSettingsToDB(data.Settings);
        }

        return {
            success: true,
            counts: {
                booksRead:   books.length,
                readingList: readingList.length,
                myLibrary:   myLibrary.length
            }
        };
    } catch (e) {
        console.error('importUnifiedDatabase failed:', e);
        return { success: false, error: e.message };
    }
}

function validateBookData(booksArray) {
    return Array.isArray(booksArray) && booksArray.every(book =>
        book &&
        typeof book === 'object' &&
        book.hasOwnProperty('Title') &&
        book.hasOwnProperty('Author') &&
        typeof book.Title === 'string' &&
        typeof book.Author === 'string' &&
        book.Title.trim() !== '' &&
        book.Author.trim() !== ''
    );
}

// ── Storage info (debug) ──────────────────────────────────────────────────────

function getStorageInfo() {
    return {
        booksRead:   books.length,
        readingList: readingList.length,
        myLibrary:   myLibrary.length
    };
}
