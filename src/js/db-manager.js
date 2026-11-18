/**
 * db-manager.js
 * Selects the appropriate database backend at runtime.
 *
 * DBManagerTauri — Tauri desktop/mobile builds (SQLite via Rust commands)
 * DBManagerWeb   — Browser builds (IndexedDB)
 *
 * All code above this file uses DBManager exclusively and never
 * references either backend directly.
 */

// isTauri() is @tauri-apps/api's own detection function — reading
// globalThis.isTauri, a flag Tauri sets independent of withGlobalTauri.
// Sniffing window.__TAURI__ stopped working once withGlobalTauri went
// false (#66 / CTX-SEC-116); that global no longer exists at all.
import { isTauri } from './vendor/tauri-api/core.js';

const Backend = isTauri() ? DBManagerTauri : DBManagerWeb;

// Writes to data that goes into a backup. After each one succeeds,
// AutoBackup (#97) restarts its countdown. Left out on purpose:
// restoreAll (a restore isn't a new edit — the restored file is already a
// backup), seedMediaTypes (startup housekeeping), setAppMeta (device
// state that isn't backed up).
const AUTO_BACKUP_TRACKED_WRITES = new Set([
    'saveCollectionRecord', 'deleteCollectionRecord', 'replaceCollection',
    'saveItem', 'deleteItem', 'attachTag', 'detachTag',
    'saveTag', 'deleteTag', 'replaceAllTags',
    'saveSettings', 'setCurrentlyReading', 'reorderQueued',
]);

// A thin pass-through over the chosen backend: every method still runs
// with the backend itself as `this`, so its internal state (caches,
// command tables) is untouched by the wrapper.
const DBManager = new Proxy(Backend, {
    get(target, prop) {
        const value = target[prop];
        if (typeof value !== 'function') return value;
        if (!AUTO_BACKUP_TRACKED_WRITES.has(prop)) return value.bind(target);
        return async function (...args) {
            const result = await value.apply(target, args);
            if (typeof AutoBackup !== 'undefined') AutoBackup.noteChange();
            return result;
        };
    }
});

window.DBManager = DBManager;
window.AUTO_BACKUP_TRACKED_WRITES = AUTO_BACKUP_TRACKED_WRITES;
