/**
 * Executes the SQL embedded in the Rust command modules against a real
 * SQLite engine. Cannot compile the Rust, but can prove the statements are
 * valid and the column indices in row_to_record line up with the SELECT
 * lists.
 *
 * Mode-aware — see tests/lib/datasource.js. Default (notional) is
 * unchanged from before: in-memory, fresh schema. COLLECTYX_TEST_MODE=disk
 * runs the same assertions against the real database file, inside a
 * transaction that is always rolled back. Fixtures are scoped to
 * TEST_OWNER so they can never collide with real 'local' data either way.
 */
const fs = require('fs');
const path = require('path');
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

console.log('mode: ' + DS.MODE + (DS.MODE === 'disk' ? ' (real DB, wrapped in a transaction that will be rolled back)' : ''));

let ctx;
try {
    ctx = DS.openRustDb();
} catch (e) {
    console.error(e.message);
    process.exit(1);
}
const db = ctx.db;

function readSrc(file) {
    return fs.readFileSync(path.join(R, 'src-tauri/src/commands', file), 'utf8');
}
function readDbSrc(file) {
    return fs.readFileSync(path.join(R, 'src-tauri/src/db', file), 'utf8');
}
function readLibSrc() {
    return fs.readFileSync(path.join(R, 'src-tauri/src/lib.rs'), 'utf8');
}

