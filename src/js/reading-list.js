// reading_list.js - Reading List functionality

// Generate unique ID for reading list items
function generateReadingListId() {
    return generateBookId(); // Reuse the existing UUID function
}

// Add book to reading list
function addToReadingList(event) {
    event.preventDefault();
    const formData = new FormData(event.target);

    const rankInput = formData.get('rank');
    let rank = null;

    // Validate rank if provided
    if (rankInput) {
        const requestedRank = parseInt(rankInput);
        const maxRank = readingList.filter(b => b.Rank).length + 1;

        if (requestedRank < 1) {
            showMessage('Rank must be 1 or higher', CONSTANTS.MESSAGE_TYPES.ERROR);
            return;
        }

        if (requestedRank > maxRank) {
            showMessage(`Rank cannot exceed ${maxRank} (current max + 1)`, CONSTANTS.MESSAGE_TYPES.ERROR);
            return;
        }

        rank = requestedRank;
    }

    // Replace the author assignment with:
    const authorGiven = formData.get('authorGiven') || '';
    const authorSurname = formData.get('authorSurname') || '';
    const fullAuthor = formatAuthorName(authorSurname, authorGiven);

    const newBook = {
        [CONSTANTS.BOOK_FIELDS.ID]: generateReadingListId(),
        [CONSTANTS.BOOK_FIELDS.TITLE]: formData.get('title'),
        [CONSTANTS.BOOK_FIELDS.AUTHOR]: fullAuthor,
        Source: formData.get('source')?.trim() || 'Other',
        Rank: rank,
        MyLibraryId: null  // No My Library ID for manual entries
    };

    // Handle rank insertion logic
    if (newBook.Rank) {
        insertBookAtRank(newBook);
    } else {
        readingList.push(newBook);
    }

    saveReadingListData();
    renderReadingList();
    event.target.reset();

    showMessage('Book added to reading list successfully', CONSTANTS.MESSAGE_TYPES.SUCCESS);
}


function validateReadingListRank(input) {
    const maxRank = readingList.filter(b => b.Rank).length + 1;
    input.setAttribute('max', maxRank);
    input.setAttribute('title', `Maximum rank allowed: ${maxRank}`);
}


// Insert book at specific rank, shifting others down
function insertBookAtRank(newBook) {
    const targetRank = newBook.Rank;

    // Shift existing books at or below target rank down by 1
    readingList.forEach(book => {
        if (book.Rank && book.Rank >= targetRank) {
            book.Rank++;
        }
    });

    readingList.push(newBook);
}

// Render the reading list
function renderReadingList() {
    const container = document.getElementById('readingListContainer');

    if (!container.dataset.delegated) {
        container.addEventListener('click', handleReadingListContainerClick);
        container.dataset.delegated = 'true';
    }

    if (readingList.length === 0) {
        container.innerHTML = '<p class="placeholder-content">No books in reading list yet.</p>';
        return;
    }

    // Sort by rank (ranked items first, then unranked)
    const sortedList = [...readingList].sort((a, b) => {
        if (a.Rank && b.Rank) return a.Rank - b.Rank;
        if (a.Rank && !b.Rank) return -1;
        if (!a.Rank && b.Rank) return 1;
        return 0; // Both unranked, maintain current order
    });

    const html = sortedList.map((book, index) => createReadingListItem(book, index)).join('');
    container.innerHTML = html;
    initializeDragAndDrop();
}


// Create individual reading list item HTML
function createReadingListItem(book, index) {
    const rankDisplay = book.Rank || 'Unranked';
    const id = book[CONSTANTS.BOOK_FIELDS.ID];

    // Only show Finished button for ranked books
    const finishedButton = book.Rank ?
        `<button class="btn btn-small btn-primary" data-action="finish">Finished</button>` : '';

    return `
        <div class="reading-list-item" data-id="${escapeHtml(id)}" draggable="true">
            <div class="book-info">
                <div class="drag-handle">⋮⋮</div>
                <div class="book-rank">${escapeHtml(rankDisplay)}</div>
                <div class="book-details">
                    <div class="book-title">${escapeHtml(book[CONSTANTS.BOOK_FIELDS.TITLE])}</div>
                    <div class="book-author">by ${escapeHtml(book[CONSTANTS.BOOK_FIELDS.AUTHOR])}</div>
                    <div class="book-source">Source: ${escapeHtml(book.Source)}</div>
                </div>
            </div>
            <div class="book-controls">
                ${finishedButton}
                <button class="btn btn-small btn-secondary" data-action="edit">Edit</button>
                <button class="btn btn-small btn-danger" data-action="remove">Remove</button>
            </div>
        </div>
    `;
}

