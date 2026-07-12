/**
 * db-manager-web.js
 * IndexedDB backend for browser / web builds.
 * Exposes the same interface as DBManagerTauri so all app code
 * works unchanged regardless of which backend is active.
 */

const DBManagerWeb = {
    db: null,

    // ── Lifecycle ─────────────────────────────────────────────────────────────

    async init() {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(
                CONSTANTS.DB.NAME,
                CONSTANTS.DB.VERSION
            );

            request.onerror = () => {
                console.error('DBManagerWeb: failed to open database');
                reject(request.error);
            };

            request.onsuccess = () => {
                this.db = request.result;
                console.log('DBManagerWeb: database opened successfully');
                resolve(this.db);
            };

            request.onupgradeneeded = (e) => {
                const db = e.target.result;

                if (!db.objectStoreNames.contains(CONSTANTS.STORES.BOOKS_READ)) {
                    db.createObjectStore(CONSTANTS.STORES.BOOKS_READ, { keyPath: 'id' });
                }
                if (!db.objectStoreNames.contains(CONSTANTS.STORES.READING_LIST)) {
                    db.createObjectStore(CONSTANTS.STORES.READING_LIST, { keyPath: 'id' });
                }
                if (!db.objectStoreNames.contains(CONSTANTS.STORES.MY_LIBRARY)) {
                    db.createObjectStore(CONSTANTS.STORES.MY_LIBRARY, { keyPath: 'id' });
                }
                if (!db.objectStoreNames.contains(CONSTANTS.STORES.SETTINGS)) {
                    db.createObjectStore(CONSTANTS.STORES.SETTINGS, { keyPath: 'id' });
                }

                console.log('DBManagerWeb: schema created');
            };
        });
    },

    close() {
        if (this.db) {
            this.db.close();
            this.db = null;
        }
    },

    deleteDatabase() {
        this.close();
        indexedDB.deleteDatabase(CONSTANTS.DB.NAME);
    },

    // ── Generic CRUD ──────────────────────────────────────────────────────────

    async get(storeName, key) {
        return new Promise((resolve, reject) => {
            const tx = this.db.transaction([storeName], 'readonly');
            const req = tx.objectStore(storeName).get(key);
            req.onsuccess = () => resolve(req.result);
            req.onerror  = () => reject(req.error);
        });
    },

    async getAll(storeName) {
        return new Promise((resolve, reject) => {
            const tx = this.db.transaction([storeName], 'readonly');
            const req = tx.objectStore(storeName).getAll();
            req.onsuccess = () => resolve(req.result);
            req.onerror  = () => reject(req.error);
        });
    },

    async put(storeName, data) {
        return new Promise((resolve, reject) => {
            const tx = this.db.transaction([storeName], 'readwrite');
            const req = tx.objectStore(storeName).put(data);
            req.onsuccess = () => resolve(req.result);
            req.onerror  = () => reject(req.error);
        });
    },

    async delete(storeName, key) {
        return new Promise((resolve, reject) => {
            const tx = this.db.transaction([storeName], 'readwrite');
            const req = tx.objectStore(storeName).delete(key);
            req.onsuccess = () => resolve(req.result);
            req.onerror  = () => reject(req.error);
        });
    },

    async clear(storeName) {
        return new Promise((resolve, reject) => {
            const tx = this.db.transaction([storeName], 'readwrite');
            const req = tx.objectStore(storeName).clear();
            req.onsuccess = () => resolve(req.result);
            req.onerror  = () => reject(req.error);
        });
    },

/**
     * Bulk put — all items in a single transaction for speed.
     */
    async putBulk(storeName, items) {
        if (!items || items.length === 0) return;
        return new Promise((resolve, reject) => {
            const tx = this.db.transaction([storeName], 'readwrite');
            const store = tx.objectStore(storeName);

            tx.oncomplete = () => resolve();
            tx.onerror    = () => reject(tx.error);

            items.forEach(item => store.put(item));
        });
    },

    /**
     * Atomically replaces all items in a store — clear + put-all in a
     * single IndexedDB transaction, matching DBManagerTauri's replaceAll
     * interface. If any put fails, the whole transaction aborts and the
     * store is left unchanged (IndexedDB transactions are all-or-nothing).
     */
    async replaceAll(storeName, items) {
        return new Promise((resolve, reject) => {
            const tx = this.db.transaction([storeName], 'readwrite');
            const store = tx.objectStore(storeName);

            tx.oncomplete = () => resolve();
            tx.onerror    = () => reject(tx.error);

            store.clear();
            (items || []).forEach(item => store.put(item));
        });
    },
};
