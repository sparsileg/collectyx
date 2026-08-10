// ── Settings ──────────────────────────────────────────────────────────────
// Modal, not a full view — confirmed decision (design doc §4.2, §7).
// Theme and font size live in the sidebar itself, not here (§4.1). Backup
// folder, daily reading goal, and date display format all persist inside
// settings.data alongside them — no schema change needed for any of the
// three fields this modal owns.

const SettingsModal = {
    // #settingsModal and its form are static markup, never rebuilt — bind
    // once, guarded, same pattern as the collection views.
    _wired: false,
    _bindEvents() {
        if (this._wired) return;
        const modal = document.getElementById('settingsModal');
        if (!modal) return;
        const form = document.getElementById('settingsForm');
        if (form) form.addEventListener('submit', (event) => this.save(event));
        modal.addEventListener('click', (event) => {
            const btn = event.target.closest('[data-action]');
            if (!btn || !modal.contains(btn)) return;
            const action = btn.dataset.action;
            if (action === 'browse-folder') this.browseBackupFolder();
            else if (action === 'clear-folder') this.clearBackupFolder();
            else if (action === 'open-owner-test') {
                if (CONSTANTS.ENABLE_OWNER_TEST_SWITCH) OwnerTestModal.open();
            }
            else if (action === 'close') this.close();
        });
        this._wired = true;
    },

    async open() {
        this._bindEvents();
        let settings = {};
        try {
            settings = await DBManager.getSettings() || {};
        } catch (e) {
            console.error('SettingsModal.open: could not load settings', e);
        }

        document.getElementById('settingsDailyGoal').value =
            settings.dailyReadingGoal != null ? settings.dailyReadingGoal : CONSTANTS.DEFAULT_DAILY_READING_GOAL;
        document.getElementById('settingsDateFormat').value = settings.dateFormat || DateUtils.DEFAULT_FORMAT;
        document.getElementById('settingsBackupFolder').value = settings.backupFolder || '';

        // Same pattern as Scriptum's Settings view: folder picker only
        // means anything in Tauri; the web build has no filesystem access
        // and always saves to the system Downloads folder (issue 43).
        const isTauri = typeof window.__TAURI__ !== 'undefined';
        document.getElementById('settingsBackupActions').style.display = isTauri ? '' : 'none';
        const folderField = document.getElementById('settingsBackupFolder');
        folderField.disabled = !isTauri;
        if (!isTauri) folderField.value = 'Your Downloads folder';

        // Owner (Testing) row is gated behind a build flag (COLLECTYX-
        // SEC-35) — hidden entirely, not just disabled, so it doesn't
        // ship in a normal build.
        const showOwnerTest = !!CONSTANTS.ENABLE_OWNER_TEST_SWITCH;
        const ownerTestBtn = document.getElementById('settingsOwnerTestBtn');
        const ownerTestDivider = document.getElementById('settingsOwnerTestDivider');
        if (ownerTestBtn) ownerTestBtn.style.display = showOwnerTest ? '' : 'none';
        if (ownerTestDivider) ownerTestDivider.style.display = showOwnerTest ? '' : 'none';

        document.getElementById('settingsModal').classList.add('open');
    },

    close() {
        document.getElementById('settingsModal').classList.remove('open');
    },

    async browseBackupFolder() {
        if (typeof window.__TAURI_PLUGIN_DIALOG__ === 'undefined') return;
        try {
            const selected = await window.__TAURI_PLUGIN_DIALOG__.open({ directory: true });
            if (selected) document.getElementById('settingsBackupFolder').value = selected;
        } catch (e) {
            console.error('SettingsModal.browseBackupFolder failed', e);
        }
    },

    clearBackupFolder() {
        document.getElementById('settingsBackupFolder').value = '';
    },

    async save(event) {
        event.preventDefault();

        let current = {};
        let loaded = true;
        try {
            current = await DBManager.getSettings() || {};
        } catch (e) {
            console.error('SettingsModal.save: could not load current settings', e);
            loaded = false;
        }
        if (!loaded) {
            showMessage('Could not read current settings — refusing to overwrite them.', CONSTANTS.MESSAGE_TYPES.ERROR);
            return;
        }

        const goalInput = document.getElementById('settingsDailyGoal').value;
        const goal = goalInput ? parseInt(goalInput, 10) : CONSTANTS.DEFAULT_DAILY_READING_GOAL;
        const dateFormat = document.getElementById('settingsDateFormat').value;
        const backupFolder = document.getElementById('settingsBackupFolder').value.trim();

        try {
            await DBManager.saveSettings({
                ...current,
                dailyReadingGoal: goal,
                dateFormat: dateFormat,
                backupFolder: backupFolder
            });

            // CollectionView reads this synchronously on every render — same
            // cache sidebar.js's initSidebarChrome() populates at startup.
            if (typeof CollectionView !== 'undefined') {
                CollectionView._dateFormatCache = dateFormat;
            }

            this.close();
            showMessage('Settings saved', CONSTANTS.MESSAGE_TYPES.SUCCESS);
            this._refreshActiveView();
        } catch (e) {
            console.error('SettingsModal.save failed', e);
            showMessage('Could not save settings — see console for details', CONSTANTS.MESSAGE_TYPES.ERROR);
        }
    },

    // Date format (and, incidentally, the daily reading goal) only show up
    // correctly once whatever's on screen re-renders — CollectionView reads
    // _dateFormatCache per row at render time, not reactively. Same
    // active-view-refresh pattern BackupRestore.executeRestore() already
    // uses, so this isn't guessing at each view's internals.
    _refreshActiveView() {
        ['consumed', 'queued', 'owned'].forEach(collection => {
            const containerId = collection + 'View';
            const el = document.getElementById(containerId);
            const view = collection === 'consumed' ? (typeof ConsumedView !== 'undefined' && ConsumedView)
                : collection === 'queued' ? (typeof QueuedView !== 'undefined' && QueuedView)
                : (typeof OwnedView !== 'undefined' && OwnedView);
            if (el && el.classList.contains('active') && view) view.load(containerId);
        });

        const tagsView = document.getElementById('tagsView');
        if (tagsView && tagsView.classList.contains('active') && typeof TagsView !== 'undefined') {
            TagsView.load('tagsView');
        }

        const dashboardView = document.getElementById('dashboardView');
        if (dashboardView && dashboardView.classList.contains('active') && typeof renderDashboard === 'function') {
            renderDashboard();
        }

        const statisticsView = document.getElementById('statisticsView');
        if (statisticsView && statisticsView.classList.contains('active') && typeof renderStatistics === 'function') {
            if (typeof destroyCharts === 'function') destroyCharts();
            renderStatistics();
        }
    }
};