// Delegated click handler for reading list item action buttons
function handleReadingListContainerClick(event) {
    const actionBtn = event.target.closest('[data-action]');
    if (!actionBtn) return;
    const itemEl = event.target.closest('[data-id]');
    if (!itemEl) return;

    const id = itemEl.dataset.id;
    const action = actionBtn.dataset.action;

    if (action === 'finish') startFinishingBook(id);
    else if (action === 'edit') editReadingListItem(id);
    else if (action === 'remove') removeReadingListItem(id);
}


// Move item up or down in ranking
function moveReadingListItem(id, direction) {
    const book = readingList.find(b => b[CONSTANTS.BOOK_FIELDS.ID] === id);
    if (!book || !book.Rank) return;

    const currentRank = book.Rank;
    let targetRank;

    if (direction === 'up' && currentRank > 1) {
        targetRank = currentRank - 1;
    } else if (direction === 'down') {
        targetRank = currentRank + 1;
    } else {
        return;
    }

    // Find the book at target rank and swap
    const targetBook = readingList.find(b => b.Rank === targetRank);
    if (targetBook) {
        targetBook.Rank = currentRank;
    }
    book.Rank = targetRank;

    saveReadingListData();
    renderReadingList();
}


// Edit reading list item
function editReadingListItem(id) {
    const book = readingList.find(b => b[CONSTANTS.BOOK_FIELDS.ID] === id);
    if (!book) return;

    // Calculate the maximum rank (excluding the current book if it has a rank)
    const otherRankedBooks = readingList.filter(b =>
        b[CONSTANTS.BOOK_FIELDS.ID] !== id && b.Rank
    );
    const maxRank = otherRankedBooks.length > 0 ?
        Math.max(...otherRankedBooks.map(b => b.Rank)) : 0;
    const maxAllowedRank = maxRank + 1;

    // Populate the modal form
    document.getElementById('editReadingListId').value = id;
    document.getElementById('editReadingListTitle').value = book[CONSTANTS.BOOK_FIELDS.TITLE];
    document.getElementById('editReadingListAuthor').value = book[CONSTANTS.BOOK_FIELDS.AUTHOR];
    document.getElementById('editReadingListSource').value = book.Source || '';
    document.getElementById('editReadingListRank').value = book.Rank || '';

    // Set the max attribute on the rank input
    const rankInput = document.getElementById('editReadingListRank');
    rankInput.setAttribute('max', maxAllowedRank);
    rankInput.setAttribute('title', `Maximum rank allowed: ${maxAllowedRank}`);

    // Show the modal
    document.getElementById('readingListEditModal').style.display = 'block';
}


function clearRank() {
    document.getElementById('editReadingListRank').value = '';
}


function saveReadingListEdit(event) {
    event.preventDefault();

    const id = document.getElementById('editReadingListId').value;
    const book = readingList.find(b => b[CONSTANTS.BOOK_FIELDS.ID] === id);
    if (!book) return;

    const newTitle = document.getElementById('editReadingListTitle').value;
    const newAuthor = document.getElementById('editReadingListAuthor').value;
    const newSource = document.getElementById('editReadingListSource').value.trim() || 'Other';
    const newRankStr = document.getElementById('editReadingListRank').value;
    const newRank = newRankStr ? parseInt(newRankStr) : null;

    // Handle rank changes
    if (book.Rank !== newRank) {
        if (book.Rank) {
            // Remove from old rank position
            readingList.forEach(b => {
                if (b[CONSTANTS.BOOK_FIELDS.ID] !== id && b.Rank && b.Rank > book.Rank) {
                    b.Rank--;
                }
            });
        }

        book.Rank = newRank;

        if (newRank) {
            // Insert at new rank position
            readingList.forEach(b => {
                if (b[CONSTANTS.BOOK_FIELDS.ID] !== id && b.Rank && b.Rank >= newRank) {
                    b.Rank++;
                }
            });
        }
    }

    // Update book properties
    book[CONSTANTS.BOOK_FIELDS.TITLE] = newTitle;
    book[CONSTANTS.BOOK_FIELDS.AUTHOR] = newAuthor;
    book.Source = newSource;

    // Close modal and update display
    document.getElementById('readingListEditModal').style.display = 'none';
    saveReadingListData();
    renderReadingList();
    showMessage('Reading list item updated', CONSTANTS.MESSAGE_TYPES.SUCCESS);
}


function cancelReadingListEdit() {
    document.getElementById('readingListEditModal').style.display = 'none';
}

// Add event listener for the form submission
document.addEventListener('DOMContentLoaded', function() {
    const editForm = document.getElementById('readingListEditForm');
    if (editForm) {
        editForm.addEventListener('submit', saveReadingListEdit);
    }
});


