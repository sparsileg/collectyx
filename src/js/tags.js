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
    const tagCounts = {};
    
    myLibrary.forEach(book => {
        if (book.Tags && Array.isArray(book.Tags)) {
            book.Tags.forEach(tag => {
                tagCounts[tag] = (tagCounts[tag] || 0) + 1;
            });
        }
    });
    
    return tagCounts;
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
    
    myLibrary.forEach(book => {
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
    
    saveMyLibraryData();
    return updatedCount;
}

function deleteTagFromLibrary(tagToDelete) {
    let updatedCount = 0;
    
    myLibrary.forEach(book => {
        if (book.Tags && Array.isArray(book.Tags)) {
            const originalLength = book.Tags.length;
            book.Tags = book.Tags.filter(tag => tag !== tagToDelete);
            if (book.Tags.length < originalLength) {
                updatedCount++;
            }
        }
    });
    
    saveMyLibraryData();
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
}