// ── Owner (Testing) ──────────────────────────────────────────────────────
// Temporary: lets Stan switch which owner's rows are visible, to exercise
// the owner-scoping the schema already carries. Stored in app_meta, not
// settings — settings itself is owner-scoped, so the currently-active
// owner can't live there without a chicken-and-egg problem. app_meta is
// deliberately generic (key/value) so a real auth mechanism (session
// token, API key hash) can reuse it later without a new table.

const OwnerTestModal = {
    _wired: false,
    _bindEvents() {
        if (this._wired) return;
        const modal = document.getElementById('ownerTestModal');
        if (!modal) return;
        modal.addEventListener('click', (event) => {
            const btn = event.target.closest('[data-action]');
            if (!btn || !modal.contains(btn)) return;
            const action = btn.dataset.action;
            if (action === 'save') this.save();
            else if (action === 'close') this.close();
        });
        this._wired = true;
    },

    async open() {
        this._bindEvents();
        let current = CONSTANTS.DEFAULT_OWNER;
        try {
            current = (await DBManager.getAppMeta(CONSTANTS.APP_META_KEYS.CURRENT_OWNER)) || CONSTANTS.DEFAULT_OWNER;
        } catch (e) {
            console.error('OwnerTestModal.open: could not load current owner', e);
        }
        document.getElementById('ownerTestCurrent').value = current;
        document.getElementById('ownerTestNew').value = '';
        document.getElementById('ownerTestModal').classList.add('open');
    },

    close() {
        document.getElementById('ownerTestModal').classList.remove('open');
    },

    async save() {
        const newOwner = document.getElementById('ownerTestNew').value.trim();
        if (!newOwner) { showMessage('Enter an owner key.', CONSTANTS.MESSAGE_TYPES.ERROR); return; }

        try {
            await DBManager.setAppMeta(CONSTANTS.APP_META_KEYS.CURRENT_OWNER, newOwner);
            this.close();
            SettingsModal.close();
            showMessage(`Switched to owner "${newOwner}" — reloading`, CONSTANTS.MESSAGE_TYPES.SUCCESS);
            // Every view's in-memory data is scoped to whichever owner was
            // active when it loaded — a full reload is the simplest way to
            // guarantee nothing on screen still reflects the old owner.
            setTimeout(() => window.location.reload(), 600);
        } catch (e) {
            console.error('OwnerTestModal.save failed', e);
            showMessage('Could not switch owner — see console for details', CONSTANTS.MESSAGE_TYPES.ERROR);
        }
    }
};