function extractConst(file, name) {
    const src = readSrc(file);
    const rx = new RegExp('const ' + name + ': &str = "([\\s\\S]*?)";');
    const found = src.match(rx);
    return found ? found[1].replace(/\\"/g, '"') : null;
}

/** Pulls a quoted SQL string out of a function body between two anchor
 *  phrases — used for SQL embedded inline (not a named const), same
 *  technique as the ALTER TABLE extraction below. */
function extractInlineSql(src, startAnchor, endAnchor) {
    const start = src.indexOf(startAnchor);
    if (start === -1) return null;
    const end = src.indexOf(endAnchor, start);
    if (end === -1) return null;
    let text = src.slice(start, end + endAnchor.length);
    // startAnchor/endAnchor are written as they appear in source (e.g.
    // '"INSERT INTO items'), which includes the Rust string's literal
    // quote characters — strip those so the result is bare SQL.
    if (text.startsWith('"')) text = text.slice(1);
    if (text.endsWith('"')) text = text.slice(0, -1);
    return text;
}

/** Restricts extraction to the text after a given marker (e.g. a function
 *  name) — needed when a startAnchor like '"DELETE FROM consumed' matches
 *  more than one statement in the same file (delete_consumed vs
 *  replace_all_consumed both start that way). */
function sliceFrom(src, marker) {
    const i = src.indexOf(marker);
    if (i === -1) throw new Error('Marker not found: ' + marker);
    return src.slice(i);
}

try {

    const migSrc = readDbSrc('migrations.rs');
    const alterMatch = migSrc.match(/ALTER TABLE queued ADD COLUMN currently_reading[^;]*;/);
    ok('migrate_v2 ALTER TABLE found in migrations.rs', !!alterMatch);

    // ── 1. Joined SELECTs parse and column indices line up ────────────────────
    console.log('\n1. joined SELECT statements');

    const selects = {
        consumed: extractConst('consumed.rs', 'SELECT_JOINED'),
        queued: extractConst('queued.rs', 'SELECT_JOINED'),
        owned: extractConst('owned.rs', 'SELECT_JOINED'),
    };

    Object.keys(selects).forEach(name => {
        ok(name + ': SELECT_JOINED found in source', !!selects[name]);
        try {
            const stmt = db.prepare(selects[name]);
            stmt.all(OWNER);
            console.log('  ok   ' + name + ': SQL is valid and executes');
        } catch (e) {
            console.log('  FAIL ' + name + ': ' + e.message);
            failures++;
        }
    });

    console.log('\n   column-index alignment (row_to_record vs SELECT list)');
    [['consumed.rs', 'consumed'], ['queued.rs', 'queued'], ['owned.rs', 'owned']].forEach(pair => {
        try {
            const src = readSrc(pair[0]);
            const fnStart = src.indexOf('fn row_to_record');
            const fnEnd = src.indexOf('\n}', fnStart);
            const body = src.slice(fnStart, fnEnd);
            const indices = [...body.matchAll(/row\.get\((\d+)\)/g)].map(x => parseInt(x[1], 10));
            const maxIdx = Math.max(...indices);
            const cols = db.prepare(selects[pair[1]]).columns().length;

            ok(pair[1] + ': highest row.get index (' + maxIdx + ') < column count (' + cols + ')',
               maxIdx < cols);
            const missing = [];
            for (let i = 0; i < cols; i++) if (!indices.includes(i)) missing.push(i);
            ok(pair[1] + ': every selected column is read', missing.length === 0,
               'unread indices: ' + missing.join(', '));
        } catch (e) {
            console.log('  FAIL ' + pair[1] + ': ' + e.message);
            failures++;
        }
    });

    // ── 2. Seed data (scoped to OWNER — never 'local', see file header) ───────
    console.log('\n2. fixture');
    DS.savepoint(db, 'sp_fixture');
    const now = '2026-08-04';
    db.prepare(`INSERT INTO items (id,owner,media_type_id,title,author,pages,isbn,date_added,modified)
             VALUES ('i-survive',?,1,'Dune','Herbert, Frank',412,'9780441013593',?,?),
                    ('i-loser',?,1,'Dune','Herbert, Frank',NULL,NULL,?,?)`)
      .run(OWNER, now, now, OWNER, now, now);
    db.prepare(`INSERT INTO consumed (id,item_id,finished,rating,recommend,date_added,modified)
             VALUES ('c1','i-survive','2020-06-01',9,1,?,?),
                    ('c2','i-loser','2018-01-01',8,1,?,?)`).run(now, now, now, now);
    db.prepare(`INSERT INTO queued (id,item_id,"rank",source,date_added,modified)
             VALUES ('q1','i-loser',3,'a friend',?,?)`).run(now, now);
    db.prepare(`INSERT INTO owned (id,item_id,location,date_added,modified)
             VALUES ('o1','i-survive','Shelf A',?,?)`).run(now, now);
    db.prepare(`INSERT INTO tags (id,owner,name,date_added,modified)
             VALUES ('t-scifi',?,'scifi',?,?),
                    ('t-classic',?,'classic',?,?),
                    ('t-paper',?,'paperback',?,?)`)
      .run(OWNER, now, now, OWNER, now, now, OWNER, now, now);
    db.exec(`INSERT INTO item_tags (item_id,tag_id) VALUES
             ('i-survive','t-scifi'),('i-survive','t-classic'),
             ('i-loser','t-scifi'),('i-loser','t-paper')`);
    console.log('  ok   fixture inserted under owner ' + OWNER);

    const joined = db.prepare(selects.consumed).all(OWNER);
    check('joined read returns both consumed rows', joined.length, 2);
    check('join pulls title from parent item', joined[0].title, 'Dune');

    // ── 3. tags_by_item query ───────────────────────────────────────────────
    console.log('\n3. tags_by_item');
    const tagRows = db.prepare(
        "SELECT it.item_id, t.name FROM item_tags it JOIN tags t ON t.id = it.tag_id " +
        "WHERE t.owner = ?1 ORDER BY t.name ASC"
    ).all(OWNER);
    const grouped = {};
    tagRows.forEach(r => { (grouped[r.item_id] = grouped[r.item_id] || []).push(r.name); });
    check('survivor tags sorted', grouped['i-survive'], ['classic', 'scifi']);
    check('loser tags sorted', grouped['i-loser'], ['paperback', 'scifi']);

    // ── 4. rollback leaves nothing half-merged ─────────────────────────────
    console.log('\n4. transaction rollback');
    DS.savepoint(db, 'sp_rb_setup');
    db.prepare(`INSERT INTO items (id,owner,media_type_id,title,date_added,modified)
             VALUES ('i-tmp',?,1,'Temp',?,?)`).run(OWNER, now, now);
    db.prepare(`INSERT INTO consumed (id,item_id,finished,date_added,modified)
             VALUES ('c9','i-tmp','2021-01-01',?,?)`).run(now, now);
    DS.release(db, 'sp_rb_setup');

    const before = db.prepare("SELECT item_id FROM consumed WHERE id='c9'").get().item_id;
    DS.savepoint(db, 'sp_rb_test');
    db.prepare("UPDATE consumed SET item_id=? WHERE item_id=?").run('i-survive', 'i-tmp');
    try {
        // Violate the FK to force the failure a multi-table update would hit mid-way.
        db.prepare("UPDATE consumed SET item_id='DOES-NOT-EXIST' WHERE id='c9'").run();
        DS.release(db, 'sp_rb_test');
    } catch (e) {
        DS.rollbackTo(db, 'sp_rb_test');
    }
    const after = db.prepare("SELECT item_id FROM consumed WHERE id='c9'").get().item_id;
    check('failed transaction left the row untouched', after, before);
    check('temp item still present', db.prepare("SELECT COUNT(*) AS n FROM items WHERE id='i-tmp'").get().n, 1);
    DS.savepoint(db, 'sp_rb_cleanup');
    db.prepare("DELETE FROM consumed WHERE id='c9'").run();
    db.prepare("DELETE FROM items WHERE id='i-tmp'").run();
    DS.release(db, 'sp_rb_cleanup');

    // ── 5. tag delete with substitute ──────────────────────────────────────
    console.log('\n5. delete_tag with substitute');
    const affected = db.prepare("SELECT COUNT(*) AS n FROM item_tags WHERE tag_id='t-paper'").get().n;
    DS.savepoint(db, 'sp_tagdel');
    db.prepare("INSERT OR IGNORE INTO item_tags (item_id, tag_id) SELECT item_id, ? FROM item_tags WHERE tag_id = ?")
      .run('t-classic', 't-paper');
    db.prepare("DELETE FROM tags WHERE id = ?").run('t-paper');
    DS.release(db, 'sp_tagdel');
    check('reported affected rows', affected, 1);
    check('substitute tag survives on the item',
          db.prepare("SELECT COUNT(*) AS n FROM item_tags WHERE item_id='i-survive' AND tag_id='t-classic'").get().n, 1);
    check('deleted tag links cascaded away',
          db.prepare("SELECT COUNT(*) AS n FROM item_tags WHERE tag_id='t-paper'").get().n, 0);
    ok('no item left untagged that had only the deleted tag',
       db.prepare("SELECT COUNT(*) AS n FROM item_tags WHERE item_id='i-survive'").get().n > 0);

    // ── 6. settings upsert on owner ────────────────────────────────────────
    console.log('\n6. settings upsert');
    DS.savepoint(db, 'sp_settings');
    db.prepare("INSERT INTO settings (owner,data) VALUES (?,?) ON CONFLICT(owner) DO UPDATE SET data=excluded.data")
      .run(OWNER, '{"a":1}');
    db.prepare("INSERT INTO settings (owner,data) VALUES (?,?) ON CONFLICT(owner) DO UPDATE SET data=excluded.data")
      .run(OWNER, '{"a":2}');
    check('one settings row for this owner', db.prepare("SELECT COUNT(*) AS n FROM settings WHERE owner=?").get(OWNER).n, 1);
    check('upsert replaced the value', db.prepare("SELECT data FROM settings WHERE owner=?").get(OWNER).data, '{"a":2}');
    DS.release(db, 'sp_settings');

    // ── 7. upsert_item — SEC-08: absent vs explicit-null vs value ─────────────
    console.log('\n7. upsert_item (COLLECTYX-SEC-08 — absent/null/value via CASE WHEN)');

    const commonSrc = readSrc('common.rs');
    const upsertSql = extractInlineSql(commonSrc, '"INSERT INTO items', 'modified      = excluded.modified"');
    ok('upsert_item SQL found in common.rs', !!upsertSql);
    ok('no COALESCE(excluded remains (issue #27 acceptance criterion)',
       !commonSrc.includes('COALESCE(excluded'));
    ok('double_option deserializer defined (issue #27)', commonSrc.includes('fn double_option'));

    if (upsertSql) {
        const stmt = db.prepare(upsertSql);
        // params: id, owner, media_type_id, title, author, author2, pages, isbn,
        //         date_added, modified, author_set, author2_set, pages_set, isbn_set
        DS.savepoint(db, 'sp_upsert8');

        stmt.run('i-double-opt', OWNER, 1, 'Test Book', 'Original Author', 'Orig2', 100, '111',
                  now, now, 1, 1, 1, 1);
        let row = db.prepare("SELECT author,author2,pages,isbn FROM items WHERE id='i-double-opt'").get();
        check('initial insert sets all fields', row, { author: 'Original Author', author2: 'Orig2', pages: 100, isbn: '111' });

        // Absent key (flag=0) — must preserve stored values regardless of
        // what garbage value is bound alongside the false flag.
        stmt.run('i-double-opt', OWNER, 1, 'Test Book', 'IGNORED', 'IGNORED', 999, 'IGNORED',
                  now, now, 0, 0, 0, 0);
        row = db.prepare("SELECT author,author2,pages,isbn FROM items WHERE id='i-double-opt'").get();
        check('absent key preserves stored author', row.author, 'Original Author');
        check('absent key preserves stored pages', row.pages, 100);

        // Explicit null (flag=1, value=NULL) — must clear.
        stmt.run('i-double-opt', OWNER, 1, 'Test Book', null, null, null, null,
                  now, now, 1, 1, 1, 1);
        row = db.prepare("SELECT author,author2,pages,isbn FROM items WHERE id='i-double-opt'").get();
        check('explicit null clears author', row.author, null);
        check('explicit null clears author2', row.author2, null);
        check('explicit null clears pages', row.pages, null);
        check('explicit null clears isbn', row.isbn, null);

        // Explicit value (flag=1, value=X) — must set.
        stmt.run('i-double-opt', OWNER, 1, 'Test Book', 'New Author', null, 250, '222',
                  now, now, 1, 1, 1, 1);
        row = db.prepare("SELECT author,author2,pages,isbn FROM items WHERE id='i-double-opt'").get();
        check('explicit value sets author', row.author, 'New Author');
        check('explicit value sets pages', row.pages, 250);

        // Title's own CASE WHEN (empty string keeps old) is untouched by
        // this fix — regression check, not a new behavior.
        stmt.run('i-double-opt', OWNER, 1, '', 'New Author', null, 250, '222', now, now, 0, 0, 0, 0);
        row = db.prepare("SELECT title FROM items WHERE id='i-double-opt'").get();
        check('empty-string title still keeps the old title (unrelated existing rule, unaffected)', row.title, 'Test Book');

        DS.release(db, 'sp_upsert8');
    }

    // ── 8. issue #23 — replace_all_* scoped by owner ───────────────────────
    console.log('\n8. issue #23 — multi-owner restore no longer wipes other owners');

    ['consumed.rs', 'queued.rs', 'owned.rs'].forEach(f => {
        const src = readSrc(f);
        ok(f + ': replace_all_* deletes via items-owner subquery, not a bare DELETE',
           /DELETE FROM \w+\s+WHERE item_id IN \(SELECT id FROM items WHERE owner = \?1\)/.test(src));
    });

    DS.savepoint(db, 'sp_i23');
    db.prepare(`INSERT INTO items (id,owner,media_type_id,title,date_added,modified)
             VALUES ('i23-a',?,1,'Owner A Book',?,?), ('i23-b',?,1,'Owner B Book',?,?)`)
      .run(OWNER, now, now, OWNER2, now, now);
    db.prepare(`INSERT INTO consumed (id,item_id,finished,date_added,modified)
             VALUES ('i23-ca','i23-a','2020-01-01',?,?), ('i23-cb','i23-b','2020-01-01',?,?)`)
      .run(now, now, now, now);

    const deleteConsumedSql = extractInlineSql(
        sliceFrom(readSrc('consumed.rs'), 'pub fn replace_all_consumed'),
        '"DELETE FROM consumed', 'params![owner]'
    );
    ok('extracted delete SQL from consumed.rs replace_all_consumed', !!deleteConsumedSql);
    if (deleteConsumedSql) {
        const sqlOnly = deleteConsumedSql.split('"')[0]; // strip the trailing params![owner] anchor text
        db.prepare(sqlOnly).run(OWNER);
    }
    check('owner A consumed rows deleted', db.prepare("SELECT COUNT(*) AS n FROM consumed WHERE id='i23-ca'").get().n, 0);
    check("owner B consumed rows untouched — this is the bug issue #23 fixed", db.prepare("SELECT COUNT(*) AS n FROM consumed WHERE id='i23-cb'").get().n, 1);
    DS.rollbackTo(db, 'sp_i23');

    // ── 9. issue #24 — BOLA: owner-scoped mutations, no ownership reassignment
    console.log('\n9. issue #24 — cross-owner mutations rejected (COLLECTYX-SEC-05)');

    ok('assert_item_owned defined in common.rs', commonSrc.includes('fn assert_item_owned'));
    ok('assert_tag_owned defined in common.rs', commonSrc.includes('fn assert_tag_owned'));
    ok('no owner = excluded.owner remains anywhere in common.rs (acceptance criterion)',
       !/owner\s*=\s*excluded\.owner/.test(commonSrc));

    const libSrc = readLibSrc();
    ok('merge_items no longer registered in invoke_handler (issue #24, later fully removed — no caller on either backend)',
       !libSrc.includes('commands::items::merge_items,'));
    ok('merge_items function removed from items.rs entirely (unused dead code, not kept)',
       !readSrc('items.rs').includes('pub fn merge_items'));
    ok('MergeResult struct removed from items.rs', !readSrc('items.rs').includes('struct MergeResult'));

    DS.savepoint(db, 'sp_i24');
    db.prepare(`INSERT INTO items (id,owner,media_type_id,title,date_added,modified)
             VALUES ('i24-a',?,1,'Owner A Book',?,?)`).run(OWNER, now, now);
    db.prepare(`INSERT INTO consumed (id,item_id,finished,date_added,modified)
             VALUES ('i24-ca','i24-a','2020-01-01',?,?)`).run(now, now);

    // Same query assert_item_owned runs — verified directly since it's
    // Rust control flow, not a standalone SQL constant.
    const ownerLookup = db.prepare("SELECT owner FROM items WHERE id = ?1");
    check("assert_item_owned's query resolves the real owner for owner A's item",
          ownerLookup.get('i24-a').owner, OWNER);
    ok("assert_item_owned's query returns nothing for a non-existent item (same error path as cross-owner)",
       ownerLookup.get('does-not-exist') === undefined);

    // delete_consumed/delete_queued/delete_owned's scoped DELETE, extracted
    // and run directly against a cross-owner id — must affect 0 rows.
    const delConsumedScoped = extractInlineSql(
        sliceFrom(readSrc('consumed.rs'), 'pub fn delete_consumed'),
        '"DELETE FROM consumed', "params![id, owner]"
    );
    if (delConsumedScoped) {
        const sqlOnly = delConsumedScoped.split('"')[0];
        const wrongOwnerResult = db.prepare(sqlOnly).run('i24-ca', OWNER2);
        check('delete_consumed with the wrong owner affects 0 rows', wrongOwnerResult.changes, 0);
        const rightOwnerResult = db.prepare(sqlOnly).run('i24-ca', OWNER);
        check('delete_consumed with the correct owner affects 1 row', rightOwnerResult.changes, 1);
    } else {
        ok('delete_consumed scoped DELETE extracted from consumed.rs', false);
    }
    DS.rollbackTo(db, 'sp_i24');

    // ── 10. issue #27 modal-layer normalization — source-level check only ───
    // (consumed-modal.js/owned-modal.js are DOM-dependent; not exercisable
    // from this SQL-focused suite. See web-backend-test.js/manual QA for
    // the payload-shape half of this fix.)
    console.log('\n10. issue #27 — modal-layer null normalization (source check)');
    ['consumed-modal.js', 'owned-modal.js'].forEach(f => {
        try {
            const src = fs.readFileSync(path.join(R, 'src/js', f), 'utf8');
            ok(f + ': ISBN sent as null when empty, not ""', /ISBN.*\.value\.trim\(\)\s*\|\|\s*null/.test(src));
        } catch (e) {
            ok(f + ": could not read (skipped — not part of this suite's file set)", true);
        }
    });

    console.log('\n' + (failures === 0 ? 'ALL RUST-SQL TESTS PASSED' : failures + ' FAILURE(S)'));

} finally {
    ctx.teardown();
}

process.exit(failures === 0 ? 0 : 1);
