/**
 * Regression test for issue #22. Loads the real backup-restore.js
 * and exercises it two ways:
 *
 *   1. _validate() against the malformed-file corpus from the issue —
 *      pure function, no DB involved.
 *   2. executeRestore() against a mock, in-memory DBManager, forcing
 *      write failures to prove the snapshot-and-rollback path actually
 *      restores the prior state, and that a rollback failure logs a
 *      recoverable snapshot rather than silently losing data.
 *
 * This cannot verify the real DBManagerTauri/DBManagerWeb backends, real
 * IPC failure modes, or gzip/truncated-file handling in a real browser —
 * those need the manual six-file-corpus pass across both builds the
 * issue's own acceptance criteria call for.
 */
const fs = require('fs');
const vm = require('vm');

const R = process.env.COLLECTYX_ROOT || '../';
const src = fs.readFileSync(R + '/src/js/backup-restore.js', 'utf8');

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
function contains(label, haystack, needle) {
    ok(label, typeof haystack === 'string' && haystack.includes(needle),
       'expected to contain: ' + JSON.stringify(needle) + '\n         got: ' + JSON.stringify(haystack));
}

// ── DOM shim ─────────────────────────────────────────────────────────────────
class El {
    constructor(id) {
        this.id = id;
        this._classes = new Set();
        this.classList = {
            add: (c) => this._classes.add(c),
            remove: (c) => this._classes.delete(c),
            contains: (c) => this._classes.has(c),
        };
        this.style = {};
        this.textContent = '';
        this.innerHTML = '';
        this.value = '';
        this.disabled = false;
        this.checked = false;
        this.files = [];
    }
}

function freshDom() {
    const store = {};
    return {
        getElementById: (id) => store[id] || (store[id] = new El(id)),
        _store: store,
    };
}

// ── in-memory mock DBManager ──────────────────────────────────────────────────
// Tags are not written directly by backup-restore.js — real tag rows are
// created via replaceCollection()'s per-record Tags reconciliation (design
// doc §6.3; already covered by web-backend-test.js / rust-sql-test.js), so
// this mock simulates that minimally: any record's Tags array causes a
// matching tag entry to exist, the same contract the real backends provide.
function makeDB(initial) {
    let items = new Map((initial.items || []).map(i => [i.id, i]));
    let consumed = initial.consumed ? initial.consumed.slice() : [];
    let queued = initial.queued ? initial.queued.slice() : [];
    let owned = initial.owned ? initial.owned.slice() : [];
    let tags = new Map((initial.tags || []).map(t => [t.id, t]));
    let settings = initial.settings || null;
    let failSaveItemIds = new Set();

    function reconcileTags(records) {
        (records || []).forEach(r => {
            (r.Tags || []).forEach(name => {
                const id = 't-' + name;
                if (!tags.has(id)) tags.set(id, { id, Name: name });
            });
        });
    }

    return {
        _state: () => ({
            items: [...items.values()], consumed, queued, owned,
            tags: [...tags.values()], settings,
        }),
        getAllItems: async () => [...items.values()],
        getCollection: async (c) => (c === 'consumed' ? consumed : c === 'queued' ? queued : owned),
        getAllTags: async () => [...tags.values()],
        getSettings: async () => settings,
        deleteItem: async (id) => {
            items.delete(id);
            consumed = consumed.filter(r => r.ItemId !== id);
            queued = queued.filter(r => r.ItemId !== id);
            owned = owned.filter(r => r.ItemId !== id);
        },
        deleteTag: async (id) => { tags.delete(id); },
        saveItem: async (item) => {
            if (failSaveItemIds.has(item.id)) throw new Error('simulated write failure on ' + item.id);
            items.set(item.id, item);
        },
        replaceCollection: async (c, recs) => {
            if (c === 'consumed') consumed = recs.slice();
            else if (c === 'queued') queued = recs.slice();
            else owned = recs.slice();
            reconcileTags(recs);
        },
        saveSettings: async (s) => { settings = s; },
        _failSaveItemOn: (id) => failSaveItemIds.add(id),
    };
}

