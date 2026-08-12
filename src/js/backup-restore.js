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

import { invoke as tauriInvoke, isTauri } from './vendor/tauri-api/core.js';

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
    // Structural problems (file isn't an object, a section isn't an array,
    // a record isn't an object) still halt in full — a shapeless record
    // can't be shown for skip review, so there's nothing to offer the user.
    // Per-record content problems (missing Title, a dangling ItemId) are
    // collected instead and offered to the user as skippable (#74): Stop
    // leaves current data untouched, same guarantee as a fatal failure;
    // Skip drops just those records and proceeds. All of this runs before
    // _wipeAll() in executeRestore() ever executes.

    _typeName(v) {
        if (Array.isArray(v)) return 'array';
        if (v === null) return 'null';
        return typeof v;
    },

    // MediaTypeId crashes Rust deserialization if present with the wrong
    // JSON type (e.g. "" instead of a number) — caught here, before the
    // wipe, rather than surfacing as a raw deserialize error mid-restore.
    _isValidMediaTypeId(v) {
        return typeof v === 'number' && Number.isInteger(v) && v >= 1;
    },

    // Every optional field below (Option<T>/Option<Option<T>> in Rust)
    // only forgives an absent key or an explicit null — a present value
    // of the wrong JSON type still crashes deserialization before any
    // validation code runs (#80). These four helpers are the type-shape
    // check for each of Rust's optional field kinds; absent/null always
    // passes, since that's the caller's concern (an unset optional field
    // is legitimate).
    _isValidOptionalString(v) {
        return v === undefined || v === null || typeof v === 'string';
    },
    _isValidOptionalInt(v) {
        return v === undefined || v === null || (typeof v === 'number' && Number.isInteger(v));
    },
    _isValidOptionalBool(v) {
        return v === undefined || v === null || typeof v === 'boolean';
    },
    _isValidOptionalStringArray(v) {
        if (v === undefined || v === null) return true;
        return Array.isArray(v) && v.every(x => typeof x === 'string');
    },

    // Returns { fatal: string|null, skippable: [{ label, index, record, reason }] }.
    // Fatal covers file-shape problems that cannot be partially applied —
    // not an object, a section not an array, a record not an object — and
    // still halts immediately, unchanged from before. Per-record content
    // problems (missing Title, a dangling ItemId reference) are collected
    // instead of failing on the first one found, so the caller can offer
    // to skip just those records and restore everything else (#74).
    _validate(data) {
        const skippable = [];

        if (this._typeName(data) !== 'object') {
            return { fatal: `Backup file must contain a JSON object, got ${this._typeName(data)}`, skippable };
        }

        if (this._typeName(data.Items) !== 'array') {
            return { fatal: `Items must be an array, got ${this._typeName(data.Items)}`, skippable };
        }
        for (let i = 0; i < data.Items.length; i++) {
            const record = data.Items[i];
            if (this._typeName(record) !== 'object') {
                return { fatal: `Items[${i}] must be an object, got ${this._typeName(record)}`, skippable };
            }
            // Rust's ItemRecord requires id/MediaTypeId with no default —
            // missing or wrong-typed crashes deserialization, not just
            // validation, so these are caught here alongside Title.
            const reasons = [];
            if (typeof record.Title !== 'string' || record.Title.trim() === '') {
                reasons.push('missing Title');
            }
            if (typeof record.id !== 'string' || record.id.trim() === '') {
                reasons.push('missing or invalid id');
            }
            if (record.MediaTypeId === undefined || record.MediaTypeId === null) {
                reasons.push('missing MediaTypeId');
            } else if (!this._isValidMediaTypeId(record.MediaTypeId)) {
                reasons.push('invalid MediaTypeId');
            }
            // Items[] uses ItemRecord — plain Author/Author2/Pages/ISBN/
            // Tags/DateAdded/Modified keys (not the ItemDateAdded/
            // ItemModified names Consumed/Queued/Owned use below).
            if (!this._isValidOptionalString(record.Author)) reasons.push('invalid Author');
            if (!this._isValidOptionalString(record.Author2)) reasons.push('invalid Author2');
            if (!this._isValidOptionalInt(record.Pages)) reasons.push('invalid Pages');
            if (!this._isValidOptionalString(record.ISBN)) reasons.push('invalid ISBN');
            if (!this._isValidOptionalStringArray(record.Tags)) reasons.push('invalid Tags');
            if (!this._isValidOptionalString(record.DateAdded)) reasons.push('invalid DateAdded');
            if (!this._isValidOptionalString(record.Modified)) reasons.push('invalid Modified');
            if (reasons.length > 0) {
                skippable.push({ label: 'Items', index: i, record, reason: reasons.join('; ') });
            }
        }

        // Consumed/Queued/Owned: absent is treated the same as today's
        // `data.Consumed || []` fallback — restores as empty. Present but
        // wrongly-typed, or containing a non-object record, is still fatal
        // — a record with no shape at all can't be shown for skip review.
        for (const key of ['Consumed', 'Queued', 'Owned']) {
            if (data[key] === undefined) continue;
            if (this._typeName(data[key]) !== 'array') {
                return { fatal: `${key} must be an array, got ${this._typeName(data[key])}`, skippable };
            }
            for (let i = 0; i < data[key].length; i++) {
                const record = data[key][i];
                if (this._typeName(record) !== 'object') {
                    return { fatal: `${key}[${i}] must be an object, got ${this._typeName(record)}`, skippable };
                }
                const reasons = [];
                if (typeof record.Title !== 'string' || record.Title.trim() === '') {
                    reasons.push('missing Title');
                }
                // MediaTypeId is optional here (ItemFields defaults to 1
                // when absent) — only a present-but-wrong-type value
                // crashes deserialization, so only that case is flagged.
                if (record.MediaTypeId !== undefined && record.MediaTypeId !== null
                    && !this._isValidMediaTypeId(record.MediaTypeId)) {
                    reasons.push('invalid MediaTypeId');
                }
                // Shared ItemFields — every optional field crashes Rust
                // deserialization if present with the wrong type (#80).
                if (!this._isValidOptionalString(record.id)) reasons.push('invalid id');
                if (!this._isValidOptionalString(record.ItemId)) reasons.push('invalid ItemId');
                if (!this._isValidOptionalString(record.Author)) reasons.push('invalid Author');
                if (!this._isValidOptionalString(record.Author2)) reasons.push('invalid Author2');
                if (!this._isValidOptionalInt(record.Pages)) reasons.push('invalid Pages');
                if (!this._isValidOptionalString(record.ISBN)) reasons.push('invalid ISBN');
                if (!this._isValidOptionalStringArray(record.Tags)) reasons.push('invalid Tags');
                if (!this._isValidOptionalString(record.ItemDateAdded)) reasons.push('invalid ItemDateAdded');
                if (!this._isValidOptionalString(record.ItemModified)) reasons.push('invalid ItemModified');
                if (!this._isValidOptionalString(record.Comments)) reasons.push('invalid Comments');
                if (!this._isValidOptionalString(record.DateAdded)) reasons.push('invalid DateAdded');
                if (!this._isValidOptionalString(record.Modified)) reasons.push('invalid Modified');
                // Collection-specific optional fields.
                if (key === 'Consumed') {
                    if (!this._isValidOptionalInt(record.Rating)) reasons.push('invalid Rating');
                }
                if (key === 'Queued') {
                    if (!this._isValidOptionalInt(record.Rank)) reasons.push('invalid Rank');
                    if (!this._isValidOptionalString(record.Source)) reasons.push('invalid Source');
                    if (!this._isValidOptionalBool(record.CurrentlyReading)) reasons.push('invalid CurrentlyReading');
                }
                if (key === 'Owned') {
                    if (!this._isValidOptionalString(record.Location)) reasons.push('invalid Location');
                    if (!this._isValidOptionalString(record.Patron)) reasons.push('invalid Patron');
                    if (!this._isValidOptionalString(record.CheckedOutDate)) reasons.push('invalid CheckedOutDate');
                }
                // Finished has no default in Rust's ConsumedRecord — schema
                // requires it (consumed.finished TEXT NOT NULL) — missing
                // or wrong-typed crashes deserialization same as Title.
                if (key === 'Consumed' && (typeof record.Finished !== 'string' || record.Finished.trim() === '')) {
                    reasons.push('missing or invalid Finished date');
                }
                if (reasons.length > 0) {
                    skippable.push({ label: key, index: i, record, reason: reasons.join('; ') });
                }
            }
        }

        // Every referenced ItemId must be present in Items[] — a membership
        // row pointing at an item the file does not carry cannot be
        // restored. Now skippable rather than fatal (#74); detection itself
        // is unchanged from the #62 fix (CTX-SEC-112). Built from every raw
        // Items entry regardless of that entry's own Title validity.
        const itemIds = new Set((data.Items || []).map(i => i.id).filter(Boolean));
        for (const key of ['Consumed', 'Queued', 'Owned']) {
            const rows = data[key];
            if (!Array.isArray(rows)) continue;
            for (let i = 0; i < rows.length; i++) {
                const ref = rows[i].ItemId;
                if (ref && !itemIds.has(ref)) {
                    skippable.push({ label: key, index: i, record: rows[i], reason: `references ItemId "${ref}", which is not in Items` });
                }
            }
        }

        if (data.Tags !== undefined) {
            if (this._typeName(data.Tags) !== 'array') {
                return { fatal: `Tags must be an array, got ${this._typeName(data.Tags)}`, skippable };
            }
            for (let i = 0; i < data.Tags.length; i++) {
                const tag = data.Tags[i];
                if (this._typeName(tag) !== 'object') {
                    return { fatal: `Tags[${i}] must be an object, got ${this._typeName(tag)}`, skippable };
                }
                if (typeof tag.Name !== 'string' || tag.Name.trim() === '') {
                    skippable.push({ label: 'Tags', index: i, record: tag, reason: 'missing Name' });
                }
            }
        }

        if (data.Settings !== undefined && this._typeName(data.Settings) !== 'object') {
            return { fatal: `Settings must be an object, got ${this._typeName(data.Settings)}`, skippable };
        }

        return { fatal: null, skippable };
    },

    // Removes every flagged record from a shallow copy of data — called
    // only after the user explicitly chooses to skip and continue.
    // data.Items itself is filtered too (a bad-Title item is dropped),
    // but membership rows referencing that item's id are only dropped if
    // they were independently flagged — no cascade is applied beyond what
    // _validate() already found (#74, Q1: orphan items are allowed).
    _filterSkippable(data, skippable) {
        const dropIndexes = { Items: new Set(), Consumed: new Set(), Queued: new Set(), Owned: new Set(), Tags: new Set() };
        for (const entry of skippable) {
            dropIndexes[entry.label].add(entry.index);
        }
        const filtered = { ...data };
        for (const key of Object.keys(dropIndexes)) {
            if (!Array.isArray(data[key])) continue;
            filtered[key] = data[key].filter((_, i) => !dropIndexes[key].has(i));
        }
        return filtered;
    },

    // ── Export ───────────────────────────────────────────────────────────────

    async backupDatabase() {
        const isTauriBuild = isTauri();

        try {
            const data = await this._gatherAllData();
            const json = JSON.stringify(data);
            const useGzip = typeof pako !== 'undefined';
            const filename = useGzip
                ? `collectyx-backup-${this._timestamp()}.json.gz`
                : `collectyx-backup-${this._timestamp()}.json`;

            if (isTauriBuild) {
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
                    await tauriInvoke('save_backup_file', { filename: filename, contents: contents });
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
                else if (action === 'stop') this.stopRestore();
                else if (action === 'skip-continue') this.skipAndContinue();
            });
            return true;
        };
        const allBound = bind('restoreScreen1Modal') && bind('restoreScreen2Modal') && bind('restoreDefectiveModal');
        if (!allBound) return;

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

        const { fatal, skippable } = this._validate(this._parsedData);
        if (fatal) {
            this._parsedData = null;
            await this.showScreen2(null, fatal);
            return;
        }

        if (skippable.length > 0) {
            this.showDefectiveModal(skippable);
            return;
        }

        await this.showScreen2(this._parsedData, null);
    },

    // ── Restore: Defective Records — skip or stop ──────────────────────────
    // Shown between Screen 1 and Screen 2 only when _validate() finds
    // skippable (non-fatal) per-record problems. Stop aborts before any
    // wipe runs — same untouched-data guarantee as today's fatal-error
    // path. Skip filters the flagged records out of _parsedData and
    // proceeds to Screen 2 as if they were never in the file.
    _pendingSkippable: null,

    showDefectiveModal(skippable) {
        this._pendingSkippable = skippable;
        document.getElementById('restoreScreen1Modal').classList.remove('open');
        document.getElementById('restoreDefectiveModal').classList.add('open');

        const count = skippable.length;
        document.getElementById('restoreDefectiveCount').innerHTML =
            `<strong>${count} record${count === 1 ? '' : 's'} could not be restored.</strong> ` +
            `Review below — Stop leaves your current data untouched, or skip these and restore everything else.`;

        const listDiv = document.getElementById('restoreDefectiveList');
        listDiv.innerHTML = skippable.map(entry => `
            <div style="border-bottom: 1px solid var(--border-color); padding: 10px 0;">
                <div style="margin-bottom: 4px;"><strong>${escapeHtml(entry.label)}[${entry.index}]</strong> — ${escapeHtml(entry.reason)}</div>
                <pre style="white-space: pre-wrap; word-break: break-all; margin: 0; font-size: 0.85em; user-select: text;">${escapeHtml(JSON.stringify(entry.record, null, 2))}</pre>
            </div>
        `).join('');
    },

    stopRestore() {
        this._pendingSkippable = null;
        this.close();
    },

    async skipAndContinue() {
        if (!this._parsedData || !this._pendingSkippable) return;
        this._parsedData = this._filterSkippable(this._parsedData, this._pendingSkippable);
        this._pendingSkippable = null;
        document.getElementById('restoreDefectiveModal').classList.remove('open');
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

        // Callers MUST run _validate() first — this method assumes Consumed/
        // Queued/Owned/Tags are arrays. current/backup are escaped here
        // regardless (CTX-SEC-117), but the assumption is load-bearing for
        // the counts being meaningful.
        const countRow = (label, current, backup) => `
            <div style="display: flex; align-items: center; gap: 12px; padding: 8px 0;
                        border-bottom: 1px solid var(--border-color);">
                <span style="flex: 1;">${escapeHtml(label)}</span>
                <span style="min-width: 40px; text-align: right;">${escapeHtml(String(current))}</span>
                <span style="opacity: 0.6;">→</span>
                <span style="min-width: 40px; text-align: right;">${escapeHtml(String(backup))}</span>
            </div>`;

        // Coerce to a real count so a non-array value can never reach the
        // template, even though _validate() already guarantees arrays here.
        const count = (v) => (Array.isArray(v) ? v.length : 0);

        countsDiv.innerHTML = `
            <div style="display: flex; gap: 12px; padding: 0 0 4px; font-weight: bold; opacity: 0.6;">
                <span style="flex: 1;">Data Store</span>
                <span style="min-width: 40px; text-align: right;">Current</span>
                <span style="opacity: 0;">→</span>
                <span style="min-width: 40px; text-align: right;">Backup</span>
            </div>
            ${countRow(MediaLabels.ConsumedLabel, currentConsumed.length, count(data.Consumed))}
            ${countRow(MediaLabels.QueuedLabel, currentQueued.length, count(data.Queued))}
            ${countRow(MediaLabels.OwnedLabel, currentOwned.length, count(data.Owned))}
            ${countRow('Tags', currentTags.length, count(data.Tags))}
        `;

        warningDiv.style.display = 'block';
        checkRow.style.display = 'block';
    },

    checkboxChanged() {
        document.getElementById('restoreConfirmBtn').disabled = !document.getElementById('restoreConfirmCheckbox').checked;
    },

    // ── Execute ──────────────────────────────────────────────────────────────
    // Restore is a single atomic call (#40) — DBManager.restoreAll wraps
    // the whole wipe-and-write in one Rust transaction / one IndexedDB
    // transaction. A failure partway through leaves the pre-restore state
    // completely unchanged, so there is nothing to roll back to: the
    // JS-level snapshot-and-rollback simulation this file used to run in
    // front of a non-atomic wipe-then-write sequence (COLLECTYX-SEC-21)
    // is gone. _validate() above is still what keeps garbage out in the
    // first place — restoreAll's atomicity is what happens after that,
    // not a substitute for it.

    _showRestoreError(message) {
        document.getElementById('restoreError').textContent = message;
        document.getElementById('restoreError').style.display = 'block';
        document.getElementById('restoreConfirmBtn').disabled = true;
        document.getElementById('restoreConfirmCheckbox').checked = false;
    },

    async executeRestore() {
        if (!this._parsedData) return;
        const data = this._parsedData;

        try {
            await DBManager.restoreAll(data);

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
            // Nothing committed — restoreAll's transaction guarantees the
            // pre-restore state is untouched on any failure, so this is a
            // plain error, not a rollback attempt.
            console.error('BackupRestore.executeRestore failed — no changes were made', e);
            this._showRestoreError(`Restore failed (${e.message}) — your previous data is unchanged.`);
        }
    },

    close() {
        document.getElementById('restoreScreen1Modal').classList.remove('open');
        document.getElementById('restoreScreen2Modal').classList.remove('open');
        document.getElementById('restoreDefectiveModal').classList.remove('open');
        this._parsedData = null;
        this._fileName = null;
        this._fileSize = null;
        this._pendingSkippable = null;
    }
};

window.BackupRestore = BackupRestore;

