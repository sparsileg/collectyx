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
                    <span class="search-icon" onclick="CollectionView.toggleSearch('${containerId}')">🔍</span>
                </h2>
                <button type="button" class="btn btn-primary collection-add-btn" onclick="CollectionView.openAdd('${containerId}')">Add</button>
            </div>
            <div class="quick-search" id="${containerId}-search" style="display: ${state.searchOpen ? 'block' : 'none'};">
                <input type="text" id="${containerId}-search-input" placeholder="Search title, author, or #tag..." value="${escapeHtml(state.filter)}"
                       oninput="CollectionView.filter('${containerId}', this.value)">
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
                return (r.Tags || []).some(t => t.toLowerCase().includes(tagQuery));
            }
            return (r.Title || '').toLowerCase().includes(q) || (r.Author || '').toLowerCase().includes(q);
        });

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
