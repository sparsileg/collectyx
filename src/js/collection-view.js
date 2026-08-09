// ── Collection view shell ────────────────────────────────────────────────────
// Shared: header (title/search/Add), quick search, list container, state
// (data array, filter, search-open). NOT shared: row layout — Books Read,
// To Be Read, and My Library each look different enough (per Stan: match
// each view's actual spec over forcing a uniform row shape) that each
// registers its own header + row renderer via registerRenderer(). This
// file owns the plumbing; {collection}-view.js owns what a row looks like
// and does.

const CollectionView = {
    _state: {},
    _renderers: {}, // collection -> { headerHtml, rowFn(record, containerId) -> html }

    registerRenderer(collection, headerHtml, rowFn) {
        this._renderers[collection] = { headerHtml, rowFn };
    },

    // Real app: sidebar.js's initSidebarChrome() sets _dateFormatCache from
    // real settings. Harness: window.__testDateFormat, set directly by the
    // test page. Checking both means this file doesn't need to differ
    // between the two.
    _dateFormatCache: null,
    _dateFormat() {
        if (typeof window !== 'undefined' && window.__testDateFormat) return window.__testDateFormat;
        return this._dateFormatCache || DateUtils.DEFAULT_FORMAT;
    },

    render(containerId, collection, data) {
        this._state[containerId] = { collection, data, filter: '', searchOpen: false };
        this._renderShell(containerId);
        this._bindEvents(containerId);
    },

    // Bound once per containerId, on the outer container — _renderShell()
    // replaces container.innerHTML on every call, which would kill any
    // listener attached to the list div or its children. The outer
    // container node itself is never replaced, so binding here survives
    // toggleSearch()/_renderRows() re-renders. Guarded so repeat render()
    // calls (e.g. a full reload) don't stack duplicate listeners.
    _boundContainers: {},
    _bindEvents(containerId) {
        if (this._boundContainers[containerId]) return;
        const container = document.getElementById(containerId);
        if (!container) return;

        container.addEventListener('click', (e) => {
            const actionEl = e.target.closest('[data-action]');
            if (actionEl && container.contains(actionEl)) {
                const action = actionEl.dataset.action;
                if (action === 'toggle-search') { this.toggleSearch(containerId); return; }
                if (action === 'add') { this.openAdd(containerId); return; }
                // Row-level action button (e.g. queued's Start Reading /
                // Finished) — resolved before row-open below, so hitting
                // a button never also opens the row.
                const row = actionEl.closest('.collection-list-row');
                const state = this._state[containerId];
                const handler = row && this._rowActionHandlers[state.collection];
                if (handler) handler(action, row.dataset.id, containerId);
                return;
            }
            // No data-action matched — a plain click anywhere else on a
            // row opens it.
            const row = e.target.closest('.collection-list-row');
            if (row && container.contains(row)) {
                const state = this._state[containerId];
                const handler = this._rowOpenHandlers[state.collection];
                if (handler) handler(row.dataset.id, containerId);
            }
        });

        container.addEventListener('input', (e) => {
            if (e.target && e.target.dataset && e.target.dataset.role === 'quick-search-input') {
                this.filter(containerId, e.target.value);
            }
        });

        this._boundContainers[containerId] = true;
    },

    _labelFor(collection) {
        if (collection === 'consumed') return MediaLabels.ConsumedLabel;
        if (collection === 'queued') return MediaLabels.QueuedLabel;
        if (collection === 'owned') return MediaLabels.OwnedLabel;
        return collection;
    },

    _renderShell(containerId) {
        const container = document.getElementById(containerId);
        if (!container) return;
        const state = this._state[containerId];
        const renderer = this._renderers[state.collection];
        if (!renderer) {
            console.error('CollectionView: no renderer registered for', state.collection);
            return;
        }

        container.innerHTML = `
            <div class="collection-view-header">
                <h2>${escapeHtml(this._labelFor(state.collection))}
                    <span class="search-icon" data-action="toggle-search">🔍</span>
                    <span class="match-count" id="${containerId}-match-count"></span>
                </h2>
                <button type="button" class="btn btn-primary collection-add-btn" data-action="add">Add</button>
            </div>
            <div class="quick-search" id="${containerId}-search" style="display: ${state.searchOpen ? 'block' : 'none'};">
                <input type="text" id="${containerId}-search-input" placeholder="Search title, author, or #tag..." value="${escapeHtml(state.filter)}"
                       data-role="quick-search-input">
            </div>
            ${renderer.headerHtml}
            <div class="collection-list" id="${containerId}-list"></div>
        `;
        this._renderRows(containerId);
    },

    _renderRows(containerId) {
        const list = document.getElementById(`${containerId}-list`);
        if (!list) return;
        const state = this._state[containerId];
        const renderer = this._renderers[state.collection];
        const q = state.filter.trim().toLowerCase();
        const isTagSearch = q.startsWith('#');
        const tagQuery = isTagSearch ? q.slice(1).trim() : '';

        const rows = state.data.filter(r => {
            if (!q) return true;
            if (isTagSearch) {
                if (!tagQuery) return true;
                return (r.Tags || []).some(t => t.toLowerCase() === tagQuery);
            }
            return (r.Title || '').toLowerCase().includes(q) || (r.Author || '').toLowerCase().includes(q);
        });

        const countEl = document.getElementById(`${containerId}-match-count`);
        if (countEl) countEl.textContent = q ? `(${rows.length} matches)` : '';

        if (rows.length === 0) {
            list.innerHTML = `<div class="collection-list-empty">${state.data.length === 0 ? 'Nothing here yet.' : 'No matches.'}</div>`;
            return;
        }

        list.innerHTML = rows.map(r => renderer.rowFn(r, containerId)).join('');
    },

    toggleSearch(containerId) {
        const state = this._state[containerId];
        if (!state) return;
        state.searchOpen = !state.searchOpen;
        if (!state.searchOpen) state.filter = '';
        this._renderShell(containerId);
        if (state.searchOpen) {
            const input = document.getElementById(`${containerId}-search-input`);
            if (input) input.focus();
        }
    },

    filter(containerId, value) {
        const state = this._state[containerId];
        if (!state) return;
        state.filter = value;
        this._renderRows(containerId);
    },

    // Each collection registers its own Add-button handler (they open
    // different modals); default here just errors loudly if one's missing
    // rather than failing silently.
    _addHandlers: {},
    registerAddHandler(collection, fn) {
        this._addHandlers[collection] = fn;
    },
    openAdd(containerId) {
        const state = this._state[containerId];
        const handler = this._addHandlers[state.collection];
        if (!handler) {
            console.error('CollectionView: no add handler registered for', state.collection);
            return;
        }
        handler(containerId);
    },

    // Row open (plain click on a row) and row action (a data-action
    // button inside a row, e.g. queued's Start Reading/Finished) differ
    // per collection the same way Add does — registered here, dispatched
    // by the delegated listener in _bindEvents().
    _rowOpenHandlers: {},
    registerRowOpenHandler(collection, fn) {
        this._rowOpenHandlers[collection] = fn;
    },
    _rowActionHandlers: {},
    registerRowActionHandler(collection, fn) {
        this._rowActionHandlers[collection] = fn;
    },

    // Called by each modal after save/delete so the list reflects changes.
    refresh(containerId) {
        this._renderRows(containerId);
    },

    getRecord(containerId, id) {
        const state = this._state[containerId];
        if (!state) return null;
        return state.data.find(r => r.id === id) || null;
    },

    getData(containerId) {
        const state = this._state[containerId];
        return state ? state.data : [];
    }
};
