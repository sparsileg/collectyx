// functions relating to books that have been read

// read-books.js state
let currentFilters = {};
let currentSort = {
    field: CONSTANTS.BOOK_FIELDS.FINISHED,
    direction: CONSTANTS.SORT_DIRECTIONS.DESC,
    group: false
};

const BOOK_CATEGORIES = [
    "Adventure", "Biography", "Business", "Children's", "Contemporary Fiction",
    "Cooking", "Fantasy", "Fiction", "Health & Fitness", "Historical Fiction",
    "History", "Horror", "Literary Fiction", "Memoir", "Mystery",
    "Non-Fiction", "Philosophy", "Poetry", "Psychology", "Reference",
    "Religion", "Romance", "Science", "Science Fiction", "Self-Help",
    "Thriller", "Travel", "True Crime", "Young Adult"
];

async function generateCategoryOptions() {
    const categories = await loadCategoriesFromDB();
    const options = categories.map(cat => `<option value="${cat}">${cat}</option>`);
    return '<option value="">Select Category</option>' + options.join('');
}

async function populateCategorySelects() {
    const categoryOptions = await generateCategoryOptions();
    const categorySelect = document.getElementById('category');
    if (categorySelect) {
        categorySelect.innerHTML = categoryOptions;
    }
    // Note: editCategory is intentionally NOT populated here. showView() calls
    // this function on every view change (fire-and-forget), and editReadBookById()
    // needs to populate + select editCategory in one deterministic sequence.
    // If both did it, whichever async call resolved last would win the race —
    // clearing the selection depending on timing (more visible in Tauri due to
    // invoke latency). See editReadBookById().
}

async function enterReadBook(event) {
    event.preventDefault();
    const formData = new FormData(event.target);
    const book = {
        id: generateBookId(),
        DateAdded: new Date().toISOString()
    };

    // Map form data to storage format with capitalized field names
    for (let [key, value] of formData.entries()) {
        if (key === 'finished') {
            book['Finished'] = dateToStorage(value);
        } else if (key === 'isbn') {
            book['ISBN'] = value || '';
        } else if (key === 'recommend') {
            book['Recommend'] = value === '1' ? 1 : value === '0' ? 0 : null;
        } else if (key === 'authorGiven' || key === 'authorSurname') {
            // Skip individual author fields - we'll handle them separately
            continue;
        } else {
            const capitalizedKey = key.charAt(0).toUpperCase() + key.slice(1);
            book[capitalizedKey] = value || '';
        }
    }

    // Handle author name concatenation
    const authorGiven = formData.get('authorGiven') || '';
    const authorSurname = formData.get('authorSurname') || '';
    book['Author'] = `${authorSurname}, ${authorGiven}`.trim();

    books.push(book);

    try {
        await saveBook(book);
    } catch (e) {
        console.error('Failed to save book:', e);
        showMessage('Failed to save book: ' + (e.message || e), CONSTANTS.MESSAGE_TYPES.ERROR);
        return;
    }

    event.target.reset();

    // Check if this was initiated from reading list and remove the item
    const pendingRemoval = sessionStorage.getItem('pendingReadingListRemoval');
    if (pendingRemoval) {
        removeReadingListItemById(pendingRemoval);
        sessionStorage.removeItem('pendingReadingListRemoval');
        showMessage('Book added successfully and removed from reading list', CONSTANTS.MESSAGE_TYPES.SUCCESS);
    } else {
        showMessage('Book added successfully', CONSTANTS.MESSAGE_TYPES.SUCCESS);
    }

    // Navigate to Books Read view
    showView(CONSTANTS.VIEWS.REVIEW, document.querySelector('[onclick*="review"]'));
}

function cancelAddBook() {
    // Clear the form
    document.getElementById('bookForm').reset();

    // Clear any pending reading list removal
    sessionStorage.removeItem('pendingReadingListRemoval');

    // Navigate to dashboard
    showView(CONSTANTS.VIEWS.DASHBOARD, document.querySelector('[onclick*="dashboard"]'));
}


function cancelEdit() {
    showView('review');
}

function renderReadBooks() {
    const tbody = document.getElementById('booksTableBody');
    let filteredBooks = applyCurrentFilters([...books]);

    // Check if we're filtering for multiple reads
    const hasMultipleReadsFilter = Object.values(currentFilters).some(filter =>
        filter.field === 'MultipleReads'
    );

    if (hasMultipleReadsFilter) {
        renderMultipleReadsBooks(filteredBooks);
        return;
    }

    // Regular rendering logic continues...
    let sortedBooks = applySortAndGroup(filteredBooks);
    tbody.innerHTML = '';

    if (currentSort.group) {
        renderGroupedBooks(sortedBooks, tbody);
    } else {
        sortedBooks.forEach((book, index) => {
            const originalIndex = books.indexOf(book);
            const row = createReadBookRow(book, originalIndex);
            tbody.appendChild(row);
        });
    }
    updateTableHeaders();
}


