/**
 * Tests for #40 — atomic full-database restore (restore_all / DBManagerWeb.restoreAll).
 *
 * Two sections, one per backend:
 *   A. Rust — structural checks (registration, pub(crate) visibility, no
 *      direct Tags write) plus a real-SQLite atomicity proof: the actual
 *      wipe+write SQL restore_all issues, run in the same sequence, with
 *      a forced failure partway through, confirming a savepoint rollback
 *      leaves the pre-restore fixture completely untouched. Cannot
 *      compile the Rust — this proves the SQL sequence is atomic when
 *      wrapped in one transaction, the same limitation and technique
 *      rust-sql-test.js's own rollback section (§4) already uses.
 *   B. Web — DBManagerWeb.restoreAll exercised end-to-end against a real
 *      fake-indexeddb instance: wipe-and-replace, cross-collection ItemId
 *      sharing, tags-not-written-directly, settings allow-list, owner
 *      scoping, and a forced-failure atomicity proof via _rawWrite's
 *      existing all-or-nothing guarantee.
 *
 * Mode-aware for section A only, same as rust-sql-test.js — see
 * tests/lib/datasource.js. Section B always runs against fake-indexeddb;
 * see web-backend-test.js's own note on why COLLECTYX_TEST_MODE doesn't
 * apply there.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const DS = require('./lib/datasource');

const R = (process.env.COLLECTYX_ROOT || '../') + '';
const OWNER = DS.TEST_OWNER;
const OWNER2 = DS.TEST_OWNER_2;

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

function readSrc(file) {
    return fs.readFileSync(path.join(R, 'src-tauri/src/commands', file), 'utf8');
}
function readLibSrc() {
    return fs.readFileSync(path.join(R, 'src-tauri/src/lib.rs'), 'utf8');
}
function readJsSrc(file) {
    return fs.readFileSync(path.join(R, 'src/js', file), 'utf8');
}

/** Same extraction technique rust-sql-test.js uses — pulls a quoted SQL
 *  string out of a function body between two anchor phrases. */
function extractInlineSql(src, startAnchor, endAnchor) {
    const start = src.indexOf(startAnchor);
    if (start === -1) return null;
    const end = src.indexOf(endAnchor, start);
    if (end === -1) return null;
    let text = src.slice(start, end + endAnchor.length);
    if (text.startsWith('"')) text = text.slice(1);
    if (text.endsWith('"')) text = text.slice(0, -1);
    return text;
}

// ── A. Rust ──────────────────────────────────────────────────────────────────