function loadBackupRestore(dom, db) {
    const sandbox = {
        console,
        document: dom,
        CONSTANTS: { APP_VERSION: '0.1.0', MESSAGE_TYPES: { SUCCESS: 'success', ERROR: 'error' } },
        MediaLabels: { ConsumedLabel: 'Books Read', QueuedLabel: 'To Be Read', OwnedLabel: 'My Library' },
        escapeHtml: (s) => String(s),
        showMessage: () => {},
        downloadFile: () => {},
        pako: { gzip: () => new Uint8Array(), ungzip: () => '' },
        DBManager: db,
    };
    sandbox.window = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(src + '\nthis.BackupRestore = BackupRestore;', sandbox);
    return sandbox.BackupRestore;
}

// ── 1. _validate() against the issue's malformed-file corpus ─────────────────
(async function run() {

console.log("\n1. _validate() — malformed-file corpus (COLLECTYX-SEC-03's own test list)");
{
    const dom = freshDom();
    const db = makeDB({});
    const BR = loadBackupRestore(dom, db);

    function v(label, data, expectSubstring) {
        const err = BR._validate(data);
        if (expectSubstring === null) {
            ok(label, err === null, 'expected valid, got error: ' + err);
        } else {
            ok(label, err !== null && err.includes(expectSubstring),
               'expected error containing ' + JSON.stringify(expectSubstring) + ', got: ' + JSON.stringify(err));
        }
    }

    v('a valid backup passes', {
        Header: {}, Items: [{ id: 'i1', Title: 'Dune' }],
        Consumed: [{ ItemId: 'i1', Title: 'Dune' }], Queued: [], Owned: [], Tags: [{ Name: 'scifi' }],
        Settings: {},
    }, null);

    v('Items as a string instead of an array', { Items: 'not-an-array' },
      "Items must be an array, got string");

    v('Consumed present but Items absent', { Consumed: [] },
      "Items must be an array, got undefined");

    v('one Consumed record missing Title', {
        Items: [{ id: 'i1', Title: 'Dune' }],
        Consumed: [{ ItemId: 'i1', Title: 'Dune' }, { ItemId: 'i1' }],
    }, 'Consumed[1] is missing Title');

    v('valid JSON but not a Collectyx backup', { hello: 'world' },
      "Items must be an array, got undefined");

    // Not part of the issue's six-file corpus (those two — .gz and
    // truncated — are encoding/parse-level, exercised by the existing
    // try/catch around JSON.parse, not by _validate()) but worth covering
    // since _validate() is the new surface this issue adds:
    v('an Items entry that is not an object', { Items: ['a', 'b'] },
      'Items[0] must be an object, got string');
    v('a Tags entry missing Name', { Items: [], Tags: [{}] },
      'Tags[0] is missing Name');
    v('Settings present but not an object', { Items: [], Settings: [] },
      "Settings must be an object, got array");
}

    console.log('\n2. a file failing validation cannot reach the confirmation checkbox');
    {
        const dom = freshDom();
        const db = makeDB({});
        const BR = loadBackupRestore(dom, db);
        BR._fileName = 'bad.json';
        BR._fileSize = '1 KB';
        BR.showScreen1 = () => {};
        BR._parsedData = { hello: 'world' };
        const err = BR._validate(BR._parsedData);
        ok('validation rejects this file', err !== null);
        await BR.showScreen2(null, err);
        ok('checkbox row hidden on validation failure',
           dom.getElementById('restoreCheckboxRow').style.display === 'none');
        contains('error banner names the specific problem', dom.getElementById('restoreError').textContent, err);
    }

    console.log('\n3. executeRestore() — clean restore');
    {
        const dom = freshDom();
        const db = makeDB({
            items: [{ id: 'old1', Title: 'Old Book' }],
            consumed: [{ ItemId: 'old1', Title: 'Old Book', Tags: ['oldtag'] }],
            tags: [{ id: 't-oldtag', Name: 'oldtag' }],
            settings: { dailyReadingGoal: 20 },
        });
        const BR = loadBackupRestore(dom, db);
        BR.close = function () { this._parsedData = null; };
        BR._parsedData = {
            Header: {}, Items: [{ id: 'new1', Title: 'New Book' }],
            Consumed: [{ ItemId: 'new1', Title: 'New Book', Tags: ['newtag'] }],
            Queued: [], Owned: [], Tags: [], Settings: { dailyReadingGoal: 99 },
        };
        await BR.executeRestore();
        const state = db._state();
        check('old item replaced', state.items.map(i => i.id), ['new1']);
        check('tags reflect only what the new data references', state.tags.map(t => t.Name).sort(), ['newtag']);
        check('new settings applied', state.settings, { dailyReadingGoal: 99 });
        ok('no error banner shown', dom.getElementById('restoreError').textContent === '');
    }

    console.log('\n4. executeRestore() — write fails partway, rollback restores prior state');
    {
        const dom = freshDom();
        const db = makeDB({
            items: [{ id: 'old1', Title: 'Old Book' }],
            consumed: [{ ItemId: 'old1', Title: 'Old Book', Tags: ['oldtag'] }],
            tags: [{ id: 't-oldtag', Name: 'oldtag' }],
            settings: { dailyReadingGoal: 20 },
        });
        const BR = loadBackupRestore(dom, db);
        db._failSaveItemOn('new2');
        BR._parsedData = {
            Header: {}, Items: [{ id: 'new1', Title: 'New Book' }, { id: 'new2', Title: 'Boom' }],
            Consumed: [], Queued: [], Owned: [], Tags: [], Settings: {},
        };
        await BR.executeRestore();
        const state = db._state();
        check('items rolled back to the pre-restore snapshot', state.items.map(i => i.id), ['old1']);
        check('consumed record rolled back, Tags included', state.consumed,
              [{ ItemId: 'old1', Title: 'Old Book', Tags: ['oldtag'] }]);
        check('tag from the rolled-back record present again', state.tags.map(t => t.Name), ['oldtag']);
        check('settings rolled back', state.settings, { dailyReadingGoal: 20 });
        contains('error banner explains failure and names the rollback',
                 dom.getElementById('restoreError').textContent, 'your previous data has been restored');
        ok('confirm button disabled after failure', dom.getElementById('restoreConfirmBtn').disabled === true);
    }

    console.log('\n5. executeRestore() — write fails AND rollback fails, snapshot logged');
    {
        const dom = freshDom();
        const db = makeDB({ items: [{ id: 'old1', Title: 'Old Book' }], tags: [], settings: null });
        const BR = loadBackupRestore(dom, db);
        // Every saveItem call fails — both the real write and the rollback
        // replay hit this, so rollback cannot succeed either.
        db.saveItem = async (item) => { throw new Error('total failure on ' + item.id); };
        BR._parsedData = {
            Header: {}, Items: [{ id: 'new1', Title: 'New Book' }],
            Consumed: [], Queued: [], Owned: [], Tags: [], Settings: {},
        };

        const originalError = console.error;
        let loggedSnapshot = null;
        console.error = (...args) => {
            const joined = args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
            if (joined.includes('"Header"') && joined.includes('old1')) loggedSnapshot = joined;
        };
        try {
            await BR.executeRestore();
        } finally {
            console.error = originalError;
        }

        contains('error banner says data was NOT restored',
                 dom.getElementById('restoreError').textContent, 'has NOT been restored');
        contains('error banner points to the console snapshot',
                 dom.getElementById('restoreError').textContent, 'console');
        ok('the pre-restore snapshot was actually logged to console for manual recovery',
           loggedSnapshot !== null);
    }

    console.log('\n6. executeRestore() — snapshot failure aborts before any wipe');
    {
        const dom = freshDom();
        const db = makeDB({ items: [{ id: 'old1', Title: 'Old Book' }] });
        const BR = loadBackupRestore(dom, db);
        db.getAllItems = async () => { throw new Error('cannot read current library'); };
        BR._parsedData = { Header: {}, Items: [{ id: 'new1', Title: 'New Book' }] };
        await BR.executeRestore();
        contains('error banner explains nothing was changed',
                 dom.getElementById('restoreError').textContent, 'before making any changes');
    }

    console.log('\n' + (failures === 0
        ? 'ALL BACKUP-RESTORE TESTS PASSED'
        : failures + ' FAILURE(S)'));
    process.exit(failures === 0 ? 0 : 1);

})().catch(e => {
    console.error('\nHARNESS ERROR:', e);
    process.exit(1);
});
