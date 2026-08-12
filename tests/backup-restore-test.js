/**
 * Regression test for issue #22 (validation) and #40 (atomic restore).
 * Loads the real backup-restore.js and exercises it two ways:
 *
 *   1. _validate() against the malformed-file corpus from #22, updated for
 *      #74's { fatal, skippable } return shape — structural problems
 *      (not an object, a section not an array, a record not an object)
 *      are still fatal; per-record content problems (missing Title, a
 *      dangling ItemId, an invalid optional field per #80) are skippable,
 *      not fatal.
 *   2. executeRestore() against a mock, in-memory DBManager exposing
 *      restoreAll(), proving a failure leaves the pre-restore state
 *      completely untouched — restoreAll is atomic (one Rust transaction
 *      / one IndexedDB transaction, #40), so there is no separate
 *      rollback step to test and no snapshot-logging last resort; both
 *      were removed from backup-restore.js when #40 landed.
 *
 * This cannot verify the real DBManagerTauri/DBManagerWeb backends, real
 * IPC failure modes, or gzip/truncated-file handling in a real browser —
 * those need the manual six-file-corpus pass across both builds the
 * issue's own acceptance criteria call for.
 */
const fs = require('fs');
const vm = require('vm');
const { stripEsmImports, esmStubs } = require('./lib/esm-shim');

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
// restoreAll is the only write surface executeRestore() calls (#40) — it
// must behave atomically, same as both real backends: compute the full new
// state first, only assign it to the mock's variables at the very end, so
// a forced failure (via _failRestoreAll) never leaves a half-applied state
// for the test to observe.
function makeDB(initial) {
    let items = new Map((initial.items || []).map(i => [i.id, i]));
    let consumed = initial.consumed ? initial.consumed.slice() : [];
    let queued = initial.queued ? initial.queued.slice() : [];
    let owned = initial.owned ? initial.owned.slice() : [];
    let tags = new Map((initial.tags || []).map(t => [t.id, t]));
    let settings = initial.settings || null;
    let restoreAllShouldFail = false;

    function reconcileTagsInto(records, tagsMap) {
        (records || []).forEach(r => {
            (r.Tags || []).forEach(name => {
                const id = 't-' + name;
                if (!tagsMap.has(id)) tagsMap.set(id, { id, Name: name });
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
        restoreAll: async (data) => {
            if (restoreAllShouldFail) throw new Error('simulated restoreAll failure');

            const newItems = new Map((data.Items || []).map(i => [i.id, i]));
            const newConsumed = (data.Consumed || []).slice();
            const newQueued = (data.Queued || []).slice();
            const newOwned = (data.Owned || []).slice();
            const newTags = new Map();
            reconcileTagsInto(newConsumed, newTags);
            reconcileTagsInto(newQueued, newTags);
            reconcileTagsInto(newOwned, newTags);
            const newSettings = data.Settings || {};

            items = newItems;
            consumed = newConsumed;
            queued = newQueued;
            owned = newOwned;
            tags = newTags;
            settings = newSettings;
        },
        _failRestoreAll: () => { restoreAllShouldFail = true; },
    };
}

function loadBackupRestore(dom, db) {
    const sandbox = {
        console,
        document: dom,
        CONSTANTS: { APP_VERSION: '0.1.0', MESSAGE_TYPES: { SUCCESS: 'success', ERROR: 'error' } },
        MediaLabels: { ConsumedLabel: 'Books Read', QueuedLabel: 'To Be Read', OwnedLabel: 'My Library' },
        // A real implementation, not a passthrough — CTX-SEC-117's test
        // (section 6) needs to see actual escaping happen at the sink, not
        // just that some string reached innerHTML.
        escapeHtml: (s) => String(s).replace(/[&<>"']/g, (c) => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
        }[c])),
        showMessage: () => {},
        downloadFile: () => {},
        pako: { gzip: () => new Uint8Array(), ungzip: () => '' },
        DBManager: db,
    };
    sandbox.window = sandbox;
    vm.createContext(sandbox);
    const { stripped, bindings } = stripEsmImports(src);
    Object.assign(sandbox, esmStubs(bindings));
    vm.runInContext(stripped + '\nthis.BackupRestore = BackupRestore;', sandbox);
    return sandbox.BackupRestore;
}

// ── 1. _validate() against the malformed/skippable-file corpus ───────────────
(async function run() {

console.log("\n1. _validate() — { fatal, skippable } contract (#74)");
{
    const dom = freshDom();
    const db = makeDB({});
    const BR = loadBackupRestore(dom, db);

    // fatal: expects _validate() to halt with a fatal message containing
    // expectSubstring, and no partial skippable review possible.
    function vFatal(label, data, expectSubstring) {
        const { fatal } = BR._validate(data);
        ok(label, fatal !== null && fatal.includes(expectSubstring),
           'expected fatal containing ' + JSON.stringify(expectSubstring) + ', got: ' + JSON.stringify(fatal));
    }

    // clean: expects no fatal error and zero skippable entries — a
    // genuinely restorable-as-is file.
    function vClean(label, data) {
        const { fatal, skippable } = BR._validate(data);
        ok(label, fatal === null && skippable.length === 0,
           'expected clean (fatal: null, skippable: []), got: fatal=' + JSON.stringify(fatal) +
           ' skippable=' + JSON.stringify(skippable));
    }

    // skippable: expects no fatal error, but at least one skippable entry
    // for the given label/index whose reason contains expectReasonSubstring.
    function vSkippable(label, data, expectLabel, expectIndex, expectReasonSubstring) {
        const { fatal, skippable } = BR._validate(data);
        ok(label + ' — not fatal', fatal === null, 'got fatal: ' + JSON.stringify(fatal));
        const entry = skippable.find(s => s.label === expectLabel && s.index === expectIndex);
        ok(label + ' — flagged skippable', !!entry && entry.reason.includes(expectReasonSubstring),
           'expected a skippable ' + expectLabel + '[' + expectIndex + '] entry containing ' +
           JSON.stringify(expectReasonSubstring) + ', got: ' + JSON.stringify(skippable));
    }

    vClean('a fully valid backup has no fatal error and nothing skippable', {
        Header: {},
        Items: [{ id: 'i1', MediaTypeId: 1, Title: 'Dune' }],
        Consumed: [{ ItemId: 'i1', Title: 'Dune', Finished: '2020-06-01' }],
        Queued: [], Owned: [], Tags: [{ Name: 'scifi' }],
        Settings: {},
    });

    vFatal('Items as a string instead of an array', { Items: 'not-an-array' },
      'Items must be an array, got string');

    vFatal('Consumed present but Items absent', { Consumed: [] },
      'Items must be an array, got undefined');

    // Missing Title used to be a fatal, whole-file-halting error (#22).
    // Under #74 it's per-record skippable instead — the rest of the file
    // still restores, this one record is offered for skip review.
    vSkippable('one Consumed record missing Title', {
        Items: [{ id: 'i1', MediaTypeId: 1, Title: 'Dune' }],
        Consumed: [
            { ItemId: 'i1', Title: 'Dune', Finished: '2020-01-01' },
            { ItemId: 'i1', Finished: '2020-01-01' },
        ],
    }, 'Consumed', 1, 'missing Title');

    vFatal('valid JSON but not a Collectyx backup', { hello: 'world' },
      'Items must be an array, got undefined');

    // Not part of the issue's six-file corpus (those two — .gz and
    // truncated — are encoding/parse-level, exercised by the existing
    // try/catch around JSON.parse, not by _validate()) but worth covering
    // since _validate() is the surface #22/#74/#80 all extend:
    vFatal('an Items entry that is not an object', { Items: ['a', 'b'] },
      'Items[0] must be an object, got string');

    // A Tags entry missing Name is skippable too, not fatal — and (#40)
    // data.Tags is never written directly during restore anyway, so a
    // malformed standalone Tags entry can never crash the write phase;
    // this only affects the pre-restore display corpus.
    vSkippable('a Tags entry missing Name', { Items: [], Tags: [{}] },
      'Tags', 0, 'missing Name');

    vFatal('Settings present but not an object', { Items: [], Settings: [] },
      'Settings must be an object, got array');

    // A representative #80 case — a present-but-wrong-typed optional
    // field is skippable, not a Rust deserialize crash after the wipe.
    vSkippable('an Items entry with Pages as the wrong type', {
        Items: [{ id: 'i1', MediaTypeId: 1, Title: 'Dune', Pages: '412' }],
    }, 'Items', 0, 'invalid Pages');
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
        const { fatal } = BR._validate(BR._parsedData);
        ok('validation rejects this file', fatal !== null);
        await BR.showScreen2(null, fatal);
        ok('checkbox row hidden on validation failure',
           dom.getElementById('restoreCheckboxRow').style.display === 'none');
        contains('error banner names the specific problem', dom.getElementById('restoreError').textContent, fatal);
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

    console.log('\n4. executeRestore() — restoreAll fails, pre-restore state is untouched (#40, no rollback needed)');
    {
        const dom = freshDom();
        const db = makeDB({
            items: [{ id: 'old1', Title: 'Old Book' }],
            consumed: [{ ItemId: 'old1', Title: 'Old Book', Tags: ['oldtag'] }],
            tags: [{ id: 't-oldtag', Name: 'oldtag' }],
            settings: { dailyReadingGoal: 20 },
        });
        const BR = loadBackupRestore(dom, db);
        db._failRestoreAll();
        BR._parsedData = {
            Header: {}, Items: [{ id: 'new1', Title: 'New Book' }],
            Consumed: [], Queued: [], Owned: [], Tags: [], Settings: {},
        };
        await BR.executeRestore();
        const state = db._state();
        check('items untouched by a failed restore — nothing was ever written', state.items.map(i => i.id), ['old1']);
        check('consumed record untouched, Tags included', state.consumed,
              [{ ItemId: 'old1', Title: 'Old Book', Tags: ['oldtag'] }]);
        check('tag untouched', state.tags.map(t => t.Name), ['oldtag']);
        check('settings untouched', state.settings, { dailyReadingGoal: 20 });
        contains('error banner explains the failure and confirms data is unchanged',
                 dom.getElementById('restoreError').textContent, 'your previous data is unchanged');
        ok('confirm button disabled after failure', dom.getElementById('restoreConfirmBtn').disabled === true);
    }

    console.log('\n5. executeRestore() — no parsed data is a no-op');
    {
        const dom = freshDom();
        const db = makeDB({ items: [{ id: 'old1', Title: 'Old Book' }] });
        const BR = loadBackupRestore(dom, db);
        BR._parsedData = null;
        await BR.executeRestore();
        const state = db._state();
        check('nothing changed when there is no parsed data to restore', state.items.map(i => i.id), ['old1']);
    }

    console.log('\n6. showScreen2 — malicious non-array Consumed cannot reach the DOM (CTX-SEC-117)');
    {
        // Bypasses continueToScreen2()/_validate() on purpose — the fix's
        // whole point is that the sink must be safe on its own, not only
        // when reached through the validator. A non-array .length here is
        // exactly the shape _validate() would normally reject before this
        // method is ever called in the real flow.
        //
        // Seeds one existing Consumed record so current (1) and backup (0,
        // once coerced) differ — otherwise a coincidental "0" elsewhere in
        // the markup (e.g. the current-count column) could make a weak
        // assertion pass for the wrong reason.
        const dom = freshDom();
        const db = makeDB({
            items: [{ id: 'old1', Title: 'Old Book' }],
            consumed: [{ ItemId: 'old1', Title: 'Old Book' }],
        });
        const BR = loadBackupRestore(dom, db);
        const malicious = {
            Header: {},
            Items: [],
            Consumed: { length: '<img src=x onerror=alert(1)>' },
            Queued: [], Owned: [], Tags: [],
        };
        await BR.showScreen2(malicious, null);
        const html = dom.getElementById('restoreCounts').innerHTML;
        ok('malicious payload does not appear anywhere in the rendered counts, escaped or not',
           !html.includes('img') && !html.includes('onerror'));

        const row = html.match(/Books Read<\/span>\s*<span[^>]*>([^<]*)<\/span>\s*<span[^>]*>→<\/span>\s*<span[^>]*>([^<]*)<\/span>/);
        ok('Books Read row rendered and is parseable', row !== null);
        if (row) {
            ok('current count reflects the real existing record (1)', row[1] === '1');
            ok('backup count is coerced to 0, not the malicious .length value', row[2] === '0');
        }
    }

    console.log('\n7. showScreen2 — a genuine array count still renders correctly');
    {
        const dom = freshDom();
        const db = makeDB({});
        const BR = loadBackupRestore(dom, db);
        await BR.showScreen2({
            Header: {}, Items: [],
            Consumed: [{ Title: 'A' }, { Title: 'B' }],
            Queued: [], Owned: [], Tags: [],
        }, null);
        const html = dom.getElementById('restoreCounts').innerHTML;
        ok('a real array of 2 renders as 2, not swallowed by the coercion guard',
           html.includes('>2<'));
    }

    console.log('\n' + (failures === 0
        ? 'ALL BACKUP-RESTORE TESTS PASSED'
        : failures + ' FAILURE(S)'));
    process.exit(failures === 0 ? 0 : 1);

})().catch(e => {
    console.error('\nHARNESS ERROR:', e);
    process.exit(1);
});
