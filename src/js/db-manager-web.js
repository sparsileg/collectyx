/**
 * db-manager-web.js
 * IndexedDB backend for browser / web builds.
 *
 * IndexedDB has no joins. The normalized schema splits what used to be one
 * flat row across items + a membership table + item_tags + tags, so every
 * read the app cares about spans stores. This file simulates those joins.
 *
 * Approach (implementation plan, Phase 1 task 4): stores are loaded into
 * memory and joined via Map lookups. Chosen over per-query cursor walks
 * because the dataset is one user's collection, and over denormalize-on-
 * write because that reintroduces the duplication normalization removed.
 *
 * Writes go to IndexedDB first, then invalidate the affected caches; the
 * next read repopulates. Bulk paths invalidate once, not per row.
 *
 * Rows are stored snake_case, matching the SQL columns exactly, so both
 * backends persist the same shape. The PascalCase records the app consumes
 * are produced here by the join layer, and on Tauri by serde renames.
 */

// ── Field maps ────────────────────────────────────────────────────────────────
// Single source of truth for PascalCase (JS) <-> snake_case (storage).

const ITEM_FIELD_MAP = {
    Title:   'title',
    Author:  'author',
    Author2: 'author2',
    Pages:   'pages',
    ISBN:    'isbn',
};

const COLLECTION_FIELD_MAPS = {
    consumed: {
        Finished:  'finished',
        Rating:    'rating',
        Recommend: 'recommend',
        Comments:  'comments',
    },
    queued: {
        Rank:     'rank',
        Source:   'source',
        Comments: 'comments',
    },
    owned: {
        Location:       'location',
        Patron:         'patron',
        CheckedOutDate: 'checked_out_date',
        Comments:       'comments',
    },
};

// ── Pure join helpers ─────────────────────────────────────────────────────────
// No IndexedDB, no state — plain functions over arrays, so they can be
// exercised directly against a hand-seeded dataset.