// Update the table header creation
function updateTableHeaders() {
    const thead = document.querySelector('#booksHeaderTable thead tr');
    const fields = ['Finished', 'Title', 'Author', 'Pages', 'Category', 'Recommend'];

    thead.innerHTML = fields.map(field => {
        const isActive = currentSort.field === field;
        let indicator = '';

        if (isActive) {
            const arrow = currentSort.direction === 'asc' ? '▲' : '▼';
            indicator = `<span class="sort-indicator">${arrow}</span>`;
        }

        return `
            <th onclick="showSortDropdown(event, '${field}')">
                ${field === 'Recommend' ? 'Like' : field}${indicator}
            </th>
        `;
    }).join('');
}


function createReadBookRow(book, index) {
    const row = document.createElement('tr');
    row.onclick = () => editReadBookById(book.id); // Use ID instead of index

    // Add context menu for ISBN lookup
    row.oncontextmenu = async (e) => {
        e.preventDefault();
        if (await confirmDialog(`Look up ISBN information for "${book.Title}"?`)) {
            lookupBookISBNById(book.id); // Use ID instead of index
        }
    };

    const displayDate = book.Finished ? book.Finished : '';
    const hasISBN = book.ISBN || book.ISBN13 ? '📚' : '❓';

    row.innerHTML = `
        <td>${displayDate}</td>
        <td>${book.Title || ''} ${hasISBN}</td>
        <td>${book.Author || ''}</td>
        <td>${book.Pages || ''}</td>
        <td>${book.Category || ''}</td>
        <td>${book.Recommend === 1 ? 'Y' : book.Recommend === 0 ? 'N' : ''}</td>
    `;

    return row;
}


// Individual book ISBN lookup for Read Books
async function lookupBookISBN(index) {
    const book = books[index];
    await lookupBookISBNGeneric(book.id, books, saveData, renderReadBooks);
}

// Bulk ISBN lookup for Read Books
async function bulkISBNLookup() {
    await bulkISBNLookupGeneric(books, saveData, renderReadBooks, "Books Read");
}

function lookupBookISBNById(id) {
    const index = findBookIndexById(id);
    if (index !== -1) {
        lookupBookISBN(index);
    } else {
        showMessage('Book not found for ISBN lookup', CONSTANTS.MESSAGE_TYPES.ERROR);
    }
}


async function editReadBookById(id) {
    const book = findBookById(id);
    if (!book) {
        showMessage('Book not found', CONSTANTS.MESSAGE_TYPES.ERROR);
        return;
    }

    document.getElementById('editIndex').value = id;
    document.getElementById('editFinished').value = dateFromStorage(book[CONSTANTS.BOOK_FIELDS.FINISHED] || '');
    document.getElementById('editTitle').value = book[CONSTANTS.BOOK_FIELDS.TITLE] || '';
    document.getElementById('editAuthor').value = book[CONSTANTS.BOOK_FIELDS.AUTHOR] || '';
    document.getElementById('editPages').value = book[CONSTANTS.BOOK_FIELDS.PAGES] || '';
    document.getElementById('editRecommend').value = book[CONSTANTS.BOOK_FIELDS.RECOMMEND] ?? '';
    document.getElementById('editISBN').value = book[CONSTANTS.BOOK_FIELDS.ISBN] || '';
    document.getElementById('editComments').value = book[CONSTANTS.BOOK_FIELDS.COMMENTS] || '';

    showView(CONSTANTS.VIEWS.EDIT);

    // Populate and select the category in one deterministic sequence —
    // no timer, no race with showView()'s populateCategorySelects().
    const editCategorySelect = document.getElementById('editCategory');
    editCategorySelect.innerHTML = await generateCategoryOptions();
    editCategorySelect.value = book[CONSTANTS.BOOK_FIELDS.CATEGORY] || '';
}


async function saveEditReadBook(event) {
    event.preventDefault();
    const formData = new FormData(event.target);
    const id = formData.get('editIndex'); // This is now an ID, not index
    const bookIndex = findBookIndexById(id);

    if (bookIndex === -1) {
        showMessage('Book not found', CONSTANTS.MESSAGE_TYPES.ERROR);
        return;
    }

    const book = { ...books[bookIndex] }; // Preserve fields not present in the edit form (e.g. DateAdded, Rating)

    // Map form data to storage format with capitalized field names
    for (let [key, value] of formData.entries()) {
        if (key !== 'editIndex') {
            if (key === 'finished') {
                book['Finished'] = dateToStorage(value);
            } else if (key === 'isbn') {
                book['ISBN'] = value || '';
            } else if (key === 'recommend') {
                book['Recommend'] = value === '1' ? 1 : value === '0' ? 0 : null;
            } else {
                const capitalizedKey = key.charAt(0).toUpperCase() + key.slice(1);
                book[capitalizedKey] = value || '';
            }
        }
    }

    books[bookIndex] = book;

    try {
        await saveBook(book);
    } catch (e) {
        console.error('Failed to save book:', e);
        showMessage('Failed to save book: ' + (e.message || e), CONSTANTS.MESSAGE_TYPES.ERROR);
        return;
    }

    showView('review');
    renderReadBooks();
    showMessage('Book updated successfully', CONSTANTS.MESSAGE_TYPES.SUCCESS);
}


