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
        // backupFolder is a local filesystem path, not portable data — never
        // written into a backup/export file in the first place (CTX-SEC-101).
        // It only ever comes from this device's own Settings, and restoring
        // one already skips it; stripping here closes the same gap at the
        // source, so a shared backup file never carries a local path at all.
        const { backupFolder, ...exportableSettings } = settings || {};
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
            Settings: exportableSettings
        };
    },

    _timestamp() {
        const d = new Date();
        const pad = (n) => String(n).padStart(2, '0');
        return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
    },

    // ── Validation ───────────────────────────────────────────────────────────
    // A backup file is rejected in full rather than imported with warnings —
    // by the time a per-record warning could be shown, the wipe in
    // executeRestore() has already happened. Every check here runs before
    // the confirmation checkbox becomes reachable (showScreen2's error path
    // hides restoreCheckboxRow), so a file that fails validation cannot
    // reach the wipe at all.

    _typeName(v) {
        if (Array.isArray(v)) return 'array';
        if (v === null) return 'null';
        return typeof v;
    },

    _validateRecord(record, label, index) {
        if (this._typeName(record) !== 'object') {
            return `${label}[${index}] must be an object, got ${this._typeName(record)}`;
        }
        if (typeof record.Title !== 'string' || record.Title.trim() === '') {
            return `${label}[${index}] is missing Title`;
        }
        return null;
    },

    // Returns an error string naming the specific problem, or null if the
    // file is structurally sound enough to restore from.
    _validate(data) {
        if (this._typeName(data) !== 'object') {
            return `Backup file must contain a JSON object, got ${this._typeName(data)}`;
        }

        if (this._typeName(data.Items) !== 'array') {
            return `Items must be an array, got ${this._typeName(data.Items)}`;
        }
        for (let i = 0; i < data.Items.length; i++) {
            const err = this._validateRecord(data.Items[i], 'Items', i);
            if (err) return err;
        }

        // Consumed/Queued/Owned: absent is treated the same as today's
        // `data.Consumed || []` fallback — restores as empty. Present but
        // wrongly-typed, or containing a malformed record, is rejected.
        for (const key of ['Consumed', 'Queued', 'Owned']) {
            if (data[key] === undefined) continue;
            if (this._typeName(data[key]) !== 'array') {
                return `${key} must be an array, got ${this._typeName(data[key])}`;
            }
            for (let i = 0; i < data[key].length; i++) {
                const err = this._validateRecord(data[key][i], key, i);
                if (err) return err;
            }
        }

        // Every referenced ItemId must be present in Items[] — a membership
        // row pointing at an item the file does not carry cannot be
        // restored, and this must be caught before _wipeAll() runs, not
        // after (CTX-SEC-112 / #62 fix 3). This is independent of the
        // owner-mismatch failure #52 already closed — a dangling ItemId
        // fails replaceCollection() for a different reason and hits the
        // same wipe-then-rollback exposure.
        const itemIds = new Set((data.Items || []).map(i => i.id).filter(Boolean));
        for (const key of ['Consumed', 'Queued', 'Owned']) {
            const rows = data[key];
            if (!Array.isArray(rows)) continue;
            for (let i = 0; i < rows.length; i++) {
                const ref = rows[i].ItemId;
                if (ref && !itemIds.has(ref)) {
                    return `${key}[${i}] references ItemId "${ref}", which is not in Items`;
                }
            }
        }

        if (data.Tags !== undefined) {
            if (this._typeName(data.Tags) !== 'array') {
                return `Tags must be an array, got ${this._typeName(data.Tags)}`;
            }
            for (let i = 0; i < data.Tags.length; i++) {
                const tag = data.Tags[i];
                if (this._typeName(tag) !== 'object') {
                    return `Tags[${i}] must be an object, got ${this._typeName(tag)}`;
                }
                if (typeof tag.Name !== 'string' || tag.Name.trim() === '') {
                    return `Tags[${i}] is missing Name`;
                }
            }
        }

        if (data.Settings !== undefined && this._typeName(data.Settings) !== 'object') {
            return `Settings must be an object, got ${this._typeName(data.Settings)}`;
        }

        return null;
    },

    // ── Export ───────────────────────────────────────────────────────────────

    async backupDatabase() {
        const isTauri = typeof window.__TAURI__ !== 'undefined';

        try {
            const data = await this._gatherAllData();
            const json = JSON.stringify(data);
            const useGzip = typeof pako !== 'undefined';
            const filename = useGzip
                ? `collectyx-backup-${this._timestamp()}.json.gz`
                : `collectyx-backup-${this._timestamp()}.json`;

            if (isTauri) {
                // _gatherAllData()'s Settings has backupFolder stripped
                // (CTX-SEC-101 — never written into the backup payload), so
                // the folder check reads settings directly instead.
                let rawSettings = {};
                try {
                    rawSettings = await DBManager.getSettings() || {};
                } catch (e) {
                    console.error('BackupRestore.backupDatabase: could not load settings', e);
                }
                const folder = (rawSettings.backupFolder || '').trim();
                if (!folder) {
                    showMessage('Backup folder is not set — set it in Settings before backing up.', CONSTANTS.MESSAGE_TYPES.ERROR);
                    return;
                }

                const contents = useGzip
                    ? Array.from(pako.gzip(json))
                    : Array.from(new TextEncoder().encode(json));

                try {
                    await window.__TAURI__.core.invoke('save_backup_file', { filename: filename, contents: contents });
                } catch (writeErr) {
                    console.error('BackupRestore.backupDatabase: write to backup folder failed', writeErr);
                    showMessage('Backup folder is missing or inaccessible — set it again in Settings.', CONSTANTS.MESSAGE_TYPES.ERROR);
                    return;
                }
            } else if (useGzip) {
                downloadFile(filename, pako.gzip(json), 'application/gzip');
            } else {
                downloadFile(filename, json, 'application/json');
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

    // Both restore modals are static markup, never rebuilt. Screen 2 is
    // only ever reached through screen 1, so binding both here covers the
    // whole flow with one guarded call.
    // fileInput/checkbox are optional companions of screen 1 — bound if
    // present, but not required to latch the guard. Both modals ARE
    // required: they gate every restore action, so the guard only latches
    // once both are confirmed bound (COLLECTYX-SEC-36) — binding only one
    // would leave the other permanently inert on a later retry.
    _wired: false,
    _bindEvents() {
        if (this._wired) return;

        const bind = (modalId) => {
            const modal = document.getElementById(modalId);
            if (!modal) return false;
            modal.addEventListener('click', (event) => {
                const btn = event.target.closest('[data-action]');
                if (!btn || !modal.contains(btn)) return;
                const action = btn.dataset.action;
                if (action === 'close') this.close();
                else if (action === 'browse') this.browseFiles();
                else if (action === 'continue') this.continueToScreen2();
                else if (action === 'execute') this.executeRestore();
            });
            return true;
        };
        const bothBound = bind('restoreScreen1Modal') && bind('restoreScreen2Modal');
        if (!bothBound) return;

        const fileInput = document.getElementById('restoreFileInput');
        if (fileInput) fileInput.addEventListener('change', () => this.fileSelected());

        const checkbox = document.getElementById('restoreConfirmCheckbox');
        if (checkbox) checkbox.addEventListener('change', () => this.checkboxChanged());

        this._wired = true;
    },

    showScreen1() {
        this._bindEvents();
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

        if (file.size > CONSTANTS.MAX_IMPORT_FILE_BYTES) {
            this._parsedData = null;
            await this.showScreen2(null, `File is too large (${Math.round(file.size / (1024 * 1024))} MB, max ${Math.round(CONSTANTS.MAX_IMPORT_FILE_BYTES / (1024 * 1024))} MB)`);
            return;
        }

        try {
            const arrayBuffer = await file.arrayBuffer();
            const jsonText = this._fileName.endsWith('.gz')
                ? pako.ungzip(new Uint8Array(arrayBuffer), { to: 'string' })
                : new TextDecoder().decode(arrayBuffer);
            // file.size only bounds the compressed .gz — a small file can
            // still decompress to something enormous. Checked post-inflate,
            // before the (potentially expensive) JSON.parse.
            if (jsonText.length > CONSTANTS.MAX_IMPORT_FILE_BYTES) {
                this._parsedData = null;
                await this.showScreen2(null, 'Decompressed backup is too large — refusing to parse');
                return;
            }
            this._parsedData = JSON.parse(jsonText);
        } catch (e) {
            this._parsedData = null;
            await this.showScreen2(null, e.message);
            return;
        }

        const validationError = this._validate(this._parsedData);
        if (validationError) {
            this._parsedData = null;
            await this.showScreen2(null, validationError);
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
    // Not a real transaction (see COLLECTYX-SEC-21, filed to move this into
    // one Rust/IndexedDB transaction) — this is a JS-level snapshot-and-
    // rollback simulation. It closes the practical data-loss risk today;
    // it does not make the wipe-then-write sequence atomic at the database
    // level. _validate() above is what actually keeps garbage out — a
    // rollback that can itself fail is not a substitute for not writing
    // garbage in the first place.

    // Deletes every item (cascades memberships + item_tags via the
    // documented deleteItem() contract) and every tag row. Shared by the
    // real restore and by rollback, which wipes back to empty before
    // replaying the snapshot.
    async _wipeAll() {
        const currentItems = await DBManager.getAllItems();
        for (const item of currentItems) {
            await DBManager.deleteItem(item.id);
        }
        const currentTags = await DBManager.getAllTags();
        for (const tag of currentTags) {
            await DBManager.deleteTag(tag.id);
        }
    },

    // Writes a full data set (a parsed backup, or a snapshot taken for
    // rollback) into an already-wiped database. Shared by the real restore
    // and by rollback.
    async _writeAll(data) {
        // Items first — memberships reference them by ItemId. IDs are
        // preserved verbatim from the source, so those references resolve
        // correctly with no remapping step. No bulk endpoint exists for
        // items, so this stays one call per item.
        for (const item of (data.Items || [])) {
            await DBManager.saveItem(item);
        }

        // One call per collection instead of one call per record —
        // replaceCollection wraps the whole thing in a single transaction
        // on the backend (replace_all_consumed etc.), rather than each
        // record crossing the Tauri IPC boundary (or hitting IndexedDB)
        // separately. Tags get created/attached automatically by the same
        // per-record Tags handling saveCollectionRecord already uses — no
        // separate pass needed.
        await DBManager.replaceCollection('consumed', data.Consumed || []);
        await DBManager.replaceCollection('queued', data.Queued || []);
        await DBManager.replaceCollection('owned', data.Owned || []);

        if (data.Settings) {
            // backupFolder is never restored from a backup file — a shared
            // or malicious backup could otherwise redirect where future
            // backups get written (CTX-SEC-101). Every other setting
            // restores normally.
            const { backupFolder, ...restoredSettings } = data.Settings;
            await DBManager.saveSettings(restoredSettings);
        }
    },

    _showRestoreError(message) {
        document.getElementById('restoreError').textContent = message;
        document.getElementById('restoreError').style.display = 'block';
        document.getElementById('restoreConfirmBtn').disabled = true;
        document.getElementById('restoreConfirmCheckbox').checked = false;
    },

    async executeRestore() {
        if (!this._parsedData) return;
        const data = this._parsedData;

        // Snapshot the current library before touching anything, so a
        // failure partway through the write has something to roll back to.
        let snapshot = null;
        try {
            snapshot = await this._gatherAllData();
        } catch (e) {
            console.error('BackupRestore.executeRestore: could not snapshot current data, aborting before any wipe', e);
            this._showRestoreError('Restore aborted before making any changes — could not read the current library: ' + e.message);
            return;
        }

        try {
            await this._wipeAll();
            await this._writeAll(data);

            this.close();
            showMessage(
                `Restore complete — ${(data.Consumed || []).length} in ${MediaLabels.ConsumedLabel}, ` +
                `${(data.Queued || []).length} in ${MediaLabels.QueuedLabel}, ` +
                `${(data.Owned || []).length} in ${MediaLabels.OwnedLabel}. Must reset backup folder.`,
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
            console.error('BackupRestore.executeRestore failed, attempting rollback to the pre-restore snapshot', e);
            try {
                await this._wipeAll();
                await this._writeAll(snapshot);
                this._showRestoreError(`Restore failed (${e.message}) — your previous data has been restored.`);
            } catch (rollbackErr) {
                console.error('BackupRestore.executeRestore: rollback also failed. Your data has NOT been restored.', rollbackErr);
                console.error('BackupRestore.executeRestore: last-resort snapshot of your pre-restore library follows — save this output:');
                console.error(JSON.stringify(snapshot));
                this._showRestoreError(
                    `Restore failed (${e.message}) and automatic recovery also failed (${rollbackErr.message}). ` +
                    `Your data has NOT been restored. A snapshot of your library from just before this restore ` +
                    `has been written to the console — do not close it until you've saved that output.`
                );
            }
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

