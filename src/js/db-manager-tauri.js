/**
 * db-manager-tauri.js
 * Tauri SQLite backend — wired up in Phase 5.
 * Exposes the same interface as DBManagerWeb so all app code
 * works unchanged regardless of which backend is active.
 *
 * Serialization shim: JS objects don't always match the shape the Rust
 * structs expect (Pages as a string from form inputs, Tags as an array
 * in memory, Finished possibly missing on legacy import records). The
 * normalize helpers below convert JS objects into the shape Rust expects
 * before they cross the invoke boundary, so app code above this file
 * never has to know about it.
 */

//── Normalization helpers ──────────────────────────────────────────────────────

function _toIntOrNull(value) {
    if (value === null || value === undefined || value === '') return null;
    const parsed = parseInt(value, 10);
    return Number.isNaN(parsed) ? null : parsed;
}

function _toTagsString(value) {
    if (typeof value === 'string') return value;
    if (Array.isArray(value)) return JSON.stringify(value);
    return JSON.stringify([]);
}

function _normalizeBookRead(book) {
    return {
        ...book,
        Pages: _toIntOrNull(book.Pages),
        Tags: book.Tags !== undefined ? _toTagsString(book.Tags) : undefined,
        Finished: book.Finished || '',
    };
}

function _normalizeReadingListItem(item) {
    return {
        ...item,
        Pages: item.Pages !== undefined ? _toIntOrNull(item.Pages) : undefined,
        Tags: item.Tags !== undefined ? _toTagsString(item.Tags) : undefined,
    };
}

function _normalizeLibraryBook(book) {
    return {
        ...book,
        Pages: _toIntOrNull(book.Pages),
        Tags: _toTagsString(book.Tags),
    };
}

const DBManagerTauri = {

    //── Lifecycle ────────────────────────────────────────────────────────────

    async init() {
        // SQLite is opened in Rust at startup — nothing to do here.
        console.log('DBManagerTauri: SQLite backend ready');
        return true;
    },

    close() {
        // Connection managed by Rust — no-op.
    },

    deleteDatabase() {
        console.warn('DBManagerTauri: deleteDatabase() not supported in Tauri mode');
    },

    //── Generic CRUD ─────────────────────────────────────────────────────────
    // Routes each storeName to the appropriate Rust command set.

    async get(storeName, key) {
        const handler = this._getHandler(storeName);
        const all = await handler.getAll();
        return all.find(item => item.id === key) || null;
    },

    async getAll(storeName) {
        return this._getHandler(storeName).getAll();
    },

    async put(storeName, data) {
        return this._getHandler(storeName).put(data);
    },

    async delete(storeName, key) {
        return this._getHandler(storeName).delete(key);
    },

    async clear(storeName) {
        return this._getHandler(storeName).clear();
    },

    async putBulk(storeName, items) {
        if (!items || items.length === 0) return;
        return this._getHandler(storeName).putBulk(items);
    },

    /**
     * Atomically replaces all rows for a store (DELETE + INSERT in one
     * Rust transaction). Unlike clear() + putBulk(), a failed insert here
     * cannot leave the table empty — the whole operation rolls back.
     * Passing an empty array is valid and clears the table intentionally.
     */
    async replaceAll(storeName, items) {
        return this._getHandler(storeName).replaceAll(items || []);
    },

    //── Store handlers ────────────────────────────────────────────────────────

    _getHandler(storeName) {
        switch (storeName) {
            case CONSTANTS.STORES.BOOKS_READ:   return DBManagerTauri._booksRead;
            case CONSTANTS.STORES.READING_LIST: return DBManagerTauri._readingList;
            case CONSTANTS.STORES.MY_LIBRARY:   return DBManagerTauri._myLibrary;
            case CONSTANTS.STORES.SETTINGS:     return DBManagerTauri._settings;
            default:
                throw new Error(`DBManagerTauri: unknown store "${storeName}"`);
        }
    },

    _booksRead: {
        getAll:     ()        => invoke('get_all_books_read'),
        put:        (book)    => invoke('save_book_read',        { book: _normalizeBookRead(book) }),
        delete:     (id)      => invoke('delete_book_read',       { id }),
        putBulk:    (books)   => invoke('save_books_read_bulk',   { books: books.map(_normalizeBookRead) }),
        clear:      ()        => invoke('clear_books_read'),
        replaceAll: (books)   => invoke('replace_all_books_read', { books: books.map(_normalizeBookRead) }),
    },

    _readingList: {
        getAll:     ()        => invoke('get_all_reading_list'),
        put:        (item)    => invoke('save_reading_list_item',  { item: _normalizeReadingListItem(item) }),
        delete:     (id)      => invoke('delete_reading_list_item', { id }),
        putBulk:    (items)   => invoke('save_reading_list_bulk',   { items: items.map(_normalizeReadingListItem) }),
        clear:      ()        => invoke('clear_reading_list'),
        replaceAll: (items)   => invoke('replace_all_reading_list', { items: items.map(_normalizeReadingListItem) }),
    },

    _myLibrary: {
        getAll:     ()        => invoke('get_all_my_library'),
        put:        (book)    => invoke('save_library_book',     { book: _normalizeLibraryBook(book) }),
        delete:     (id)      => invoke('delete_library_book',   { id }),
        putBulk:    (books)   => invoke('save_library_bulk',     { books: books.map(_normalizeLibraryBook) }),
        clear:      ()        => invoke('clear_my_library'),
        replaceAll: (books)   => invoke('replace_all_my_library', { books: books.map(_normalizeLibraryBook) }),
    },

    _settings: {
        getAll:  async ()     => {
            const data = await invoke('get_settings');
            // Return in the same shape as IndexedDB — array with one row
            return data ? [{ id: 'app-settings', data: JSON.parse(data) }] : [];
        },
        put:     async (row)  => invoke('save_settings', {
            data: typeof row.data === 'string' ? row.data : JSON.stringify(row.data)
        }),
        delete:  (_id)        => Promise.resolve(), // settings row is never deleted
        putBulk: async (rows) => {
            for (const row of rows) {
                await DBManagerTauri._settings.put(row);
            }
        },
        clear:   ()           => Promise.resolve(), // settings row is never cleared
    },
};

//── invoke helper ─────────────────────────────────────────────────────────────

function invoke(command, args = {}) {
    return window.__TAURI__.core.invoke(command, args);
}