async function deleteReadBookById(id) {
    const book = findBookById(id);
    const bookIndex = findBookIndexById(id);

    if (!book || bookIndex === -1) {
        showMessage('Book not found', CONSTANTS.MESSAGE_TYPES.ERROR);
        return;
    }

    const confirmed = await confirmDialog(`⚠️ REMOVE BOOK?\n\nTitle: "${book.Title}"\nAuthor: ${book.Author}\n\nThis cannot be undone.`);

    if (!confirmed) return;

    books.splice(bookIndex, 1);

    try {
        await deleteBook(id);
    } catch (e) {
        console.error('Failed to delete book:', e);
        showMessage('Failed to delete book: ' + (e.message || e), CONSTANTS.MESSAGE_TYPES.ERROR);
        return;
    }

    showMessage(`"${book.Title}" removed from the Books Read list`, CONSTANTS.MESSAGE_TYPES.SUCCESS);
    showView('review');
    renderReadBooks();
}


function renderGroupedBooks(groupedBooks, tbody) {
    for (const [groupValue, groupBooks] of Object.entries(groupedBooks)) {
        const headerRow = document.createElement('tr');
        headerRow.innerHTML = `<td colspan="6" class="group-header">${currentSort.field}: ${groupValue || 'Empty'} (${groupBooks.length} books)</td>`;
        tbody.appendChild(headerRow);

        groupBooks.forEach(book => {
            const originalIndex = books.indexOf(book);
            const row = createReadBookRow(book, originalIndex);
            tbody.appendChild(row);
        });
    }
}


function showSortDropdown(event, field) {
    const DROPDOWN_CLOSE_DELAY = CONSTANTS.API_DELAYS.DROPDOWN_CLOSE;
    event.stopPropagation();

    // Remove existing dropdown
    const existingDropdown = document.querySelector('.sort-dropdown');
    if (existingDropdown) {
        existingDropdown.remove();
    }

    const dropdown = document.createElement('div');
    dropdown.className = 'sort-dropdown';
    dropdown.innerHTML = `
                <div class="sort-option" onclick="sortBooks('${field}', 'desc', false)">Descending Sort</div>
                <div class="sort-option" onclick="sortBooks('${field}', 'asc', false)">Ascending Sort</div>
                <div class="sort-option" onclick="sortBooks('${field}', 'desc', true)">Descending Group</div>
                <div class="sort-option" onclick="sortBooks('${field}', 'asc', true)">Ascending Group</div>
            `;

    const th = event.target;
    th.style.position = 'relative';
    th.appendChild(dropdown);

    // Close dropdown when clicking elsewhere
    setTimeout(() => {
        document.addEventListener('click', function closeDropdown() {
            dropdown.remove();
            document.removeEventListener('click', closeDropdown);
        });
    }, DROPDOWN_CLOSE_DELAY);
}


function sortBooks(field, direction, group) {
    currentSort = { field, direction, group };
    renderReadBooks();
    updateTableHeaders();
}


function applySortAndGroup(books) {
    const sorted = [...books].sort((a, b) => {
        let aVal = a[currentSort.field] || '';
        let bVal = b[currentSort.field] || '';

        // Handle numeric fields
        if (currentSort.field === 'Pages') {
            aVal = parseInt(aVal) || 0;
            bVal = parseInt(bVal) || 0;
        }

        // Handle dates - convert to Date objects for comparison
        if (currentSort.field === 'Finished') {
            const aISO = aVal ? dateToISO(aVal) : '';
            const bISO = bVal ? dateToISO(bVal) : '';
            aVal = aISO ? new Date(aISO) : new Date(0);
            bVal = bISO ? new Date(bISO) : new Date(0);
        }

        if (aVal < bVal) return currentSort.direction === 'asc' ? -1 : 1;
        if (aVal > bVal) return currentSort.direction === 'asc' ? 1 : -1;

        // Tiebreaker: when Finished dates are equal, order by entry time (DateAdded)
        if (currentSort.field === 'Finished') {
            const aAdded = a.DateAdded || '';
            const bAdded = b.DateAdded || '';
            if (aAdded < bAdded) return currentSort.direction === 'asc' ? -1 : 1;
            if (aAdded > bAdded) return currentSort.direction === 'asc' ? 1 : -1;
        }

        return 0;
    });

    if (currentSort.group) {
        const grouped = {};
        sorted.forEach(book => {
            const groupValue = book[currentSort.field] || '';
            if (!grouped[groupValue]) {
                grouped[groupValue] = [];
            }
            grouped[groupValue].push(book);
        });
        return grouped;
    }

    return sorted;
}


let quickSearchTimeout;
function handleQuickSearch(searchTerm) {
    const QUICK_SEARCH_DELAY = CONSTANTS.API_DELAYS.QUICK_SEARCH;
    clearTimeout(quickSearchTimeout);
    quickSearchTimeout = setTimeout(() => {
        performQuickSearch(searchTerm);
    }, QUICK_SEARCH_DELAY);
}


function performQuickSearch(searchTerm) {
    if (!searchTerm.trim()) {
        currentFilters = {};
        renderReadBooks();
        showMessage('Search cleared', CONSTANTS.MESSAGE_TYPES.INFO);
        return;
    }

    currentFilters = {
        quickSearch: {
            field: 'all',
            operator: 'contains',
            values: [searchTerm.toLowerCase()]
        }
    };

    const filteredBooks = applyCurrentFilters([...books]);
    showMessage(`Quick search: ${filteredBooks.length} of ${books.length} books found`, CONSTANTS.MESSAGE_TYPES.SUCCESS);
    renderReadBooks();
}


