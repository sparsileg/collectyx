/**
 * restore.js
 * Restore from backup — handles both .json and .json.gz files.
 * Two-screen modal flow: file selection → confirmation → restore.
 */

let _restoreParsedData = null;
let _restoreFileName   = null;
let _restoreFileSize   = null;

// ── Screen 1 — Select File ────────────────────────────────────────────────────

function showRestoreScreen1() {
    _restoreParsedData = null;
    _restoreFileName   = null;
    _restoreFileSize   = null;
    document.getElementById('restoreFileInfo').textContent = '';
    document.getElementById('restoreFileInput').value = '';
    document.getElementById('restoreContinueBtn').disabled = true;
    document.getElementById('restoreScreen1Modal').style.display = 'block';
}

function restoreBrowseFiles() {
    document.getElementById('restoreFileInput').click();
}

async function restoreFileSelected() {
    const input = document.getElementById('restoreFileInput');
    const file = input.files[0];
    if (!file) return;

    _restoreFileName = file.name;
    _restoreFileSize = (file.size / 1024).toFixed(2) + ' KB';

    document.getElementById('restoreFileInfo').textContent =
        `Selected: ${_restoreFileName} (${_restoreFileSize})`;
    document.getElementById('restoreContinueBtn').disabled = false;
}

async function restoreContinue() {
    const input = document.getElementById('restoreFileInput');
    const file = input.files[0];
    if (!file) return;

    // Parse the file
    try {
        const arrayBuffer = await file.arrayBuffer();
        let jsonText;

        if (_restoreFileName.endsWith('.gz')) {
            // Decompress with pako
            const uint8 = new Uint8Array(arrayBuffer);
            const decompressed = pako.ungzip(uint8, { to: 'string' });
            jsonText = decompressed;
        } else {
            // Plain JSON
            jsonText = new TextDecoder().decode(arrayBuffer);
        }

        _restoreParsedData = JSON.parse(jsonText);
    } catch (e) {
        _restoreParsedData = null;
        showRestoreScreen2(null, e.message);
        return;
    }

    showRestoreScreen2(_restoreParsedData, null);
}

// ── Screen 2 — Confirm ────────────────────────────────────────────────────────

