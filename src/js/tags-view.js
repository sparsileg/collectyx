// ── Tags CRUD view (Phase 7, design doc §4.6) ───────────────────────────────
// Split out of tags.js for naming/structure consistency with the other
// collections' {collection}-view.js files. Depends on the chip-input
// helpers (tag-chip-input.js) for refreshLibraryTagCache(); TagFormModal/
// TagDeleteModal (tags-modal.js) are invoked here but not required at
// load time — only when a button is clicked.
//
// Real DBManager-backed list — getAllTags()/saveTag()/deleteTag() already
// work; this is UI only. Delete-from-a-single-book stays in each
// collection's own Edit modal (existing, untouched); this view deletes a
// tag from the system entirely.

const TagsView = {
    CONTAINER_ID: 'tagsView',
    _tags: [],
    _sortKey: 'Name',
    _sortDir: 'asc',

    async load(containerId) {
        this._bindEvents();
        try {
            this._tags = await DBManager.getAllTags();
        } catch (e) {
            console.error('TagsView.load: could not load tags', e);
            if (typeof showMessage === 'function') {
                showMessage('Could not load tags — see console for details', CONSTANTS.MESSAGE_TYPES.ERROR);
            }
            this._tags = [];
        }
        this.render();
    },

    // #tagsView survives every re-render — render() only replaces
    // #tagsList's innerHTML, and the toolbar above it is never rebuilt —
    // so one listener here covers both the toolbar controls and the
    // per-row buttons. Guarded so repeat load() calls (e.g. revisiting
    // the Tags nav item) don't stack duplicate listeners.
    _bound: false,
    _bindEvents() {
        if (this._bound) return;
        const container = document.getElementById('tagsView');
        if (!container) return;
        container.addEventListener('click', (e) => {
            const btn = e.target.closest('[data-action]');
            if (!btn || !container.contains(btn)) return;
            const action = btn.dataset.action;
            if (action === 'add-tag') { TagFormModal.openAdd(); return; }
            if (action === 'toggle-sort-dir') { this.toggleSortDir(); return; }
            const item = btn.closest('.tag-item');
            const tagId = item && item.dataset.id;
            if (!tagId) return;
            if (action === 'rename') TagFormModal.openRename(tagId);
            else if (action === 'delete') TagDeleteModal.open(tagId);
        });
        const sortSelect = document.getElementById('tagsSortSelect');
        if (sortSelect) sortSelect.addEventListener('change', (e) => this.setSort(e.target.value));
        this._bound = true;
    },

    setSort(key) {
        this._sortKey = key;
        this.render();
    },

    toggleSortDir() {
        this._sortDir = this._sortDir === 'asc' ? 'desc' : 'asc';
        const btn = document.getElementById('tagsSortDirBtn');
        if (btn) btn.textContent = this._sortDir === 'asc' ? '▲' : '▼';
        this.render();
    },

    getTag(tagId) {
        return this._tags.find(t => t.id === tagId) || null;
    },

    _sorted() {
        const key = this._sortKey;
        const dir = this._sortDir === 'asc' ? 1 : -1;
        const list = this._tags.slice();
        list.sort((a, b) => {
            if (key === 'Count') {
                return ((a.Count || 0) - (b.Count || 0)) * dir;
            }
            const av = String(a[key] || '').toLowerCase();
            const bv = String(b[key] || '').toLowerCase();
            if (av < bv) return -1 * dir;
            if (av > bv) return 1 * dir;
            return 0;
        });
        return list;
    },

    render() {
        const container = document.getElementById('tagsList');
        if (!container) return;
        const sorted = this._sorted();

        if (sorted.length === 0) {
            container.innerHTML = '<p class="placeholder-content">No tags found in library</p>';
            return;
        }

        container.innerHTML = sorted.map(tag => `
            <div class="tag-item" data-id="${escapeHtml(tag.id)}">
                <span class="tag-name">${escapeHtml(tag.Name)}</span>
                <span class="tag-count">${tag.Count || 0}</span>
                <div class="tag-actions">
                    <button type="button" class="btn btn-small btn-secondary" data-action="rename">Rename</button>
                    <button type="button" class="btn btn-small btn-danger" data-action="delete">Delete</button>
                </div>
            </div>
        `).join('');
    },

    // Called after any Add/Rename/Delete. Refreshes this view, the chip-
    // input autocomplete cache, and any collection view currently loaded —
    // a rename/delete changes Tags on the shared item, visible from all
    // three. Same guarded pattern as OwnedView.refreshAll().
    async refreshAll() {
        await this.load(this.CONTAINER_ID);
        refreshLibraryTagCache();
        if (typeof ConsumedView !== 'undefined') ConsumedView.load('consumedView');
        if (typeof QueuedView !== 'undefined') QueuedView.load('queuedView');
        if (typeof OwnedView !== 'undefined') OwnedView.load('ownedView');
    }
};

window.TagsView = TagsView;
