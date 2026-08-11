// Tag chip-input control + shared tag helpers. Used by consumed-modal.js
// and owned-modal.js (cross-collection), not tags-view.js/tags-modal.js
// internals — kept in its own file rather than folded into either.

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

// Called from consumed-modal.js / owned-modal.js as well as tags-view.js /
// tags-modal.js — exported the same way dashboard.js/statistics.js are
// (#66 / CTX-SEC-116).
window.parseTagsFromString = parseTagsFromString;
window.tagsToString = tagsToString;
window.getAllLibraryTags = getAllLibraryTags;
window.initTagChipInput = initTagChipInput;
window.validateTagName = validateTagName;
window.tagLiveFormatError = tagLiveFormatError;
window.refreshLibraryTagCache = refreshLibraryTagCache;