async function showRestoreScreen2(data, errorMsg) {
    document.getElementById('restoreScreen1Modal').style.display = 'none';
    document.getElementById('restoreScreen2Modal').style.display = 'block';
    document.getElementById('restoreConfirmBtn').disabled = true;
    document.getElementById('restoreConfirmCheckbox').checked = false;

    const metaDiv    = document.getElementById('restoreMetadata');
    const countsDiv  = document.getElementById('restoreCounts');
    const errorDiv   = document.getElementById('restoreError');
    const warningDiv = document.getElementById('restoreWarning');
    const checkRow   = document.getElementById('restoreCheckboxRow');

    if (errorMsg || !data) {
        // Show error state
        metaDiv.innerHTML = `
            <div style="display: grid; grid-template-columns: 120px 1fr; gap: 6px;">
                <span style="opacity: 0.6;">File:</span><span>${escapeHtml(_restoreFileName || 'Unknown')}</span>
                <span style="opacity: 0.6;">Size:</span><span>${escapeHtml(_restoreFileSize || 'Unknown')}</span>
            </div>`;
        countsDiv.innerHTML = '';
        errorDiv.textContent = `Error reading backup file: ${errorMsg || 'Unknown error'}`;
        errorDiv.style.display = 'block';
        warningDiv.style.display = 'none';
        checkRow.style.display = 'none';
        return;
    }

    errorDiv.style.display = 'none';

    // Metadata
    const header = data.Header || {};
    metaDiv.innerHTML = `
        <div style="display: grid; grid-template-columns: 120px 1fr; gap: 6px;">
            <span style="opacity: 0.6;">File:</span><span>${escapeHtml(_restoreFileName)}</span>
            <span style="opacity: 0.6;">Size:</span><span>${escapeHtml(_restoreFileSize)}</span>
            <span style="opacity: 0.6;">Created:</span><span>${escapeHtml(header.timestamp ? new Date(header.timestamp).toLocaleString() : 'Unknown')}</span>
            <span style="opacity: 0.6;">App Version:</span><span>${escapeHtml(header.appVersion || 'Unknown')}</span>
        </div>`;

    // Current counts
    const currentTagsSet = new Set();
    myLibrary.forEach(b => { if (Array.isArray(b.Tags)) b.Tags.forEach(t => currentTagsSet.add(t)); });
    books.forEach(b => { if (Array.isArray(b.Tags)) b.Tags.forEach(t => currentTagsSet.add(t)); });
    readingList.forEach(b => { if (Array.isArray(b.Tags)) b.Tags.forEach(t => currentTagsSet.add(t)); });
    const currentCategories = await loadCategoriesFromDB();

    // Backup counts
    const backupBooksRead   = (data.BooksRead   || []).length;
    const backupReadingList = (data.ReadingList  || []).length;
    const backupMyLibrary   = (data.MyLibrary    || []).length;

    const backupTagsSet = new Set();
    (data.MyLibrary   || []).forEach(b => { if (Array.isArray(b.Tags)) b.Tags.forEach(t => backupTagsSet.add(t)); });
    (data.BooksRead   || []).forEach(b => { if (Array.isArray(b.Tags)) b.Tags.forEach(t => backupTagsSet.add(t)); });
    (data.ReadingList || []).forEach(b => { if (Array.isArray(b.Tags)) b.Tags.forEach(t => backupTagsSet.add(t)); });

    const backupCategories = (data.Settings && Array.isArray(data.Settings.categories))
        ? data.Settings.categories.length
        : 0;

    const countRow = (label, current, backup) => `
        <div style="display: flex; align-items: center; gap: 12px; padding: 8px 0;
                    border-bottom: 1px solid var(--color-border);">
            <span style="flex: 1;">${label}</span>
            <span style="min-width: 40px; text-align: right;">${current}</span>
            <span style="opacity: 0.6;">→</span>
            <span style="min-width: 40px; text-align: right;">${backup}</span>
        </div>`;

    countsDiv.innerHTML = `
        <div style="display: flex; gap: 12px; padding: 0 0 4px; font-weight: bold; opacity: 0.6;">
            <span style="flex: 1;">Data Store</span>
            <span style="min-width: 40px; text-align: right;">Current</span>
            <span style="opacity: 0;">→</span>
            <span style="min-width: 40px; text-align: right;">Backup</span>
        </div>
        ${countRow('Books Read',   books.length,           backupBooksRead)}
        ${countRow('Reading List', readingList.length,     backupReadingList)}
        ${countRow('My Library',   myLibrary.length,       backupMyLibrary)}
        ${countRow('Tags',         currentTagsSet.size,    backupTagsSet.size)}
        ${countRow('Categories',   currentCategories.length, backupCategories)}
    `;

    warningDiv.style.display = 'block';
    checkRow.style.display = 'block';
}

function restoreCheckboxChanged() {
    const checked = document.getElementById('restoreConfirmCheckbox').checked;
    document.getElementById('restoreConfirmBtn').disabled = !checked;
}

// ── Execute Restore ───────────────────────────────────────────────────────────

async function executeRestore() {
    if (!_restoreParsedData) return;

    try {
        const result = await importUnifiedDatabase(_restoreParsedData);
        if (result.success) {
            await loadData();
            await loadReadingListData();
            await loadMyLibraryData();
            closeRestore();
            renderReadBooks();
            renderReadingList();
            renderMyLibrary();
            renderDashboard();
            showMessage(
                `Restore complete — ${result.counts.booksRead} books read, ` +
                `${result.counts.readingList} in reading list, ` +
                `${result.counts.myLibrary} in library.`,
                CONSTANTS.MESSAGE_TYPES.SUCCESS
            );
        } else {
            document.getElementById('restoreError').textContent = 'Restore failed: ' + result.error;
            document.getElementById('restoreError').style.display = 'block';
            document.getElementById('restoreConfirmBtn').disabled = true;
            document.getElementById('restoreConfirmCheckbox').checked = false;
        }
    } catch (e) {
        document.getElementById('restoreError').textContent = 'Restore failed: ' + e.message;
        document.getElementById('restoreError').style.display = 'block';
    }
}

// ── Close ─────────────────────────────────────────────────────────────────────

function closeRestore() {
    document.getElementById('restoreScreen1Modal').style.display = 'none';
    document.getElementById('restoreScreen2Modal').style.display = 'none';
    _restoreParsedData = null;
    _restoreFileName   = null;
    _restoreFileSize   = null;
}
