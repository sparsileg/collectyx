// ── Automatic backup (#97) ───────────────────────────────────────────────────
// Ported from Astryx's debounce-timer pattern: every write to backed-up
// data restarts a timer; when the configured interval passes with no
// further writes, one backup runs through BackupRestore.backupDatabase() —
// the same code path, file format and destination as the manual "Backup
// Database" action (backup folder on desktop, a browser download on web,
// so the web version has a file copy that survives clearing browser data).
//
// Hook point: DBManager itself (db-manager.js wraps the backend's write
// methods and calls noteChange()), so no view or modal has to remember to
// report its own writes.
//
// The last-change and last-backup times live in localStorage, not in
// settings: they describe this device, and writing them through settings
// would itself be a tracked write. They let a backup that was still
// pending when the app closed run at the next launch (Astryx does the
// same). If localStorage is unavailable, only that catch-up is lost.

const AutoBackup = {
    _timer: null,
    _running: false,
    _rerun: false,

    LAST_CHANGE_KEY: 'collectyx.autoBackup.lastChange',
    LAST_BACKUP_KEY: 'collectyx.autoBackup.lastBackup',

    // Reads the two settings this feature owns, falling back to defaults.
    async _config() {
        let settings = {};
        try {
            settings = await DBManager.getSettings() || {};
        } catch (e) {
            console.error('AutoBackup: could not load settings', e);
        }
        const enabled = typeof settings.autoBackupEnabled === 'boolean'
            ? settings.autoBackupEnabled
            : CONSTANTS.DEFAULT_AUTO_BACKUP_ENABLED;
        const minutes = CONSTANTS.AUTO_BACKUP_MINUTES_OPTIONS.includes(settings.autoBackupMinutes)
            ? settings.autoBackupMinutes
            : CONSTANTS.DEFAULT_AUTO_BACKUP_MINUTES;
        return { enabled, delayMs: minutes * 60000 };
    },

    _getTime(key) {
        try {
            const v = Number(localStorage.getItem(key));
            return Number.isFinite(v) && v > 0 ? v : 0;
        } catch (e) {
            return 0;
        }
    },

    _setTime(key, ms) {
        try {
            localStorage.setItem(key, String(ms));
        } catch (e) {
            // Private window / blocked storage — the in-session timer
            // still works; only the next-launch catch-up is lost.
        }
    },

    // Called by DBManager after every successful write to backed-up data.
    // Never throws and never blocks the caller.
    noteChange() {
        this._setTime(this.LAST_CHANGE_KEY, Date.now());
        this.schedule().catch(e => console.error('AutoBackup.schedule failed', e));
    },

    // (Re)starts the countdown. delayMs overrides the configured interval
    // (used to resume a countdown carried over from the last session).
    async schedule(delayMs) {
        this.cancel();
        const config = await this._config();
        if (!config.enabled) return;
        // A write that lands while _config() is awaited may have already
        // scheduled its own timer — keep only one.
        this.cancel();
        const wait = delayMs != null ? Math.max(0, delayMs) : config.delayMs;
        this._timer = setTimeout(() => {
            this._timer = null;
            this.run(false);
        }, wait);
    },

    cancel() {
        if (this._timer) {
            clearTimeout(this._timer);
            this._timer = null;
        }
    },

    // Runs one automatic backup. A run already in progress isn't
    // interrupted; if another one is due meanwhile it runs right after.
    async run(fromLastSession) {
        if (this._running) {
            this._rerun = true;
            return;
        }
        const config = await this._config();
        if (!config.enabled) return;
        this._running = true;
        try {
            await BackupRestore.backupDatabase({ auto: true, fromLastSession: !!fromLastSession });
        } catch (e) {
            console.error('AutoBackup.run failed', e);
        } finally {
            this._running = false;
        }
        if (this._rerun) {
            this._rerun = false;
            this.run(false);
        }
    },

    // Called by BackupRestore.backupDatabase() after any successful backup,
    // manual or automatic, so a catch-up at next launch isn't repeated for
    // changes that are already backed up. A pending timer is left alone.
    recordBackup() {
        this._setTime(this.LAST_BACKUP_KEY, Date.now());
    },

    // App startup: if changes from the last session were never backed up,
    // back them up now (interval already passed) or resume the countdown.
    async init() {
        const config = await this._config();
        if (!config.enabled) return;
        const lastChange = this._getTime(this.LAST_CHANGE_KEY);
        if (!lastChange) return;
        if (this._getTime(this.LAST_BACKUP_KEY) >= lastChange) return;

        const remaining = config.delayMs - (Date.now() - lastChange);
        if (remaining <= 0) {
            await this.run(true);
        } else {
            await this.schedule(remaining);
        }
    }
};

window.AutoBackup = AutoBackup;
