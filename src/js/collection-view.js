// ── Collection view shell ────────────────────────────────────────────────────
// Shared: header (title/search/Add), quick search, list container, state
// (data array, filter, search-open). NOT shared: row layout — Books Read,
// To Be Read, and My Library each look different enough (per Stan: match
// each view's actual spec over forcing a uniform row shape) that each
// registers its own header + row renderer via registerRenderer(). This
// file owns the plumbing; {collection}-view.js owns what a row looks like
// and does.
//
// Advanced filter panel (issue #49): a collection optionally registers a
// field set via registerFilterFields(). Registered collections (Books
// Read, My Library) get a filter icon in the header alongside search;
// unregistered ones (To Be Read) don't. Field/operator/value shape is
// modeled on Scriptum's read-books.js filter panel, generalized into a
// declarative field-definition list per collection instead of one
// hardcoded switch per view.
//
// Filtering is live, not Apply-gated: every row in state.filterRows with
// a field+operator set contributes to the result set as soon as its
// value is known. Select-type values (Tag/Rating/CheckedOut, and field/
// operator pickers themselves) re-filter immediately on change; free-text
// and number values debounce ~300ms so a keystroke doesn't refilter the
// whole list. There is no separate "applied" copy of the filters — what's
// in the panel IS what's active, which is also why Clear Filters and Hide
// are two different actions now instead of one.

