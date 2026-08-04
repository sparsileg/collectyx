// File related functions

function exportFilteredData() {
    const filteredBooks = applyCurrentFilters([...books]);
    const metadata = generateExportMetadata();
    const isFiltered = Object.keys(currentFilters).length > 0;

    const dataToExport = {
        exportInfo: metadata,
        BooksRead: filteredBooks
    };

    const dataStr = JSON.stringify(dataToExport, null, 2);
    const blob = new Blob([dataStr], { type: 'application/json' });
    const filename = generateTimestampedFilename('books_read', 'json', isFiltered);

    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    showMessage(`Filtered data exported: ${filteredBooks.length} books saved to ${filename}`, CONSTANTS.MESSAGE_TYPES.SUCCESS);
}


function exportFilteredCSV() {
    const filteredBooks = applyCurrentFilters([...books]);
    const isFiltered = Object.keys(currentFilters).length > 0;
    const headers = [CONSTANTS.BOOK_FIELDS.FINISHED, CONSTANTS.BOOK_FIELDS.TITLE, CONSTANTS.BOOK_FIELDS.AUTHOR,
                   'Author2', CONSTANTS.BOOK_FIELDS.ISBN, CONSTANTS.BOOK_FIELDS.PAGES, CONSTANTS.BOOK_FIELDS.CATEGORY,
                   CONSTANTS.BOOK_FIELDS.RECOMMEND, CONSTANTS.BOOK_FIELDS.COMMENTS, 'Tags'];

    let csvContent = headers.join(',') + '\n';

    filteredBooks.forEach(book => {
        const row = [
            escapeCSV(dateToISO(book[CONSTANTS.BOOK_FIELDS.FINISHED])),
            escapeCSV(book[CONSTANTS.BOOK_FIELDS.TITLE]),
            escapeCSV(book[CONSTANTS.BOOK_FIELDS.AUTHOR]),
            escapeCSV(book.Author2),
            escapeCSV(book[CONSTANTS.BOOK_FIELDS.ISBN]),
            escapeCSV(book[CONSTANTS.BOOK_FIELDS.PAGES]),
            escapeCSV(book[CONSTANTS.BOOK_FIELDS.CATEGORY]),
            escapeCSV(book[CONSTANTS.BOOK_FIELDS.RECOMMEND]),
            escapeCSV(book[CONSTANTS.BOOK_FIELDS.COMMENTS]),
            escapeCSV(Array.isArray(book.Tags) ? book.Tags.join(', ') : '')
        ];
        csvContent += row.join(',') + '\n';
    });

    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const filename = generateTimestampedFilename('books_read', 'csv', isFiltered);

    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    showMessage(`Filtered CSV exported: ${filteredBooks.length} books saved to ${filename}`, CONSTANTS.MESSAGE_TYPES.SUCCESS);
}






// Save Database - saves as <APP_NAME>_data_<timestamp>.json
async function saveDatabaseFile() {
    const dataToExport = await generateUnifiedDatabase();
    const dataStr = JSON.stringify(dataToExport, null, 2);
    const blob = new Blob([dataStr], { type: 'application/json' });
    const filename = generateTimestampedFilename(`${CONSTANTS.APP_NAME}_data`, 'json');

    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    showMessage(`Data downloaded as ${filename}`, CONSTANTS.MESSAGE_TYPES.SUCCESS);
}

// Backup Database - saves as <appname>-YYYYMMDD.json.gz (compressed if available)
async function backupDatabaseFile() {
    const now = new Date();
    const dateStr = now.getFullYear() +
          String(now.getMonth() + 1).padStart(2, '0') +
          String(now.getDate()).padStart(2, '0') + '_' +
          String(now.getHours()).padStart(2, '0') +
          String(now.getMinutes()).padStart(2, '0') +
          String(now.getSeconds()).padStart(2, '0');
    const dataToExport = await generateUnifiedDatabase();
    const dataStr = JSON.stringify(dataToExport, null, 2);
    let filename = `${CONSTANTS.APP_NAME}_${dateStr}.json`;

    // If running in Tauri and a backup folder is set, write directly to disk
    if (typeof window.__TAURI__ !== 'undefined') {
        const settings = await loadSettingsFromDB() || {};
        if (settings.backupFolder) {
            try {
                if (typeof pako !== 'undefined') {
                    // Write compressed binary file
                    const encoder = new TextEncoder();
                    const data = encoder.encode(dataStr);
                    const compressed = pako.gzip(data);
                    const compressedFilename = `${CONSTANTS.APP_NAME}_${dateStr}.json.gz`;
                    const filePath = `${settings.backupFolder}/${compressedFilename}`;
                    console.log('Writing compressed backup to:', filePath);
                    await window.__TAURI_PLUGIN_FS__.writeFile(filePath, compressed);
                    showMessage(`Database backup saved to ${filePath}`, CONSTANTS.MESSAGE_TYPES.SUCCESS);
                } else {
                    // Write uncompressed text file
                    const filePath = `${settings.backupFolder}/${filename}`;
                    console.log('Writing uncompressed backup to:', filePath);
                    await window.__TAURI_PLUGIN_FS__.writeTextFile(filePath, dataStr);
                    showMessage(`Database backup saved to ${filePath}`, CONSTANTS.MESSAGE_TYPES.SUCCESS);
                }
                return;
            } catch (e) {
                console.error('Backup to folder failed:', e);
                showMessage('Could not write to backup folder: ' + (e.message || JSON.stringify(e)), CONSTANTS.MESSAGE_TYPES.ERROR);
                return;
            }
        }
    }

    // Fallback: browser download (web build or no backup folder set)
    let blob;
    if (typeof pako !== 'undefined') {
        try {
            const encoder = new TextEncoder();
            const data = encoder.encode(dataStr);
            const compressed = pako.gzip(data);
            blob = new Blob([compressed], { type: 'application/gzip' });
            filename = `${CONSTANTS.APP_NAME.toLowerCase()}_${dateStr}.json.gz`;
        } catch (e) {
            console.warn('Compression failed, using uncompressed data:', e);
            blob = new Blob([dataStr], { type: 'application/json' });
            showMessage('Compression failed, saved uncompressed backup', CONSTANTS.MESSAGE_TYPES.INFO);
        }
    } else {
        blob = new Blob([dataStr], { type: 'application/json' });
        showMessage('Compression library not available, saved uncompressed backup', CONSTANTS.MESSAGE_TYPES.INFO);
    }
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    showMessage(`Database backup saved as ${filename}`, CONSTANTS.MESSAGE_TYPES.SUCCESS);
}