function runRustSection() {
    console.log('mode: ' + DS.MODE + (DS.MODE === 'disk' ? ' (real DB, wrapped in a transaction that will be rolled back)' : ''));

    let ctx;
    try {
        ctx = DS.openRustDb();
    } catch (e) {
        console.error(e.message);
        process.exit(1);
    }
    const db = ctx.db;

    try {
        const restoreSrc = readSrc('restore.rs');
        const itemsSrc = readSrc('items.rs');
        const consumedSrc = readSrc('consumed.rs');
        const queuedSrc = readSrc('queued.rs');
        const ownedSrc = readSrc('owned.rs');
        const libSrc = readLibSrc();

        // ── A1. structural ────────────────────────────────────────────────────
        console.log('\nA1. restore_all structure');

        ok('restore.rs defines restore_all', restoreSrc.includes('pub fn restore_all'));
        ok('restore_all uses TransactionBehavior::Immediate (CTX-SEC-113 convention)',
           restoreSrc.includes('TransactionBehavior::Immediate'));
        ok('wipe is scoped by owner (items)',
           /DELETE FROM items WHERE owner = \?1/.test(restoreSrc));
        ok('wipe is scoped by owner (tags)',
           /DELETE FROM tags WHERE owner = \?1/.test(restoreSrc));
        ok('RestorePayload has no Tags field — tags stay implicit (#80 contract)',
           !/rename = "Tags"/.test(restoreSrc));
        ok('restore_all never INSERTs into tags directly — only via reconcile_tags inside write_one',
           !restoreSrc.includes('INSERT INTO tags'));

        ok('consumed::write_one is pub(crate)', /pub\(crate\)\s+fn write_one/.test(consumedSrc));
        ok('queued::write_one is pub(crate)', /pub\(crate\)\s+fn write_one/.test(queuedSrc));
        ok('owned::write_one is pub(crate)', /pub\(crate\)\s+fn write_one/.test(ownedSrc));
        ok('items::write_item is pub(crate)', /pub\(crate\)\s+fn write_item/.test(itemsSrc));
        ok('save_item now calls write_item — no duplicated insert logic',
           itemsSrc.includes('write_item(&tx, &item, &now)'));

        ok('restore_all registered in lib.rs (owner-test-switch block and default block)',
           (libSrc.match(/commands::restore::restore_all,/g) || []).length === 2);
        ok('replace_all_consumed still registered — coexists, not replaced (#40 decision)',
           libSrc.includes('commands::consumed::replace_all_consumed,'));

        // Settings allow-list must agree between restore.rs and
        // db-manager-web.js's own copy — same drift risk every duplicated
        // constant in this codebase has (mirrors common.rs/constants.js/
        // db-manager-web.js's VALIDATION triple already being watched).
        const rustKeysMatch = restoreSrc.match(/ALLOWED_SETTINGS_KEYS: &\[&str\] = &\[([\s\S]*?)\];/);
        const webSrcForKeys = readJsSrc('db-manager-web.js');
        const webKeysMatch = webSrcForKeys.match(/ALLOWED_SETTINGS_KEYS = \[([\s\S]*?)\];/);
        ok('ALLOWED_SETTINGS_KEYS found in restore.rs', !!rustKeysMatch);
        ok('ALLOWED_SETTINGS_KEYS found in db-manager-web.js', !!webKeysMatch);
        if (rustKeysMatch && webKeysMatch) {
            const norm = (s) => s.match(/['"]([^'"]+)['"]/g).map(x => x.slice(1, -1)).sort();
            check('settings allow-list agrees between restore.rs and db-manager-web.js',
                  norm(rustKeysMatch[1]), norm(webKeysMatch[1]));
        }

        // ── A2. atomicity — real SQL, forced failure, savepoint rollback ───────
        console.log('\nA2. atomicity — wipe+write sequence rolls back cleanly on forced failure');

        const now = '2026-08-11';
        DS.savepoint(db, 'sp_restore_fixture');
        db.prepare(`INSERT INTO items (id,owner,media_type_id,title,author,date_added,modified)
                 VALUES ('ra-keep',?,1,'Original Book','Original, Author',?,?)`)
          .run(OWNER, now, now);
        db.prepare(`INSERT INTO consumed (id,item_id,finished,date_added,modified)
                 VALUES ('ra-keep-c','ra-keep','2020-01-01',?,?)`).run(now, now);
        DS.release(db, 'sp_restore_fixture');

        const itemsInsertSql = extractInlineSql(
            itemsSrc, '"INSERT INTO items', 'modified      = excluded.modified"'
        );
        const consumedInsertSql = extractInlineSql(
            consumedSrc, '"INSERT INTO consumed', 'modified  = excluded.modified"'
        );
        ok('extracted items INSERT SQL from items.rs write_item', !!itemsInsertSql);
        ok('extracted consumed INSERT SQL from consumed.rs write_one', !!consumedInsertSql);

        if (itemsInsertSql && consumedInsertSql) {
            DS.savepoint(db, 'sp_restore_sim');
            try {
                // The exact two-statement wipe restore_all issues.
                db.prepare('DELETE FROM items WHERE owner = ?1').run(OWNER);
                db.prepare('DELETE FROM tags WHERE owner = ?1').run(OWNER);

                // One item restores successfully.
                db.prepare(itemsInsertSql).run(
                    'ra-new', OWNER, 1, 'New Book', 'New, Author', null, null, null,
                    now, now
                );

                // A consumed row referencing a nonexistent item forces the
                // same FK violation a real multi-record restore would hit
                // mid-way through a malformed or truncated backup file.
                db.prepare(consumedInsertSql).run(
                    'ra-bad-c', 'DOES-NOT-EXIST', '2021-01-01', null, null, now, now
                );

                DS.release(db, 'sp_restore_sim');
                ok('forced FK violation should have thrown but did not', false);
            } catch (e) {
                DS.rollbackTo(db, 'sp_restore_sim');
                ok('forced mid-sequence failure threw as expected', true);
            }

            const survived = db.prepare("SELECT COUNT(*) AS n FROM items WHERE id='ra-keep'").get().n;
            const survivedConsumed = db.prepare("SELECT COUNT(*) AS n FROM consumed WHERE id='ra-keep-c'").get().n;
            const newItemLeaked = db.prepare("SELECT COUNT(*) AS n FROM items WHERE id='ra-new'").get().n;
            check('pre-restore item survives a failed restore sequence — nothing partial commits', survived, 1);
            check('pre-restore consumed row survives too', survivedConsumed, 1);
            check('the successful item insert from the failed sequence did not leak through', newItemLeaked, 0);

            DS.savepoint(db, 'sp_restore_cleanup');
            db.prepare("DELETE FROM consumed WHERE id='ra-keep-c'").run();
            db.prepare("DELETE FROM items WHERE id='ra-keep'").run();
            DS.release(db, 'sp_restore_cleanup');
        }

        // ── A3. owner scoping — a second owner's data is never touched ─────────
        console.log('\nA3. owner scoping');
        DS.savepoint(db, 'sp_restore_owner2');
        db.prepare(`INSERT INTO items (id,owner,media_type_id,title,date_added,modified)
                 VALUES ('ra-owner2',?,1,'Owner 2 Book',?,?)`).run(OWNER2, now, now);
        db.prepare('DELETE FROM items WHERE owner = ?').run(OWNER);
        check('owner-scoped wipe leaves a different owner\'s item untouched',
              db.prepare("SELECT COUNT(*) AS n FROM items WHERE id='ra-owner2'").get().n, 1);
        DS.rollbackTo(db, 'sp_restore_owner2');

        console.log('\n' + (failures === 0 ? 'ALL RUST restore_all TESTS PASSED (section A)' : failures + ' FAILURE(S) so far'));
    } finally {
        ctx.teardown();
    }
}

