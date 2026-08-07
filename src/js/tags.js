// Tag management functions

function parseTagsFromString(tagString) {
    if (!tagString || typeof tagString !== 'string') return [];
    
    return tagString.split(',')
        .map(tag => tag.trim().toLowerCase())
        .filter(tag => tag.length > 0 && /^[a-z0-9_-]+$/i.test(tag))
        .filter((tag, index, arr) => arr.indexOf(tag) === index); // Remove duplicates
}

function tagsToString(tagsArray) {
    if (!Array.isArray(tagsArray)) return '';
    return tagsArray.join(', ');
}

function getAllLibraryTags() {
    return _libraryTagCache;
}

// Cache of {tagName: count}, refreshed via refreshLibraryTagCache().
// getAllLibraryTags() is called synchronously in a few places — chip-input
// autocomplete on every keystroke being the hot path — but the real data
// now lives behind DBManager.getAllTags(), which is async (IndexedDB or a
// Tauri invoke()). Re-fetching on every keystroke would be wasteful and
// slow, so this fetches once when a chip input initializes and again each
// time its modal opens (via the returned controller's refreshSuggestions()),
// with synchronous reads against whatever's cached in between.
let _libraryTagCache = {};

async function refreshLibraryTagCache() {
    try {
        const tags = await DBManager.getAllTags();
        const counts = {};
        (tags || []).forEach(t => { counts[t.Name] = t.Count || 0; });
        _libraryTagCache = counts;
    } catch (e) {
        console.error('refreshLibraryTagCache: could not load tags', e);
    }
}

// One reusable chip-based multi-tag entry control, instantiated once per
// Tags field. `ids` identifies the DOM pieces for a single instance: the
// visible text input, the suggestion dropdown, the chip row, and the
// hidden field that existing save-path code already reads tags from
// (same id/name as the old single text field, so no save-function
// changes are needed — only the population side calls setTags()).
function initTagChipInput(ids) {
    const input = document.getElementById(ids.input);
    const suggestions = document.getElementById(ids.suggestions);
    const chipRow = document.getElementById(ids.chipRow);
    const hidden = document.getElementById(ids.hidden);
    if (!input || !suggestions || !chipRow || !hidden) return null;

    // Optional — a field lacking a matching '<inputId>Error' element still
    // works, just falls back to the message bar (showError() below).
    const errorEl = document.getElementById(ids.input + 'Error');

    let tags = [];

    // Fire-and-forget — initTagChipInput() itself isn't async (core.js
    // calls it without awaiting), so the first keystroke or two might race
    // ahead of this completing. Harmless: showSuggestions() just reads
    // whatever's cached, empty object until this resolves.
    refreshLibraryTagCache();

    function syncHidden() {
        hidden.value = tags.join(', ');
    }

    function renderChips() {
        chipRow.innerHTML = tags.map((tag, i) => `
            <span class="tag-chip">
                ${escapeHtml(tag)}
                <button type="button" class="tag-chip-remove" data-i="${i}" aria-label="Remove ${escapeHtml(tag)}">&times;</button>
            </span>
        `).join('');
        syncHidden();
    }

    function hideSuggestions() {
        suggestions.style.display = 'none';
        suggestions.innerHTML = '';
    }

    // Inline, next to the field that rejected the tag — falls back to the
    // message bar for any chip input whose markup has no matching error
    // element yet.
    function showError(msg) {
        if (errorEl) {
            errorEl.textContent = msg;
            errorEl.style.display = 'block';
        } else {
            showMessage(msg, CONSTANTS.MESSAGE_TYPES.ERROR);
        }
    }

    function clearError() {
        if (errorEl) {
            errorEl.textContent = '';
            errorEl.style.display = 'none';
        }
    }

    function showSuggestions() {
        const val = input.value.trim().toLowerCase();
        if (!val) { hideSuggestions(); return; }
        const allTags = Object.keys(getAllLibraryTags()).sort();
        const matches = allTags.filter(t => t.includes(val) && !tags.includes(t)).slice(0, 8);
        if (matches.length === 0) { hideSuggestions(); return; }
        suggestions.innerHTML = matches.map(t =>
            `<div class="tag-chip-suggestion" data-tag="${escapeHtml(t)}">${escapeHtml(t)}</div>`
        ).join('');
        suggestions.style.display = 'block';
    }

    function addTag(rawTag) {
        // Duplicate check is scoped to tags already added to this chip
        // row, not the global vocabulary — a tag existing elsewhere in
        // the library is exactly what we want to add, not reject.
        const currentAsMap = {};
        tags.forEach(t => currentAsMap[t] = true);
        const validation = validateTagName(rawTag, currentAsMap);

        if (!validation.valid) {
            if (!validation.isDuplicate && rawTag && rawTag.trim()) {
                showError(validation.message);
            }
            input.value = '';
            hideSuggestions();
            return;
        }

        clearError();
        tags.push(validation.cleanTag);
        renderChips();
        input.value = '';
        hideSuggestions();
    }

    function removeTag(index) {
        tags.splice(index, 1);
        renderChips();
    }

    input.addEventListener('input', () => {
        const liveError = tagLiveFormatError(input.value);
        if (liveError) showError(liveError); else clearError();
        showSuggestions();
    });
    input.addEventListener('keydown', event => {
        if (event.key === 'Enter' || event.key === ',') {
            event.preventDefault();
            addTag(input.value);
        }
    });
    input.addEventListener('blur', () => {
        // Delay so a suggestion click still registers before the dropdown closes
        setTimeout(hideSuggestions, 150);
    });

    suggestions.addEventListener('click', event => {
        const item = event.target.closest('[data-tag]');
        if (item) addTag(item.dataset.tag);
    });

    chipRow.addEventListener('click', event => {
        const btn = event.target.closest('.tag-chip-remove');
        if (btn) removeTag(parseInt(btn.dataset.i));
    });

    return {
        setTags(newTags) {
            tags = Array.isArray(newTags) ? [...newTags] : [];
            clearError();
            renderChips();
        },
        getTags() {
            return [...tags];
        },
        // Called by each modal's open() — keeps autocomplete current with
        // tags created in earlier saves this session, not just whatever
        // existed when the page first loaded.
        refreshSuggestions() {
            refreshLibraryTagCache();
        }
    };
}

