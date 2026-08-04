/**
 * db-manager-tauri.js
 * Tauri SQLite backend.
 *
 * PHASE 1: stubs only. Every method below mirrors DBManagerWeb's interface
 * so the two backends stay interchangeable, but the Rust commands they call
 * don't exist until Phase 2. Calling one now fails loudly rather than
 * silently returning empty data that could be mistaken for "no records".
 */

function invoke(command, args) {
    return window.__TAURI__.core.invoke(command, args || {});
}

function _notWired(method) {
    return function () {
        throw new Error(
            'DBManagerTauri.' + method + '() is not wired up yet — the Rust ' +
            'commands arrive in Phase 2. Use the web build until then.'
        );
    };
}

const DBManagerTauri = {

    // ── Lifecycle ─────────────────────────────────────────────────────────────

    async init() {
        // SQLite is opened and migrated in Rust at startup — nothing to do here.
        console.log('DBManagerTauri: SQLite backend ready (Phase 1 — commands not yet wired)');
        return true;
    },

    close() {
        // Connection is managed by Rust.
    },

    deleteDatabase() {
        console.warn('DBManagerTauri: deleteDatabase() is not supported in Tauri mode');
    },

    // ── Media types ───────────────────────────────────────────────────────────

    getAllMediaTypes: _notWired('getAllMediaTypes'),
    seedMediaTypes: async function () {
        // Seeded by SQLite migration v1; nothing for the JS layer to do.
    },

    // ── Collections ───────────────────────────────────────────────────────────

    getCollection: _notWired('getCollection'),
    getCollectionRecord: _notWired('getCollectionRecord'),
    saveCollectionRecord: _notWired('saveCollectionRecord'),
    deleteCollectionRecord: _notWired('deleteCollectionRecord'),
    replaceCollection: _notWired('replaceCollection'),

    // ── Items ─────────────────────────────────────────────────────────────────

    getAllItems: _notWired('getAllItems'),
    deleteItem: _notWired('deleteItem'),

    // ── Tags ──────────────────────────────────────────────────────────────────

    getAllTags: _notWired('getAllTags'),
    saveTag: _notWired('saveTag'),
    deleteTag: _notWired('deleteTag'),

    // ── Merge ─────────────────────────────────────────────────────────────────

    mergeItems: _notWired('mergeItems'),

    // ── Settings ──────────────────────────────────────────────────────────────

    getSettings: _notWired('getSettings'),
    saveSettings: _notWired('saveSettings'),
};