// Remove reading list item
async function removeReadingListItem(id) {
    const book = readingList.find(b => b[CONSTANTS.BOOK_FIELDS.ID] === id);
    if (!book) return;

    const confirmed = await confirmDialog(`Remove "${book.Title}" from reading list?`);
    if (!confirmed) return;

    const bookRank = book.Rank;

    // Remove book
    const index = readingList.findIndex(b => b[CONSTANTS.BOOK_FIELDS.ID] === id);
    readingList.splice(index, 1);

    // Shift ranks up if necessary
    if (bookRank) {
        readingList.forEach(b => {
            if (b.Rank && b.Rank > bookRank) {
                b.Rank--;
            }
        });
    }

    if (readingList.length === 0) {
        clearReadingListData();
    } else {
        saveReadingListData();
    }
    renderReadingList();
    showMessage(`"${book[CONSTANTS.BOOK_FIELDS.TITLE]}" removed from reading list`,
                CONSTANTS.MESSAGE_TYPES.SUCCESS);
}


// Migration function for existing reading list items
function migrateReadingListItems() {
    let migrated = 0;
    readingList.forEach(book => {
        if (!book[CONSTANTS.BOOK_FIELDS.ID]) {
            book[CONSTANTS.BOOK_FIELDS.ID] = generateReadingListId();
            migrated++;
        }
    });

    if (migrated > 0) {
        saveReadingListData();
        showMessage(`Migrated ${migrated} reading list items to include unique IDs`, CONSTANTS.MESSAGE_TYPES.INFO);
    }
}


// Drag and drop functionality
let draggedItem = null;

function initializeDragAndDrop() {
    const container = document.getElementById('readingListContainer');

    if (container.dataset.dragInitialized) return;

    container.addEventListener('dragstart', handleDragStart);
    container.addEventListener('dragover', handleDragOver);
    container.addEventListener('drop', handleDrop);
    container.addEventListener('dragend', handleDragEnd);

    container.dataset.dragInitialized = 'true';
}

function handleDragStart(e) {
    if (e.target.classList.contains('reading-list-item')) {
        draggedItem = e.target;
        e.target.style.opacity = '0.5';
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/html', e.target.outerHTML);
    }
}

function handleDragOver(e) {
    if (e.preventDefault) {
        e.preventDefault();
    }
    e.dataTransfer.dropEffect = 'move';

    // Add visual feedback
    const target = e.target.closest('.reading-list-item');
    if (target && target !== draggedItem) {
        target.classList.add('drag-over');
    }

    return false;
}

function handleDrop(e) {
    if (e.stopPropagation) {
        e.stopPropagation();
    }

    const target = e.target.closest('.reading-list-item');
    if (target && target !== draggedItem) {
        const draggedId = draggedItem.dataset.id;
        const targetId = target.dataset.id;

        reorderReadingList(draggedId, targetId);
    }

    // Clean up
    document.querySelectorAll('.reading-list-item').forEach(item => {
        item.classList.remove('drag-over');
    });

    return false;
}

function handleDragEnd(e) {
    if (draggedItem) {
        draggedItem.style.opacity = '1';
        draggedItem = null;
    }

    // Clean up any remaining drag-over classes
    document.querySelectorAll('.reading-list-item').forEach(item => {
        item.classList.remove('drag-over');
    });
}


function reorderReadingList(draggedId, targetId) {
    const draggedIndex = readingList.findIndex(book => book[CONSTANTS.BOOK_FIELDS.ID] === draggedId);
    const targetIndex = readingList.findIndex(book => book[CONSTANTS.BOOK_FIELDS.ID] === targetId);

    if (draggedIndex === -1 || targetIndex === -1) return;

    const draggedBook = readingList[draggedIndex];
    const targetBook = readingList[targetIndex];

    // If dragging to an unranked book, remove the rank
    if (!targetBook.Rank && draggedBook.Rank) {
        const oldRank = draggedBook.Rank;

        // Remove rank from dragged book
        delete draggedBook.Rank;

        // Shift other ranked books up to fill the gap
        readingList.forEach(book => {
            if (book.Rank && book.Rank > oldRank) {
                book.Rank--;
            }
        });
    }
    // If dragging to a ranked book, swap ranks
    else if (targetBook.Rank && draggedBook.Rank) {
        const oldRank = draggedBook.Rank;
        const newRank = targetBook.Rank;

        // Update ranks of other books
        readingList.forEach(book => {
            if (book[CONSTANTS.BOOK_FIELDS.ID] === draggedId) {
                book.Rank = newRank;
            } else if (book.Rank) {
                if (oldRank < newRank) {
                    // Moving down: shift books between old and new position up
                    if (book.Rank > oldRank && book.Rank <= newRank) {
                        book.Rank--;
                    }
                } else if (oldRank > newRank) {
                    // Moving up: shift books between new and old position down
                    if (book.Rank >= newRank && book.Rank < oldRank) {
                        book.Rank++;
                    }
                }
            }
        });
    }
    // If dragging an unranked book to a ranked position, give it that rank
    else if (targetBook.Rank && !draggedBook.Rank) {
        const newRank = targetBook.Rank;

        // Shift existing ranked books down
        readingList.forEach(book => {
            if (book.Rank && book.Rank >= newRank) {
                book.Rank++;
            }
        });

        // Assign rank to dragged book
        draggedBook.Rank = newRank;
    }

    saveReadingListData();
    renderReadingList();
    showMessage('Reading list reordered', CONSTANTS.MESSAGE_TYPES.SUCCESS);
}