function showFilter() {
    document.getElementById('filterPanel').style.display = 'block';
    setupFilterControls();
}


function hideFilter() {
    document.getElementById('filterPanel').style.display = 'none';
}


function setupFilterControls() {
    const container = document.getElementById('filterControls');

    // Clear existing controls
    container.innerHTML = '';

    // Add the "Add Filter" button first
    const addButton = document.createElement('button');
    addButton.type = 'button';
    addButton.className = 'btn btn-secondary';
    addButton.onclick = () => addFilterRow();
    addButton.textContent = 'Add Filter';
    container.appendChild(addButton);

    // If there are existing filters, recreate them
    if (Object.keys(currentFilters).length > 0) {
        Object.entries(currentFilters).forEach(([filterKey, filter]) => {
            addFilterRowWithData(filter);
        });
    } else {
        // Add default empty filter row
        addEmptyFilterRow();
    }
}


function addFilterRowWithData(filterData) {
    const container = document.getElementById('filterControls');
    const addButton = container.querySelector('button[onclick*="addFilterRow"]');

    const filterRow = document.createElement('div');
    filterRow.className = 'filter-row';
    filterRow.innerHTML = `
            <select class="filter-field" onchange="updateFilterOptions(this)">
                <option value="">Select Field</option>
                <option value="Finished">Finished</option>
                <option value="Title">Title</option>
                <option value="Author">Author</option>
                <option value="Pages">Pages</option>
                <option value="Category">Category</option>
                <option value="Recommend">Recommend</option>
                <option value="ISBN">ISBN</option>
                <option value="MultipleReads">Multiple Reads</option>
            </select>
            <select class="filter-operator" disabled>
                <option value="">Select Operator</option>
            </select>
            <div class="filter-value"></div>
        <button type="button" class="btn btn-danger" onclick="removeFilterRow(this)">Remove</button>
    `;

    if (addButton) {
        container.insertBefore(filterRow, addButton);
    } else {
        container.appendChild(filterRow);
    }

    // Set the field value and trigger options update
    const fieldSelect = filterRow.querySelector('.filter-field');
    fieldSelect.value = filterData.field;
    updateFilterOptions(fieldSelect);

    // Set the operator value and trigger value update
    setTimeout(() => {
        const operatorSelect = filterRow.querySelector('.filter-operator');
        operatorSelect.value = filterData.operator;
        updateFilterValue(operatorSelect);

        // Set the actual values
        setTimeout(() => {
            const valueInputs = filterRow.querySelectorAll('.filter-value-input');
            filterData.values.forEach((value, index) => {
                if (valueInputs[index]) {
                    valueInputs[index].value = value;
                }
            });
        }, 10);
    }, 10);
}


function addEmptyFilterRow() {
    const container = document.getElementById('filterControls');
    const addButton = container.querySelector('button[onclick*="addFilterRow"]');

    const filterRow = document.createElement('div');
    filterRow.className = 'filter-row';
    filterRow.innerHTML = `
                <select class="filter-field" onchange="updateFilterOptions(this)">
                <option value="">Select Field</option>
                <option value="Finished">Finished</option>
                <option value="Title">Title</option>
                <option value="Author">Author</option>
                <option value="Pages">Pages</option>
                <option value="Category">Category</option>
                <option value="Recommend">Recommend</option>
                <option value="ISBN">ISBN</option>
                <option value="MultipleReads">Multiple Reads</option>
            </select>
            <select class="filter-operator" disabled>
                <option value="">Select Operator</option>
            </select>
            <div class="filter-value"></div>
            <button type="button" class="btn btn-danger" onclick="removeFilterRow(this)">Remove</button>
            `;

    if (addButton) {
        container.insertBefore(filterRow, addButton);
    } else {
        container.appendChild(filterRow);
    }

}


function addFilterRow() {
    addEmptyFilterRow();
}


function removeFilterRow(button) {
    button.parentElement.remove();
}


function updateFilterOptions(select) {
    const row = select.parentElement;
    const operatorSelect = row.querySelector('.filter-operator');
    const valueContainer = row.querySelector('.filter-value');
    const field = select.value;

    operatorSelect.disabled = !field;
    operatorSelect.innerHTML = '<option value="">Select Operator</option>';
    valueContainer.innerHTML = '';

    if (!field) return;

    let operators = [];

    switch (field) {
    case 'Finished':
        operators = [
            { value: 'isEmpty', text: 'Is Empty' },
            { value: 'between', text: 'Between' }
        ];
        break;
    case 'Title':
    case 'Author':
        operators = [
            { value: 'isEmpty', text: 'Is Empty' },
            { value: 'contains', text: 'Contains' }
        ];
        break;
    case 'Pages':
        operators = [
            { value: 'isEmpty', text: 'Is Empty' },
            { value: 'lte', text: 'Less than or equal to' },
            { value: 'gte', text: 'Greater than or equal to' }
        ];
        break;
    case 'Category':
    case 'Recommend':
        operators = [
            { value: 'isEmpty', text: 'Is Empty' },
            { value: 'equals', text: 'Equals' }
        ];
        break;
    case 'ISBN':
        operators = [
            { value: 'isEmpty', text: 'Is Empty' },
            { value: 'contains', text: 'Contains' }
        ];
        break;
    case 'MultipleReads':
        operators = [
            { value: 'gte', text: 'Greater than or equal to' }
        ];
        break;
    }

    operators.forEach(op => {
        const option = document.createElement('option');
        option.value = op.value;
        option.textContent = op.text;
        operatorSelect.appendChild(option);
    });

    // REPLACE THE AUTO-SELECTION LOGIC WITH:
    // Auto-select based on field type
    let defaultOperator = null;
    switch (field) {
    case 'Finished':
        defaultOperator = 'between';
        break;
    case 'Title':
    case 'Author':
        defaultOperator = 'contains';
        break;
    case 'Pages':
    case 'MultipleReads':
        defaultOperator = 'gte';
        break;
    case 'Category':
    case 'Recommend':
        defaultOperator = 'equals';
        break;
    case 'ISBN':
        defaultOperator = 'isEmpty';  // Most useful for finding books without ISBNs
        break;
    }

    if (defaultOperator) {
        operatorSelect.value = defaultOperator;
        updateFilterValue(operatorSelect); // Trigger the value field setup
    }

    operatorSelect.onchange = () => updateFilterValue(operatorSelect);
}


