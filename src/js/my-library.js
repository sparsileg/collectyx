// myLibrary.js - My Library functionality

let currentMyLibrarySort = { field: 'Title', direction: 'asc', group: false };
let currentMyLibraryFilters = {};

// Bookshelf locations
const MY_LIBRARY_BOOKSHELVES = [
    'Study-Front-Left-1', 'Study-Front-Left-2', 'Study-Front-Left-3', 'Study-Front-Left-4', 'Study-Front-Left-5',
    'Study-Front-Right-1', 'Study-Front-Right-2', 'Study-Front-Right-3', 'Study-Front-Right-4', 'Study-Front-Right-5',
    'Study-Right-Mini-1', 'Study-Right-Mini-2',
    'Study-Left-Rear-c1-1', 'Study-Left-Rear-c1-2', 'Study-Left-Rear-c1-3', 'Study-Left-Rear-c1-4', 'Study-Left-Rear-c1-5', 'Study-Left-Rear-c1-6',
    'Study-Left-Rear-C2-1', 'Study-Left-Rear-C2-2', 'Study-Left-Rear-C2-3', 'Study-Left-Rear-C2-4', 'Study-Left-Rear-C2-5', 'Study-Left-Rear-C2-6', 'Study-Left-Rear-C2-7',
    'Study-Left-Mid-c1-1', 'Study-Left-Mid-c1-2', 'Study-Left-Mid-c1-3', 'Study-Left-Mid-c1-4', 'Study-Left-Mid-c1-5', 'Study-Left-Mid-c1-6', 'Study-Left-Mid-c1-7',
    'Study-Left-Mid-c2-1', 'Study-Left-Mid-c2-2', 'Study-Left-Mid-c2-3', 'Study-Left-Mid-c2-4', 'Study-Left-Mid-c2-5', 'Study-Left-Mid-c2-6', 'Study-Left-Mid-c2-7',
    'Study-Right-1', 'Study-Right-2', 'Study-Right-3', 'Study-Right-4', 'Study-Right-5', 'Study-Right-6', 'Study-Right-7'
];

// Generate unique ID for library items
function generateMyLibraryId() {
    return generateBookId(); // Reuse the existing UUID function
}


// Populate bookshelf dropdowns
function populateMyLibraryBookshelfSelects() {
    const addSelect = document.getElementById('myLibraryAddBookshelf');
    const editSelect = document.getElementById('myLibraryEditBookshelf');

    const options = MY_LIBRARY_BOOKSHELVES.map(shelf => `<option value="${shelf}">${shelf}</option>`).join('');

    if (addSelect) addSelect.innerHTML = options;
    if (editSelect) editSelect.innerHTML = options;
}


// Populate category selects
async function populateMyLibraryCategorySelects() {
    const categoryOptions = await generateCategoryOptions();
    const addSelect = document.getElementById('myLibraryAddCategory');
    const editSelect = document.getElementById('myLibraryEditCategory');
    if (addSelect) addSelect.innerHTML = categoryOptions;
    if (editSelect) editSelect.innerHTML = categoryOptions;
}


// Update location fields based on type selection
function updateMyLibraryLocationFields(mode) {
    const typeSelect = document.getElementById(`myLibrary${mode}LocationType`);
    const bookshelfGroup = document.getElementById(`myLibrary${mode}BookshelfGroup`);
    const otherGroup = document.getElementById(`myLibrary${mode}OtherGroup`);

    if (typeSelect.value === 'Bookshelf') {
        bookshelfGroup.style.display = 'flex';
        otherGroup.style.display = 'none';
    } else {
        bookshelfGroup.style.display = 'none';
        otherGroup.style.display = 'flex';
    }
}


// Show add modal
function showAddMyLibraryModal() {
    populateMyLibraryCategorySelects();
    populateMyLibraryBookshelfSelects();
    updateMyLibraryLocationFields('Add');
    document.getElementById('myLibraryAddModal').style.display = 'block';
}


// Cancel add
function cancelMyLibraryAdd() {
    document.getElementById('myLibraryAddModal').style.display = 'none';
    document.getElementById('myLibraryAddForm').reset();
}


// Add book to library
function addToMyLibrary(event) {
    event.preventDefault();
    const formData = new FormData(event.target);

    const locationType = document.getElementById('myLibraryAddLocationType').value;
    let location;
    if (locationType === 'Bookshelf') {
        location = document.getElementById('myLibraryAddBookshelf').value;
    } else {
        location = document.getElementById('myLibraryAddOther').value;
    }

    // Replace the author assignment with:
    const authorGiven = document.getElementById('myLibraryAddAuthorGiven').value;
    const authorSurname = document.getElementById('myLibraryAddAuthorSurname').value;
    const fullAuthor = `${authorSurname}, ${authorGiven}`.trim();
    const tagsInput = document.getElementById('myLibraryAddTags').value;
    const tags = parseTagsFromString(tagsInput);

    const newBook = {
        id: generateMyLibraryId(),
        Title: document.getElementById('myLibraryAddTitle').value,
        Author: fullAuthor,
        Category: document.getElementById('myLibraryAddCategory').value,
        ISBN: document.getElementById('myLibraryAddISBN').value,
        Pages: document.getElementById('myLibraryAddPages').value,
        Location: location,
        CheckedOutDate: null,
        Patron: null,
        Tags: tags
    };

    myLibrary.push(newBook);
    saveMyLibraryData();
    renderMyLibrary();
    cancelMyLibraryAdd();
    showMessage('Book added to library successfully', CONSTANTS.MESSAGE_TYPES.SUCCESS);
}


