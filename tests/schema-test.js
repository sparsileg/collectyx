// Extracts the SQL string constants out of schema.rs and runs them against a
// real SQLite engine, in the same order migrations.rs applies them.
const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');

const src = fs.readFileSync((process.env.COLLECTYX_ROOT || '../') + '/src-tauri/src/db/schema.rs', 'utf8');

// pub const NAME: &str = "....";
const re = /pub const (\w+): &str = "([\s\S]*?)";\n/g;
const consts = {};
let m;
while ((m = re.exec(src)) !== null) {
    consts[m[1]] = m[2].replace(/\\"/g, '"');
}

console.log('Extracted constants:', Object.keys(consts).join(', '));

const order = [
    'CREATE_MEDIA_TYPES',
    'CREATE_ITEMS',
    'CREATE_CONSUMED',
    'CREATE_QUEUED',
    'CREATE_OWNED',
    'CREATE_TAGS',
    'CREATE_ITEM_TAGS',
    'CREATE_SETTINGS',
    'CREATE_INDEXES',
    'SEED_MEDIA_TYPES',
];

const missing = order.filter(k => !consts[k]);
if (missing.length) {
    console.error('MISSING CONSTANTS:', missing);
    process.exit(1);
}

const db = new DatabaseSync(':memory:');
db.exec('PRAGMA foreign_keys = ON;');

for (const key of order) {
    try {
        db.exec(consts[key]);
        console.log(`  ok  ${key}`);
    } catch (e) {
        console.error(`  FAIL ${key}: ${e.message}`);
        process.exit(1);
    }
}

// Verify all eight tables exist
const tables = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
).all().map(r => r.name);
console.log('\nTables created:', tables.join(', '));

const expected = ['consumed','item_tags','items','media_types','owned','queued','settings','tags'];
const missingT = expected.filter(t => !tables.includes(t));
if (missingT.length) { console.error('MISSING TABLES:', missingT); process.exit(1); }

// Verify seed row
const seed = db.prepare('SELECT * FROM media_types').all();
console.log('media_types seed:', JSON.stringify(seed));
if (seed.length !== 1 || seed[0].name !== 'Books') { console.error('SEED WRONG'); process.exit(1); }

// Verify no category column anywhere (design doc §3.2 hard requirement)
for (const t of expected) {
    const cols = db.prepare(`PRAGMA table_info(${t})`).all().map(c => c.name);
    if (cols.includes('category')) { console.error(`category column found in ${t}!`); process.exit(1); }
}
console.log('confirmed: no category column in any table');

// Verify the quoted "rank" column really landed as a usable column
const qcols = db.prepare("PRAGMA table_info(queued)").all().map(c => c.name);
console.log('queued columns:', qcols.join(', '));
if (!qcols.includes('rank')) { console.error('rank column missing/misnamed'); process.exit(1); }

// Exercise rank in a real query, since RANK is a SQLite window-function keyword
db.exec("INSERT INTO items (id, owner, media_type_id, title) VALUES ('i1','local',1,'T')");
db.exec("INSERT INTO queued (id, item_id, \"rank\") VALUES ('q1','i1',3)");
const r = db.prepare('SELECT "rank" FROM queued ORDER BY "rank" ASC').all();
console.log('rank round-trip:', JSON.stringify(r));
if (r[0].rank !== 3) { console.error('rank round-trip failed'); process.exit(1); }

// Verify FK enforcement actually rejects an orphan membership row
let fkEnforced = false;
try {
    db.exec("INSERT INTO consumed (id, item_id, finished) VALUES ('c1','NOPE','2026-01-01')");
} catch (e) { fkEnforced = true; }
console.log('FK enforcement rejects orphan consumed row:', fkEnforced);
if (!fkEnforced) { console.error('FOREIGN KEYS NOT ENFORCED'); process.exit(1); }

// Verify ON DELETE CASCADE clears membership + tags when an item is deleted
db.exec("INSERT INTO tags (id, owner, name) VALUES ('t1','local','fiction')");
db.exec("INSERT INTO item_tags (item_id, tag_id) VALUES ('i1','t1')");
db.exec("DELETE FROM items WHERE id = 'i1'");
const leftQ = db.prepare('SELECT COUNT(*) AS n FROM queued').get().n;
const leftIT = db.prepare('SELECT COUNT(*) AS n FROM item_tags').get().n;
console.log('after item delete — queued rows:', leftQ, ' item_tags rows:', leftIT);
if (leftQ !== 0 || leftIT !== 0) { console.error('CASCADE FAILED'); process.exit(1); }

// Verify tags UNIQUE(owner,name) permits the same tag name for a different owner
db.exec("INSERT INTO tags (id, owner, name) VALUES ('t2','local','scifi')");
let dupRejected = false;
try { db.exec("INSERT INTO tags (id, owner, name) VALUES ('t3','local','scifi')"); }
catch (e) { dupRejected = true; }
db.exec("INSERT INTO tags (id, owner, name) VALUES ('t4','other','scifi')");
console.log('duplicate tag rejected within owner:', dupRejected, '| same name allowed across owners: true');
if (!dupRejected) { console.error('UNIQUE(owner,name) NOT ENFORCED'); process.exit(1); }

console.log('\nALL SCHEMA TESTS PASSED');
