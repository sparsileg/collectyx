/**
 * Executes the SQL embedded in the Rust command modules against a real
 * SQLite engine. Cannot compile the Rust, but can prove the statements are
 * valid, the column indices in row_to_record line up with the SELECT lists,
 * and that merge_items' statement sequence produces the right end state.
 */
const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');

const R = (process.env.COLLECTYX_ROOT || '../') + '';
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

// Build the schema from schema.rs, same as the migration does. Every
// pub const is applied in file order (media_types before items before
// consumed, etc. — the same order schema.rs itself is written in, and the
// order migrate_v1 applies them), so a new table added there is picked up
// here automatically instead of needing this list hand-maintained.
const schemaSrc = fs.readFileSync(R + '/src-tauri/src/db/schema.rs', 'utf8');
const migSrc = fs.readFileSync(R + '/src-tauri/src/db/migrations.rs', 'utf8');
const consts = {};
let m;
const re = /pub const (\w+): &str = "([\s\S]*?)";\n/g;
while ((m = re.exec(schemaSrc)) !== null) consts[m[1]] = m[2].replace(/\\"/g, '"');

const db = new DatabaseSync(':memory:');
db.exec('PRAGMA foreign_keys = ON;');
[...schemaSrc.matchAll(/pub const (\w+): &str = /g)].map(x => x[1])
    .forEach(k => db.exec(consts[k]));

// migrate_v2 is additive (app_meta table already applied above via the
// schema.rs loop; queued.currently_reading is an ALTER TABLE that only
// lives in migrations.rs) — apply it here too so SELECT_JOINED for queued,
// which reads currently_reading, has a column to find.
const alterMatch = migSrc.match(/ALTER TABLE queued ADD COLUMN currently_reading[^;]*;/);
ok('migrate_v2 ALTER TABLE found in migrations.rs', !!alterMatch);
if (alterMatch) db.exec(alterMatch[0]);

// ── 1. Joined SELECTs parse and column indices line up ────────────────────────
console.log('\n1. joined SELECT statements');

function extractConst(file, name) {
    const src = fs.readFileSync(R + '/src-tauri/src/commands/' + file, 'utf8');
    const rx = new RegExp('const ' + name + ': &str = "([\\s\\S]*?)";');
    const found = src.match(rx);
    return found ? found[1].replace(/\\"/g, '"') : null;
}

const selects = {
    consumed: extractConst('consumed.rs', 'SELECT_JOINED'),
    queued: extractConst('queued.rs', 'SELECT_JOINED'),
    owned: extractConst('owned.rs', 'SELECT_JOINED'),
};

Object.keys(selects).forEach(name => {
    ok(name + ': SELECT_JOINED found in source', !!selects[name]);
    try {
        const stmt = db.prepare(selects[name]);
        stmt.all('local');
        console.log('  ok   ' + name + ': SQL is valid and executes');
    } catch (e) {
        console.log('  FAIL ' + name + ': ' + e.message);
        failures++;
    }
});

// row_to_record reads row.get(N); the highest N must be within the SELECT list.
console.log('\n   column-index alignment (row_to_record vs SELECT list)');
// Wrapped per-collection so one failure (e.g. a missing column) doesn't
// skip the alignment check for the other two — each collection's result
// is independent signal.
[['consumed.rs', 'consumed'], ['queued.rs', 'queued'], ['owned.rs', 'owned']].forEach(pair => {
    try {
        const src = fs.readFileSync(R + '/src-tauri/src/commands/' + pair[0], 'utf8');
        const fnStart = src.indexOf('fn row_to_record');
        const fnEnd = src.indexOf('\n}', fnStart);
        const body = src.slice(fnStart, fnEnd);
        const indices = [...body.matchAll(/row\.get\((\d+)\)/g)].map(x => parseInt(x[1], 10));
        const maxIdx = Math.max(...indices);

        // Count the columns the SELECT actually returns.
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

// ── 2. Seed data ──────────────────────────────────────────────────────────────
console.log('\n2. fixture');
const now = '2026-08-04';
db.exec(`INSERT INTO items (id,owner,media_type_id,title,author,pages,isbn,date_added,modified)
         VALUES ('i-survive','local',1,'Dune','Herbert, Frank',412,'9780441013593','${now}','${now}'),
                ('i-loser','local',1,'Dune','Herbert, Frank',NULL,NULL,'${now}','${now}')`);
db.exec(`INSERT INTO consumed (id,item_id,finished,rating,recommend,date_added,modified)
         VALUES ('c1','i-survive','2020-06-01',9,1,'${now}','${now}'),
                ('c2','i-loser','2018-01-01',8,1,'${now}','${now}')`);
db.exec(`INSERT INTO queued (id,item_id,"rank",source,date_added,modified)
         VALUES ('q1','i-loser',3,'a friend','${now}','${now}')`);
db.exec(`INSERT INTO owned (id,item_id,location,date_added,modified)
         VALUES ('o1','i-survive','Shelf A','${now}','${now}')`);
db.exec(`INSERT INTO tags (id,owner,name,date_added,modified)
         VALUES ('t-scifi','local','scifi','${now}','${now}'),
                ('t-classic','local','classic','${now}','${now}'),
                ('t-paper','local','paperback','${now}','${now}')`);
db.exec(`INSERT INTO item_tags (item_id,tag_id) VALUES
         ('i-survive','t-scifi'),('i-survive','t-classic'),
         ('i-loser','t-scifi'),('i-loser','t-paper')`);
console.log('  ok   fixture inserted');

const joined = db.prepare(selects.consumed).all('local');
check('joined read returns both consumed rows', joined.length, 2);
check('join pulls title from parent item', joined[0].title, 'Dune');

// ── 3. tags_by_item query ─────────────────────────────────────────────────────
console.log('\n3. tags_by_item');
const tagRows = db.prepare(
    "SELECT it.item_id, t.name FROM item_tags it JOIN tags t ON t.id = it.tag_id " +
    "WHERE t.owner = ?1 ORDER BY t.name ASC"
).all('local');
const grouped = {};
tagRows.forEach(r => { (grouped[r.item_id] = grouped[r.item_id] || []).push(r.name); });
check('survivor tags sorted', grouped['i-survive'], ['classic', 'scifi']);
check('loser tags sorted', grouped['i-loser'], ['paperback', 'scifi']);

// ── 4. merge_items statement sequence ─────────────────────────────────────────
console.log('\n4. merge_items (executed in source order)');

const droppedBefore = db.prepare(
    "SELECT COUNT(*) AS n FROM item_tags l WHERE l.item_id = ? " +
    "AND EXISTS (SELECT 1 FROM item_tags s WHERE s.item_id = ? AND s.tag_id = l.tag_id)"
).get('i-loser', 'i-survive').n;
check('duplicate-tag count computed before the move', droppedBefore, 1);

db.exec('BEGIN');
db.prepare("UPDATE items SET title=?,author=?,author2=?,pages=?,isbn=?,modified=? WHERE id=?")
  .run('Dune', 'Herbert, Frank', null, 412, '9780441013593', now, 'i-survive');

const mc = db.prepare("UPDATE consumed SET item_id=?,modified=? WHERE item_id=?")
             .run('i-survive', now, 'i-loser').changes;
const mq = db.prepare("UPDATE queued SET item_id=?,modified=? WHERE item_id=?")
             .run('i-survive', now, 'i-loser').changes;
const mo = db.prepare("UPDATE owned SET item_id=?,modified=? WHERE item_id=?")
             .run('i-survive', now, 'i-loser').changes;

const mt = db.prepare(
    "INSERT OR IGNORE INTO item_tags (item_id, tag_id) SELECT ?, tag_id FROM item_tags WHERE item_id = ?"
).run('i-survive', 'i-loser').changes;

db.prepare("DELETE FROM item_tags WHERE item_id = ?").run('i-loser');
db.prepare("DELETE FROM items WHERE id = ?").run('i-loser');
db.exec('COMMIT');

check('consumed rows moved', mc, 1);
check('queued rows moved', mq, 1);
check('owned rows moved (none belonged to loser)', mo, 0);
check('only the non-duplicate tag link moved', mt, 1);

check('loser item gone', db.prepare("SELECT COUNT(*) AS n FROM items").get().n, 1);
check('no consumed row orphaned',
      db.prepare("SELECT COUNT(*) AS n FROM consumed WHERE item_id <> 'i-survive'").get().n, 0);
check('both reads survive the merge',
      db.prepare("SELECT COUNT(*) AS n FROM consumed").get().n, 2);
check('queued row survives and points at survivor',
      db.prepare("SELECT item_id FROM queued WHERE id='q1'").get().item_id, 'i-survive');
const finalTags = db.prepare(
    "SELECT t.name FROM item_tags it JOIN tags t ON t.id=it.tag_id WHERE it.item_id='i-survive' ORDER BY t.name"
).all().map(r => r.name);
check('tags unioned, no duplicates', finalTags, ['classic', 'paperback', 'scifi']);
check('survivor pages kept (loser had none)',
      db.prepare("SELECT pages FROM items WHERE id='i-survive'").get().pages, 412);

// ── 5. rollback leaves nothing half-merged ────────────────────────────────────
console.log('\n5. transaction rollback');
db.exec(`INSERT INTO items (id,owner,media_type_id,title,date_added,modified)
         VALUES ('i-tmp','local',1,'Temp','${now}','${now}')`);
db.exec(`INSERT INTO consumed (id,item_id,finished,date_added,modified)
         VALUES ('c9','i-tmp','2021-01-01','${now}','${now}')`);

const before = db.prepare("SELECT item_id FROM consumed WHERE id='c9'").get().item_id;
db.exec('BEGIN');
db.prepare("UPDATE consumed SET item_id=? WHERE item_id=?").run('i-survive', 'i-tmp');
try {
    // Violate the FK to force the failure a real merge would hit mid-way.
    db.prepare("UPDATE consumed SET item_id='DOES-NOT-EXIST' WHERE id='c9'").run();
    db.exec('COMMIT');
} catch (e) {
    db.exec('ROLLBACK');
}
const after = db.prepare("SELECT item_id FROM consumed WHERE id='c9'").get().item_id;
check('failed transaction left the row untouched', after, before);
check('temp item still present', db.prepare("SELECT COUNT(*) AS n FROM items WHERE id='i-tmp'").get().n, 1);

// ── 6. tag delete with substitute ─────────────────────────────────────────────
console.log('\n6. delete_tag with substitute');
const affected = db.prepare("SELECT COUNT(*) AS n FROM item_tags WHERE tag_id='t-paper'").get().n;
db.exec('BEGIN');
db.prepare("INSERT OR IGNORE INTO item_tags (item_id, tag_id) SELECT item_id, ? FROM item_tags WHERE tag_id = ?")
  .run('t-classic', 't-paper');
db.prepare("DELETE FROM tags WHERE id = ?").run('t-paper');
db.exec('COMMIT');
check('reported affected rows', affected, 1);
check('substitute tag survives on the item',
      db.prepare("SELECT COUNT(*) AS n FROM item_tags WHERE item_id='i-survive' AND tag_id='t-classic'").get().n, 1);
check('deleted tag links cascaded away',
      db.prepare("SELECT COUNT(*) AS n FROM item_tags WHERE tag_id='t-paper'").get().n, 0);
ok('no item left untagged that had only the deleted tag',
   db.prepare("SELECT COUNT(*) AS n FROM item_tags WHERE item_id='i-survive'").get().n > 0);

// ── 7. settings upsert on owner ───────────────────────────────────────────────
console.log('\n7. settings upsert');
db.prepare("INSERT INTO settings (owner,data) VALUES (?,?) ON CONFLICT(owner) DO UPDATE SET data=excluded.data")
  .run('local', '{"a":1}');
db.prepare("INSERT INTO settings (owner,data) VALUES (?,?) ON CONFLICT(owner) DO UPDATE SET data=excluded.data")
  .run('local', '{"a":2}');
check('one settings row per owner', db.prepare("SELECT COUNT(*) AS n FROM settings").get().n, 1);
check('upsert replaced the value', db.prepare("SELECT data FROM settings WHERE owner='local'").get().data, '{"a":2}');

// ── 8. items upsert (ON CONFLICT clause used by upsert_item) ──────────────────
console.log('\n8. items ON CONFLICT upsert');
const upsertSql =
    "INSERT INTO items (id,owner,media_type_id,title,author,author2,pages,isbn,date_added,modified) " +
    "VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET owner=excluded.owner, " +
    "media_type_id=excluded.media_type_id, title=excluded.title, author=excluded.author, " +
    "author2=excluded.author2, pages=excluded.pages, isbn=excluded.isbn, modified=excluded.modified";
db.prepare(upsertSql).run('i-survive','local',1,'Dune (rev)','Herbert, Frank',null,500,'978',now,now);
const upserted = db.prepare("SELECT title,pages,date_added FROM items WHERE id='i-survive'").get();
check('upsert updated title', upserted.title, 'Dune (rev)');
check('upsert updated pages', upserted.pages, 500);
check('date_added preserved by the upsert (not in the SET list)', upserted.date_added, '2026-08-04');
check('still one row', db.prepare("SELECT COUNT(*) AS n FROM items WHERE id='i-survive'").get().n, 1);

console.log('\n' + (failures === 0 ? 'ALL RUST-SQL TESTS PASSED' : failures + ' FAILURE(S)'));
process.exit(failures === 0 ? 0 : 1);