// Edit library book
function editMyLibraryBook(id) {
    const book = myLibrary.find(b => b.id === id);
    if (!book) return;

    populateMyLibraryCategorySelects();
    populateMyLibraryBookshelfSelects();

    document.getElementById('myLibraryEditId').value = id;
    document.getElementById('myLibraryEditTitle').value = book.Title;
    document.getElementById('myLibraryEditAuthor').value = book.Author;
    document.getElementById('myLibraryEditCategory').value = book.Category || '';
    document.getElementById('myLibraryEditISBN').value = book.ISBN || '';
    document.getElementById('myLibraryEditPages').value = book.Pages || '';
    document.getElementById('myLibraryEditPatron').value = book.Patron || '';
    document.getElementById('myLibraryEditCheckedOutDate').value = book.CheckedOutDate || '';
    document.getElementById('myLibraryEditTags').value = tagsToString(book.Tags || []);

    // Handle location
    const isBookshelf = MY_LIBRARY_BOOKSHELVES.includes(book.Location);
    document.getElementById('myLibraryEditLocationType').value = isBookshelf ? 'Bookshelf' : 'Other';
    updateMyLibraryLocationFields('Edit');

    if (isBookshelf) {
        document.getElementById('myLibraryEditBookshelf').value = book.Location;
    } else {
        document.getElementById('myLibraryEditOther').value = book.Location;
    }

    document.getElementById('myLibraryEditModal').style.display = 'block';
}


// Save edit and return to library view
function saveMyLibraryEdit(event) {
    event.preventDefault();

    const id = document.getElementById('myLibraryEditId').value;
    const book = myLibrary.find(b => b.id === id);
    if (!book) return;

    const locationType = document.getElementById('myLibraryEditLocationType').value;
    let location;
    if (locationType === 'Bookshelf') {
        location = document.getElementById('myLibraryEditBookshelf').value;
    } else {
        location = document.getElementById('myLibraryEditOther').value;
    }

    const tagsInput = document.getElementById('myLibraryEditTags').value;
    const tags = parseTagsFromString(tagsInput);

    book.Title = document.getElementById('myLibraryEditTitle').value;
    book.Author = document.getElementById('myLibraryEditAuthor').value;
    book.Category = document.getElementById('myLibraryEditCategory').value;
    book.ISBN = document.getElementById('myLibraryEditISBN').value;
    book.Pages = document.getElementById('myLibraryEditPages').value;
    book.Location = location;
    book.Patron = document.getElementById('myLibraryEditPatron').value || null;
    book.CheckedOutDate = document.getElementById('myLibraryEditCheckedOutDate').value || null;
    book.Tags = tags;

    saveMyLibraryData();
    document.getElementById('myLibraryEditModal').style.display = 'none';
    renderMyLibrary();
    showMessage('Library book updated successfully', CONSTANTS.MESSAGE_TYPES.SUCCESS);
}


// Process checkout and return to library view
function processMyLibraryCheckout(event) {
    event.preventDefault();

    const id = document.getElementById('myLibraryCheckoutId').value;
    const patron = document.getElementById('myLibraryCheckoutPatron').value;
    const book = myLibrary.find(b => b.id === id);

    if (!book) return;

    book.Patron = patron;
    book.CheckedOutDate = new Date().toISOString().split('T')[0];

    // Check if this book is already on the reading list and remove it
    const existingReadingListIndex = readingList.findIndex(item => item.MyLibraryId === book.id);
    if (existingReadingListIndex !== -1) {
        const existingBook = readingList[existingReadingListIndex];
        const existingRank = existingBook.Rank;

        // Remove the existing item
        readingList.splice(existingReadingListIndex, 1);

        // Shift ranks up if the removed item had a rank
        if (existingRank) {
            readingList.forEach(item => {
                if (item.Rank && item.Rank > existingRank) {
                    item.Rank--;
                }
            });
        }
    }

    // Add to reading list at top with checkout annotation
    const newReadingListItem = {
        [CONSTANTS.BOOK_FIELDS.ID]: generateReadingListId(),
        [CONSTANTS.BOOK_FIELDS.TITLE]: book.Title,
        [CONSTANTS.BOOK_FIELDS.AUTHOR]: book.Author,
        Source: `My Library (C/O ${patron})`,
        Rank: 1,
        IsCheckedOut: true,
        MyLibraryId: book.id
    };

    // Shift all existing ranked items down by 1
    readingList.forEach(item => {
        if (item.Rank) {
            item.Rank++;
        }
    });

    readingList.unshift(newReadingListItem);

    saveMyLibraryData();
    saveReadingListData();
    document.getElementById('myLibraryCheckoutModal').style.display = 'none';
    renderMyLibrary();
    showMessage(`"${book.Title}" checked out to ${patron} and added to reading list`, CONSTANTS.MESSAGE_TYPES.SUCCESS);
}