function validateTagName(tagName, existingTags, originalTag = null) {
    if (!tagName || typeof tagName !== 'string') {
        return { valid: false, message: 'Tag name cannot be empty' };
    }
    
    const cleanTag = tagName.trim().toLowerCase();
    
    if (!/^[a-z0-9_-]+$/i.test(cleanTag)) {
        return { valid: false, message: 'Tags can only contain letters, numbers, hyphens, and underscores' };
    }
    
    if (cleanTag !== originalTag && existingTags.hasOwnProperty(cleanTag)) {
        return { valid: false, message: 'Tag already exists', isDuplicate: true, existingTag: cleanTag };
    }
    
    return { valid: true, cleanTag };
}

// Per-keystroke check, separate from validateTagName's commit-time check
// (which trims before validating, so a stray leading/trailing space isn't
// an error there). This flags a space the instant it's typed, anywhere in
// the field — that's the one a user can't otherwise tell caused the
// rejection. Returns the message to show, or null if there's nothing to
// flag yet.
function tagLiveFormatError(rawValue) {
    if (!rawValue) return null;
    if (/\s/.test(rawValue)) {
        return 'Tags can only contain letters, numbers, hyphens, and underscores — no spaces';
    }
    return null;
}

// ── Tags CRUD view (Phase 7, design doc §4.6) ───────────────────────────────
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

