// ── Backup & Restore ─────────────────────────────────────────────────────────
// Collectyx's own format — not Scriptum's. Backup/export gathers data
// through the same documented DBManager surface used everywhere else in
// this codebase (getAllItems/getCollection/getAllTags/getSettings), so
// there's no separate, less-trustworthy code path for this one feature.
//
// Restore reuses the original Scriptum-era modal markup (restoreScreen1Modal/
// restoreScreen2Modal in index.html) — same two-screen flow, same required
// confirmation checkbox — but the logic underneath is entirely new, since
// the old restore.js parsed Scriptum's own JSON shape and wrote to flat
// arrays (books/myLibrary/readingList) that don't exist in this schema.
//
// A one-time Scriptum backup import (Phase 6) is a separate, smaller
// piece of work — a standalone conversion script producing a file in
// *this* format, then restored through this same UI. Not part of this file.

const BackupRestore = {
    _parsedData: null,
    _fileName: null,
    _fileSize: null,

    // ── Shared: gather everything ───────────────────────────────────────────

    async _gatherAllData() {
        const [items, consumed, queued, owned, tags, settings] = await Promise.all([
            DBManager.getAllItems(),
            DBManager.getCollection('consumed'),
            DBManager.getCollection('queued'),
            DBManager.getCollection('owned'),
            DBManager.getAllTags(),
            DBManager.getSettings()
        ]);
        return {
            Header: {
                timestamp: new Date().toISOString(),
                appVersion: CONSTANTS.APP_VERSION,
                schemaVersion: 1
            },
            Items: items,
            Consumed: consumed,
            Queued: queued,
            Owned: owned,
            Tags: tags,
            Settings: settings || {}
        };
    },

    _timestamp() {
        const d = new Date();
        const pad = (n) => String(n).padStart(2, '0');
        return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
    },

    // ── Export ───────────────────────────────────────────────────────────────

    async backupDatabase() {
        try {
            const data = await this._gatherAllData();
            const json = JSON.stringify(data);
            if (typeof pako !== 'undefined') {
                downloadFile(`collectyx-backup-${this._timestamp()}.json.gz`, pako.gzip(json), 'application/gzip');
            } else {
                downloadFile(`collectyx-backup-${this._timestamp()}.json`, json, 'application/json');
            }
            showMessage('Backup complete', CONSTANTS.MESSAGE_TYPES.SUCCESS);
        } catch (e) {
            console.error('BackupRestore.backupDatabase failed', e);
            showMessage('Backup failed — see console for details', CONSTANTS.MESSAGE_TYPES.ERROR);
        }
    },

    async exportAllData() {
        try {
            const data = await this._gatherAllData();
            downloadFile(`collectyx-export-${this._timestamp()}.json`, JSON.stringify(data, null, 2), 'application/json');
            showMessage('Export complete', CONSTANTS.MESSAGE_TYPES.SUCCESS);
        } catch (e) {
            console.error('BackupRestore.exportAllData failed', e);
            showMessage('Export failed — see console for details', CONSTANTS.MESSAGE_TYPES.ERROR);
        }
    },

    // ── Restore: Screen 1 — select file ─────────────────────────────────────

    showScreen1() {
        this._parsedData = null;
        this._fileName = null;
        this._fileSize = null;
        document.getElementById('restoreFileInfo').textContent = '';
        document.getElementById('restoreFileInput').value = '';
        document.getElementById('restoreContinueBtn').disabled = true;
        document.getElementById('restoreScreen1Modal').classList.add('open');
    },

    browseFiles() {
        document.getElementById('restoreFileInput').click();
    },

    fileSelected() {
        const file = document.getElementById('restoreFileInput').files[0];
        if (!file) return;
        this._fileName = file.name;
        this._fileSize = (file.size / 1024).toFixed(2) + ' KB';
        document.getElementById('restoreFileInfo').textContent = `Selected: ${this._fileName} (${this._fileSize})`;
        document.getElementById('restoreContinueBtn').disabled = false;
    },

    async continueToScreen2() {
        const file = document.getElementById('restoreFileInput').files[0];
        if (!file) return;

        try {
            const arrayBuffer = await file.arrayBuffer();
            const jsonText = this._fileName.endsWith('.gz')
                ? pako.ungzip(new Uint8Array(arrayBuffer), { to: 'string' })
                : new TextDecoder().decode(arrayBuffer);
            this._parsedData = JSON.parse(jsonText);
        } catch (e) {
            this._parsedData = null;
            await this.showScreen2(null, e.message);
            return;
        }
        await this.showScreen2(this._parsedData, null);
    },

    // ── Restore: Screen 2 — compare and confirm ─────────────────────────────

    async showScreen2(data, errorMsg) {
        document.getElementById('restoreScreen1Modal').classList.remove('open');
        document.getElementById('restoreScreen2Modal').classList.add('open');
        document.getElementById('restoreConfirmBtn').disabled = true;
        document.getElementById('restoreConfirmCheckbox').checked = false;

        const metaDiv = document.getElementById('restoreMetadata');
        const countsDiv = document.getElementById('restoreCounts');
        const errorDiv = document.getElementById('restoreError');
        const warningDiv = document.getElementById('restoreWarning');
        const checkRow = document.getElementById('restoreCheckboxRow');

        if (errorMsg || !data) {
            metaDiv.innerHTML = `
                <div style="display: grid; grid-template-columns: 120px 1fr; gap: 6px;">
                    <span style="opacity: 0.6;">File:</span><span>${escapeHtml(this._fileName || 'Unknown')}</span>
                    <span style="opacity: 0.6;">Size:</span><span>${escapeHtml(this._fileSize || 'Unknown')}</span>
                </div>`;
            countsDiv.innerHTML = '';
            errorDiv.textContent = `Error reading backup file: ${errorMsg || 'Unknown error'}`;
            errorDiv.style.display = 'block';
            warningDiv.style.display = 'none';
            checkRow.style.display = 'none';
            return;
        }

        errorDiv.style.display = 'none';

        const header = data.Header || {};
        metaDiv.innerHTML = `
            <div style="display: grid; grid-template-columns: 120px 1fr; gap: 6px;">
                <span style="opacity: 0.6;">File:</span><span>${escapeHtml(this._fileName)}</span>
                <span style="opacity: 0.6;">Size:</span><span>${escapeHtml(this._fileSize)}</span>
                <span style="opacity: 0.6;">Created:</span><span>${escapeHtml(header.timestamp ? new Date(header.timestamp).toLocaleString() : 'Unknown')}</span>
                <span style="opacity: 0.6;">App Version:</span><span>${escapeHtml(header.appVersion || 'Unknown')}</span>
            </div>`;

        let currentConsumed = [], currentQueued = [], currentOwned = [], currentTags = [];
        try {
            [currentConsumed, currentQueued, currentOwned, currentTags] = await Promise.all([
                DBManager.getCollection('consumed'),
                DBManager.getCollection('queued'),
                DBManager.getCollection('owned'),
                DBManager.getAllTags()
            ]);
        } catch (e) {
            console.error('BackupRestore.showScreen2: could not load current counts', e);
        }

        const countRow = (label, current, backup) => `
            <div style="display: flex; align-items: center; gap: 12px; padding: 8px 0;
                        border-bottom: 1px solid var(--border-color);">
                <span style="flex: 1;">${escapeHtml(label)}</span>
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
            ${countRow(MediaLabels.ConsumedLabel, currentConsumed.length, (data.Consumed || []).length)}
            ${countRow(MediaLabels.QueuedLabel, currentQueued.length, (data.Queued || []).length)}
            ${countRow(MediaLabels.OwnedLabel, currentOwned.length, (data.Owned || []).length)}
            ${countRow('Tags', currentTags.length, (data.Tags || []).length)}
        `;

        warningDiv.style.display = 'block';
        checkRow.style.display = 'block';
    },

    checkboxChanged() {
        document.getElementById('restoreConfirmBtn').disabled = !document.getElementById('restoreConfirmCheckbox').checked;
    },

    // ── Execute ──────────────────────────────────────────────────────────────

    async executeRestore() {
        if (!this._parsedData) return;
        const data = this._parsedData;

        try {
            // Wipe: delete every item (cascades memberships + item_tags
            // associations via the documented, already-tested deleteItem()
            // contract) and every tag row.
            const currentItems = await DBManager.getAllItems();
            for (const item of currentItems) {
                await DBManager.deleteItem(item.id);
            }
            const currentTags = await DBManager.getAllTags();
            for (const tag of currentTags) {
                await DBManager.deleteTag(tag.id);
            }

            // Items first — memberships reference them by ItemId. IDs are
            // preserved verbatim from the backup, so those references
            // resolve correctly with no remapping step. No bulk endpoint
            // exists for items, so this stays one call per item — the
            // remaining unavoidable cost in a large restore.
            for (const item of (data.Items || [])) {
                await DBManager.saveItem(item);
            }

            // One call per collection instead of one call per record —
            // replaceCollection wraps the whole thing in a single
            // transaction on the backend (replace_all_consumed etc.),
            // rather than each record crossing the Tauri IPC boundary (or
            // hitting IndexedDB) separately. Tags get created/attached
            // automatically by the same per-record Tags handling
            // saveCollectionRecord already uses — no separate pass needed.
            await DBManager.replaceCollection('consumed', data.Consumed || []);
            await DBManager.replaceCollection('queued', data.Queued || []);
            await DBManager.replaceCollection('owned', data.Owned || []);

            if (data.Settings) {
                await DBManager.saveSettings(data.Settings);
            }

            this.close();
            showMessage(
                `Restore complete — ${(data.Consumed || []).length} in ${MediaLabels.ConsumedLabel}, ` +
                `${(data.Queued || []).length} in ${MediaLabels.QueuedLabel}, ` +
                `${(data.Owned || []).length} in ${MediaLabels.OwnedLabel}.`,
                CONSTANTS.MESSAGE_TYPES.SUCCESS
            );

            // Refresh whichever collection view is currently on screen, if any.
            ['consumed', 'queued', 'owned'].forEach(collection => {
                const containerId = collection + 'View';
                const el = document.getElementById(containerId);
                const view = collection === 'consumed' ? (typeof ConsumedView !== 'undefined' && ConsumedView)
                    : collection === 'queued' ? (typeof QueuedView !== 'undefined' && QueuedView)
                    : (typeof OwnedView !== 'undefined' && OwnedView);
                if (el && el.classList.contains('active') && view) view.load(containerId);
            });
        } catch (e) {
            console.error('BackupRestore.executeRestore failed', e);
            document.getElementById('restoreError').textContent = 'Restore failed: ' + e.message;
            document.getElementById('restoreError').style.display = 'block';
            document.getElementById('restoreConfirmBtn').disabled = true;
            document.getElementById('restoreConfirmCheckbox').checked = false;
        }
    },

    close() {
        document.getElementById('restoreScreen1Modal').classList.remove('open');
        document.getElementById('restoreScreen2Modal').classList.remove('open');
        this._parsedData = null;
        this._fileName = null;
        this._fileSize = null;
    }
};

// Bridge functions matching the existing modal markup's onclick attributes
// (restoreContinue(), restoreFileSelected(), etc. — same names the
// original Scriptum-era restore.js used, so the untouched HTML needs no
// changes at all).
function restoreBrowseFiles() { BackupRestore.browseFiles(); }
function restoreFileSelected() { BackupRestore.fileSelected(); }
function restoreContinue() { BackupRestore.continueToScreen2(); }
function restoreCheckboxChanged() { BackupRestore.checkboxChanged(); }
function executeRestore() { BackupRestore.executeRestore(); }
function closeRestore() { BackupRestore.close(); }