// Cancel edit
function cancelMyLibraryEdit() {
    document.getElementById('myLibraryEditModal').style.display = 'none';
}


// Delete book
async function deleteMyLibraryBook() {
    const id = document.getElementById('myLibraryEditId').value;
    const book = myLibrary.find(b => b.id === id);

    if (!book) return;

    const confirmed = await confirmDialog(`⚠️ DELETE BOOK?\n\nTitle: "${book.Title}"\nAuthor: ${book.Author}\n\nThis cannot be undone.`);

    if (confirmed) {
        const index = myLibrary.findIndex(b => b.id === id);
        myLibrary.splice(index, 1);
        saveMyLibraryData();
        renderMyLibrary();
        cancelMyLibraryEdit();
        showMessage(`"${book.Title}" deleted from library`, CONSTANTS.MESSAGE_TYPES.SUCCESS);
    }
}


// Show checkout modal
function showMyLibraryCheckout(id) {
    const book = myLibrary.find(b => b.id === id);
    if (!book) return;

    document.getElementById('myLibraryCheckoutId').value = id;
    document.getElementById('myLibraryCheckoutBookInfo').innerHTML = `
        <p><strong>Title:</strong> ${book.Title}</p>
        <p><strong>Author:</strong> ${book.Author}</p>
        <p><strong>Location:</strong> ${book.Location}</p>
    `;
    document.getElementById('myLibraryCheckoutPatron').value = '';
    document.getElementById('myLibraryCheckoutModal').style.display = 'block';
}


// Cancel checkout
function cancelMyLibraryCheckout() {
    document.getElementById('myLibraryCheckoutModal').style.display = 'none';
}


// Add to reading list
function addMyLibraryToReadingList(id) {
    const book = myLibrary.find(b => b.id === id);
    if (!book) return;

    // Find the lowest rank to add this book at the end
    const rankedBooks = readingList.filter(b => b.Rank);
    const highestRank = rankedBooks.length > 0 ? Math.max(...rankedBooks.map(b => b.Rank)) : 0;

    const newReadingListItem = {
        [CONSTANTS.BOOK_FIELDS.ID]: generateReadingListId(),
        [CONSTANTS.BOOK_FIELDS.TITLE]: book.Title,
        [CONSTANTS.BOOK_FIELDS.AUTHOR]: book.Author,
        Source: 'My Library',
        Rank: highestRank + 1,
        MyLibraryId: book.id
    };

    readingList.push(newReadingListItem);
    saveReadingListData();
    renderMyLibrary(); // Re-render to hide the "To Read" button
    showMessage(`"${book.Title}" added to reading list`, CONSTANTS.MESSAGE_TYPES.SUCCESS);
}


// Render my library table
function renderMyLibrary() {
    const tbody = document.getElementById('myLibraryTableBody');
    let filteredBooks = applyCurrentMyLibraryFilters([...myLibrary]);
    let sortedBooks = applyMyLibrarySortAndGroup(filteredBooks);

    tbody.innerHTML = '';

    if (currentMyLibrarySort.group) {
        renderGroupedMyLibraryBooks(sortedBooks, tbody);
    } else {
        sortedBooks.forEach(book => {
            const row = createMyLibraryRow(book);
            tbody.appendChild(row);
        });
    }
    updateMyLibraryTableHeaders();
}


function createMyLibraryRow(book) {
    const row = document.createElement('tr');
    row.onclick = () => editMyLibraryBook(book.id);

    // Add context menu for ISBN lookup
    row.oncontextmenu = async (e) => {
        e.preventDefault();
        if (await confirmDialog(`Look up ISBN information for "${book.Title}"?`)) {
            lookupMyLibraryBookISBN(book.id);
        }
    };

    const checkedOutStatus = book.Patron ? `C/O ${book.Patron}` : 'Available';
    const hasISBN = book.ISBN ? '📚' : '❓';

    // Check if this book is already on the reading list
    const isOnReadingList = readingList.some(item => item.MyLibraryId === book.id);

    row.innerHTML = `
        <td>${book.Title} ${hasISBN}</td>
        <td>${book.Author}</td>
        <td>${book.Category || ''}</td>
        <td>${checkedOutStatus}</td>
        <td onclick="event.stopPropagation()">
            ${(!book.Patron && !isOnReadingList) ? `<button class="btn btn-small btn-secondary" onclick="addMyLibraryToReadingList('${book.id}')">To Read</button>` : ''}
            ${!book.Patron ? `<button class="btn btn-small btn-primary" onclick="showMyLibraryCheckout('${book.id}')">C/O</button>` : ''}
            ${book.Patron ? `<button class="btn btn-small btn-primary" onclick="checkInMyLibraryBook('${book.id}')">C/I</button>` : ''}
        </td>
    `;

    return row;
}