// One modal, two modes — Add (blank) and Rename (prefilled). Reuses
// validateTagName so standalone-created tags follow the same format rule
// as chip-input-created ones (lowercase, a-z0-9_- only).
const TagFormModal = {
    _mode: 'add',
    _tagId: null,
    _wired: false,

    // Attached once, lazily — every element here exists in the DOM from
    // page load and is never rebuilt, so there's nothing to re-wire per
    // open() call.
    _bindEvents() {
        if (this._wired) return;
        this._wired = true;
        const nameInput = document.getElementById('tagFormName');
        if (nameInput) {
            nameInput.addEventListener('input', (event) => {
                const liveError = tagLiveFormatError(event.target.value);
                if (liveError) this._showError(liveError); else this._clearError();
            });
        }
        const form = document.getElementById('tagFormForm');
        if (form) form.addEventListener('submit', (event) => this.save(event));
        const modal = document.getElementById('tagFormModal');
        if (modal) {
            modal.addEventListener('click', (event) => {
                const btn = event.target.closest('[data-action]');
                if (!btn || !modal.contains(btn)) return;
                if (btn.dataset.action === 'close') this.close();
            });
        }
    },

    _showError(msg) {
        const errorEl = document.getElementById('tagFormNameError');
        if (errorEl) { errorEl.textContent = msg; errorEl.style.display = 'block'; }
    },

    _clearError() {
        const errorEl = document.getElementById('tagFormNameError');
        if (errorEl) { errorEl.textContent = ''; errorEl.style.display = 'none'; }
    },

    openAdd() {
        this._bindEvents();
        this._mode = 'add';
        this._tagId = null;
        document.getElementById('tagFormModalTitle').textContent = 'Add Tag';
        document.getElementById('tagFormName').value = '';
        this._clearError();
        document.getElementById('tagFormModal').classList.add('open');
    },

    openRename(tagId) {
        this._bindEvents();
        const tag = TagsView.getTag(tagId);
        if (!tag) return;
        this._mode = 'rename';
        this._tagId = tagId;
        document.getElementById('tagFormModalTitle').textContent = 'Rename Tag';
        document.getElementById('tagFormName').value = tag.Name;
        this._clearError();
        document.getElementById('tagFormModal').classList.add('open');
    },

    close() {
        document.getElementById('tagFormModal').classList.remove('open');
    },

    async save(event) {
        event.preventDefault();

        const originalName = this._mode === 'rename'
            ? ((TagsView.getTag(this._tagId) || {}).Name || null)
            : null;

        const existingMap = {};
        TagsView._tags.forEach(t => {
            if (this._mode === 'rename' && t.id === this._tagId) return;
            existingMap[t.Name] = true;
        });

        const validation = validateTagName(document.getElementById('tagFormName').value, existingMap, originalName);
        if (!validation.valid) {
            showMessage(validation.message, CONSTANTS.MESSAGE_TYPES.ERROR);
            this._showError(validation.message);
            return;
        }

        const payload = { Name: validation.cleanTag };
        if (this._mode === 'rename' && this._tagId) payload.id = this._tagId;

        try {
            await DBManager.saveTag(payload);
            this.close();
            showMessage(this._mode === 'rename' ? 'Tag renamed' : 'Tag added', CONSTANTS.MESSAGE_TYPES.SUCCESS);
            await TagsView.refreshAll();
        } catch (e) {
            console.error('TagFormModal.save failed', e);
            showMessage(e && e.message ? e.message : 'Could not save tag — see console for details', CONSTANTS.MESSAGE_TYPES.ERROR);
        }
    }
};

// Delete-from-the-system, with an optional substitute tag (design doc
// §4.6). Deleting a single book's tag stays in that collection's own Edit
// modal — this always removes the tag entirely.
const TagDeleteModal = {
    _tagId: null,
    _wired: false,

    _bindEvents() {
        if (this._wired) return;
        this._wired = true;
        const modal = document.getElementById('tagDeleteModal');
        if (!modal) return;
        modal.addEventListener('click', (event) => {
            const btn = event.target.closest('[data-action]');
            if (!btn || !modal.contains(btn)) return;
            const action = btn.dataset.action;
            if (action === 'confirm') this.confirm();
            else if (action === 'close') this.close();
        });
    },

    open(tagId) {
        this._bindEvents();
        const tag = TagsView.getTag(tagId);
        if (!tag) return;
        this._tagId = tagId;

        document.getElementById('tagDeleteName').textContent = tag.Name;
        document.getElementById('tagDeleteCount').textContent = tag.Count || 0;

        const select = document.getElementById('tagDeleteSubstitute');
        const others = TagsView._tags
            .filter(t => t.id !== tagId)
            .slice()
            .sort((a, b) => a.Name.localeCompare(b.Name));
        select.innerHTML = '<option value="">No substitute</option>' +
            others.map(t => `<option value="${t.id}">${escapeHtml(t.Name)}</option>`).join('');
        select.value = '';

        document.getElementById('tagDeleteModal').classList.add('open');
    },

    close() {
        document.getElementById('tagDeleteModal').classList.remove('open');
    },

    async confirm() {
        if (!this._tagId) return;
        const substituteId = document.getElementById('tagDeleteSubstitute').value || null;

        try {
            const affected = await DBManager.deleteTag(this._tagId, substituteId);
            this.close();
            showMessage(`Tag deleted, removed from ${affected} book(s)`, CONSTANTS.MESSAGE_TYPES.SUCCESS);
            await TagsView.refreshAll();
        } catch (e) {
            console.error('TagDeleteModal.confirm failed', e);
            showMessage(e && e.message ? e.message : 'Could not delete tag — see console for details', CONSTANTS.MESSAGE_TYPES.ERROR);
        }
    }
};