// ── B. Web ───────────────────────────────────────────────────────────────────

async function runWebSection() {
    console.log('\nB. web backend (fake-indexeddb)');

    try {
        require('fake-indexeddb/auto');
    } catch (e) {
        console.error('This suite needs fake-indexeddb.  Run:  cd tests && npm install');
        failures++;
        return;
    }

    const constantsSrc = fs.readFileSync(path.join(R, 'src/js/constants.js'), 'utf8');
    const webSrc = fs.readFileSync(path.join(R, 'src/js/db-manager-web.js'), 'utf8');

    let uuidN = 0;
    const sandbox = {
        console,
        indexedDB,
        IDBKeyRange,
        crypto: { randomUUID: () => 'uuid-' + String(++uuidN).padStart(4, '0') },
        Promise, Set, Map, Array, Object, String, Number, Date, JSON, Error, Boolean,
    };
    sandbox.window = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(constantsSrc + '\nthis.CONSTANTS = CONSTANTS;', sandbox);
    vm.runInContext(webSrc + '\nthis.DBManagerWeb = DBManagerWeb;\nthis.JoinHelpers = JoinHelpers;', sandbox);

    const DB = sandbox.DBManagerWeb;
    const CONSTANTS = sandbox.CONSTANTS;

    await DB.init();

    // ── B1. wipe-and-replace, cross-collection ItemId sharing ──────────────────
    console.log('\nB1. restoreAll — wipe, replace, cross-collection ItemId sharing');

    const preExisting = await DB.saveCollectionRecord('consumed', {
        Title: 'Old Book', Author: 'Old, Author', Finished: '2019-01-01', Tags: ['old-tag'],
    });
    check('pre-existing record present before restore', (await DB.getCollection('consumed')).length, 1);

    const data = {
        Items: [
            { id: 'itm-dune', MediaTypeId: 1, Title: 'Dune', Author: 'Herbert, Frank', Pages: 412, ISBN: '9780441013593' },
        ],
        Consumed: [
            { id: 'con-1', ItemId: 'itm-dune', Title: 'Dune', Author: 'Herbert, Frank', Finished: '2020-06-01', Rating: 5, Tags: ['scifi', 'classic'] },
        ],
        Queued: [],
        Owned: [
            { id: 'own-1', ItemId: 'itm-dune', Title: 'Dune', Author: 'Herbert, Frank', Location: 'Shelf A', Tags: ['scifi', 'classic'] },
        ],
        Settings: { fontSize: 18, backupFolder: '/should/not/restore' },
        // Present but must never be written directly — tags come only
        // from Consumed/Owned's own embedded Tags lists (#80 contract).
        Tags: [{ Name: 'should-not-appear' }],
    };

    await DB.restoreAll(data);

    const afterConsumed = await DB.getCollection('consumed');
    const afterOwned = await DB.getCollection('owned');
    check('old pre-restore record is gone', afterConsumed.find(r => r.id === preExisting.id), undefined);
    check('restored consumed record present', afterConsumed.length, 1);
    check('restored consumed record has the right Title', afterConsumed[0].Title, 'Dune');
    check('restored owned record present', afterOwned.length, 1);
    ok('consumed and owned share the same restored ItemId',
       afterConsumed[0].ItemId === afterOwned[0].ItemId);
    check('exactly one items row backs both memberships', (await DB.getAllItems()).length, 1);
    check('ISBN survived onto the shared item (from data.Items, not either membership record)',
          (await DB.getAllItems())[0].ISBN, '9780441013593');

    // ── B2. tags not written directly ───────────────────────────────────────
    console.log('\nB2. tags — never written directly from data.Tags');
    const tagNames = (await DB.getAllTags()).map(t => t.Name).sort();
    ok('should-not-appear tag was never created', !tagNames.includes('should-not-appear'));
    check('only the tags referenced by Consumed/Owned exist', tagNames, ['classic', 'scifi']);
    check('old-tag from the wiped pre-existing record is gone', tagNames.includes('old-tag'), false);

    // ── B3. settings allow-list ─────────────────────────────────────────────
    console.log('\nB3. settings — allow-list only, backupFolder never restored');
    const settings = await DB.getSettings();
    check('fontSize restored', settings.fontSize, 18);
    ok('backupFolder never restores from a backup file (CTX-SEC-101)',
       settings.backupFolder === undefined);

    // ── B4. atomicity — forced failure leaves nothing partial ──────────────
    console.log('\nB4. atomicity — forced failure mid-restore commits nothing');
    const itemsBefore = await DB.getAllItems();
    const consumedBefore = await DB.getCollection('consumed');

    let threw = false;
    try {
        await DB.restoreAll({
            Items: [
                { id: 'itm-good', MediaTypeId: 1, Title: 'Good Item' },
            ],
            Consumed: [
                { ItemId: 'itm-good', Title: 'Good Item', Finished: '2022-01-01' },
            ],
            Queued: [],
            // MediaTypeId 999 does not exist — Validation.itemFields lets
            // bounds-only values through, but the explicit FK-equivalent
            // existence check in restoreAll (CTX-SEC-121) throws before
            // _rawWrite ever runs.
            Owned: [
                { ItemId: 'itm-bad', MediaTypeId: 999, Title: 'Bad Item', Location: 'Nowhere' },
            ],
            Settings: {},
        });
    } catch (e) {
        threw = true;
    }
    ok('restoreAll with an invalid MediaTypeId throws', threw);

    const itemsAfter = await DB.getAllItems();
    const consumedAfter = await DB.getCollection('consumed');
    check('no items were added by the failed restore', itemsAfter.length, itemsBefore.length);
    check('no consumed rows were added by the failed restore', consumedAfter.length, consumedBefore.length);
    ok('the pre-failure state (from B1) is exactly what remains',
       consumedAfter.length === 1 && consumedAfter[0].Title === 'Dune');

    // ── B5. owner scoping ────────────────────────────────────────────────────
    console.log('\nB5. owner scoping — restoreAll only touches the active owner');
    const OWNER_KEY = CONSTANTS.APP_META_KEYS.CURRENT_OWNER;
    const OWNER_A = '__test_owner_a__';
    const OWNER_B = '__test_owner_b__';
    const OWNER_DEFAULT = CONSTANTS.DEFAULT_OWNER;

    await DB.setAppMeta(OWNER_KEY, OWNER_B);
    await DB.saveCollectionRecord('consumed', {
        Title: 'Owner B Book', Author: 'B. Author', Finished: '2020-01-01',
    });
    check('owner B has one record before owner A restores', (await DB.getCollection('consumed')).length, 1);

    await DB.setAppMeta(OWNER_KEY, OWNER_A);
    await DB.restoreAll({
        Items: [{ id: 'itm-a', MediaTypeId: 1, Title: 'Owner A Restored Book' }],
        Consumed: [{ ItemId: 'itm-a', Title: 'Owner A Restored Book', Finished: '2023-01-01' }],
        Queued: [], Owned: [], Settings: {},
    });
    check("owner A's restore leaves owner A with exactly one record",
          (await DB.getCollection('consumed')).length, 1);

    await DB.setAppMeta(OWNER_KEY, OWNER_B);
    check("owner B's record survives owner A's restoreAll call",
          (await DB.getCollection('consumed')).length, 1);
    check("owner B's record is untouched",
          (await DB.getCollection('consumed'))[0].Title, 'Owner B Book');

    await DB.setAppMeta(OWNER_KEY, OWNER_DEFAULT);

    console.log('\n' + (failures === 0
        ? 'ALL WEB restore_all TESTS PASSED (section B)'
        : failures + ' FAILURE(S) total'));
}

(async function run() {
    runRustSection();
    await runWebSection();

    console.log('\n' + (failures === 0 ? 'ALL restore-all TESTS PASSED' : failures + ' FAILURE(S)'));
    process.exit(failures === 0 ? 0 : 1);
})().catch(e => {
    console.error('\nHARNESS ERROR:', e);
    process.exit(1);
});
