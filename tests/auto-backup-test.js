/**
 * Issue #97 — automatic backup on a debounce timer.
 *
 * Loads the real src/js/db-manager.js (the write-tracking wrapper) and
 * src/js/auto-backup.js (the timer) into a sandbox with a fake clock, a
 * fake backend and a fake BackupRestore, then checks:
 *
 *   - a burst of writes produces exactly one backup, after the interval
 *   - each write restarts the countdown
 *   - reads and untracked writes (restoreAll) never start one
 *   - the wrapper still runs backend methods with the backend as `this`
 *   - auto-backup off means no backup, and the interval setting is honoured
 *   - startup catch-up: overdue changes back up at once (fromLastSession),
 *     a countdown still in progress resumes, already-backed-up changes don't
 *   - a manual backup doesn't cancel a pending automatic one
 *   - every tracked write exists on both real backends
 */
const fs = require('fs');
const vm = require('vm');
const { stripEsmImports, esmStubs } = require('./lib/esm-shim');

const R = process.env.COLLECTYX_ROOT || '../';
const dbManagerSrc = fs.readFileSync(R + '/src/js/db-manager.js', 'utf8');
const autoBackupSrc = fs.readFileSync(R + '/src/js/auto-backup.js', 'utf8');
const webSrc = fs.readFileSync(R + '/src/js/db-manager-web.js', 'utf8');
const tauriSrc = fs.readFileSync(R + '/src/js/db-manager-tauri.js', 'utf8');

let failures = 0;
function check(label, actual, expected) {
    const a = JSON.stringify(actual), e = JSON.stringify(expected);
    if (a === e) console.log('  ok   ' + label);
    else { console.log('  FAIL ' + label + '\n         got:      ' + a + '\n         expected: ' + e); failures++; }
}
function ok(label, cond, detail) {
    if (cond) console.log('  ok   ' + label);
    else { console.log('  FAIL ' + label + (detail ? '\n         ' + detail : '')); failures++; }
}

const MIN = 60000;
const flush = () => new Promise(r => setImmediate(r));

// Fresh sandbox per scenario: fake clock + timers, in-memory localStorage,
// a backend that records calls, and a BackupRestore that records backups.
function makeWorld({ settings = {}, storage = {}, now = 1_000_000_000_000 } = {}) {
    let clock = now;
    let timers = [];
    let nextId = 1;
    const store = new Map(Object.entries(storage));
    const backups = [];
    const calls = [];

    const backend = {
        _settings: settings,
        _secret: 'backend-this',
        async getSettings() { return this._settings; },
        async getCollection() { calls.push('getCollection'); return []; },
        async saveCollectionRecord(c, r) { calls.push('saveCollectionRecord'); return { id: 'x', who: this._secret }; },
        async deleteCollectionRecord() { calls.push('deleteCollectionRecord'); },
        async reorderQueued() { calls.push('reorderQueued'); },
        async saveSettings(s) { calls.push('saveSettings'); this._settings = s; },
        async restoreAll() { calls.push('restoreAll'); },
        async setAppMeta() { calls.push('setAppMeta'); },
    };

    const sandbox = {
        console,
        Promise, Set, Map, Number, String, Math, Error, Object,
        Date: { now: () => clock },
        setTimeout: (fn, ms) => { const id = nextId++; timers.push({ id, at: clock + ms, fn }); return id; },
        clearTimeout: (id) => { timers = timers.filter(t => t.id !== id); },
        localStorage: {
            getItem: (k) => (store.has(k) ? store.get(k) : null),
            setItem: (k, v) => { store.set(k, String(v)); },
        },
        CONSTANTS: {
            DEFAULT_AUTO_BACKUP_ENABLED: true,
            DEFAULT_AUTO_BACKUP_MINUTES: 5,
            AUTO_BACKUP_MINUTES_OPTIONS: [1, 5, 30],
        },
        DBManagerWeb: backend,
        DBManagerTauri: backend,
        BackupRestore: {
            async backupDatabase(opts) {
                backups.push({ at: clock, opts });
                sandbox.AutoBackup.recordBackup();
                return true;
            },
        },
    };
    sandbox.window = sandbox;
    vm.createContext(sandbox);
    const { stripped, bindings } = stripEsmImports(dbManagerSrc);
    Object.assign(sandbox, esmStubs(bindings));
    vm.runInContext(stripped, sandbox);
    vm.runInContext(autoBackupSrc, sandbox);

    // Advance the fake clock, firing due timers in order.
    async function advance(ms) {
        const target = clock + ms;
        for (;;) {
            await flush();
            const due = timers.filter(t => t.at <= target).sort((a, b) => a.at - b.at)[0];
            if (!due) break;
            timers = timers.filter(t => t !== due);
            clock = due.at;
            due.fn();
            await flush();
        }
        clock = target;
        await flush();
    }

    return {
        DB: sandbox.DBManager, AutoBackup: sandbox.AutoBackup, backend, backups, calls, store, advance,
        pending: () => timers.length,
        tracked: sandbox.AUTO_BACKUP_TRACKED_WRITES,
    };
}

