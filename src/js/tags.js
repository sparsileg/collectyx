// Tag management functions

// Registry of collections that support tags. Add an entry here (rather
// than duplicating rename/delete logic per collection) whenever a new
// collection gains Tags support.
const TAGGABLE_COLLECTIONS = [
    { getItems: () => myLibrary, save: () => saveMyLibraryData() },
    { getItems: () => books, save: () => saveData() }
];

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
    const tagCounts = {};

    TAGGABLE_COLLECTIONS.forEach(collection => {
        collection.getItems().forEach(book => {
            if (book.Tags && Array.isArray(book.Tags)) {
                book.Tags.forEach(tag => {
                    tagCounts[tag] = (tagCounts[tag] || 0) + 1;
                });
            }
        });
    });

    return tagCounts;
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

    let tags = [];

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
                showMessage(validation.message, CONSTANTS.MESSAGE_TYPES.ERROR);
            }
            input.value = '';
            hideSuggestions();
            return;
        }

        tags.push(validation.cleanTag);
        renderChips();
        input.value = '';
        hideSuggestions();
    }

    function removeTag(index) {
        tags.splice(index, 1);
        renderChips();
    }

    input.addEventListener('input', showSuggestions);
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
            renderChips();
        },
        getTags() {
            return [...tags];
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

async function renameTagInLibrary(oldTag, newTag) {
    const validation = validateTagName(newTag, getAllLibraryTags(), oldTag);
    
    if (!validation.valid) {
        if (validation.isDuplicate) {
            const confirmed = await confirmDialog(`Tag "${newTag}" already exists. Merge "${oldTag}" into "${newTag}"? This will combine their usage.`);
            if (!confirmed) return false;
            // Proceed with merge by treating as rename to existing tag
        } else {
            showMessage(validation.message, CONSTANTS.MESSAGE_TYPES.ERROR);
            return false;
        }
    }
    
    const targetTag = validation.cleanTag || newTag.toLowerCase();
    let updatedCount = 0;

    TAGGABLE_COLLECTIONS.forEach(collection => {
        collection.getItems().forEach(book => {
            if (book.Tags && Array.isArray(book.Tags)) {
                const tagIndex = book.Tags.indexOf(oldTag);
                if (tagIndex !== -1) {
                    book.Tags[tagIndex] = targetTag;
                    // Remove duplicates that might result from merge
                    book.Tags = book.Tags.filter((tag, index, arr) => arr.indexOf(tag) === index);
                    updatedCount++;
                }
            }
        });
        collection.save();
    });

    return updatedCount;
}

function deleteTagFromLibrary(tagToDelete) {
    let updatedCount = 0;

    TAGGABLE_COLLECTIONS.forEach(collection => {
        collection.getItems().forEach(book => {
            if (book.Tags && Array.isArray(book.Tags)) {
                const originalLength = book.Tags.length;
                book.Tags = book.Tags.filter(tag => tag !== tagToDelete);
                if (book.Tags.length < originalLength) {
                    updatedCount++;
                }
            }
        });
        collection.save();
    });

    return updatedCount;
}


function showTagManagement() {
    renderTagsList();
    document.getElementById('tagManagementModal').style.display = 'block';
}

function closeTagManagement() {
    document.getElementById('tagManagementModal').style.display = 'none';
}

function renderTagsList() {
    const tagCounts = getAllLibraryTags();
    const sortedTags = Object.keys(tagCounts).sort();
    const container = document.getElementById('tagsList');

    if (!container.dataset.delegated) {
        container.addEventListener('click', handleTagsListClick);
        container.dataset.delegated = 'true';
    }

    if (sortedTags.length === 0) {
        container.innerHTML = '<p class="placeholder-content">No tags found in library</p>';
        return;
    }
    
    const html = sortedTags.map(tag => `
        <div class="tag-item" data-tag="${escapeHtml(tag)}">
            <span class="tag-name">${escapeHtml(tag)}</span>
            <span class="tag-count">(${tagCounts[tag]})</span>
            <div class="tag-actions">
                <button class="btn btn-small btn-secondary" data-action="rename">Rename</button>
                <button class="btn btn-small btn-danger" data-action="delete">Delete</button>
            </div>
        </div>
    `).join('');
    
    container.innerHTML = html;
}

// Delegated click handler for tag list action buttons
function handleTagsListClick(event) {
    const actionBtn = event.target.closest('[data-action]');
    if (!actionBtn) return;
    const itemEl = event.target.closest('[data-tag]');
    if (!itemEl) return;

    const tag = itemEl.dataset.tag;
    const action = actionBtn.dataset.action;

    if (action === 'rename') renameTag(tag);
    else if (action === 'delete') deleteTag(tag);
}

async function renameTag(oldTag) {
    const newTag = prompt(`Rename tag "${oldTag}" to:`, oldTag);
    if (!newTag || newTag.trim() === '' || newTag.toLowerCase() === oldTag) {
        return;
    }
    
    const updatedCount = await renameTagInLibrary(oldTag, newTag.trim());
    if (updatedCount > 0) {
        showMessage(`Tag renamed and updated in ${updatedCount} books`, CONSTANTS.MESSAGE_TYPES.SUCCESS);
        renderTagsList();
        renderMyLibrary(); // Refresh library view if open
        renderReadBooks(); // Refresh books read view if open
    }
}

async function deleteTag(tag) {
    const tagCounts = getAllLibraryTags();
    const count = tagCounts[tag];
    
    const confirmed = await confirmDialog(`Delete tag "${tag}"? This will remove it from ${count} book(s). This cannot be undone.`);
    if (!confirmed) return;
    
    const updatedCount = deleteTagFromLibrary(tag);
    showMessage(`Tag deleted and removed from ${updatedCount} books`, CONSTANTS.MESSAGE_TYPES.SUCCESS);
    renderTagsList();
    renderMyLibrary(); // Refresh library view if open
    renderReadBooks(); // Refresh books read view if open
}