const JoinHelpers = {

    /** Builds an id -> row Map for O(1) parent lookup. */
    indexById(rows, key = 'id') {
        const map = new Map();
        (rows || []).forEach(row => map.set(row[key], row));
        return map;
    },

    /**
     * Resolves item_tags + tags into a Map of item_id -> sorted tag-name
     * array. Junction rows whose tag no longer exists are skipped rather
     * than yielding undefined entries.
     */
    tagNamesByItem(itemTags, tags) {
        const tagsById = JoinHelpers.indexById(tags);
        const out = new Map();
        (itemTags || []).forEach(link => {
            const tag = tagsById.get(link.tag_id);
            if (!tag) return;
            if (!out.has(link.item_id)) out.set(link.item_id, []);
            out.get(link.item_id).push(tag.name);
        });
        out.forEach(names => names.sort());
        return out;
    },

    /** Counts how many items carry each tag id. */
    tagUsageCounts(itemTags) {
        const counts = new Map();
        (itemTags || []).forEach(link => {
            counts.set(link.tag_id, (counts.get(link.tag_id) || 0) + 1);
        });
        return counts;
    },

    /**
     * The join this file exists for: membership rows + their parent items
     * row + resolved tag names, as one flat PascalCase record.
     *
     * A membership row whose parent item is missing is dropped and reported
     * via onOrphan rather than silently yielding undefined Title.
     */
    joinCollection(collection, membershipRows, items, itemTags, tags, onOrphan) {
        if (!COLLECTION_FIELD_MAPS[collection]) {
            throw new Error('Unknown collection "' + collection + '"');
        }
        const itemsById = JoinHelpers.indexById(items);
        const tagsByItem = JoinHelpers.tagNamesByItem(itemTags, tags);
        const out = [];

        (membershipRows || []).forEach(row => {
            const item = itemsById.get(row.item_id);
            if (!item) {
                if (onOrphan) onOrphan(collection, row);
                return;
            }
            out.push(JoinHelpers.toRecord(
                collection, row, item, tagsByItem.get(row.item_id) || []
            ));
        });

        return out;
    },

    /** Assembles one joined record. */
    toRecord(collection, row, item, tagNames) {
        const record = {
            id:          row.id,
            ItemId:      item.id,
            Owner:       item.owner,
            MediaTypeId: item.media_type_id,
            Tags:        tagNames.slice(),
            // The membership row's timestamps are the record's own; the
            // item's are exposed separately so neither is lost in the join.
            DateAdded:     row.date_added != null ? row.date_added : null,
            Modified:      row.modified != null ? row.modified : null,
            ItemDateAdded: item.date_added != null ? item.date_added : null,
            ItemModified:  item.modified != null ? item.modified : null,
        };
        Object.keys(ITEM_FIELD_MAP).forEach(js => {
            const v = item[ITEM_FIELD_MAP[js]];
            record[js] = v != null ? v : null;
        });
        Object.keys(COLLECTION_FIELD_MAPS[collection]).forEach(js => {
            const v = row[COLLECTION_FIELD_MAPS[collection][js]];
            record[js] = v != null ? v : null;
        });
        return record;
    },

    /**
     * Inverse of toRecord: splits a joined record back into the item row
     * and membership row that persist it. Tag names come back separately
     * since they resolve against the tags store.
     *
     * `existing` is the currently-stored { item, membership } for this
     * record, or null for a new one. It matters because one item is shared
     * across collections: saving a queued record that only carries Rank and
     * Source must not blank the Pages and ISBN that the consumed record set.
     * So a field absent from the payload keeps its stored value, while a
     * field explicitly present as null is a deliberate clear.
     *
     * Tags follow the same rule: no Tags key means "leave tags alone"
     * (signalled by tagNames === null), an empty array means "remove all".
     */
    splitRecord(collection, record, defaults, existing) {
        const fieldMap = COLLECTION_FIELD_MAPS[collection];
        if (!fieldMap) throw new Error('Unknown collection "' + collection + '"');
        defaults = defaults || {};
        existing = existing || {};
        const has = (k) => Object.prototype.hasOwnProperty.call(record, k);

        const prevItem = existing.item || null;
        const item = {};
        if (prevItem) Object.keys(prevItem).forEach(k => { item[k] = prevItem[k]; });

        item.id = record.ItemId;
        item.owner = record.Owner || (prevItem && prevItem.owner) || defaults.owner;
        item.media_type_id = record.MediaTypeId ||
                             (prevItem && prevItem.media_type_id) || defaults.mediaTypeId;
        item.date_added = record.ItemDateAdded != null ? record.ItemDateAdded
                        : (prevItem && prevItem.date_added != null ? prevItem.date_added
                                                                  : defaults.today);
        item.modified = defaults.today;

        Object.keys(ITEM_FIELD_MAP).forEach(js => {
            const col = ITEM_FIELD_MAP[js];
            if (has(js)) item[col] = record[js] != null ? record[js] : null;
            else if (!prevItem) item[col] = null;
        });

        const prevMembership = existing.membership || null;
        const membership = {};
        if (prevMembership) Object.keys(prevMembership).forEach(k => { membership[k] = prevMembership[k]; });

        membership.id = record.id;
        membership.item_id = record.ItemId;
        membership.date_added = record.DateAdded != null ? record.DateAdded
                              : (prevMembership && prevMembership.date_added != null
                                    ? prevMembership.date_added : defaults.today);
        membership.modified = defaults.today;

        Object.keys(fieldMap).forEach(js => {
            const col = fieldMap[js];
            if (has(js)) membership[col] = record[js] != null ? record[js] : null;
            else if (!prevMembership) membership[col] = null;
        });

        let tagNames = null;
        if (has('Tags')) {
            const list = Array.isArray(record.Tags) ? record.Tags : [];
            tagNames = Array.from(new Set(
                list.map(t => String(t).trim().toLowerCase()).filter(Boolean)
            ));
        }

        return { item: item, membership: membership, tagNames: tagNames };
    },

    /**
     * Given desired tag names for an item and the current tags store, works
     * out which tags need creating and what the item_tags rows should be.
     * Names match within an owner, consistent with UNIQUE(owner, name).
     *
     * A reused tag that's newly linked to this item also gets its modified
     * stamp bumped — otherwise a tag's Last Updated only ever reflects its
     * own creation or an explicit rename, never actual usage, which is the
     * opposite of what the Tags view's sort-by-last-updated is for.
     * existingLinkedTagIds should be the set of tag_ids already linked to
     * this item *before* this save; a tag already in that set is untouched
     * even if it's in tagNames again (nothing changed for it). Omit it
     * (replaceCollection's bulk path) to skip the bump entirely — a
     * restore reproducing historical state shouldn't look like fresh
     * activity.
     */
    reconcileTags(itemId, tagNames, tags, owner, newId, today, existingLinkedTagIds) {
        const alreadyLinked = existingLinkedTagIds || null;
        const byName = new Map();
        (tags || []).filter(t => t.owner === owner).forEach(t => byName.set(t.name, t));

        const newTags = [];
        const touchedTags = [];
        const links = [];

        tagNames.forEach(name => {
            let tag = byName.get(name);
            if (!tag) {
                tag = { id: newId(), owner: owner, name: name, date_added: today, modified: today };
                byName.set(name, tag);
                newTags.push(tag);
            } else if (alreadyLinked && !alreadyLinked.has(tag.id)) {
                tag.modified = today;
                touchedTags.push(tag);
            }
            links.push({ item_id: itemId, tag_id: tag.id });
        });

        return { newTags: newTags, touchedTags: touchedTags, links: links };
    },

    /**
     * Merge planning (design doc §3.3). Pure — returns the rows to rewrite
     * and delete; the caller applies them. Reassigns every membership and
     * junction row from loser to survivor, deduplicating item_tags where
     * the survivor already carries that tag.
     */
    planMerge(survivorId, loserId, memberships, itemTags) {
        if (survivorId === loserId) throw new Error('Cannot merge an item into itself');

        const reassigned = { consumed: [], queued: [], owned: [] };
        ['consumed', 'queued', 'owned'].forEach(name => {
            (memberships[name] || []).forEach(row => {
                if (row.item_id === loserId) {
                    const moved = {};
                    Object.keys(row).forEach(k => { moved[k] = row[k]; });
                    moved.item_id = survivorId;
                    reassigned[name].push(moved);
                }
            });
        });

        const survivorTagIds = new Set(
            (itemTags || []).filter(l => l.item_id === survivorId).map(l => l.tag_id)
        );
        const loserLinks = (itemTags || []).filter(l => l.item_id === loserId);

        return {
            reassigned: reassigned,
            movedLinks: loserLinks
                .filter(l => !survivorTagIds.has(l.tag_id))
                .map(l => ({ item_id: survivorId, tag_id: l.tag_id })),
            droppedLinks: loserLinks.filter(l => survivorTagIds.has(l.tag_id)),
            deleteItemId: loserId,
        };
    },

    /**
     * Applies field resolutions to the survivor item. Any field where the
     * two genuinely disagree must be resolved explicitly — there is no
     * automatic winner (design doc §3.3 step 3). A field one side simply
     * lacks is not a conflict; there's nothing to choose between.
     */
    resolveMergedItem(survivor, loser, resolutions) {
        resolutions = resolutions || {};
        const merged = {};
        Object.keys(survivor).forEach(k => { merged[k] = survivor[k]; });
        const unresolved = [];

        const fields = Object.keys(ITEM_FIELD_MAP).map(js => ITEM_FIELD_MAP[js]);

        fields.forEach(col => {
            const a = survivor[col] != null ? survivor[col] : null;
            const b = loser[col] != null ? loser[col] : null;
            if (a === b) return;
            if (a === null || a === '') { merged[col] = b; return; }
            if (b === null || b === '') { merged[col] = a; return; }
            if (Object.prototype.hasOwnProperty.call(resolutions, col)) {
                merged[col] = resolutions[col];
            } else {
                unresolved.push(col);
            }
        });

        return { merged: merged, unresolved: unresolved };
    },
};