async function startFinishingBook(readingListId) {
    const readingListBook = readingList.find(b => b[CONSTANTS.BOOK_FIELDS.ID] === readingListId);
    if (!readingListBook) {
        showMessage('Reading list book not found', CONSTANTS.MESSAGE_TYPES.ERROR);
        return;
    }

    let bookData = {
        title: readingListBook[CONSTANTS.BOOK_FIELDS.TITLE],
        author: readingListBook[CONSTANTS.BOOK_FIELDS.AUTHOR],
        pages: '',
        category: '',
        isbn: '',
        recommend: '',
        comments: ''
    };

    // If this book is from My Library, use direct UUID lookup
    if (readingListBook.MyLibraryId) {
        const libraryBook = myLibrary.find(lib => lib.id === readingListBook.MyLibraryId);

        if (libraryBook) {
            bookData.pages = libraryBook.Pages || '';
            bookData.category = libraryBook.Category || '';
            bookData.isbn = libraryBook.ISBN || '';
        }
    } else {
        // For "Other" source books, try ISBN lookup
        showMessage('Looking up book information...', CONSTANTS.MESSAGE_TYPES.INFO);

        try {
            const isbnData = await lookupISBN(bookData.title, bookData.author);
            if (isbnData && isbnData.confidence > CONSTANTS.CONFIDENCE_LEVELS.GOOD_MATCH) {
                if (!bookData.isbn) {
                    bookData.isbn = isbnData.isbn13 || isbnData.isbn || '';
                }
                if (!bookData.pages) {
                    bookData.pages = isbnData.pages || '';
                }
            }
        } catch (error) {
            console.error('ISBN lookup failed:', error);
            // Continue with existing data
        }
    }

    // Store the reading list ID for removal after successful book entry
    sessionStorage.setItem('pendingReadingListRemoval', readingListId);

    // Clear the "Looking up book information..." status before navigating —
    // it's an INFO message, so clearMessage() (error-only) won't touch it.
    document.getElementById('messageArea').textContent = '';

    // Navigate to the finished book form and populate it
    populateFinishedBookForm(bookData);
    showView(CONSTANTS.VIEWS.ENTER_FINISHED, document.querySelector('[onclick*="enterFinished"]'));
}


function populateFinishedBookForm(bookData) {
    // Set today's date
    const today = new Date().toISOString().split('T')[0];
    document.getElementById('finished').value = dateFromStorage(today);

    // Populate form fields
    document.getElementById('title').value = bookData.title;
    const authorInfo = parseAuthorName(bookData.author);
    document.getElementById('authorGiven').value = authorInfo.first;
    document.getElementById('authorSurname').value = authorInfo.last;
    document.getElementById('pages').value = bookData.pages;
    document.getElementById('isbn').value = bookData.isbn;
    document.getElementById('recommend').value = bookData.recommend;
    document.getElementById('comments').value = bookData.comments;

    // Handle category after a brief delay to ensure options are loaded
    setTimeout(() => {
        if (bookData.category) {
            document.getElementById('category').value = bookData.category;
        }
    }, 50);
}


function removeReadingListItemById(id) {
    const book = readingList.find(b => b[CONSTANTS.BOOK_FIELDS.ID] === id);
    if (!book) return;

    const bookRank = book.Rank;

    // Remove book
    const index = readingList.findIndex(b => b[CONSTANTS.BOOK_FIELDS.ID] === id);
    readingList.splice(index, 1);

    // Shift ranks up if necessary
    if (bookRank) {
        readingList.forEach(b => {
            if (b.Rank && b.Rank > bookRank) {
                b.Rank--;
            }
        });
    }

    if (readingList.length === 0) {
        clearReadingListData();
    } else {
        saveReadingListData();
    }
    renderReadingList();

    // Re-render My Library if this was a My Library book to show "To Read" button again
    if (book.MyLibraryId) {
        renderMyLibrary();
    }
}
