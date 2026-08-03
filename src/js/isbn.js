// Generic ISBN lookup functions

// Updated generic ISBN lookup with better ISBN handling
async function lookupBookISBNGeneric(bookId, collection, saveCallback, renderCallback) {
    const book = collection.find(b => b.id === bookId);
    
    if (!book.Title || !book.Author) {
        showMessage('Book must have title and author for ISBN lookup', CONSTANTS.MESSAGE_TYPES.ERROR);
        return;
    }
    
    showMessage(`Looking up ISBN information for ${book.Title} ...`, CONSTANTS.MESSAGE_TYPES.INFO);
    
    try {
        const isbnData = await lookupISBN(book.Title, book.Author);
        if (isbnData) {
            let selectedISBN = null;
            let isConverted = false;
            
            // First priority: actual ISBN-13 from API
            if (isbnData.isbn13) {
                selectedISBN = isbnData.isbn13;
            }
            // Second priority: convert ISBN-10 only if no ISBN-13 available
            else if (isbnData.isbn && isbnData.isbn.length === 10) {
                selectedISBN = convertISBN10ToISBN13(isbnData.isbn);
                isConverted = true;
            }
            // Fallback: use whatever ISBN we have
            else if (isbnData.isbn) {
                selectedISBN = isbnData.isbn;
            }
            
            if (selectedISBN) {
                const conversionNote = isConverted ? " (converted from ISBN-10)" : "";
                const confirmText = `Found ISBN information:\n\n` +
                      `Title: ${book.Title}\n` +
                      `Author: ${book.Author}\n` +
                      `ISBN-10: ${isbnData.isbn || 'Not found'}\n` +
                      `ISBN-13: ${isbnData.isbn13 || 'Not found'}\n` +
                      `Selected: ${selectedISBN}${conversionNote}\n` +
                      `Publisher: ${isbnData.publisher || 'Not found'}\n` +
                      `Publish Year: ${isbnData.publishYear || 'Not found'}\n` +
                      `Pages: ${isbnData.pages || 'Not found'}\n` +
                      `Confidence: ${isbnData.confidence}%\n\n` +
                      `Update this book with this information?`;

                if (await confirmDialog(confirmText)) {
                    book.ISBN = selectedISBN;
                    
                    saveCallback();
                    renderCallback();
                    showMessage(`${book.Title} by ${book.Author} updated with ISBN: ${selectedISBN}`, CONSTANTS.MESSAGE_TYPES.SUCCESS);
                } else {
                    showMessage(`ISBN information not saved for ${book.Title} by ${book.Author}`, CONSTANTS.MESSAGE_TYPES.INFO);
                }
            } else {
                let msg = `No valid ISBN found for "${book.Title}" by ${book.Author} `;
                msg += `(conf: ${isbnData.confidence || 'N/A'}%)`;
                showMessage(msg, CONSTANTS.MESSAGE_TYPES.INFO);
            }
        } else {
            showMessage(`No information found for ${book.Title} by ${book.Author}`, CONSTANTS.MESSAGE_TYPES.INFO);
        }
    } catch (error) {
        showMessage('Error looking up ISBN information', CONSTANTS.MESSAGE_TYPES.ERROR);
        console.error('ISBN lookup error:', error);
    }
}


// Generic bulk ISBN lookup
async function bulkISBNLookupGeneric(collection, saveCallback, renderCallback, collectionName) {
    const pauseAfterSave = CONSTANTS.API_DELAYS.PAUSE_AFTER_SAVE;
    const pauseApiRespect = CONSTANTS.API_DELAYS.API_RESPECT;
    const confidenceLevel = CONSTANTS.CONFIDENCE_LEVELS.MIN_ISBN_LOOKUP;
    const booksWithoutISBN = collection.filter(book => !book.ISBN && !book.ISBN13);
    
    if (booksWithoutISBN.length === 0) {
        showMessage(`All books in ${collectionName} already have ISBN information`, CONSTANTS.MESSAGE_TYPES.INFO);
        return;
    }
    
    const confirmed = await confirmDialog(`This will attempt to find ISBN information for ${booksWithoutISBN.length} books in ${collectionName}. This may take several minutes. Continue?`);
    if (!confirmed) return;
    
    showMessage(`Starting ISBN lookup for ${booksWithoutISBN.length} books in ${collectionName}...`, CONSTANTS.MESSAGE_TYPES.INFO);
    
    let processed = 0;
    let found = 0;
    let notFound = 0;
    
    for (const bookWithoutISBN of booksWithoutISBN) {
        try {
            const originalIndex = collection.findIndex(originalBook => 
                originalBook.Title === bookWithoutISBN.Title && 
                originalBook.Author === bookWithoutISBN.Author
            );
            
            if (originalIndex === -1) continue;
            
            const isbnData = await lookupISBN(bookWithoutISBN.Title, bookWithoutISBN.Author);
            
            if (isbnData && isbnData.confidence > confidenceLevel && (isbnData.isbn13 || isbnData.isbn)) {
                if (isbnData.isbn13) {
                    collection[originalIndex].ISBN = isbnData.isbn13;
                } else if (isbnData.isbn) {
                    collection[originalIndex].ISBN = isbnData.isbn;
                }
                
                let msg = `ISBN ${collection[originalIndex].ISBN} saved for `;
                msg += `${bookWithoutISBN.Title} by ${bookWithoutISBN.Author}`;
                showMessage(msg, CONSTANTS.MESSAGE_TYPES.INFO);
                found++;
            } else {
                notFound++;
                let msg = `No ISBN found for "${bookWithoutISBN.Title}" by ${bookWithoutISBN.Author} `;
                msg += `(conf: ${isbnData?.confidence || 'N/A'}%)`;
                showMessage(msg, CONSTANTS.MESSAGE_TYPES.INFO);
            }
            
            processed++;
            
            if (processed % CONSTANTS.ISBN_MSG_INTERVAL === 0) {
                showMessage(`Processed ${processed}/${booksWithoutISBN.length} books. Found: ${found}, Not found: ${notFound}`, CONSTANTS.MESSAGE_TYPES.INFO);
                saveCallback();
                await new Promise(resolve => setTimeout(resolve, pauseAfterSave));
            }
            
            await new Promise(resolve => setTimeout(resolve, pauseApiRespect));
            
        } catch (error) {
            showMessage(`Error processing: "${bookWithoutISBN.Title}" - ${error.message}`, CONSTANTS.MESSAGE_TYPES.ERROR);
            console.error(`Error processing book: ${bookWithoutISBN.Title}`, error);
        }
    }
    
    saveCallback();
    renderCallback();
    showMessage(`ISBN lookup complete for ${collectionName}! Processed: ${processed}, Found: ${found}, Not found: ${notFound}`, CONSTANTS.MESSAGE_TYPES.SUCCESS);
}


// Convert ISBN-10 to ISBN-13
function convertISBN10ToISBN13(isbn10) {
    if (!isbn10 || isbn10.length !== 10) return isbn10;
    
    // Remove any existing check digit and non-digits
    const digits = isbn10.replace(/\D/g, '').slice(0, 9);
    
    if (digits.length !== 9) return isbn10;
    
    // Add 978 prefix
    const isbn12 = '978' + digits;
    
    // Calculate check digit
    let sum = 0;
    for (let i = 0; i < 12; i++) {
        const digit = parseInt(isbn12[i]);
        sum += (i % 2 === 0) ? digit : digit * 3;
    }
    
    const checkDigit = (10 - (sum % 10)) % 10;
    
    return isbn12 + checkDigit;
}

