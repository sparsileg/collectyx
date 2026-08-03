/**
 * category-management.js
 * Category management functions for Scriptum.
 * Categories are stored as a JSON array in the settings table.
 */

// ── Helpers ──────────────────────────────────────────────────────────────────

function getCategoryUsageCounts() {
    const counts = {};
    const allBooks = [
        ...books.map(b => ({ ...b, _source: 'booksRead' })),
        ...readingList.map(b => ({ ...b, _source: 'readingList' })),
        ...myLibrary.map(b => ({ ...b, _source: 'myLibrary' }))
    ];
    allBooks.forEach(book => {
        if (book.Category && book.Category.trim()) {
            counts[book.Category] = (counts[book.Category] || 0) + 1;
        }
    });
    return counts;
}

function getBooksForCategory(category) {
    const result = [];
    books.forEach(b => {
        if (b.Category === category) result.push({ ...b, _source: 'booksRead' });
    });
    readingList.forEach(b => {
        if (b.Category === category) result.push({ ...b, _source: 'readingList' });
    });
    myLibrary.forEach(b => {
        if (b.Category === category) result.push({ ...b, _source: 'myLibrary' });
    });
    return result;
}

// ── Show / Close ──────────────────────────────────────────────────────────────

async function showCategoryManagement() {
    await renderCategoriesList();
    document.getElementById('categoryManagementModal').style.display = 'block';
}

function closeCategoryManagement() {
    document.getElementById('categoryManagementModal').style.display = 'none';
    document.getElementById('categoryDeleteBooksList').style.display = 'none';
    document.getElementById('categoryDeleteBooksList').innerHTML = '';
}

// ── Render ────────────────────────────────────────────────────────────────────

async function renderCategoriesList() {
    const categories = await loadCategoriesFromDB();
    const counts = getCategoryUsageCounts();
    const container = document.getElementById('categoriesList');

    if (categories.length === 0) {
        container.innerHTML = '<p class="placeholder-content">No categories found</p>';
        return;
    }

    const html = categories.map(cat => `
        <div class="tag-item">
            <span class="tag-name">${cat}</span>
            <span class="tag-count">(${counts[cat] || 0})</span>
            <div class="tag-actions">
                <button class="btn btn-small btn-secondary" onclick="renameCategory('${cat.replace(/'/g, "\\'")}')">Rename</button>
                <button class="btn btn-small btn-danger" onclick="deleteCategory('${cat.replace(/'/g, "\\'")}')">Delete</button>
            </div>
        </div>
    `).join('');

    container.innerHTML = html;
}

// ── Add ───────────────────────────────────────────────────────────────────────

async function addCategory() {
    const input = document.getElementById('newCategoryInput');
    const name = input.value.trim();

    if (!name) {
        showMessage('Please enter a category name', CONSTANTS.MESSAGE_TYPES.ERROR);
        return;
    }

    const categories = await loadCategoriesFromDB();
    if (categories.some(c => c.toLowerCase() === name.toLowerCase())) {
        showMessage(`Category "${name}" already exists`, CONSTANTS.MESSAGE_TYPES.ERROR);
        return;
    }

    const updated = [...categories, name].sort((a, b) => a.localeCompare(b));
    await saveCategoriesToDB(updated);
    input.value = '';
    showMessage(`Category "${name}" added`, CONSTANTS.MESSAGE_TYPES.SUCCESS);
    await renderCategoriesList();
}

// ── Rename ────────────────────────────────────────────────────────────────────

async function renameCategory(oldName) {
    const newName = prompt(`Rename category "${oldName}" to:`, oldName);
    if (!newName || newName.trim() === '' || newName.trim() === oldName) return;

    const trimmed = newName.trim();
    const categories = await loadCategoriesFromDB();

    if (categories.some(c => c.toLowerCase() === trimmed.toLowerCase() && c !== oldName)) {
        showMessage(`Category "${trimmed}" already exists`, CONSTANTS.MESSAGE_TYPES.ERROR);
        return;
    }

    // Update category list
    const updated = categories.map(c => c === oldName ? trimmed : c).sort((a, b) => a.localeCompare(b));
    await saveCategoriesToDB(updated);

    // Update all books across all three collections
    let count = 0;
    books.forEach(b => { if (b.Category === oldName) { b.Category = trimmed; count++; } });
    readingList.forEach(b => { if (b.Category === oldName) { b.Category = trimmed; count++; } });
    myLibrary.forEach(b => { if (b.Category === oldName) { b.Category = trimmed; count++; } });

    if (count > 0) {
        await saveData();
        await saveReadingListData();
        await saveMyLibraryData();
    }

    showMessage(`Category renamed to "${trimmed}", updated in ${count} book(s)`, CONSTANTS.MESSAGE_TYPES.SUCCESS);
    await renderCategoriesList();
}

// ── Delete ────────────────────────────────────────────────────────────────────

async function deleteCategory(category) {
    const booksUsing = getBooksForCategory(category);

    if (booksUsing.length > 0) {
        // Show list of books using this category
        const listContainer = document.getElementById('categoryDeleteBooksList');
        const sourceLabel = { booksRead: 'Books Read', readingList: 'Reading List', myLibrary: 'My Library' };

        listContainer.innerHTML = `
            <p style="margin: 10px 0 5px;">The following books use "<strong>${category}</strong>".
            Change their category before deleting:</p>
            <div class="tags-list">
                ${booksUsing.map(b => `
                    <div class="tag-item">
                        <span class="tag-name">${b.Title}</span>
                        <span class="tag-count">${sourceLabel[b._source]}</span>
                        <div class="tag-actions">
                            <button class="btn btn-small btn-secondary"
                                onclick="editBookFromCategoryManager('${b.id}', '${b._source}')">Edit</button>
                        </div>
                    </div>
                `).join('')}
            </div>
        `;
        listContainer.style.display = 'block';
        return;
    }

    const confirmed = await confirmDialog(`Delete category "${category}"? This cannot be undone.`);
    if (!confirmed) return;

    const categories = await loadCategoriesFromDB();
    const updated = categories.filter(c => c !== category);
    await saveCategoriesToDB(updated);

    showMessage(`Category "${category}" deleted`, CONSTANTS.MESSAGE_TYPES.SUCCESS);
    await renderCategoriesList();
    document.getElementById('categoryDeleteBooksList').style.display = 'none';
}

function editBookFromCategoryManager(id, source) {
    closeCategoryManagement();
    if (source === 'booksRead') {
        editReadBookById(id);
    } else if (source === 'readingList') {
        editReadingListItem(id);
    } else if (source === 'myLibrary') {
        editMyLibraryBook(id);
    }
}