function updateFilterValue(operatorSelect) {
    const row = operatorSelect.parentElement;
    const valueContainer = row.querySelector('.filter-value');
    const fieldSelect = row.querySelector('.filter-field');
    const field = fieldSelect.value;
    const operator = operatorSelect.value;

    valueContainer.innerHTML = '';

    if (!operator || operator === 'isEmpty') return;

    switch (operator) {
    case 'between':
        valueContainer.innerHTML = `
          <div class="date-range">
          <input type="text" class="filter-value-input" placeholder="MM/DD/YYYY" maxlength="10" onblur="validateDateInput(this)" oninput="clearMessage()">
          <span>to</span>
          <input type="text" class="filter-value-input" placeholder="MM/DD/YYYY" maxlength="10" onblur="validateDateInput(this)" oninput="clearMessage()">
        </div>
        `;
        break;
    case 'contains':
    case 'lte':
    case 'gte':
    case 'gte':
        if (field === 'MultipleReads') {
            valueContainer.innerHTML = '<input type="text" class="filter-value-input" value="2" readonly>';
        } else {
            valueContainer.innerHTML = '<input type="text" class="filter-value-input" placeholder="Enter value">';
        }
        break;
    case 'equals':
        if (field === 'Category') {
            generateCategoryOptions().then(opts => {
                valueContainer.innerHTML = `<select class="filter-value-input">${opts}</select>`;
            });
        } else if (field === 'Recommend') {
            valueContainer.innerHTML = `
                            <select class="filter-value-input">
                                <option value="">Select</option>
                                <option value="1">Y</option>
                                <option value="0">N</option>
                            </select>
                        `;
        }
        break;
    }
}

function applyFilters() {
    const filterRows = document.querySelectorAll('.filter-row');
    currentFilters = {};

    filterRows.forEach((row, index) => {
        const field = row.querySelector('.filter-field').value;
        const operator = row.querySelector('.filter-operator').value;
        const valueInputs = row.querySelectorAll('.filter-value-input');

        if (field && operator) {
            currentFilters[`filter_${index}`] = {
                field,
                operator,
                values: Array.from(valueInputs).map(input => input.value)
            };
        }
    });

    // Clear quick search when applying filters
    document.getElementById('quickSearch').value = '';

    // Count filtered results AFTER currentFilters is fully set
    const filteredBooks = applyCurrentFilters([...books]);
    const filterCount = filteredBooks.length;
    const totalCount = books.length;

    showMessage(`Filter applied: ${filterCount} of ${totalCount} books match the criteria`, CONSTANTS.MESSAGE_TYPES.SUCCESS);
    renderReadBooks();
    hideFilter();
}

function clearFilters() {
    currentFilters = {};

    document.getElementById('quickSearch').value = '';
    showMessage(`Filters cleared: showing all ${books.length} books`, CONSTANTS.MESSAGE_TYPES.INFO);

    // Reset search icon appearance
    const searchIcon = document.querySelector('.search-icon');
    searchIcon.style.background = '';
    searchIcon.style.color = '';

    renderReadBooks();
    hideFilter();
}




function applyCurrentFilters(books) {
    if (Object.keys(currentFilters).length === 0) {
        return books;
    }

    return books.filter(book => {
        return Object.values(currentFilters).every(filter => {
            // Handle quick search across all fields
            if (filter.field === 'all') {
                const searchTerm = filter.values[0];
                const searchableFields =
                      [book.Title, book.Author, book.Category, book.Comments].join(' ').toLowerCase();
                return searchableFields.includes(searchTerm);
            }

            // Existing filter logic
            const fieldValue = book[filter.field] || '';
            switch (filter.operator) {
            case 'isEmpty':
                return fieldValue === '' || fieldValue === null || fieldValue === undefined;
            case 'contains':
                return fieldValue.toLowerCase().includes((filter.values[0] || '').toLowerCase());
            case 'between':
                if (!filter.values[0] || !filter.values[1]) return true;
                const bookDateISO = dateToISO(fieldValue);
                const bookDate = new Date(bookDateISO);
                const afterDate = new Date(filter.values[0]);
                const beforeDate = new Date(filter.values[1]);
                return bookDate >= afterDate && bookDate <= beforeDate;
            case 'lte':
                return parseInt(fieldValue) <= parseInt(filter.values[0] || 0);
            case 'gte':
                if (filter.field === 'MultipleReads') {
                    // Use normalized matching
                    const bookKey = normalizeBookKey(book.Title, book.Author);
                    const readCount = books.filter(b =>
                        normalizeBookKey(b.Title, b.Author) === bookKey
                    ).length;
                    return readCount >= parseInt(filter.values[0] || 2);
                } else {
                    return parseInt(fieldValue) >= parseInt(filter.values[0] || 0);
                }
            case 'equals':
                return fieldValue === filter.values[0];
            default:
                return true;
            }
        });
    });
}