// Apply sorting and grouping
function applyMyLibrarySortAndGroup(books) {
    const sorted = [...books].sort((a, b) => {
        let aVal = a[currentMyLibrarySort.field] || '';
        let bVal = b[currentMyLibrarySort.field] || '';

        // Handle special cases
        if (currentMyLibrarySort.field === 'CheckedOut') {
            aVal = a.Patron ? `C/O ${a.Patron}` : 'Available';
            bVal = b.Patron ? `C/O ${b.Patron}` : 'Available';
        }

        if (aVal < bVal) return currentMyLibrarySort.direction === 'asc' ? -1 : 1;
        if (aVal > bVal) return currentMyLibrarySort.direction === 'asc' ? 1 : -1;
        return 0;
    });

    if (currentMyLibrarySort.group) {
        const grouped = {};
        sorted.forEach(book => {
            let groupValue = book[currentMyLibrarySort.field] || '';
            if (currentMyLibrarySort.field === 'CheckedOut') {
                groupValue = book.Patron ? 'Checked Out' : 'Available';
            }
            if (!grouped[groupValue]) {
                grouped[groupValue] = [];
            }
            grouped[groupValue].push(book);
        });
        return grouped;
    }

    return sorted;
}


// Render grouped books
function renderGroupedMyLibraryBooks(groupedBooks, tbody) {
    for (const [groupValue, groupBooks] of Object.entries(groupedBooks)) {
        const headerRow = document.createElement('tr');
        headerRow.innerHTML = `<td colspan="5" class="group-header">${currentMyLibrarySort.field}: ${groupValue || 'Empty'} (${groupBooks.length} books)</td>`;
        tbody.appendChild(headerRow);

        groupBooks.forEach(book => {
            const row = createMyLibraryRow(book);
            tbody.appendChild(row);
        });
    }
}


// Update table headers
function updateMyLibraryTableHeaders() {
    const thead = document.querySelector('#myLibraryHeaderTable thead tr');
    const fields = ['Title', 'Author', 'Category', 'CheckedOut'];

    const headers = fields.map(field => {
        const isActive = currentMyLibrarySort.field === field;
        let indicator = '';

        if (isActive) {
            const arrow = currentMyLibrarySort.direction === 'asc' ? '▲' : '▼';
            indicator = `<span class="sort-indicator">${arrow}</span>`;
        }

        const displayName = field === 'CheckedOut' ? 'Status' : field;
        return `<th onclick="showMyLibrarySortDropdown(event, '${field}')">${displayName}${indicator}</th>`;
    }).join('');

    thead.innerHTML = headers + '<th>Actions</th>';
}


// Show sort dropdown
function showMyLibrarySortDropdown(event, field) {
    const DROPDOWN_CLOSE_DELAY = 10;
    event.stopPropagation();

    const existingDropdown = document.querySelector('.sort-dropdown');
    if (existingDropdown) {
        existingDropdown.remove();
    }

    const dropdown = document.createElement('div');
    dropdown.className = 'sort-dropdown';
    dropdown.innerHTML = `
        <div class="sort-option" onclick="sortMyLibrary('${field}', 'desc', false)">Descending Sort</div>
        <div class="sort-option" onclick="sortMyLibrary('${field}', 'asc', false)">Ascending Sort</div>
        <div class="sort-option" onclick="sortMyLibrary('${field}', 'desc', true)">Descending Group</div>
        <div class="sort-option" onclick="sortMyLibrary('${field}', 'asc', true)">Ascending Group</div>
    `;

    const th = event.target;
    th.style.position = 'relative';
    th.appendChild(dropdown);

    setTimeout(() => {
        document.addEventListener('click', function closeDropdown() {
            dropdown.remove();
            document.removeEventListener('click', closeDropdown);
        });
    }, DROPDOWN_CLOSE_DELAY);
}

// Sort library
function sortMyLibrary(field, direction, group) {
    currentMyLibrarySort = { field, direction, group };
    renderMyLibrary();
}

// Filter functions
function showMyLibraryFilter() {
    document.getElementById('myLibraryFilterPanel').style.display = 'block';
    setupMyLibraryFilterControls();
}

function hideMyLibraryFilter() {
    document.getElementById('myLibraryFilterPanel').style.display = 'none';
}

function setupMyLibraryFilterControls() {
    const container = document.getElementById('myLibraryFilterControls');
    container.innerHTML = '';

    const addButton = document.createElement('button');
    addButton.type = 'button';
    addButton.className = 'btn btn-secondary';
    addButton.onclick = () => addMyLibraryFilterRow();
    addButton.textContent = 'Add Filter';
    container.appendChild(addButton);

    if (Object.keys(currentMyLibraryFilters).length > 0) {
        Object.entries(currentMyLibraryFilters).forEach(([filterKey, filter]) => {
            addMyLibraryFilterRowWithData(filter);
        });
    } else {
        addEmptyMyLibraryFilterRow();
    }
}


