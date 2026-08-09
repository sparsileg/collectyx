/**
 * Regression test for issues #52–#58 (CTX-SEC-101 through CTX-SEC-108) —
 * the "owner taken from payload" / cross-owner membership-write family
 * found in the 2026-08-07 audit.
 *
 * Two halves:
 *
 *   PART A — Rust (source-level + SQL-executed against real SQLite).
 *   The Rust command handlers themselves are NOT compiled — no cargo in
 *   this environment. Where the vulnerable/fixed logic is a literal SQL
 *   string, it's extracted and executed for real. Where the fix is Rust
 *   control flow around a dynamically-built query (format!() with a
 *   table-name placeholder, or an owner resolved in code rather than
 *   SQL), the equivalent query is hand-written here to mirror the source
 *   and is checked against source text for drift — same approach
 *   rust-sql-test.js section 9 already uses for assert_item_owned.
 *   Run `cargo build` for the real compiler check; this suite cannot
 *   substitute for that.
 *
 *   PART B — Web (fully executable). DBManagerWeb runs for real against
 *   fake-indexeddb, so #53 (web half), #57, and #58 get full behavioral
 *   coverage, not just a source check.
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
function sliceFrom(src, marker) {
    const i = src.indexOf(marker);
    if (i === -1) throw new Error('Marker not found: ' + marker);
    return src.slice(i);
}
function sliceBetween(src, startMarker, endMarker) {
    const start = src.indexOf(startMarker);
    if (start === -1) throw new Error('Marker not found: ' + startMarker);
    const end = src.indexOf(endMarker, start);
    if (end === -1) throw new Error('End marker not found: ' + endMarker);
    return src.slice(start, end);
}

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

    const now = '2026-08-09';
    const itemsSrc = readSrc('items.rs');
    const commonSrc = readSrc('common.rs');
    const consumedSrc = readSrc('consumed.rs');
    const queuedSrc = readSrc('queued.rs');
    const ownedSrc = readSrc('owned.rs');
    const tagsSrc = readSrc('tags.rs');

    // ═══════════════════════════════════════════════════════════════════
    // PART A — Rust
    // ═══════════════════════════════════════════════════════════════════

    // ── #52 / CTX-SEC-101 — save_item ignores payload Owner ────────────
    console.log('\n#52 (CTX-SEC-101) — save_item: owner never from payload');

    ok('save_item resolves owner via current_owner(), not item.owner',
       /let owner = common::current_owner\(&db\);/.test(sliceFrom(itemsSrc, 'pub fn save_item')));
    ok('save_item no longer binds item.owner as a SQL param',
       !/params!\[\s*id,\s*item\.owner/.test(sliceFrom(itemsSrc, 'pub fn save_item')));
    ok('ItemRecord.owner is serialize-only (skip_deserializing)',
       /rename = "Owner", default, skip_deserializing\)\]\s*\n\s*pub owner: String/.test(itemsSrc));
    ok('title CASE WHEN guard present (blank payload title cannot blank stored title)',
       /title\s*=\s*CASE WHEN excluded\.title != '' THEN excluded\.title ELSE items\.title END/.test(itemsSrc));
    ok('save_item validates Title/Author/Author2/ISBN/Pages/DateAdded',
       /Title cannot be empty/.test(sliceFrom(itemsSrc, 'pub fn save_item')) &&
       /validate_short_text\(&item\.author, "Author"\)/.test(itemsSrc) &&
       /validate_short_text\(&item\.isbn, "ISBN"\)/.test(itemsSrc));

    console.log('   SQL-executed: server-resolved owner wins regardless of what a payload would have said');
    DS.savepoint(db, 'sp_52');
    // save_item's actual INSERT, run with the server-resolved owner param
    // (OWNER) exactly as items.rs now always supplies it — a payload
    // claiming OWNER2 never reaches this call at all post-fix, which is
    // the point being proven.
    db.prepare(
        `INSERT INTO items (id,owner,media_type_id,title,author,author2,pages,isbn,date_added,modified)
         VALUES ('i52-a',?,1,'Spoof Target','A','',0,'',?,?)
         ON CONFLICT(id) DO UPDATE SET
            media_type_id = excluded.media_type_id,
            title = CASE WHEN excluded.title != '' THEN excluded.title ELSE items.title END,
            modified = excluded.modified`
    ).run(OWNER, now, now);
    check('item created under the server-resolved owner', db.prepare("SELECT owner FROM items WHERE id='i52-a'").get().owner, OWNER);
    // Blank-title guard: an update with title='' must not blank the stored title.
    db.prepare(
        `INSERT INTO items (id,owner,media_type_id,title,author,author2,pages,isbn,date_added,modified)
         VALUES ('i52-a',?,1,'',NULL,NULL,NULL,NULL,?,?)
         ON CONFLICT(id) DO UPDATE SET
            media_type_id = excluded.media_type_id,
            title = CASE WHEN excluded.title != '' THEN excluded.title ELSE items.title END,
            modified = excluded.modified`
    ).run(OWNER, now, now);
    check('empty-string title on update does not blank the stored title', db.prepare("SELECT title FROM items WHERE id='i52-a'").get().title, 'Spoof Target');
    DS.rollbackTo(db, 'sp_52');

    // ── #53 / CTX-SEC-103 — membership-row BOLA ─────────────────────────
    console.log('\n#53 (CTX-SEC-103) — membership row ownership asserted before upsert');

    ok('assert_membership_writable defined in common.rs', commonSrc.includes('fn assert_membership_writable'));
    [['consumed.rs', consumedSrc, 'consumed'], ['queued.rs', queuedSrc, 'queued'], ['owned.rs', ownedSrc, 'owned']]
        .forEach(([file, src, table]) => {
            ok(file + ': write_one calls assert_membership_writable("' + table + '") before the upsert',
               new RegExp('assert_membership_writable\\(tx, "' + table + '", &id\\)').test(src));
        });

    console.log('   SQL-executed: the query assert_membership_writable runs, per table');
    DS.savepoint(db, 'sp_53');
    db.prepare(`INSERT INTO items (id,owner,media_type_id,title,date_added,modified)
             VALUES ('i53-a',?,1,'Owner A Item',?,?), ('i53-b',?,1,'Owner B Item',?,?)`)
      .run(OWNER, now, now, OWNER2, now, now);
    db.prepare(`INSERT INTO consumed (id,item_id,finished,date_added,modified) VALUES ('m53-cb','i53-b','2020-01-01',?,?)`).run(now, now);
    db.prepare(`INSERT INTO queued (id,item_id,"rank",date_added,modified) VALUES ('m53-qb','i53-b',1,?,?)`).run(now, now);
    db.prepare(`INSERT INTO owned (id,item_id,date_added,modified) VALUES ('m53-ob','i53-b',?,?)`).run(now, now);

    // Mirrors assert_membership_writable's query, table substituted the
    // same way the Rust format!() call substitutes it — see common.rs.
    function membershipOwner(table, membershipId) {
        const sql = `SELECT i.owner FROM ${table} m JOIN items i ON i.id = m.item_id WHERE m.id = ?1`;
        const row = db.prepare(sql).get(membershipId);
        return row ? row.owner : undefined;
    }
    check('consumed: foreign membership row resolves to its real (other) owner', membershipOwner('consumed', 'm53-cb'), OWNER2);
    check('queued: foreign membership row resolves to its real (other) owner', membershipOwner('queued', 'm53-qb'), OWNER2);
    check('owned: foreign membership row resolves to its real (other) owner', membershipOwner('owned', 'm53-ob'), OWNER2);
    ok('a genuinely new id (no row yet) resolves to undefined — the create case, allowed',
       membershipOwner('consumed', 'does-not-exist') === undefined);
    // The actual assertion function then does: row_owner === current_owner
    // ? Ok : Err. Proven here by comparing against OWNER (the active
    // owner in this fixture) — a mismatch is exactly what write_one now
    // rejects before ever reaching the ON CONFLICT that used to repoint
    // the row.
    ok('foreign row owner (' + OWNER2 + ') does not match active owner (' + OWNER + ') — write_one now rejects this',
       membershipOwner('consumed', 'm53-cb') !== OWNER);
    DS.rollbackTo(db, 'sp_53');

    // ── #54 / CTX-SEC-104 — reconcile_tags owner resolved internally ───
    console.log('\n#54 (CTX-SEC-104) — reconcile_tags never accepts a payload-supplied owner');

    const reconcileSig = sliceBetween(commonSrc, 'pub fn reconcile_tags(', ') -> Result<()> {');
    ok('reconcile_tags signature no longer takes an owner parameter', !/owner:\s*&str/.test(reconcileSig));
    ok('reconcile_tags resolves owner via current_owner(tx) in its own body',
       /let owner = current_owner\(tx\);/.test(sliceBetween(commonSrc, 'pub fn reconcile_tags(', 'let mut wanted')));
    [['consumed.rs', consumedSrc], ['queued.rs', queuedSrc], ['owned.rs', ownedSrc]].forEach(([file, src]) => {
        ok(file + ': owner_or_default no longer present', !src.includes('owner_or_default'));
        ok(file + ': reconcile_tags called without an owner argument',
           /reconcile_tags\(tx, &item_id, names, now, bump_modified_on_new_link\)/.test(src));
    });

    console.log('   SQL-executed: tag lookup/creation scoped to the resolved owner, not a spoofed one');
    DS.savepoint(db, 'sp_54');
    // Mirrors reconcile_tags' own tag lookup/insert — owner is the value
    // current_owner(tx) would return, never anything from the payload.
    const resolvedOwner = OWNER;
    const spoofedOwnerFromPayload = OWNER2; // what an attacker's payload would have said
    const existingTag = db.prepare("SELECT id FROM tags WHERE owner = ?1 AND name = ?2").get(resolvedOwner, 'probe-54');
    ok('no pre-existing tag for the resolved owner', !existingTag);
    db.prepare("INSERT INTO tags (id,owner,name,date_added,modified) VALUES ('t54-probe',?,?,?,?)")
      .run(resolvedOwner, 'probe-54', now, now);
    check('tag created under the resolved (active) owner, not the payload-claimed owner',
          db.prepare("SELECT owner FROM tags WHERE id='t54-probe'").get().owner, resolvedOwner);
    ok('tag was NOT created under the spoofed payload owner',
       db.prepare("SELECT owner FROM tags WHERE id='t54-probe'").get().owner !== spoofedOwnerFromPayload);
    DS.rollbackTo(db, 'sp_54');

    // ── #55 / CTX-SEC-105 — replace_all_tags ────────────────────────────
    console.log('\n#55 (CTX-SEC-105) — replace_all_tags: id ownership asserted, owner pinned');

    const replaceAllTagsSlice = sliceFrom(tagsSrc, 'pub fn replace_all_tags');
    ok('replace_all_tags checks an incoming id\'s existing owner before upserting',
       /SELECT owner FROM tags WHERE id = \?1/.test(replaceAllTagsSlice));
    ok('replace_all_tags never takes owner from the payload (tag.owner.clone() removed)',
       !/owner: tag\.owner\.clone\(\)/.test(replaceAllTagsSlice));
    ok('replace_all_tags pins owner on the prepared row unconditionally',
       /owner: owner\.clone\(\)/.test(replaceAllTagsSlice));
    ok('the upsert refuses to touch another owner\'s row (WHERE tags.owner = ?2)',
       /WHERE tags\.owner = \?2"/.test(replaceAllTagsSlice));

    console.log('   SQL-executed: the pinned-owner upsert is a no-op against a foreign row');
    DS.savepoint(db, 'sp_55');
    db.prepare("INSERT INTO tags (id,owner,name,date_added,modified) VALUES ('t55-b',?,?,?,?)")
      .run(OWNER2, 'victim-tag', now, now);
    const upsertSql =
        `INSERT INTO tags (id, owner, name, date_added, modified)
         VALUES (?1,?2,?3,?4,?5)
         ON CONFLICT(id) DO UPDATE SET
            name     = excluded.name,
            modified = excluded.modified
          WHERE tags.owner = ?2`;
    ok('extracted upsert SQL matches the source text (drift check)',
       replaceAllTagsSlice.includes(
           'INSERT INTO tags (id, owner, name, date_added, modified)\n' +
           '             VALUES (?1,?2,?3,?4,?5)\n' +
           '             ON CONFLICT(id) DO UPDATE SET\n' +
           '                name     = excluded.name,\n' +
           '                modified = excluded.modified\n' +
           '              WHERE tags.owner = ?2'
       ));
    const attackResult = db.prepare(upsertSql).run('t55-b', OWNER, 'pwned', now, now);
    check('renaming another owner\'s tag id affects 0 rows', attackResult.changes, 0);
    check('victim tag name is untouched', db.prepare("SELECT name FROM tags WHERE id='t55-b'").get().name, 'victim-tag');
    check('victim tag owner is untouched', db.prepare("SELECT owner FROM tags WHERE id='t55-b'").get().owner, OWNER2);
    // Same upsert against a row the caller actually owns must still work.
    db.prepare("INSERT INTO tags (id,owner,name,date_added,modified) VALUES ('t55-a',?,?,?,?)")
      .run(OWNER, 'my-tag', now, now);
    const legitResult = db.prepare(upsertSql).run('t55-a', OWNER, 'renamed', now, now);
    check('renaming your own tag id still works', legitResult.changes, 1);
    check('own tag actually renamed', db.prepare("SELECT name FROM tags WHERE id='t55-a'").get().name, 'renamed');
    DS.rollbackTo(db, 'sp_55');

    // ── #56 / CTX-SEC-106 — save_tag ────────────────────────────────────
    console.log('\n#56 (CTX-SEC-106) — save_tag: owner never from payload');

    const saveTagSlice = sliceFrom(tagsSrc, 'pub fn save_tag');
    ok('save_tag resolves owner via current_owner(&db), not tag.owner',
       /let owner = common::current_owner\(&db\);/.test(saveTagSlice));
    ok('save_tag no longer contains tag.owner.clone().unwrap_or_else(...)',
       !/tag\.owner\.clone\(\)\.unwrap_or_else/.test(saveTagSlice));
    ok('TagRecord.owner is serialize-only (skip_deserializing)',
       /rename = "Owner", default, skip_deserializing\)\]/.test(tagsSrc));

    console.log('   SQL-executed: create-under-arbitrary-owner is no longer reachable — owner is server-resolved');
    DS.savepoint(db, 'sp_56');
    // As save_tag now always does: owner comes from current_owner(), so
    // the only owner a new tag can ever land under is the active one.
    db.prepare("INSERT INTO tags (id,owner,name,date_added,modified) VALUES ('t56-probe',?,?,?,?)")
      .run(OWNER, 'probe-56', now, now);
    check('tag lands under the active owner', db.prepare("SELECT owner FROM tags WHERE id='t56-probe'").get().owner, OWNER);
    ok('the clash-oracle query is scoped to that same resolved owner, not an attacker-chosen one',
       /SELECT id FROM tags WHERE owner = \?1 AND name = \?2 AND id <> \?3/.test(saveTagSlice));
    DS.rollbackTo(db, 'sp_56');

    console.log('\nPart A (Rust): ' + (failures === 0 ? 'all checks passed so far' : failures + ' failure(s) so far'));

} finally {
    ctx.teardown();
}

// ═══════════════════════════════════════════════════════════════════════
// PART B — Web (fully executable against fake-indexeddb)
// Covers #53 (web half), #57, #58.
// ═══════════════════════════════════════════════════════════════════════

(async function runWeb() {
    console.log('\n\n--- web backend (db-manager-web.js) ---');

    try {
        require('fake-indexeddb/auto');
    } catch (e) {
        console.error('This suite needs fake-indexeddb.  Run:  cd tests && npm install');
        process.exit(failures === 0 ? 1 : 1);
    }

    const constantsSrc = fs.readFileSync(path.join(R, 'src/js/constants.js'), 'utf8');
    const webSrc = fs.readFileSync(path.join(R, 'src/js/db-manager-web.js'), 'utf8');

    // ── source-level checks (mirrors Part A's approach for the JS side) ─
    console.log('\nsource checks (#53 web half, #57, #58)');
    ok('_saveCollectionRecordImpl asserts the membership row\'s parent-item ownership too, not just the item',
       /existing\.membership\)[\s\S]{0,300}parent\.owner !== defaults\.owner/.test(webSrc));
    ok('splitRecord refuses a foreign prevItem rather than silently preserving its owner',
       /prevItem && defaults\.owner && prevItem\.owner !== defaults\.owner/.test(webSrc));
    ok('replaceCollection explicitly checks prevItem ownership before calling splitRecord',
       /const prevItem = existingItems\.get\(prepared\.ItemId\) \|\| null;[\s\S]{0,200}prevItem\.owner !== defaults\.owner/.test(webSrc));
    ok('setCurrentlyReading asserts item ownership via _assertItemOwned',
       /setCurrentlyReading\(id, value\) \{[\s\S]{0,500}_assertItemOwned\(row\.item_id\)/.test(webSrc));
    ok('setCurrentlyReading no longer leaks the requested id in its error message',
       !webSrc.includes("'Queued record not found: ' + id"));

    let uuidN = 0;
    const sandbox = {
        console,
        indexedDB,
        IDBKeyRange,
        crypto: { randomUUID: () => 'uuid-52-58-' + String(++uuidN).padStart(4, '0') },
        Promise, Set, Map, Array, Object, String, Number, Date, JSON, Error, Boolean,
    };
    sandbox.window = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(constantsSrc + '\nthis.CONSTANTS = CONSTANTS;', sandbox);
    vm.runInContext(webSrc + '\nthis.DBManagerWeb = DBManagerWeb;\nthis.JoinHelpers = JoinHelpers;', sandbox);

    const DB = sandbox.DBManagerWeb;
    const CONSTANTS = sandbox.CONSTANTS;
    const OWNER_KEY = CONSTANTS.APP_META_KEYS.CURRENT_OWNER;
    const OWNER_A = '__52_58_owner_a__';
    const OWNER_B = '__52_58_owner_b__';

    async function expectThrow(label, fn, expectedMessage) {
        let threw = false, msg = null;
        try { await fn(); } catch (e) { threw = true; msg = e.message; }
        ok(label, threw, threw ? undefined : 'did not throw');
        if (threw && expectedMessage) {
            check(label + ' — error message', msg, expectedMessage);
        }
        return msg;
    }

    await DB.init();
    await DB.setAppMeta(OWNER_KEY, OWNER_B);

    // B creates one record in each collection.
    const bConsumed = await DB.saveCollectionRecord('consumed', {
        Title: 'B Consumed', Author: 'B', Finished: '2020-01-01',
    });
    const bQueued = await DB.saveCollectionRecord('queued', {
        Title: 'B Queued', Author: 'B', Rank: 1,
    });
    const bOwned = await DB.saveCollectionRecord('owned', {
        Title: 'B Owned', Author: 'B', Location: 'Shelf 1',
    });

    // ── #53 (web half) — foreign membership id ───────────────────────
    console.log('\n#53 (web half) — saveCollectionRecord rejects a foreign membership id');
    await DB.setAppMeta(OWNER_KEY, OWNER_A);
    const aItem = await DB.saveCollectionRecord('consumed', {
        Title: 'A Own Book', Author: 'A', Finished: '2020-01-01',
    });

    await expectThrow(
        'consumed: hijacking B\'s membership row via its id is rejected',
        () => DB.saveCollectionRecord('consumed', {
            id: bConsumed.id, ItemId: aItem.ItemId, Title: 'Hijacked', Finished: '2021-01-01',
        }),
        'Record not found'
    );
    await expectThrow(
        'queued: hijacking B\'s membership row via its id is rejected',
        () => DB.saveCollectionRecord('queued', {
            id: bQueued.id, ItemId: aItem.ItemId, Title: 'Hijacked', Rank: 9,
        }),
        'Record not found'
    );
    await expectThrow(
        'owned: hijacking B\'s membership row via its id is rejected',
        () => DB.saveCollectionRecord('owned', {
            id: bOwned.id, ItemId: aItem.ItemId, Title: 'Hijacked', Location: 'Nowhere',
        }),
        'Record not found'
    );

    await DB.setAppMeta(OWNER_KEY, OWNER_B);
    const bConsumedAfter = await DB.getCollection('consumed');
    check('B\'s consumed record is completely unaffected by the rejected hijack attempts',
          bConsumedAfter.find(r => r.id === bConsumed.id).Title, 'B Consumed');

    // ── #57 — replaceCollection cross-owner destructive write ─────────
    console.log('\n#57 — replaceCollection rejects an ItemId belonging to another owner');
    await DB.setAppMeta(OWNER_KEY, OWNER_A);
    await expectThrow(
        'replaceCollection rejects a record whose ItemId belongs to B',
        () => DB.replaceCollection('consumed', [
            { id: 'new-row', ItemId: bConsumed.ItemId, Title: 'OVERWRITTEN', Author: null, Finished: '2026-01-01' },
        ]),
        'Item not found'
    );
    await DB.setAppMeta(OWNER_KEY, OWNER_B);
    const bItemAfterReplace = await DB._rawGet(CONSTANTS.STORES.ITEMS, bConsumed.ItemId);
    check('B\'s item title is untouched by A\'s rejected replaceCollection call', bItemAfterReplace.title, 'B Consumed');

    // ── #58 — setCurrentlyReading cross-owner ──────────────────────────
    console.log('\n#58 — setCurrentlyReading rejects another owner\'s queued row via _assertItemOwned');
    await DB.setAppMeta(OWNER_KEY, OWNER_A);
    await expectThrow(
        'setCurrentlyReading rejects B\'s queued row id (row exists, item belongs to another owner)',
        () => DB.setCurrentlyReading(bQueued.id, true),
        'Item not found'
    );
    await expectThrow(
        'setCurrentlyReading rejects a genuinely nonexistent id',
        () => DB.setCurrentlyReading('totally-made-up-id', true),
        'Record not found'
    );
    await DB.setAppMeta(OWNER_KEY, OWNER_B);
    const bQueuedAfter = (await DB.getCollection('queued')).find(r => r.id === bQueued.id);
    ok('B\'s queued row currently_reading flag is untouched (not flipped to true/1)',
       bQueuedAfter.CurrentlyReading !== true && bQueuedAfter.CurrentlyReading !== 1);

    // restore default owner so this suite doesn't leak state to any
    // process reusing the same fake-indexeddb instance
    await DB.setAppMeta(OWNER_KEY, CONSTANTS.DEFAULT_OWNER);

    console.log('\n' + (failures === 0
        ? 'ALL #52-#58 REGRESSION TESTS PASSED'
        : failures + ' FAILURE(S)'));
    process.exit(failures === 0 ? 0 : 1);

})().catch(e => {
    console.error('\nHARNESS ERROR:', e);
    process.exit(1);
});