(async function run() {

console.log('\n1. a burst of writes produces exactly one backup, after the interval');
{
    const w = makeWorld();
    for (let i = 0; i < 5; i++) {
        await w.DB.saveCollectionRecord('consumed', { Title: 'B' + i });
        await w.advance(10 * 1000);
    }
    check('no backup during the burst', w.backups.length, 0);
    await w.advance(5 * MIN);
    check('exactly one backup once the burst settles', w.backups.length, 1);
    ok('it is flagged as automatic, not from last session',
       w.backups[0].opts.auto === true && w.backups[0].opts.fromLastSession === false);
    await w.advance(60 * MIN);
    check('no further backups without further changes', w.backups.length, 1);
}

console.log('\n2. each write restarts the countdown');
{
    const w = makeWorld();
    await w.DB.saveCollectionRecord('queued', { Title: 'A' });
    await w.advance(4 * MIN);
    await w.DB.reorderQueued('x', 1);
    await w.advance(4 * MIN);
    check('no backup 8 minutes in — the second write restarted the clock', w.backups.length, 0);
    await w.advance(1 * MIN);
    check('one backup 5 minutes after the last write', w.backups.length, 1);
}

console.log('\n3. reads and untracked writes never start a countdown');
{
    const w = makeWorld();
    await w.DB.getCollection('consumed');
    await w.DB.restoreAll({});
    await w.DB.setAppMeta('k', 'v');
    await w.advance(60 * MIN);
    check('no backup', w.backups.length, 0);
    check('the calls still reached the backend', w.calls, ['getCollection', 'restoreAll', 'setAppMeta']);
}

console.log('\n4. the wrapper keeps the backend as `this` and passes results through');
{
    const w = makeWorld();
    const result = await w.DB.saveCollectionRecord('consumed', { Title: 'T' });
    check('tracked write returns the backend result, run with backend `this`', result, { id: 'x', who: 'backend-this' });
    await w.DB.saveSettings({ a: 1 });
    check('state written via the wrapper lands on the backend itself', w.backend._settings, { a: 1 });
}

console.log('\n5. settings: off means no backup; the interval setting is honoured');
{
    const off = makeWorld({ settings: { autoBackupEnabled: false } });
    await off.DB.saveCollectionRecord('consumed', { Title: 'T' });
    await off.advance(60 * MIN);
    check('auto-backup off: no backup', off.backups.length, 0);

    const thirty = makeWorld({ settings: { autoBackupMinutes: 30 } });
    await thirty.DB.deleteCollectionRecord('owned', 'x');
    await thirty.advance(29 * MIN);
    check('30-minute setting: nothing at 29 minutes', thirty.backups.length, 0);
    await thirty.advance(1 * MIN);
    check('30-minute setting: one backup at 30 minutes', thirty.backups.length, 1);

    const bogus = makeWorld({ settings: { autoBackupMinutes: 7 } });
    await bogus.DB.deleteCollectionRecord('owned', 'x');
    await bogus.advance(5 * MIN);
    check('an unsupported interval falls back to the 5-minute default', bogus.backups.length, 1);

    const turnedOff = makeWorld();
    await turnedOff.DB.saveCollectionRecord('consumed', { Title: 'T' });
    await turnedOff.DB.saveSettings({ autoBackupEnabled: false });
    await turnedOff.advance(60 * MIN);
    check('saving settings with auto-backup off leaves nothing pending', turnedOff.backups.length, 0);
}

console.log('\n6. startup catch-up of changes from the last session');
{
    const now = 1_000_000_000_000;
    const overdue = makeWorld({ now, storage: { 'collectyx.autoBackup.lastChange': String(now - 20 * MIN) } });
    await overdue.AutoBackup.init();
    check('overdue changes are backed up immediately', overdue.backups.length, 1);
    ok('flagged as from the last session', overdue.backups[0].opts.fromLastSession === true);

    const midway = makeWorld({ now, storage: { 'collectyx.autoBackup.lastChange': String(now - 2 * MIN) } });
    await midway.AutoBackup.init();
    check('countdown in progress: nothing yet', midway.backups.length, 0);
    await midway.advance(3 * MIN - 1);
    check('still nothing just before the remaining 3 minutes are up', midway.backups.length, 0);
    await midway.advance(1);
    check('backup when the remaining time runs out', midway.backups.length, 1);

    const done = makeWorld({ now, storage: {
        'collectyx.autoBackup.lastChange': String(now - 20 * MIN),
        'collectyx.autoBackup.lastBackup': String(now - 10 * MIN),
    } });
    await done.AutoBackup.init();
    await done.advance(60 * MIN);
    check('changes already backed up: no catch-up', done.backups.length, 0);

    const offAtStart = makeWorld({ now, settings: { autoBackupEnabled: false },
        storage: { 'collectyx.autoBackup.lastChange': String(now - 20 * MIN) } });
    await offAtStart.AutoBackup.init();
    check('auto-backup off: no catch-up', offAtStart.backups.length, 0);

    const fresh = makeWorld({ now });
    await fresh.AutoBackup.init();
    check('no recorded change: nothing scheduled', fresh.pending(), 0);
}

console.log('\n7. a write records the change time for the next launch');
{
    const w = makeWorld({ now: 5000 });
    await w.DB.saveCollectionRecord('consumed', { Title: 'T' });
    check('lastChange stored', w.store.get('collectyx.autoBackup.lastChange'), '5000');
    await w.advance(5 * MIN);
    check('lastBackup stored after the backup', w.store.get('collectyx.autoBackup.lastBackup'), String(5000 + 5 * MIN));
}

console.log('\n8. a manual backup does not cancel a pending automatic one');
{
    const w = makeWorld();
    await w.DB.saveCollectionRecord('consumed', { Title: 'T' });
    await w.advance(1 * MIN);
    w.AutoBackup.recordBackup(); // what BackupRestore.backupDatabase() does after a manual backup
    check('timer still pending after the manual backup', w.pending(), 1);
    await w.advance(4 * MIN);
    check('automatic backup still runs', w.backups.length, 1);
}

console.log('\n9. every tracked write exists on both real backends');
{
    const w = makeWorld();
    const names = [...w.tracked];
    const missingWeb = names.filter(n => !new RegExp('\\basync\\s+' + n + '\\s*\\(').test(webSrc));
    const missingTauri = names.filter(n => !new RegExp('\\basync\\s+' + n + '\\s*\\(').test(tauriSrc));
    check('DBManagerWeb has every tracked write', missingWeb, []);
    check('DBManagerTauri has every tracked write', missingTauri, []);
}

console.log('\n' + (failures === 0 ? 'ALL AUTO-BACKUP TESTS PASSED' : failures + ' FAILURE(S)'));
process.exit(failures === 0 ? 0 : 1);

})().catch(e => {
    console.error('\nHARNESS ERROR:', e);
    process.exit(1);
});