// ── Backend ───────────────────────────────────────────────────────────────────

const DBManagerWeb = {
    db: null,
    _cache: {},

    get _storeNames() {
        return Object.keys(CONSTANTS.STORES).map(k => CONSTANTS.STORES[k]);
    },

    // ── Lifecycle ─────────────────────────────────────────────────────────────

    async init() {
        const db = await new Promise((resolve, reject) => {
            const request = indexedDB.open(CONSTANTS.DB.NAME, CONSTANTS.DB.VERSION);

            request.onerror = () => {
                console.error('DBManagerWeb: failed to open database');
                reject(request.error);
            };

            request.onsuccess = () => resolve(request.result);

            request.onupgradeneeded = (e) => {
                const idb = e.target.result;
                const S = CONSTANTS.STORES;

                const ensure = (name, options) =>
                    idb.objectStoreNames.contains(name)
                        ? e.target.transaction.objectStore(name)
                        : idb.createObjectStore(name, options);

                const index = (store, name, keyPath) => {
                    if (!store.indexNames.contains(name)) store.createIndex(name, keyPath);
                };

                ensure(S.MEDIA_TYPES, { keyPath: 'id' });

                const items = ensure(S.ITEMS, { keyPath: 'id' });
                index(items, 'owner', 'owner');
                index(items, 'media_type_id', 'media_type_id');

                [S.CONSUMED, S.QUEUED, S.OWNED].forEach(name => {
                    index(ensure(name, { keyPath: 'id' }), 'item_id', 'item_id');
                });

                const tags = ensure(S.TAGS, { keyPath: 'id' });
                index(tags, 'owner', 'owner');
                index(tags, 'name', 'name');

                // Compound key mirrors the SQL composite primary key
                // (item_id, tag_id), so the junction can't hold duplicates.
                const itemTags = ensure(S.ITEM_TAGS, { keyPath: ['item_id', 'tag_id'] });
                index(itemTags, 'item_id', 'item_id');
                index(itemTags, 'tag_id', 'tag_id');

                // Keyed on owner, matching settings' SQL primary key.
                ensure(S.SETTINGS, { keyPath: 'owner' });

                console.log('DBManagerWeb: schema created — ' +
                            Array.from(idb.objectStoreNames).join(', '));
            };
        });

        this.db = db;
        this._cache = {};
        console.log('DBManagerWeb: database opened — ' +
                    Array.from(db.objectStoreNames).join(', '));
        await this.seedMediaTypes();
        return db;
    },

    close() {
        if (this.db) {
            this.db.close();
            this.db = null;
        }
        this._cache = {};
    },

    deleteDatabase() {
        this.close();
        indexedDB.deleteDatabase(CONSTANTS.DB.NAME);
    },

    // ── Cache ─────────────────────────────────────────────────────────────────

    async _load(storeName) {
        if (!this._cache[storeName]) {
            this._cache[storeName] = await this._rawGetAll(storeName);
        }
        return this._cache[storeName];
    },

    _invalidate() {
        const names = arguments.length
            ? Array.prototype.slice.call(arguments)
            : this._storeNames;
        names.forEach(name => { delete this._cache[name]; });
    },

    // ── Raw store access ──────────────────────────────────────────────────────

    _rawGetAll(storeName) {
        return new Promise((resolve, reject) => {
            const tx = this.db.transaction([storeName], 'readonly');
            const req = tx.objectStore(storeName).getAll();
            req.onsuccess = () => resolve(req.result || []);
            req.onerror = () => reject(req.error);
        });
    },

    _rawGet(storeName, key) {
        return new Promise((resolve, reject) => {
            const tx = this.db.transaction([storeName], 'readonly');
            const req = tx.objectStore(storeName).get(key);
            req.onsuccess = () => resolve(req.result || null);
            req.onerror = () => reject(req.error);
        });
    },

    /**
     * Applies writes across several stores in one IndexedDB transaction.
     * IndexedDB transactions auto-close if control leaves the current event
     * loop turn, so every operation is queued synchronously here — no
     * awaits inside this function, deliberately.
     *
     * ops: [{ store, action: 'put'|'delete'|'clear', value?, key? }]
     */
    _rawWrite(storeNames, ops) {
        return new Promise((resolve, reject) => {
            const tx = this.db.transaction(storeNames, 'readwrite');
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
            tx.onabort = () => reject(tx.error || new Error('Transaction aborted'));

            try {
                ops.forEach(op => {
                    const store = tx.objectStore(op.store);
                    if (op.action === 'put') store.put(op.value);
                    else if (op.action === 'delete') store.delete(op.key);
                    else if (op.action === 'clear') store.clear();
                    else throw new Error('Unknown write action "' + op.action + '"');
                });
            } catch (e) {
                try { tx.abort(); } catch (ignored) { /* already aborting */ }
                reject(e);
            }
        });
    },

    // ── Helpers ───────────────────────────────────────────────────────────────

    _newId() {
        if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
        return 'id_' + Date.now() + '_' + Math.random().toString(36).slice(2, 11);
    },

    _today() {
        const d = new Date();
        return d.getFullYear() + '-' +
               String(d.getMonth() + 1).padStart(2, '0') + '-' +
               String(d.getDate()).padStart(2, '0');
    },

    _defaults() {
        return {
            owner: CONSTANTS.DEFAULT_OWNER,
            mediaTypeId: CONSTANTS.MEDIA_TYPE_BOOKS,
            today: this._today(),
        };
    },

    _onOrphan(collection, row) {
        // Never drop data silently — an orphan means an items row went away
        // without its membership rows, which is worth surfacing.
        console.warn(
            'DBManagerWeb: ' + collection + ' row ' + row.id +
            ' references missing item ' + row.item_id + ' and was omitted.'
        );
    },

    // ── Media types ───────────────────────────────────────────────────────────

    async getAllMediaTypes() {
        const rows = await this._load(CONSTANTS.STORES.MEDIA_TYPES);
        return rows.map(r => ({
            id: r.id,
            Name: r.name,
            ConsumedLabel: r.consumed_label,
            QueuedLabel: r.queued_label,
            OwnedLabel: r.owned_label,
        }));
    },

    /**
     * Seeds the one media type v1 ships with. The SQLite side does this in
     * migration v1; IndexedDB has no migration runner, so it happens here.
     */
    async seedMediaTypes() {
        const existing = await this._load(CONSTANTS.STORES.MEDIA_TYPES);
        if (existing.length > 0) return;
        await this._rawWrite([CONSTANTS.STORES.MEDIA_TYPES], [{
            store: CONSTANTS.STORES.MEDIA_TYPES,
            action: 'put',
            value: {
                id: CONSTANTS.MEDIA_TYPE_BOOKS,
                name: 'Books',
                consumed_label: 'Books Read',
                queued_label: 'To Be Read',
                owned_label: 'My Library',
            },
        }]);
        this._invalidate(CONSTANTS.STORES.MEDIA_TYPES);
    },

    // ── Collection reads (the join) ───────────────────────────────────────────

    async getCollection(collection) {
        const results = await Promise.all([
            this._load(collection),
            this._load(CONSTANTS.STORES.ITEMS),
            this._load(CONSTANTS.STORES.ITEM_TAGS),
            this._load(CONSTANTS.STORES.TAGS),
        ]);
        return JoinHelpers.joinCollection(
            collection, results[0], results[1], results[2], results[3], this._onOrphan
        );
    },

    async getCollectionRecord(collection, id) {
        const all = await this.getCollection(collection);
        return all.find(r => r.id === id) || null;
    },

    // ── Collection writes ─────────────────────────────────────────────────────

    /**
     * Upserts one joined record: its items row, its membership row, and its
     * tag links. Passing an existing ItemId is how the same physical book
     * joins a second collection without re-typing title/author.
     */
    async saveCollectionRecord(collection, record) {
        const defaults = this._defaults();
        const prepared = {};
        Object.keys(record).forEach(k => { prepared[k] = record[k]; });
        if (!prepared.id) prepared.id = this._newId();
        if (!prepared.ItemId) prepared.ItemId = this._newId();

        const S = CONSTANTS.STORES;
        const loaded = await Promise.all([
            this._load(S.TAGS),
            this._load(S.ITEM_TAGS),
            this._load(S.ITEMS),
            this._load(collection),
        ]);
        const tags = loaded[0];
        const itemTags = loaded[1];

        // The stored rows matter: one item is shared across collections, so
        // a partial payload must not blank fields another collection set.
        const existing = {
            item: loaded[2].find(i => i.id === prepared.ItemId) || null,
            membership: loaded[3].find(m => m.id === prepared.id) || null,
        };

        const split = JoinHelpers.splitRecord(collection, prepared, defaults, existing);
        const item = split.item;

        const ops = [
            { store: S.ITEMS, action: 'put', value: item },
            { store: collection, action: 'put', value: split.membership },
        ];

        // tagNames === null means the payload said nothing about tags, so
        // leave the existing links alone.
        if (split.tagNames !== null) {
            const existingLinkedTagIds = new Set(
                itemTags.filter(l => l.item_id === item.id).map(l => l.tag_id)
            );
            const rec = JoinHelpers.reconcileTags(
                item.id, split.tagNames, tags, item.owner,
                () => this._newId(), defaults.today, existingLinkedTagIds
            );
            rec.newTags.forEach(t => ops.push({ store: S.TAGS, action: 'put', value: t }));
            rec.touchedTags.forEach(t => ops.push({ store: S.TAGS, action: 'put', value: t }));

            const keep = new Set(rec.links.map(l => l.tag_id));
            itemTags.filter(l => l.item_id === item.id && !keep.has(l.tag_id))
                    .forEach(l => ops.push({
                        store: S.ITEM_TAGS, action: 'delete', key: [l.item_id, l.tag_id],
                    }));
            rec.links.forEach(l => ops.push({ store: S.ITEM_TAGS, action: 'put', value: l }));
        }

        await this._rawWrite([S.ITEMS, collection, S.TAGS, S.ITEM_TAGS], ops);
        this._invalidate(S.ITEMS, collection, S.TAGS, S.ITEM_TAGS);

        return { id: prepared.id, ItemId: prepared.ItemId };
    },

    /**
     * Deletes a membership row. The items row is deliberately left alone —
     * the same item may belong to other collections, and an item with no
     * memberships is still a valid catalogue entry.
     */
    async deleteCollectionRecord(collection, id) {
        await this._rawWrite([collection], [{ store: collection, action: 'delete', key: id }]);
        this._invalidate(collection);
    },

    /** Bulk replace for one collection. Invalidates once, not per row. */
    async replaceCollection(collection, records) {
        const defaults = this._defaults();
        const S = CONSTANTS.STORES;
        const loaded = await Promise.all([
            this._load(S.TAGS),
            this._load(S.ITEM_TAGS),
            this._load(S.ITEMS),
        ]);
        const workingTags = loaded[0].slice();
        const itemTags = loaded[1];
        const existingItems = JoinHelpers.indexById(loaded[2]);

        const ops = [{ store: collection, action: 'clear' }];
        const touchedItems = new Set();
        const desired = new Set();

        (records || []).forEach(input => {
            const prepared = {};
            Object.keys(input).forEach(k => { prepared[k] = input[k]; });
            if (!prepared.id) prepared.id = this._newId();
            if (!prepared.ItemId) prepared.ItemId = this._newId();

            // Same absent-vs-null rule as saveCollectionRecord: replacing a
            // collection must not blank item fields owned by another one.
            const split = JoinHelpers.splitRecord(collection, prepared, defaults, {
                item: existingItems.get(prepared.ItemId) || null,
                membership: null,
            });
            const item = split.item;

            ops.push({ store: S.ITEMS, action: 'put', value: item });
            ops.push({ store: collection, action: 'put', value: split.membership });
            touchedItems.add(item.id);

            if (split.tagNames !== null) {
                const rec = JoinHelpers.reconcileTags(
                    item.id, split.tagNames, workingTags, item.owner,
                    () => this._newId(), defaults.today
                );
                rec.newTags.forEach(t => {
                    workingTags.push(t);
                    ops.push({ store: S.TAGS, action: 'put', value: t });
                });
                rec.links.forEach(l => {
                    ops.push({ store: S.ITEM_TAGS, action: 'put', value: l });
                    desired.add(l.item_id + '\u0000' + l.tag_id);
                });
            } else {
                // Tags untouched for this item — keep whatever links exist.
                itemTags.filter(l => l.item_id === item.id)
                        .forEach(l => desired.add(l.item_id + '\u0000' + l.tag_id));
            }
        });

        // Drop stale links, but only for items this replace actually rewrote.
        itemTags.filter(l => touchedItems.has(l.item_id) &&
                             !desired.has(l.item_id + '\u0000' + l.tag_id))
                .forEach(l => ops.push({
                    store: S.ITEM_TAGS, action: 'delete', key: [l.item_id, l.tag_id],
                }));

        await this._rawWrite([S.ITEMS, collection, S.TAGS, S.ITEM_TAGS], ops);
        this._invalidate(S.ITEMS, collection, S.TAGS, S.ITEM_TAGS);
    },

    // ── Items ─────────────────────────────────────────────────────────────────

    async getAllItems() {
        const loaded = await Promise.all([
            this._load(CONSTANTS.STORES.ITEMS),
            this._load(CONSTANTS.STORES.ITEM_TAGS),
            this._load(CONSTANTS.STORES.TAGS),
        ]);
        const tagsByItem = JoinHelpers.tagNamesByItem(loaded[1], loaded[2]);
        return loaded[0].map(item => {
            const rec = {
                id: item.id,
                Owner: item.owner,
                MediaTypeId: item.media_type_id,
                Tags: tagsByItem.get(item.id) || [],
                DateAdded: item.date_added != null ? item.date_added : null,
                Modified: item.modified != null ? item.modified : null,
            };
            Object.keys(ITEM_FIELD_MAP).forEach(js => {
                const v = item[ITEM_FIELD_MAP[js]];
                rec[js] = v != null ? v : null;
            });
            return rec;
        });
    },

    /**
     * Creates or updates a bare item with no collection membership. The
     * collection save paths upsert their own item, so this is mainly for
     * the importer and for tests.
     */
    async saveItem(item) {
        const S = CONSTANTS.STORES;
        const today = this._today();
        const existing = item.id ? await this._rawGet(S.ITEMS, item.id) : null;
        const row = {};
        if (existing) Object.keys(existing).forEach(k => { row[k] = existing[k]; });

        row.id = item.id || this._newId();
        row.owner = item.Owner || (existing && existing.owner) || CONSTANTS.DEFAULT_OWNER;
        row.media_type_id = item.MediaTypeId || (existing && existing.media_type_id) ||
                            CONSTANTS.MEDIA_TYPE_BOOKS;
        row.date_added = item.DateAdded ||
                         (existing && existing.date_added) || today;
        row.modified = today;
        Object.keys(ITEM_FIELD_MAP).forEach(js => {
            const col = ITEM_FIELD_MAP[js];
            if (Object.prototype.hasOwnProperty.call(item, js)) {
                row[col] = item[js] != null ? item[js] : null;
            } else if (!existing) {
                row[col] = null;
            }
        });

        await this._rawWrite([S.ITEMS], [{ store: S.ITEMS, action: 'put', value: row }]);
        this._invalidate(S.ITEMS);
        return row.id;
    },

    async attachTag(itemId, tagId) {
        const S = CONSTANTS.STORES;
        await this._rawWrite([S.ITEM_TAGS], [{
            store: S.ITEM_TAGS, action: 'put', value: { item_id: itemId, tag_id: tagId },
        }]);
        this._invalidate(S.ITEM_TAGS);
    },

    async detachTag(itemId, tagId) {
        const S = CONSTANTS.STORES;
        await this._rawWrite([S.ITEM_TAGS], [{
            store: S.ITEM_TAGS, action: 'delete', key: [itemId, tagId],
        }]);
        this._invalidate(S.ITEM_TAGS);
    },

    /**
     * Deletes an item and everything hanging off it. SQLite does this via
     * ON DELETE CASCADE; IndexedDB has no such thing, so the cascade is
     * spelled out here to keep the two backends behaving identically.
     */
    async deleteItem(itemId) {
        const S = CONSTANTS.STORES;
        const loaded = await Promise.all([
            this._load(S.CONSUMED),
            this._load(S.QUEUED),
            this._load(S.OWNED),
            this._load(S.ITEM_TAGS),
        ]);

        const ops = [{ store: S.ITEMS, action: 'delete', key: itemId }];
        [[S.CONSUMED, loaded[0]], [S.QUEUED, loaded[1]], [S.OWNED, loaded[2]]]
            .forEach(pair => {
                pair[1].filter(r => r.item_id === itemId)
                       .forEach(r => ops.push({ store: pair[0], action: 'delete', key: r.id }));
            });
        loaded[3].filter(l => l.item_id === itemId)
                 .forEach(l => ops.push({
                     store: S.ITEM_TAGS, action: 'delete', key: [l.item_id, l.tag_id],
                 }));

        await this._rawWrite(
            [S.ITEMS, S.CONSUMED, S.QUEUED, S.OWNED, S.ITEM_TAGS], ops
        );
        this._invalidate();
    },

    // ── Tags ──────────────────────────────────────────────────────────────────

    async getAllTags() {
        const loaded = await Promise.all([
            this._load(CONSTANTS.STORES.TAGS),
            this._load(CONSTANTS.STORES.ITEM_TAGS),
        ]);
        const counts = JoinHelpers.tagUsageCounts(loaded[1]);
        return loaded[0].map(t => ({
            id: t.id,
            Owner: t.owner,
            Name: t.name,
            Count: counts.get(t.id) || 0,
            DateAdded: t.date_added != null ? t.date_added : null,
            Modified: t.modified != null ? t.modified : null,
        }));
    },

    async saveTag(tag) {
        const today = this._today();
        const row = {
            id: tag.id || this._newId(),
            owner: tag.Owner || CONSTANTS.DEFAULT_OWNER,
            name: String(tag.Name || '').trim().toLowerCase(),
            date_added: tag.DateAdded || today,
            modified: today,
        };
        if (!row.name) throw new Error('Tag name cannot be empty');

        const tags = await this._load(CONSTANTS.STORES.TAGS);
        const clash = tags.find(t => t.owner === row.owner && t.name === row.name && t.id !== row.id);
        if (clash) throw new Error('Tag "' + row.name + '" already exists');

        await this._rawWrite([CONSTANTS.STORES.TAGS],
                             [{ store: CONSTANTS.STORES.TAGS, action: 'put', value: row }]);
        this._invalidate(CONSTANTS.STORES.TAGS);
        return row.id;
    },

    /**
     * Deletes a tag, optionally reassigning its item_tags rows to a
     * substitute first (design doc §4.6). Links that would duplicate an
     * existing substitute link are dropped rather than written twice.
     */
    async deleteTag(tagId, substituteTagId) {
        substituteTagId = substituteTagId || null;
        const S = CONSTANTS.STORES;
        const itemTags = await this._load(S.ITEM_TAGS);
        const affected = itemTags.filter(l => l.tag_id === tagId);

        const ops = [{ store: S.TAGS, action: 'delete', key: tagId }];
        affected.forEach(l => ops.push({
            store: S.ITEM_TAGS, action: 'delete', key: [l.item_id, l.tag_id],
        }));

        if (substituteTagId) {
            const already = new Set(
                itemTags.filter(l => l.tag_id === substituteTagId).map(l => l.item_id)
            );
            affected.filter(l => !already.has(l.item_id)).forEach(l => ops.push({
                store: S.ITEM_TAGS, action: 'put',
                value: { item_id: l.item_id, tag_id: substituteTagId },
            }));
        }

        await this._rawWrite([S.TAGS, S.ITEM_TAGS], ops);
        this._invalidate(S.TAGS, S.ITEM_TAGS);
        return affected.length;
    },

    /** Bulk tag replace, scoped to one owner. */
    async replaceAllTags(tagList) {
        const S = CONSTANTS.STORES;
        const today = this._today();
        const owner = CONSTANTS.DEFAULT_OWNER;
        const existing = await this._load(S.TAGS);

        const ops = [];
        existing.filter(t => t.owner === owner)
                .forEach(t => ops.push({ store: S.TAGS, action: 'delete', key: t.id }));

        const seen = new Set();
        (tagList || []).forEach(tag => {
            const name = String(tag.Name || '').trim().toLowerCase();
            if (!name || seen.has(name)) return;
            seen.add(name);
            ops.push({
                store: S.TAGS, action: 'put',
                value: {
                    id: tag.id || this._newId(),
                    owner: tag.Owner || owner,
                    name: name,
                    date_added: tag.DateAdded || today,
                    modified: today,
                },
            });
        });

        await this._rawWrite([S.TAGS], ops);
        this._invalidate(S.TAGS);
    },

    // ── Merge (design doc §3.3) ───────────────────────────────────────────────

    /**
     * Merges loser into survivor: every membership and junction row moves
     * across and the loser item is deleted, all in one transaction — a
     * failure partway through leaves nothing half-merged.
     */
    async mergeItems(survivorId, loserId, fieldResolutions) {
        const S = CONSTANTS.STORES;
        const loaded = await Promise.all([
            this._load(S.ITEMS),
            this._load(S.CONSUMED),
            this._load(S.QUEUED),
            this._load(S.OWNED),
            this._load(S.ITEM_TAGS),
        ]);
        const items = loaded[0], itemTags = loaded[4];

        const itemsById = JoinHelpers.indexById(items);
        const survivor = itemsById.get(survivorId);
        const loser = itemsById.get(loserId);
        if (!survivor) throw new Error('Survivor item ' + survivorId + ' not found');
        if (!loser) throw new Error('Loser item ' + loserId + ' not found');

        const resolution = JoinHelpers.resolveMergedItem(survivor, loser, fieldResolutions);
        if (resolution.unresolved.length) {
            throw new Error('Merge needs a resolution for: ' + resolution.unresolved.join(', '));
        }
        const merged = resolution.merged;
        merged.modified = this._today();

        const plan = JoinHelpers.planMerge(
            survivorId, loserId,
            { consumed: loaded[1], queued: loaded[2], owned: loaded[3] },
            itemTags
        );

        const ops = [{ store: S.ITEMS, action: 'put', value: merged }];
        Object.keys(plan.reassigned).forEach(store => {
            plan.reassigned[store].forEach(r => ops.push({ store: store, action: 'put', value: r }));
        });
        itemTags.filter(l => l.item_id === loserId).forEach(l => ops.push({
            store: S.ITEM_TAGS, action: 'delete', key: [l.item_id, l.tag_id],
        }));
        plan.movedLinks.forEach(l => ops.push({ store: S.ITEM_TAGS, action: 'put', value: l }));
        ops.push({ store: S.ITEMS, action: 'delete', key: loserId });

        await this._rawWrite(
            [S.ITEMS, S.CONSUMED, S.QUEUED, S.OWNED, S.ITEM_TAGS], ops
        );
        this._invalidate();

        return {
            movedConsumed: plan.reassigned.consumed.length,
            movedQueued: plan.reassigned.queued.length,
            movedOwned: plan.reassigned.owned.length,
            movedTags: plan.movedLinks.length,
            droppedDuplicateTags: plan.droppedLinks.length,
        };
    },

    // ── Settings ──────────────────────────────────────────────────────────────

    // Owner is not a parameter: v1 is single-owner and the Rust side reads
    // DEFAULT_OWNER internally. Keeping the signatures identical means the
    // two backends stay drop-in interchangeable; when multi-user arrives,
    // both change together.
    async getSettings() {
        const row = await this._rawGet(CONSTANTS.STORES.SETTINGS, CONSTANTS.DEFAULT_OWNER);
        if (!row) return null;
        // Stored as a JSON string so both backends persist the identical
        // shape; SQLite's settings.data is TEXT.
        try {
            return typeof row.data === 'string' ? JSON.parse(row.data) : row.data;
        } catch (e) {
            console.error('DBManagerWeb: settings JSON is malformed', e);
            return null;
        }
    },

    async saveSettings(settingsObj) {
        await this._rawWrite([CONSTANTS.STORES.SETTINGS], [{
            store: CONSTANTS.STORES.SETTINGS,
            action: 'put',
            value: {
                owner: CONSTANTS.DEFAULT_OWNER,
                data: JSON.stringify(settingsObj || {}),
            },
        }]);
        this._invalidate(CONSTANTS.STORES.SETTINGS);
    },
};