const CollectionView = {
    _state: {},
    _renderers: {}, // collection -> { headerHtml, rowFn(record, containerId) -> html }
    _filterFieldSets: {}, // collection -> [ fieldDef, ... ]

    registerRenderer(collection, headerHtml, rowFn) {
        this._renderers[collection] = { headerHtml, rowFn };
    },

    // fields: [{ key, label, operators: [{ key, label, valueType, fixedValue }] }]
    // valueType one of: 'none' | 'text' | 'number' | 'dateRange' | 'tagSelect'
    //                  | 'ratingSelect' | 'checkedOutSelect' | 'fixedNumber'
    registerFilterFields(collection, fields) {
        this._filterFieldSets[collection] = fields;
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

    // First mount (nav click into a view with no state yet) creates fresh
    // state. A reload of an already-mounted container (post-mutation calls
    // like OwnedView.confirmCheckout/checkIn/refreshAll, QueuedView's
    // toggle/markFinished) only swaps state.data in place — filter,
    // searchOpen, filterRows, and filterPanelOpen all survive, so an
    // active search/filter is not lost by an unrelated row action (#49).
    render(containerId, collection, data) {
        const existing = this._state[containerId];
        if (existing && existing.collection === collection) {
            existing.data = data;
        } else {
            this._state[containerId] = {
                collection, data, filter: '', searchOpen: false,
                filterRows: [], filterPanelOpen: false
            };
        }
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
                if (action === 'toggle-filter') { this.toggleFilterPanel(containerId); return; }
                if (action === 'add-filter-row') { this.addFilterRow(containerId); return; }
                if (action === 'remove-filter-row') { this.removeFilterRow(containerId, parseInt(actionEl.dataset.rowIndex, 10)); return; }
                if (action === 'clear-filters') { this.clearFilters(containerId); return; }
                if (action === 'close-filter-panel') { this.closeFilterPanel(containerId); return; }
                if (action === 'noop') { return; }
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
            const role = e.target && e.target.dataset && e.target.dataset.role;
            if (role === 'quick-search-input') { this.filter(containerId, e.target.value); return; }
            if (role === 'filter-value-input') { this._captureFilterValueDebounced(containerId, e.target); return; }
        });

        container.addEventListener('change', (e) => {
            const role = e.target && e.target.dataset && e.target.dataset.role;
            if (role === 'filter-field') { this._onFilterFieldChange(containerId, e.target); return; }
            if (role === 'filter-operator') { this._onFilterOperatorChange(containerId, e.target); return; }
            if (role === 'filter-value-input') { this._captureFilterValueImmediate(containerId, e.target); return; }
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
        const hasFilters = !!this._filterFieldSets[state.collection];

        // Preserve scroll position across a reload — this rebuilds the
        // whole subtree including the scrollable .collection-list div
        // (a brand new element defaults to scrollTop 0), which otherwise
        // snapped a scrolled list back to the top after every save/delete/
        // row action, even ones that don't change the filtered result set
        // (e.g. editing a tag on a book mid-list while a search is active).
        const existingList = document.getElementById(`${containerId}-list`);
        const savedScrollTop = existingList ? existingList.scrollTop : 0;

        container.innerHTML = `
            <div class="collection-view-header">
                <h2>${escapeHtml(this._labelFor(state.collection))}
                    <span class="search-icon" data-action="toggle-search">🔍</span>
                    ${hasFilters ? `<span class="filter-icon" data-action="toggle-filter" title="Advanced filters">▤</span>` : ''}
                </h2>
                <button type="button" class="btn btn-primary collection-add-btn" data-action="add">Add</button>
            </div>
            <div class="quick-search" id="${containerId}-search" style="display: ${state.searchOpen ? 'block' : 'none'};">
                <input type="text" id="${containerId}-search-input" placeholder="Search title, author, or #tag..." value="${escapeHtml(state.filter)}"
                       data-role="quick-search-input">
            </div>
            ${hasFilters ? `<div class="filter-panel" id="${containerId}-filterpanel" style="display: ${state.filterPanelOpen ? 'block' : 'none'};">${this._filterPanelHtml(containerId)}</div>` : ''}
            ${renderer.headerHtml}
            <div class="collection-list" id="${containerId}-list"></div>
        `;
        this._renderRows(containerId);

        if (savedScrollTop) {
            const newList = document.getElementById(`${containerId}-list`);
            if (newList) newList.scrollTop = savedScrollTop;
        }
    },

    // ── Advanced filter panel ────────────────────────────────────────────────

    _filterPanelHtml(containerId) {
        const state = this._state[containerId];
        const fields = this._filterFieldSets[state.collection] || [];
        const rowsHtml = state.filterRows.map((row, i) => this._filterRowHtml(containerId, fields, row, i)).join('');
        return `
            ${rowsHtml}
            <div class="filter-panel-actions">
                <button type="button" class="btn btn-secondary" data-action="add-filter-row">Add Filter</button>
                <button type="button" class="btn btn-secondary" data-action="clear-filters">Clear Filters</button>
                <button type="button" class="btn btn-secondary" data-action="close-filter-panel">Hide</button>
            </div>
        `;
    },

    _fieldDef(containerId, fieldKey) {
        const state = this._state[containerId];
        const fields = this._filterFieldSets[state.collection] || [];
        return fields.find(f => f.key === fieldKey) || null;
    },

    _filterRowHtml(containerId, fields, row, rowIndex) {
        const fieldDef = fields.find(f => f.key === row.field) || null;
        const operators = fieldDef ? fieldDef.operators : [];
        const operatorDef = fieldDef ? operators.find(o => o.key === row.operator) : null;

        const fieldOptions = ['<option value="">Select Field</option>']
            .concat(fields.map(f => `<option value="${escapeHtml(f.key)}"${f.key === row.field ? ' selected' : ''}>${escapeHtml(f.label)}</option>`))
            .join('');

        const operatorOptions = ['<option value="">Select Operator</option>']
            .concat(operators.map(o => `<option value="${escapeHtml(o.key)}"${o.key === row.operator ? ' selected' : ''}>${escapeHtml(o.label)}</option>`))
            .join('');

        return `
            <div class="filter-row" data-row-index="${rowIndex}">
                <select class="filter-field" data-role="filter-field" data-row-index="${rowIndex}">${fieldOptions}</select>
                <select class="filter-operator" data-role="filter-operator" data-row-index="${rowIndex}" ${fieldDef ? '' : 'disabled'}>${operatorOptions}</select>
                <div class="filter-value">${operatorDef ? this._filterValueHtml(rowIndex, operatorDef, row.values) : ''}</div>
                <button type="button" class="btn btn-danger" data-action="remove-filter-row" data-row-index="${rowIndex}">Remove</button>
            </div>
        `;
    },

    _filterValueHtml(rowIndex, operatorDef, values) {
        const v = (i) => escapeHtml((values && values[i] != null) ? values[i] : '');
        switch (operatorDef.valueType) {
        case 'none':
            return '';
        case 'text':
        case 'number':
            return `<input type="text" class="filter-value-input" data-role="filter-value-input" data-row-index="${rowIndex}" data-value-index="0" value="${v(0)}" placeholder="Enter value">`;
        case 'dateRange': {
            const format = this._dateFormat();
            const ph = DateUtils.placeholderFor(format);
            return `
                <div class="date-range">
                    <input type="text" class="filter-value-input" data-role="filter-value-input" data-row-index="${rowIndex}" data-value-index="0" value="${v(0)}" placeholder="${escapeHtml(ph)}" maxlength="10">
                    <span>to</span>
                    <input type="text" class="filter-value-input" data-role="filter-value-input" data-row-index="${rowIndex}" data-value-index="1" value="${v(1)}" placeholder="${escapeHtml(ph)}" maxlength="10">
                </div>
            `;
        }
        case 'tagSelect': {
            const opts = ['<option value="">Select Tag</option>']
                .concat(this._allTagsFor(rowIndex).map(t => `<option value="${escapeHtml(t)}"${values && values[0] === t ? ' selected' : ''}>${escapeHtml(t)}</option>`))
                .join('');
            return `<select class="filter-value-input" data-role="filter-value-input" data-row-index="${rowIndex}" data-value-index="0">${opts}</select>`;
        }
        case 'ratingSelect': {
            // Hardcoded rather than sourced from RatingUtils — its exact
            // internal API (property name, ordering) isn't something this
            // file should assume. Word map matches #76's design-doc
            // correction: 1=Skip, 2=Okay, 3=Good, 4=Excellent, 5=Essential.
            const ratingWords = ['Skip', 'Okay', 'Good', 'Excellent', 'Essential'];
            const opts = ['<option value="">Select Rating</option>']
                .concat(ratingWords.map((word, i) => {
                    const n = i + 1;
                    return `<option value="${n}"${values && values[0] === String(n) ? ' selected' : ''}>${n} - ${escapeHtml(word)}</option>`;
                })).join('');
            return `<select class="filter-value-input" data-role="filter-value-input" data-row-index="${rowIndex}" data-value-index="0">${opts}</select>`;
        }
        case 'checkedOutSelect': {
            const opts = [
                { val: 'available', label: 'Available' },
                { val: 'checkedout', label: 'Checked Out' }
            ].map(o => `<option value="${o.val}"${values && values[0] === o.val ? ' selected' : ''}>${o.label}</option>`).join('');
            return `<select class="filter-value-input" data-role="filter-value-input" data-row-index="${rowIndex}" data-value-index="0"><option value="">Select</option>${opts}</select>`;
        }
        case 'fixedNumber':
            return `<input type="text" class="filter-value-input" value="${escapeHtml(String(operatorDef.fixedValue))}" readonly>`;
        default:
            return '';
        }
    },

    // Tag options come from the collection's own loaded data (already
    // in memory), not a fresh DBManager.getAllTags() call — this stays
    // synchronous, and the tags offered are exactly the ones that could
    // actually match something in this list.
    _allTagsFor(rowIndex) {
        // rowIndex unused for now — kept as a parameter in case a future
        // per-row scoping need arises; tag pool is per-container, not
        // per-row.
        return this._currentTagPool || [];
    },

    toggleFilterPanel(containerId) {
        const state = this._state[containerId];
        if (!state) return;
        state.filterPanelOpen = !state.filterPanelOpen;
        // No "applied vs draft" split anymore — filterRows persists as-is
        // across hide/show. Only seed an empty row the first time there's
        // nothing there yet.
        if (state.filterPanelOpen && state.filterRows.length === 0) {
            state.filterRows = [{ field: '', operator: '', values: [] }];
        }
        this._refreshTagPool(containerId);
        this._renderShell(containerId);
    },

    closeFilterPanel(containerId) {
        const state = this._state[containerId];
        if (!state) return;
        state.filterPanelOpen = false;
        this._renderShell(containerId);
    },

    addFilterRow(containerId) {
        const state = this._state[containerId];
        if (!state) return;
        state.filterRows.push({ field: '', operator: '', values: [] });
        this._renderShell(containerId);
    },

    removeFilterRow(containerId, rowIndex) {
        const state = this._state[containerId];
        if (!state) return;
        state.filterRows.splice(rowIndex, 1);
        this._renderShell(containerId);
    },

    // Picking a field auto-selects a sensible default operator (Stan's
    // per-field spec) instead of leaving "Select Operator" blank — one
    // less click for the common case, still fully overridable via the
    // operator dropdown.
    _defaultOperatorByField: {
        Finished: 'between',
        Title: 'contains',
        Author: 'contains',
        Pages: 'gte',
        Tag: 'equals',
        Rating: 'gte',
        ISBN: 'isEmpty',
        MultipleReads: 'gte',
        Location: 'contains',
        Patron: 'isNotEmpty',
        CheckedOut: 'equals'
    },

    // fixedNumber (MultipleReads' "2") and defaultValues (CheckedOut's
    // "Checked Out") both need a starting value the moment the operator
    // is known — either auto-selected via the field's default, or picked
    // manually from the operator dropdown.
    _defaultValuesFor(operatorDef) {
        if (!operatorDef) return [];
        if (operatorDef.valueType === 'fixedNumber') return [String(operatorDef.fixedValue)];
        if (operatorDef.defaultValues) return [...operatorDef.defaultValues];
        return [];
    },

    _onFilterFieldChange(containerId, selectEl) {
        const state = this._state[containerId];
        if (!state) return;
        const rowIndex = parseInt(selectEl.dataset.rowIndex, 10);
        const fieldKey = selectEl.value;
        const fieldDef = this._fieldDef(containerId, fieldKey);
        const defaultOperatorKey = this._defaultOperatorByField[fieldKey] || '';
        const operatorDef = fieldDef && defaultOperatorKey
            ? fieldDef.operators.find(o => o.key === defaultOperatorKey)
            : null;
        state.filterRows[rowIndex] = {
            field: fieldKey,
            operator: operatorDef ? operatorDef.key : '',
            values: this._defaultValuesFor(operatorDef)
        };
        this._renderShell(containerId);
    },

    _onFilterOperatorChange(containerId, selectEl) {
        const state = this._state[containerId];
        if (!state) return;
        const rowIndex = parseInt(selectEl.dataset.rowIndex, 10);
        const row = state.filterRows[rowIndex];
        if (!row) return;
        row.operator = selectEl.value;
        const fieldDef = this._fieldDef(containerId, row.field);
        const operatorDef = fieldDef ? fieldDef.operators.find(o => o.key === row.operator) : null;
        row.values = this._defaultValuesFor(operatorDef);
        this._renderShell(containerId);
    },

    // Text/number/date keystrokes: capture the value, then debounce the
    // re-filter (~300ms) so every keystroke doesn't re-scan the list.
    // Rebuilding the whole shell here would drop focus mid-type, so this
    // only triggers _renderRows, never _renderShell.
    _filterDebounceTimers: {},
    _captureFilterValueDebounced(containerId, inputEl) {
        this._captureFilterValue(containerId, inputEl);
        clearTimeout(this._filterDebounceTimers[containerId]);
        this._filterDebounceTimers[containerId] = setTimeout(() => {
            this._renderRows(containerId);
        }, 300);
    },

    // Select-type values (Tag/Rating/CheckedOut) are discrete picks, not
    // keystrokes — no debounce, and any pending debounced re-filter from a
    // sibling text field is cancelled so it doesn't fire a stale render
    // right after this one.
    _captureFilterValueImmediate(containerId, inputEl) {
        this._captureFilterValue(containerId, inputEl);
        clearTimeout(this._filterDebounceTimers[containerId]);
        this._renderRows(containerId);
    },

    _captureFilterValue(containerId, inputEl) {
        const state = this._state[containerId];
        if (!state) return;
        const rowIndex = parseInt(inputEl.dataset.rowIndex, 10);
        const valueIndex = parseInt(inputEl.dataset.valueIndex, 10);
        const row = state.filterRows[rowIndex];
        if (!row) return;
        row.values[valueIndex] = inputEl.value;
    },

    clearFilters(containerId) {
        const state = this._state[containerId];
        if (!state) return;
        clearTimeout(this._filterDebounceTimers[containerId]);
        state.filterRows = [{ field: '', operator: '', values: [] }];
        state.filter = '';
        state.searchOpen = false;
        // Panel visibility is untouched — Clear Filters resets the
        // criteria back to native (no filters active), not the panel's
        // open/closed state. Hide is the only action that closes it.
        this._renderShell(containerId);
        showMessage('No filters', CONSTANTS.MESSAGE_TYPES.INFO);
    },

    _refreshTagPool(containerId) {
        const state = this._state[containerId];
        if (!state) return;
        const tagSet = new Set();
        state.data.forEach(r => (r.Tags || []).forEach(t => tagSet.add(t)));
        this._currentTagPool = Array.from(tagSet).sort();
    },

    // ── Per-field matchers for the advanced filter panel ─────────────────────
    // One entry per registered field key. Each returns a boolean given the
    // record, the applied operator, its values, and (only MultipleReads
    // needs it) the full unfiltered dataset for duplicate counting.

    _fieldMatchers: {
        Finished(record, operator, values) {
            if (operator === 'isEmpty') return !record.Finished;
            if (operator === 'between') {
                if (!values[0] || !values[1]) return true;
                const format = CollectionView._dateFormat();
                const from = DateUtils.parseDateInput(values[0], format);
                const to = DateUtils.parseDateInput(values[1], format);
                if (!from || !to || !record.Finished) return false;
                return record.Finished >= from && record.Finished <= to;
            }
            return true;
        },
        Title(record, operator, values) {
            if (operator === 'isEmpty') return !record.Title;
            if (operator === 'contains') return CollectionView._matchesTokenizedText(record.Title, values[0]);
            return true;
        },
        Author(record, operator, values) {
            const combined = `${record.Author || ''} ${record.Author2 || ''}`;
            if (operator === 'isEmpty') return !record.Author && !record.Author2;
            if (operator === 'contains') return CollectionView._matchesTokenizedText(combined, values[0]);
            return true;
        },
        Pages(record, operator, values) {
            if (operator === 'isEmpty') return record.Pages == null;
            if (record.Pages == null) return false;
            const n = parseInt(values[0], 10);
            if (isNaN(n)) return true;
            if (operator === 'gte') return record.Pages >= n;
            if (operator === 'lt') return record.Pages < n;
            return true;
        },
        Tag(record, operator, values) {
            const tags = record.Tags || [];
            if (operator === 'isEmpty') return tags.length === 0;
            if (operator === 'equals') return !!values[0] && tags.includes(values[0]);
            return true;
        },
        Rating(record, operator, values) {
            if (operator === 'isEmpty') return record.Rating == null;
            if (record.Rating == null) return false;
            const n = parseInt(values[0], 10);
            if (isNaN(n)) return true;
            if (operator === 'equals') return record.Rating === n;
            if (operator === 'gte') return record.Rating >= n;
            if (operator === 'lt') return record.Rating < n;
            return true;
        },
        ISBN(record, operator) {
            if (operator === 'isEmpty') return !record.ISBN;
            return true;
        },
        MultipleReads(record, operator, values, fullData) {
            if (operator !== 'gte') return true;
            const n = parseInt(values[0], 10) || 2;
            const key = CollectionView._normalizeKey(record.Title, record.Author);
            const count = fullData.filter(r => CollectionView._normalizeKey(r.Title, r.Author) === key).length;
            return count >= n;
        },
        Location(record, operator, values) {
            if (operator === 'isEmpty') return !record.Location;
            if (operator === 'contains') return CollectionView._matchesTokenizedText(record.Location, values[0]);
            return true;
        },
        Patron(record, operator, values) {
            if (operator === 'isEmpty') return !record.Patron;
            if (operator === 'isNotEmpty') return !!record.Patron;
            if (operator === 'contains') return CollectionView._matchesTokenizedText(record.Patron, values[0]);
            return true;
        },
        CheckedOut(record, operator, values) {
            if (operator !== 'equals') return true;
            const isCheckedOut = !!record.CheckedOutDate;
            if (values[0] === 'available') return !isCheckedOut;
            if (values[0] === 'checkedout') return isCheckedOut;
            return true;
        }
    },

    _normalizeKey(title, author) {
        return `${(title || '').trim().toLowerCase()}|${(author || '').trim().toLowerCase()}`;
    },

    // Space-separated words are an implicit AND, order-independent — "work
    // marvelous" and "marvelous work" both match a book titled "Marvelous
    // Work". A single- or double-quoted run is kept as one exact-substring
    // token instead of being split on its internal spaces. Used by both
    // the quick search box and every "contains" advanced-filter matcher,
    // so the two behave the same way.
    _tokenizeQuery(q) {
        const tokens = [];
        const re = /"([^"]+)"|'([^']+)'|(\S+)/g;
        let m;
        while ((m = re.exec(q)) !== null) {
            const token = (m[1] || m[2] || m[3] || '').toLowerCase();
            if (token) tokens.push(token);
        }
        return tokens;
    },

    _matchesTokenizedText(haystack, query) {
        const tokens = this._tokenizeQuery(query || '');
        if (!tokens.length) return true;
        const h = (haystack || '').toLowerCase();
        return tokens.every(t => h.includes(t));
    },

    _matchesAdvancedFilters(record, filters, fullData) {
        if (!filters.length) return true;
        return filters.every(f => {
            const matcher = this._fieldMatchers[f.field];
            if (!matcher) return true;
            return matcher(record, f.operator, f.values, fullData);
        });
    },

    // ── Row rendering / quick search ──────────────────────────────────────────

    _renderRows(containerId) {
        const list = document.getElementById(`${containerId}-list`);
        if (!list) return;
        const state = this._state[containerId];
        const renderer = this._renderers[state.collection];
        const q = state.filter.trim().toLowerCase();
        const isTagSearch = q.startsWith('#');
        const tagQuery = isTagSearch ? q.slice(1).trim() : '';
        // Only rows with both a field and an operator picked contribute —
        // a row still missing one (mid-edit) is silently ignored rather
        // than matching everything or nothing.
        const advanced = (state.filterRows || []).filter(r => r.field && r.operator);

        const rows = state.data.filter(r => {
            if (q) {
                if (isTagSearch) {
                    if (tagQuery && !(r.Tags || []).some(t => t.toLowerCase() === tagQuery)) return false;
                } else {
                    const combined = `${r.Title || ''} ${r.Author || ''} ${r.Author2 || ''}`;
                    if (!this._matchesTokenizedText(combined, q)) return false;
                }
            }
            return this._matchesAdvancedFilters(r, advanced, state.data);
        });

        // Routed through the normal status message, not a dedicated
        // element — a search's match count is just another status
        // message; it gets overwritten by the next save/delete message
        // and auto-dismisses after 60s like anything else shown here.
        if (q || advanced.length) {
            const n = rows.length;
            showMessage(`${n} match${n === 1 ? '' : 'es'}`, CONSTANTS.MESSAGE_TYPES.INFO);
        }

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

window.CollectionView = CollectionView;