function addMyLibraryFilterRowWithData(filterData) {
    const container = document.getElementById('myLibraryFilterControls');
    const addButton = container.querySelector('button[onclick*="addMyLibraryFilterRow"]');

    const filterRow = document.createElement('div');
    filterRow.className = 'filter-row';
    filterRow.innerHTML = `
        <select class="filter-field" onchange="updateMyLibraryFilterOptions(this)">
            <option value="">Select Field</option>
            <option value="Title">Title</option>
            <option value="Author">Author</option>
            <option value="Category">Category</option>
            <option value="ISBN">ISBN</option>
            <option value="Location">Location</option>
            <option value="Patron">Patron</option>
            <option value="CheckedOut">Checked Out Status</option>
        </select>
        <select class="filter-operator" disabled>
            <option value="">Select Operator</option>
        </select>
        <div class="filter-value"></div>
        <button type="button" class="btn btn-danger" onclick="removeMyLibraryFilterRow(this)">Remove</button>
    `;

    if (addButton) {
        container.insertBefore(filterRow, addButton);
    } else {
        container.appendChild(filterRow);
    }

    // Set the field value and trigger options update
    const fieldSelect = filterRow.querySelector('.filter-field');
    fieldSelect.value = filterData.field;
    updateMyLibraryFilterOptions(fieldSelect);

    // Set the operator value and trigger value update
    setTimeout(() => {
        const operatorSelect = filterRow.querySelector('.filter-operator');
        operatorSelect.value = filterData.operator;
        updateMyLibraryFilterValue(operatorSelect);

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


function addEmptyMyLibraryFilterRow() {
    const container = document.getElementById('myLibraryFilterControls');
    const addButton = container.querySelector('button[onclick*="addMyLibraryFilterRow"]');

    const filterRow = document.createElement('div');
    filterRow.className = 'filter-row';
    filterRow.innerHTML = `
        <select class="filter-field" onchange="updateMyLibraryFilterOptions(this)">
            <option value="">Select Field</option>
            <option value="Title">Title</option>
            <option value="Author">Author</option>
            <option value="Category">Category</option>
            <option value="ISBN">ISBN</option>
            <option value="Location">Location</option>
            <option value="Patron">Patron</option>
            <option value="CheckedOut">Checked Out Status</option>
        </select>
        <select class="filter-operator" disabled>
            <option value="">Select Operator</option>
        </select>
        <div class="filter-value"></div>
        <button type="button" class="btn btn-danger" onclick="removeMyLibraryFilterRow(this)">Remove</button>
    `;

    if (addButton) {
        container.insertBefore(filterRow, addButton);
    } else {
        container.appendChild(filterRow);
    }
}


function addMyLibraryFilterRow() {
    addEmptyMyLibraryFilterRow();
}

function removeMyLibraryFilterRow(button) {
    button.parentElement.remove();
}


function updateMyLibraryFilterOptions(select) {
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
    case 'Title':
    case 'Author':
    case 'Location':
    case 'Patron':
        operators = [
            { value: 'isEmpty', text: 'Is Empty' },
            { value: 'contains', text: 'Contains' }
        ];
        break;
    case 'Category':
        operators = [
            { value: 'isEmpty', text: 'Is Empty' },
            { value: 'equals', text: 'Equals' }
        ];
        break;
    case 'CheckedOut':
        operators = [
            { value: 'equals', text: 'Equals' }
        ];
        break;
    case 'ISBN':
        operators = [
            { value: 'isEmpty', text: 'Is Empty' }
        ];
        break;
    }

    operators.forEach(op => {
        const option = document.createElement('option');
        option.value = op.value;
        option.textContent = op.text;
        operatorSelect.appendChild(option);
    });

    // Auto-select default operator
    let defaultOperator = null;
    switch (field) {
    case 'Title':
    case 'Author':
    case 'Location':
    case 'Patron':
        defaultOperator = 'contains';
        break;
    case 'Category':
    case 'CheckedOut':
        defaultOperator = 'equals';
        break;
    case 'ISBN':
        defaultOperator = 'isEmpty';
        break;
    }

    if (defaultOperator) {
        operatorSelect.value = defaultOperator;
        updateMyLibraryFilterValue(operatorSelect);
    }

    operatorSelect.onchange = () => updateMyLibraryFilterValue(operatorSelect);
}


function updateMyLibraryFilterValue(operatorSelect) {
    const row = operatorSelect.parentElement;
    const valueContainer = row.querySelector('.filter-value');
    const fieldSelect = row.querySelector('.filter-field');
    const field = fieldSelect.value;
    const operator = operatorSelect.value;

    valueContainer.innerHTML = '';

    if (!operator || operator === 'isEmpty') return;

    switch (operator) {
    case 'contains':
        valueContainer.innerHTML = '<input type="text" class="filter-value-input" placeholder="Enter value">';
        break;
    case 'equals':
        if (field === 'Category') {
            generateCategoryOptions().then(opts => {
                valueContainer.innerHTML = `<select class="filter-value-input">${opts}</select>`;
            });
        } else if (field === 'CheckedOut') {
            valueContainer.innerHTML = `
                <select class="filter-value-input">
                    <option value="">Select</option>
                    <option value="Available">Available</option>
                    <option value="Checked Out">Checked Out</option>
                </select>
            `;
        }
        break;
    }
}

function applyMyLibraryFilters() {
    const filterRows = document.querySelectorAll('#myLibraryFilterControls .filter-row');
    currentMyLibraryFilters = {};

    filterRows.forEach((row, index) => {
        const field = row.querySelector('.filter-field').value;
        const operator = row.querySelector('.filter-operator').value;
        const valueInputs = row.querySelectorAll('.filter-value-input');

        if (field && operator) {
            currentMyLibraryFilters[`filter_${index}`] = {
                field,
                operator,
                values: Array.from(valueInputs).map(input => input.value)
            };
        }
    });

    document.getElementById('myLibraryQuickSearch').value = '';
    const filteredBooks = applyCurrentMyLibraryFilters([...myLibrary]);
    showMessage(`Filter applied: ${filteredBooks.length} of ${myLibrary.length} books match the criteria`, CONSTANTS.MESSAGE_TYPES.SUCCESS);
    renderMyLibrary();
    hideMyLibraryFilter();
}

function clearMyLibraryFilters() {
    currentMyLibraryFilters = {};
    document.getElementById('myLibraryQuickSearch').value = '';
    showMessage(`Filters cleared: showing all ${myLibrary.length} books`, CONSTANTS.MESSAGE_TYPES.INFO);
    renderMyLibrary();
    hideMyLibraryFilter();
}


function applyCurrentMyLibraryFilters(books) {
    if (Object.keys(currentMyLibraryFilters).length === 0) {
        return books;
    }

    return books.filter(book => {
        return Object.values(currentMyLibraryFilters).every(filter => {
            if (filter.field === 'all') {
                // Handle text search
                const searchTerm = filter.values[0];
                let textMatch = true;

                if (searchTerm && searchTerm.trim()) {
                    const searchableFields = [book.Title, book.Author, book.Category, book.Location, book.Patron].join(' ').toLowerCase();
                    textMatch = searchableFields.includes(searchTerm);
                }

                // Handle tag search (AND logic)
                let tagMatch = true;
                if (filter.tags && filter.tags.length > 0) {
                    const bookTags = book.Tags || [];
                    tagMatch = filter.tags.every(searchTag =>
                        bookTags.some(bookTag => bookTag.includes(searchTag))
                    );
                }

                return textMatch && tagMatch;
            }

            // Existing filter logic
            let fieldValue = book[filter.field] || '';
            if (filter.field === 'CheckedOut') {
                fieldValue = book.Patron ? 'Checked Out' : 'Available';
            }

            switch (filter.operator) {
            case 'isEmpty':
                return fieldValue === '' || fieldValue === null || fieldValue === undefined;
            case 'contains':
                return fieldValue.toLowerCase().includes((filter.values[0] || '').toLowerCase());
            case 'equals':
                return fieldValue === filter.values[0];
            default:
                return true;
            }
        });
    });
}


// Quick search
let myLibraryQuickSearchTimeout;
function handleMyLibraryQuickSearch(searchTerm) {
    const QUICK_SEARCH_DELAY = 300;
    clearTimeout(myLibraryQuickSearchTimeout);
    myLibraryQuickSearchTimeout = setTimeout(() => {
        performMyLibraryQuickSearch(searchTerm);
    }, QUICK_SEARCH_DELAY);
}


function performMyLibraryQuickSearch(searchTerm) {
    if (!searchTerm.trim()) {
        currentMyLibraryFilters = {};
        renderMyLibrary();
        showMessage('Search cleared', CONSTANTS.MESSAGE_TYPES.INFO);
        return;
    }

    // Parse search term for tags and regular text
    const searchParts = searchTerm.toLowerCase().split(/\s+/);
    const tagQueries = [];
    const textQueries = [];

    searchParts.forEach(part => {
        if (part.startsWith('#') && part.length > 1) {
            tagQueries.push(part.substring(1));
        } else if (part.trim()) {
            textQueries.push(part);
        }
    });

    currentMyLibraryFilters = {
        quickSearch: {
            field: 'all',
            operator: 'contains',
            values: [textQueries.join(' ')],
            tags: tagQueries
        }
    };

    const filteredBooks = applyCurrentMyLibraryFilters([...myLibrary]);
    showMessage(`Quick search: ${filteredBooks.length} of ${myLibrary.length} books found`, CONSTANTS.MESSAGE_TYPES.SUCCESS);
    renderMyLibrary();
}


// Add this helper function to properly parse CSV content
function parseCSVContent(csvText) {
    const result = [];
    const lines = csvText.split(/\r?\n/);

    for (let line of lines) {
        line = line.trim();
        if (!line) continue;

        const row = [];
        let currentField = '';
        let inQuotes = false;
        let i = 0;

        while (i < line.length) {
            const char = line[i];

            if (char === '"') {
                if (inQuotes && line[i + 1] === '"') {
                    // Handle escaped quotes ("")
                    currentField += '"';
                    i += 2;
                } else {
                    // Toggle quote state
                    inQuotes = !inQuotes;
                    i++;
                }
            } else if (char === ',' && !inQuotes) {
                // Field separator
                row.push(currentField.trim());
                currentField = '';
                i++;
            } else {
                // Regular character
                currentField += char;
                i++;
            }
        }

        // Add the last field
        row.push(currentField.trim());
        result.push(row);
    }

    return result;
}


// Export functions
function toggleMyLibraryExportDropdown() {
    document.getElementById("myLibraryExportDropdownContent").parentElement.classList.toggle("show");
}

function exportMyLibraryData() {
    const filteredBooks = applyCurrentMyLibraryFilters([...myLibrary]);
    const metadata = {
        timestamp: new Date().toISOString(),
        totalBooksInLibrary: myLibrary.length,
        filteredBooks: filteredBooks.length
    };

    const dataToExport = {
        exportInfo: metadata,
        MyLibrary: filteredBooks
    };

    const dataStr = JSON.stringify(dataToExport, null, 2);
    const blob = new Blob([dataStr], { type: 'application/json' });
    const filename = generateTimestampedFilename('my_library', 'json');

    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    showMessage(`Library data exported: ${filteredBooks.length} books saved to ${filename}`, CONSTANTS.MESSAGE_TYPES.SUCCESS);
}

function exportMyLibraryCSV() {
    const filteredBooks = applyCurrentMyLibraryFilters([...myLibrary]);
    const headers = ['Title', 'Author', 'Category', 'ISBN', 'Pages', 'Location', 'Patron', 'CheckedOutDate'];

    let csvContent = headers.join(',') + '\n';

    filteredBooks.forEach(book => {
        const row = [
            escapeCSV(book.Title),
            escapeCSV(book.Author),
            escapeCSV(book.Category),
            escapeCSV(book.ISBN),
            escapeCSV(book.Pages),
            escapeCSV(book.Location),
            escapeCSV(book.Patron),
            escapeCSV(book.CheckedOutDate)
        ];
        csvContent += row.join(',') + '\n';
    });

    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const filename = generateTimestampedFilename('my_library', 'csv');

    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    showMessage(`Library CSV exported: ${filteredBooks.length} books saved to ${filename}`, CONSTANTS.MESSAGE_TYPES.SUCCESS);
}


// Migration function
function migrateMyLibraryItems() {
    let migrated = 0;
    myLibrary.forEach(book => {
        if (!book.id) {
            book.id = generateMyLibraryId();
            migrated++;
        }
    });

    if (migrated > 0) {
        saveMyLibraryData();
        showMessage(`Migrated ${migrated} library items to include unique IDs`, CONSTANTS.MESSAGE_TYPES.INFO);
    }
}


// Event listeners
document.addEventListener('DOMContentLoaded', function() {
    const addForm = document.getElementById('myLibraryAddForm');
    if (addForm) {
        addForm.addEventListener('submit', addToMyLibrary);
    }

    const editForm = document.getElementById('myLibraryEditForm');
    if (editForm) {
        editForm.addEventListener('submit', saveMyLibraryEdit);
    }

    const checkoutForm = document.getElementById('myLibraryCheckoutForm');
    if (checkoutForm) {
        checkoutForm.addEventListener('submit', processMyLibraryCheckout);
    }

    const categorySelectForm = document.getElementById('myLibraryCategorySelectForm');
    if (categorySelectForm) {
        categorySelectForm.addEventListener('submit', proceedWithCategorySelection);
    }
});


async function clearAllMyLibraryBooks() {
    if (myLibrary.length === 0) {
        showMessage('Library is already empty', CONSTANTS.MESSAGE_TYPES.INFO);
        return;
    }

    const confirmed = await confirmDialog(`⚠️ CLEAR ALL LIBRARY BOOKS?\n\nThis will delete all ${myLibrary.length} books from your library.\n\nThis action cannot be undone.\n\nAre you sure?`);

    if (confirmed) {
        const deletedCount = myLibrary.length;
        myLibrary = [];
        saveMyLibraryData();
        renderMyLibrary();
        showMessage(`All ${deletedCount} books cleared from library`, CONSTANTS.MESSAGE_TYPES.SUCCESS);
    }
}

let selectedImportCategory = null;

// Start the CSV import process with category selection
async function startMyLibraryCSVImport() {
    const categorySelect = document.getElementById('myLibraryImportCategory');
    if (categorySelect) {
        categorySelect.innerHTML = await generateCategoryOptions();
    }
    document.getElementById('myLibraryCategorySelectModal').style.display = 'block';
}

// Handle category selection and proceed to file selection
function proceedWithCategorySelection(event) {
    event.preventDefault();

    selectedImportCategory = document.getElementById('myLibraryImportCategory').value;

    if (!selectedImportCategory) {
        showMessage('Please select a category', CONSTANTS.MESSAGE_TYPES.ERROR);
        return;
    }

    // Hide the modal
    document.getElementById('myLibraryCategorySelectModal').style.display = 'none';

    // Trigger file selection
    document.getElementById('importMyLibraryFile').click();
}

// Cancel category selection
function cancelMyLibraryCategorySelect() {
    document.getElementById('myLibraryCategorySelectModal').style.display = 'none';
    selectedImportCategory = null;
}

// Updated CSV import function that uses the selected category
function importMyLibraryCSV() {
    const file = document.getElementById('importMyLibraryFile').files[0];
    if (!file) return;

    // Check if we have a selected category
    if (!selectedImportCategory) {
        showMessage('No category selected for import', CONSTANTS.MESSAGE_TYPES.ERROR);
        return;
    }

    const reader = new FileReader();
    reader.onload = function(e) {
        try {
            const csvContent = e.target.result;

            // Use a proper CSV parser that handles quotes
            const parsedData = parseCSVContent(csvContent);

            if (parsedData.length === 0) {
                showMessage('No data found in CSV file', CONSTANTS.MESSAGE_TYPES.ERROR);
                return;
            }

            const headers = parsedData[0];

            // Validate headers
            const requiredHeaders = ['Title', 'Author', 'ISBN', 'Location'];
            const missingHeaders = requiredHeaders.filter(h => !headers.includes(h));
            if (missingHeaders.length > 0) {
                showMessage(`Missing required headers: ${missingHeaders.join(', ')}`, CONSTANTS.MESSAGE_TYPES.ERROR);
                return;
            }

            let imported = 0;
            for (let i = 1; i < parsedData.length; i++) {
                const values = parsedData[i];
                if (values.length === 0) continue;

                const book = {
                    id: generateMyLibraryId(),
                    Title: values[headers.indexOf('Title')] || '',
                    Author: values[headers.indexOf('Author')] || '',
                    Category: selectedImportCategory, // Use the selected category
                    ISBN: values[headers.indexOf('ISBN')] || '',
                    Pages: headers.includes('Pages') ? (values[headers.indexOf('Pages')] || '') : '',
                    Location: values[headers.indexOf('Location')] || '',
                    CheckedOutDate: null,
                    Patron: null
                };

                if (book.Title && book.Author) {
                    myLibrary.push(book);
                    imported++;
                }
            }

            saveMyLibraryData();
            renderMyLibrary();
            showMessage(`Imported ${imported} books to library with category "${selectedImportCategory}"`, CONSTANTS.MESSAGE_TYPES.SUCCESS);

            // Reset the selected category
            selectedImportCategory = null;

        } catch (error) {
            showMessage('Error parsing CSV file: ' + error.message, CONSTANTS.MESSAGE_TYPES.ERROR);
            selectedImportCategory = null;
        }

        document.getElementById('importMyLibraryFile').value = '';
    };
    reader.readAsText(file);
}


// Individual book ISBN lookup for My Library
async function lookupMyLibraryBookISBN(id) {
    await lookupBookISBNGeneric(id, myLibrary, saveMyLibraryData, renderMyLibrary);
}

// Bulk ISBN lookup for My Library
async function bulkMyLibraryISBNLookup() {
    await bulkISBNLookupGeneric(myLibrary, saveMyLibraryData, renderMyLibrary, "My Library");
}


async function checkInMyLibraryBook(id) {
    const book = myLibrary.find(b => b.id === id);
    if (!book || !book.Patron) return;

    const patron = book.Patron;
    const confirmed = await confirmDialog(`Check in "${book.Title}" from ${patron}?`);

    if (confirmed) {
        // Clear checkout information
        book.Patron = null;
        book.CheckedOutDate = null;

        // Remove from reading list if it's there as a checked-out item
        const readingListIndex = readingList.findIndex(item =>
            item.MyLibraryId === book.id && item.IsCheckedOut
        );

        if (readingListIndex !== -1) {
            const readingListBook = readingList[readingListIndex];
            const bookRank = readingListBook.Rank;

            // Remove from reading list
            readingList.splice(readingListIndex, 1);

            // Shift ranks up if necessary
            if (bookRank) {
                readingList.forEach(item => {
                    if (item.Rank && item.Rank > bookRank) {
                        item.Rank--;
                    }
                });
            }

            saveReadingListData();
        }

        saveMyLibraryData();
        renderMyLibrary();
        showMessage(`"${book.Title}" checked in successfully`, CONSTANTS.MESSAGE_TYPES.SUCCESS);
    }
}
