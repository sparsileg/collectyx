/**
 * db-manager-tauri.js
 * Tauri SQLite backend — real invoke() wiring.
 *
 * Exposes the same interface as DBManagerWeb so all code above this file
 * works unchanged regardless of which backend is active.
 *
 * On partial payloads: one items row is shared across collections, so
 * saving a queued record that carries only Rank must not blank the Pages
 * the consumed record set. DBManagerWeb handles that internally; here the
 * record is completed against its stored version before crossing the
 * invoke boundary, so Rust receives a full record and both backends end up
 * applying identical rules. A key present as null is still a deliberate
 * clear — Object.assign keeps it — while an absent key inherits the
 * stored value.
 *
 * No client-side cache: SQLite reads are cheap and synchronous in Rust,
 * so there is nothing to invalidate and no staleness to get wrong.
 */

function invoke(command, args) {
    return window.__TAURI__.core.invoke(command, args || {});
}

/** Rust command names are per-collection; this keeps the mapping in one place. */
const TAURI_COLLECTION_COMMANDS = {
    consumed: {
        getAll: 'get_all_consumed',
        save: 'save_consumed',
        remove: 'delete_consumed',
        replaceAll: 'replace_all_consumed',
    },
    queued: {
        getAll: 'get_all_queued',
        save: 'save_queued',
        remove: 'delete_queued',
        replaceAll: 'replace_all_queued',
    },
    owned: {
        getAll: 'get_all_owned',
        save: 'save_owned',
        remove: 'delete_owned',
        replaceAll: 'replace_all_owned',
    },
};

const DBManagerTauri = {

    // ── Lifecycle ─────────────────────────────────────────────────────────────

    async init() {
        // SQLite is opened and migrated in Rust at startup.
        console.log('DBManagerTauri: SQLite backend ready');
        return true;
    },

    close() {
        // Connection is managed by Rust.
    },

    deleteDatabase() {
        console.warn('DBManagerTauri: deleteDatabase() is not supported in Tauri mode');
    },

    _commands(collection) {
        const cmds = TAURI_COLLECTION_COMMANDS[collection];
        if (!cmds) throw new Error('Unknown collection "' + collection + '"');
        return cmds;
    },

    // ── Media types ───────────────────────────────────────────────────────────

    async getAllMediaTypes() {
        return invoke('get_all_media_types');
    },

    async seedMediaTypes() {
        // Seeded by SQLite migration v1; nothing for the JS layer to do.
    },

    // ── Collection reads ──────────────────────────────────────────────────────

    async getCollection(collection) {
        return invoke(this._commands(collection).getAll);
    },

    async getCollectionRecord(collection, id) {
        const all = await this.getCollection(collection);
        return all.find(r => r.id === id) || null;
    },

    // ── Collection writes ─────────────────────────────────────────────────────

    async saveCollectionRecord(collection, record) {
        // Complete a partial payload against what is stored, so an omitted
        // field keeps its value rather than being written as null.
        let complete = record;
        if (record.id) {
            const existing = await this.getCollectionRecord(collection, record.id);
            if (existing) complete = Object.assign({}, existing, record);
        }

        const id = await invoke(this._commands(collection).save, { record: complete });
        return { id: id, ItemId: complete.ItemId || null };
    },

    async deleteCollectionRecord(collection, id) {
        return invoke(this._commands(collection).remove, { id: id });
    },

    async replaceCollection(collection, records) {
        return invoke(this._commands(collection).replaceAll, { records: records || [] });
    },

    // ── Items ─────────────────────────────────────────────────────────────────

    async getAllItems() {
        return invoke('get_all_items');
    },

    async saveItem(item) {
        return invoke('save_item', { item: item });
    },

    /** Cascades to membership and junction rows via ON DELETE CASCADE. */
    async deleteItem(itemId) {
        return invoke('delete_item', { id: itemId });
    },

    async attachTag(itemId, tagId) {
        return invoke('attach_tag', { itemId: itemId, tagId: tagId });
    },

    async detachTag(itemId, tagId) {
        return invoke('detach_tag', { itemId: itemId, tagId: tagId });
    },

    // ── Tags ──────────────────────────────────────────────────────────────────

    async getAllTags() {
        return invoke('get_all_tags');
    },

    async saveTag(tag) {
        return invoke('save_tag', { tag: tag });
    },

    async deleteTag(tagId, substituteTagId) {
        return invoke('delete_tag', {
            id: tagId,
            substituteTagId: substituteTagId || null,
        });
    },

    async replaceAllTags(tags) {
        return invoke('replace_all_tags', { tags: tags || [] });
    },

    // ── Merge ─────────────────────────────────────────────────────────────────

    async mergeItems(survivorId, loserId, fieldResolutions) {
        return invoke('merge_items', {
            survivorId: survivorId,
            loserId: loserId,
            fieldResolutions: fieldResolutions || {},
        });
    },

    // ── Settings ──────────────────────────────────────────────────────────────

    async getSettings() {
        const data = await invoke('get_settings');
        if (!data) return null;
        try {
            return typeof data === 'string' ? JSON.parse(data) : data;
        } catch (e) {
            console.error('DBManagerTauri: settings JSON is malformed', e);
            return null;
        }
    },

    async saveSettings(settingsObj) {
        return invoke('save_settings', { data: JSON.stringify(settingsObj || {}) });
    },
};