function renderMultipleReadsBooks(filteredBooks) {
    const tbody = document.getElementById('booksTableBody');
    tbody.innerHTML = '';

    // Group books by normalized title + author
    const grouped = {};
    filteredBooks.forEach(book => {
        const key = normalizeBookKey(book.Title, book.Author);
        if (!grouped[key]) {
            grouped[key] = [];
        }
        grouped[key].push(book);
    });

    // Sort each group by date ascending and render
    Object.entries(grouped).forEach(([key, bookGroup]) => {
        // Sort this group by date ascending
        const sortedGroup = bookGroup.sort((a, b) => {
            const dateA = new Date(dateToISO(a.Finished));
            const dateB = new Date(dateToISO(b.Finished));
            return dateA - dateB;
        });

        // Add group header
        const headerRow = document.createElement('tr');
        headerRow.innerHTML = `<td colspan="6" class="group-header">${sortedGroup[0].Title} by ${sortedGroup[0].Author} (${sortedGroup.length} reads)</td>`;
        tbody.appendChild(headerRow);

        // Add each read
        sortedGroup.forEach(book => {
            const originalIndex = books.indexOf(book);
            const row = createReadBookRow(book, originalIndex);
            tbody.appendChild(row);
        });
    });
}

function normalizeBookKey(title, author) {
    // Normalize both title and author for consistent matching
    const normalizeString = (str) => {
        return str.toLowerCase()
                  .trim()
                  .replace(/\s+/g, ' ')        // Replace multiple spaces with single space
                  .replace(/[.,;:!?]/g, '')    // Remove common punctuation
                  .replace(/\s*-\s*/g, '-');   // Normalize hyphens
    };

    let normalizedAuthor = normalizeString(author);

    // Handle "Lastname, Firstname" format - convert to "firstname lastname"
    if (normalizedAuthor.includes(',')) {
        const parts = normalizedAuthor.split(',').map(part => part.trim());
        normalizedAuthor = `${parts[1]} ${parts[0]}`.trim();
    }

    return `${normalizeString(title)}|||${normalizedAuthor}`;
}


// Helper function to convert date format from DD-MMM-YYYY to YYYY-MM-DD
function dateToISO(storageDate) {
    if (!storageDate) return '';
    try {
        const parts = storageDate.split('-');
        if (parts.length === 3 && parts[1].length === 3) {
            const day = parts[0].padStart(2, '0');
            const monthAbbr = parts[1];
            const year = parts[2];

            const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                            'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
            const monthNum = months.indexOf(monthAbbr);

            if (monthNum !== -1) {
                const month = (monthNum + 1).toString().padStart(2, '0');
                return `${year}-${month}-${day}`;
            }
        }
        return storageDate;
    } catch (e) {
        return storageDate;
    }
}


