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
    _page: 0,

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
            if (action === 'prev-page') { this.prevPage(); return; }
            if (action === 'next-page') { this.nextPage(); return; }
            if (action === 'page-start') { this.pageStart(); return; }
            if (action === 'page-end') { this.pageEnd(); return; }
            const item = btn.closest('.tag-item');
            const tagId = item && item.dataset.id;
            if (!tagId) return;
            if (action === 'rename') TagFormModal.openRename(tagId);
            else if (action === 'delete') TagDeleteModal.open(tagId);
        });
        const sortSelect = document.getElementById('tagsSortSelect');
        if (sortSelect) sortSelect.addEventListener('change', (e) => this.setSort(e.target.value));

        // Slider: live label update on 'input' (drag), actual page
        // change on 'change' (drag release) — same split CollectionView
        // uses, avoids re-rendering the whole tag list on every pixel of
        // drag.
        container.addEventListener('input', (e) => {
            if (e.target && e.target.dataset && e.target.dataset.role === 'page-slider') {
                const numEl = container.querySelector('[data-role="page-slider-num"]');
                if (numEl) numEl.textContent = e.target.value;
            }
        });
        container.addEventListener('change', (e) => {
            if (e.target && e.target.dataset && e.target.dataset.role === 'page-slider') {
                this.goToPage(parseInt(e.target.value, 10) - 1);
            }
        });

        this._bound = true;
    },

    setSort(key) {
        this._sortKey = key;
        this._page = 0;
        this.render();
    },

    toggleSortDir() {
        this._sortDir = this._sortDir === 'asc' ? 'desc' : 'asc';
        const btn = document.getElementById('tagsSortDirBtn');
        if (btn) btn.textContent = this._sortDir === 'asc' ? '▲' : '▼';
        this._page = 0;
        this.render();
    },

    prevPage() {
        if (this._page <= 0) return;
        this._page -= 1;
        this.render();
        const list = document.getElementById('tagsList');
        if (list) list.scrollTop = 0;
    },

    nextPage() {
        this._page += 1; // clamped against totalPages inside render()
        this.render();
        const list = document.getElementById('tagsList');
        if (list) list.scrollTop = 0;
    },

    // Jump size for << / >> — meant to move by roughly total-tags/20
    // *tags*, not pages. Was previously treating the tag count as a page
    // count directly, jumping far too many pages per press. Correct
    // version: total-tags/20 converted to a page count via page size.
    // (Superseded — the </> big-jump buttons this fed are gone, replaced
    // by the slider in CollectionView.pagerHtml(). goToPage() below is
    // the direct-jump path now.)

    pageStart() {
        if (this._page <= 0) return;
        this._page = 0;
        this.render();
        const list = document.getElementById('tagsList');
        if (list) list.scrollTop = 0;
    },

    pageEnd() {
        this._page = Number.MAX_SAFE_INTEGER; // clamped inside render()
        this.render();
        const list = document.getElementById('tagsList');
        if (list) list.scrollTop = 0;
    },

    // Direct jump — the slider's 'change' handler (drag release).
    goToPage(pageIndex) {
        this._page = pageIndex; // clamped inside render()
        this.render();
        const list = document.getElementById('tagsList');
        if (list) list.scrollTop = 0;
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

        // Pager (#47) — shares CollectionView's getRecordsPerPage()/
        // pagerHtml() rather than a second copy of the same logic; one
        // setting, one implementation, used by both.
        const pageSize = CollectionView.getRecordsPerPage();
        let pageTags = sorted;
        let totalPages = 1;
        if (pageSize > 0 && sorted.length > pageSize) {
            totalPages = Math.ceil(sorted.length / pageSize);
            if (this._page >= totalPages) this._page = totalPages - 1;
            if (this._page < 0) this._page = 0;
            const start = this._page * pageSize;
            pageTags = sorted.slice(start, start + pageSize);
        } else {
            this._page = 0;
        }

        // Pager rendered first (Stan: top of the list, not bottom).
        container.innerHTML = CollectionView.pagerHtml(this._page, totalPages) + pageTags.map(tag => `
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