// Helper function to escape CSV values
function escapeCSV(value) {
    if (value === null || value === undefined) return '';

    const stringValue = String(value);

    // Check if the value needs to be quoted
    if (stringValue.includes(',') || stringValue.includes('"') ||
        stringValue.includes('\n') || stringValue.includes('\r')) {
        // Escape double quotes by doubling them
        const escaped = stringValue.replace(/"/g, '""');
        return `"${escaped}"`;
    }

    return stringValue;
}


// Helper function to escape TSV values
function escapeTSV(value) {
    if (value === null || value === undefined) return '';

    const stringValue = String(value);

    // Replace tabs with spaces and escape special characters
    return stringValue
        .replace(/\t/g, ' ')
        .replace(/\r\n/g, ' ')
        .replace(/\n/g, ' ')
        .replace(/\r/g, ' ');
}


function toggleExportDropdown() {
    document.getElementById("exportDropdownContent").parentElement.classList.toggle("show");
}


// Close dropdown when clicking outside
window.onclick = function(event) {
    if (!event.target.matches('.export-btn')) {
        const dropdowns = document.getElementsByClassName("export-dropdown-content");
        for (let openDropdown of dropdowns) {
            if (openDropdown.parentElement.classList.contains('show')) {
                openDropdown.parentElement.classList.remove('show');
            }
        }
    }
}


function generateExportMetadata() {
    const now = new Date();
    const filteredBooks = applyCurrentFilters([...books]);

    const metadata = {
        timestamp: now.toISOString(),
        totalBooksInDatabase: books.length,
        filteredBooks: filteredBooks.length,
        appliedFilters: [],
        quickSearch: document.getElementById('quickSearch').value || null
    };

    // Convert currentFilters to readable format
    Object.values(currentFilters).forEach(filter => {
        if (filter.field !== 'all') {
            metadata.appliedFilters.push({
                field: filter.field,
                operator: filter.operator,
                values: filter.values
            });
        }
    });

    return metadata;
}


function generateTimestampedFilename(baseFilename, extension) {
    const filteredBooks = applyCurrentFilters([...books]);
    const hasQuickSearch = document.getElementById('quickSearch').value.trim();
    const hasFilters = Object.keys(currentFilters).length > 0 && !currentFilters.quickSearch;

    // If no filters or search, use simple filename
    if (!hasQuickSearch && !hasFilters && filteredBooks.length === books.length) {
        return `books-read.${extension}`;
    }

    // Otherwise use timestamped filename
    const now = new Date();
    const timestamp = now.getFullYear() +
        String(now.getMonth() + 1).padStart(2, '0') +
        String(now.getDate()).padStart(2, '0') + '.' +
        String(now.getHours()).padStart(2, '0') +
        String(now.getMinutes()).padStart(2, '0') +
        String(now.getSeconds()).padStart(2, '0');

    return `${baseFilename}_${timestamp}.${extension}`;
}


function generateCSVTSVHeader(metadata) {
    const lines = [
        `# Export Date: ${new Date(metadata.timestamp).toLocaleString()}`,
        `# Total Books in Database: ${metadata.totalBooksInDatabase}`,
        `# Filtered Results: ${metadata.filteredBooks} books`
    ];

    if (metadata.appliedFilters.length > 0) {
        metadata.appliedFilters.forEach(filter => {
            const valueStr = filter.values.join(', ');
            lines.push(`# Applied Filter: ${filter.field} ${filter.operator} ${valueStr}`);
        });
    }

    if (metadata.quickSearch) {
        lines.push(`# Quick Search: ${metadata.quickSearch}`);
    }

    lines.push(''); // Empty line before headers
    return lines.join('\n') + '\n';
}

// ----------------------------------------------------------------------
// ISBN lookup functionality
async function lookupISBN(title, author) {
    try {
        // Try OpenLibrary first
        const openLibraryResult = await searchOpenLibrary(title, author);
        if (openLibraryResult) return openLibraryResult;

        // Fallback to Google Books
        const googleBooksResult = await searchGoogleBooks(title, author);
        if (googleBooksResult) return googleBooksResult;

        return null;
    } catch (error) {
        console.error('ISBN lookup error:', error);
        return null;
    }
}


function parseAuthorName(authorString) {
    if (!authorString) return { first: '', last: '', original: authorString };

    // Handle "Lastname, Firstname" format
    if (authorString.includes(',')) {
        const parts = authorString.split(',').map(part => part.trim());
        return {
            first: parts[1] || '',
            last: parts[0] || '',
            original: authorString,
            reversed: `${parts[1]} ${parts[0]}`.trim()
        };
    }

    // Handle "Firstname Lastname" format
    const parts = authorString.split(' ');
    return {
        first: parts[0] || '',
        last: parts.slice(1).join(' ') || '',
        original: authorString,
        reversed: authorString // Already in correct order
    };
}


async function searchOpenLibrary(title, author) {
    const authorInfo = parseAuthorName(author);

    // Create multiple author format variations
    const authorVariations = [
        authorInfo.original,           // "Lastname, Firstname"
        authorInfo.reversed,           // "Firstname Lastname"
        authorInfo.last,               // Just "Lastname"
        `${authorInfo.first} ${authorInfo.last}`.trim() // Explicit "First Last"
    ].filter(variation => variation && variation.length > 0);

    // Try multiple search strategies with author variations
    const searches = [];

    authorVariations.forEach(authorVar => {
        searches.push(
            `title:"${title}" author:"${authorVar}"`,           // Exact match
            `"${title}" "${authorVar}"`,                         // Quoted terms
            `${title} ${authorVar}`,                             // Loose match
            `title:${title.split(':')[0]} author:"${authorVar}"` // Title without subtitle
        );
    });

    for (const query of searches) {
        try {
            const url = `https://openlibrary.org/search.json?q=${encodeURIComponent(query)}&limit=5`;
            const response = await fetch(url);
            const data = await response.json();

            if (data.docs && data.docs.length > 0) {
                // Find best match by confidence score
                const bestMatch = data.docs
                    .map(book => ({
                        ...book,
                        confidence: calculateAdvancedConfidence(title, authorInfo, book.title, book.author_name)
                    }))
                    .filter(book => book.confidence > 50)
                    .sort((a, b) => b.confidence - a.confidence)[0];

                if (bestMatch && bestMatch.confidence > 60) {
                    // If we have a cover_edition_key, get the full edition details
                    if (bestMatch.cover_edition_key) {
                        try {
                            const editionUrl = `https://openlibrary.org/books/${bestMatch.cover_edition_key}.json`;
                            const editionResponse = await fetch(editionUrl);
                            const editionData = await editionResponse.json();

                            // Extract ISBNs from the edition data
                            const isbn10List = editionData.isbn_10 || [];
                            const isbn13List = editionData.isbn_13 || [];

                            return {
                                isbn: isbn10List[0] || null,
                                isbn13: isbn13List[0] || null,
                                publisher: editionData.publishers ? editionData.publishers[0] : null,
                                publishYear: editionData.publish_date ? parseInt(editionData.publish_date) : bestMatch.first_publish_year,
                                pages: editionData.number_of_pages || bestMatch.number_of_pages_median,
                                confidence: bestMatch.confidence,
                                matchedQuery: query // For debugging
                            };
                        } catch (error) {
                            console.error('Error fetching edition details:', error);
                        }
                    }

                    // Fallback to original method if edition fetch fails
                    return {
                        isbn: null,
                        isbn13: null,
                        publisher: bestMatch.publisher ? bestMatch.publisher[0] : null,
                        publishYear: bestMatch.first_publish_year,
                        pages: bestMatch.number_of_pages_median,
                        confidence: bestMatch.confidence,
                        matchedQuery: query // For debugging
                    };
                }
            } else {
                console.log('No results for this query');
            }
        } catch (error) {
            console.error(`Search failed for query: ${query}`, error);
        }
    }
    return null;
}


function calculateAdvancedConfidence(searchTitle, searchAuthorInfo, resultTitle, resultAuthors) {
    let confidence = 0;

    // Title similarity (60% weight)
    const titleSimilarity = calculateTitleSimilarity(searchTitle, resultTitle);
    confidence += titleSimilarity * 0.6;

    // Author similarity (40% weight) - check multiple formats
    let bestAuthorMatch = 0;
    const authorArray = Array.isArray(resultAuthors) ? resultAuthors : [resultAuthors || ''];

    authorArray.forEach(resultAuthor => {
        const resultAuthorInfo = parseAuthorName(resultAuthor);

        // Try different comparison strategies
        const similarities = [
            calculateStringSimilarity(searchAuthorInfo.original.toLowerCase(), resultAuthor.toLowerCase()),
            calculateStringSimilarity(searchAuthorInfo.reversed.toLowerCase(), resultAuthor.toLowerCase()),
            calculateStringSimilarity(searchAuthorInfo.last.toLowerCase(), resultAuthorInfo.last.toLowerCase()),
            // Check if last names match exactly (high confidence indicator)
            searchAuthorInfo.last.toLowerCase() === resultAuthorInfo.last.toLowerCase() ? 0.9 : 0
        ];

        bestAuthorMatch = Math.max(bestAuthorMatch, ...similarities);
    });

    confidence += bestAuthorMatch * 0.4;

    return Math.round(confidence * 100);
}


function calculateTitleSimilarity(title1, title2) {
    if (!title1 || !title2) return 0;

    const clean1 = title1.toLowerCase().replace(/[^\w\s]/g, '');
    const clean2 = title2.toLowerCase().replace(/[^\w\s]/g, '');

    // Check for exact match after cleaning
    if (clean1 === clean2) return 1.0;

    // Check if one title contains the other (handles subtitles)
    if (clean1.includes(clean2) || clean2.includes(clean1)) return 0.85;

    // Word-based similarity
    const words1 = clean1.split(/\s+/).filter(w => w.length > 2);
    const words2 = clean2.split(/\s+/).filter(w => w.length > 2);
    const commonWords = words1.filter(word => words2.includes(word));

    return commonWords.length / Math.max(words1.length, words2.length);
}


// Also update Google Books search similarly
async function searchGoogleBooks(title, author) {
    const authorInfo = parseAuthorName(author);
    const authorVariations = [
        authorInfo.reversed,    // "Firstname Lastname" (Google Books prefers this)
        authorInfo.original,    // "Lastname, Firstname"
        authorInfo.last         // Just surname
    ].filter(variation => variation && variation.length > 0);

    for (const authorVar of authorVariations) {
        const query = `intitle:"${title}" inauthor:"${authorVar}"`;
        const url = `https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(query)}&maxResults=3`;

        try {
            const response = await fetch(url);
            const data = await response.json();

            if (data.items && data.items.length > 0) {
                const bestMatch = data.items
                    .map(item => ({
                        ...item,
                        confidence: calculateAdvancedConfidence(title, authorInfo, item.volumeInfo.title, item.volumeInfo.authors)
                    }))
                    .filter(item => item.confidence > 60)
                    .sort((a, b) => b.confidence - a.confidence)[0];

                if (bestMatch) {
                    const book = bestMatch.volumeInfo;
                    const industryIdentifiers = book.industryIdentifiers || [];

                    return {
                        isbn: industryIdentifiers.find(id => id.type === 'ISBN_10')?.identifier || null,
                        isbn13: industryIdentifiers.find(id => id.type === 'ISBN_13')?.identifier || null,
                        publisher: book.publisher,
                        publishYear: book.publishedDate ? parseInt(book.publishedDate.split('-')[0]) : null,
                        pages: book.pageCount,
                        confidence: bestMatch.confidence
                    };
                }
            }
        } catch (error) {
            console.error('Google Books search error:', error);
        }
    }
    return null;
}


function calculateStringSimilarity(str1, str2) {
    if (!str1 || !str2) return 0;

    // Simple similarity based on common words
    const words1 = str1.split(/\s+/);
    const words2 = str2.split(/\s+/);
    const commonWords = words1.filter(word => words2.includes(word));

    return commonWords.length / Math.max(words1.length, words2.length);
}


function findBookById(id) {
    return books.find(book => book.id === id);
}


function findBookIndexById(id) {
    return books.findIndex(book => book.id === id);
}
