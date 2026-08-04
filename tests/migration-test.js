// Reconstructs the exact execute_batch string migrate_v1() builds and runs it,
// verifying the transaction wrapper, statement order, and PRAGMA user_version.
const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');

const schemaSrc = fs.readFileSync((process.env.COLLECTYX_ROOT || '../') + '/src-tauri/src/db/schema.rs', 'utf8');
const migSrc = fs.readFileSync((process.env.COLLECTYX_ROOT || '../') + '/src-tauri/src/db/migrations.rs', 'utf8');

const re = /pub const (\w+): &str = "([\s\S]*?)";\n/g;
const consts = {};
let m;
while ((m = re.exec(schemaSrc)) !== null) consts[m[1]] = m[2].replace(/\\"/g, '"');

// Pull the schema:: references out of migrations.rs in the order they appear
// in the format! args, so the test follows the source rather than my memory.
const order = [...migSrc.matchAll(/schema::(\w+),/g)].map(x => x[1]);
console.log('migrate_v1 applies, in order:');
order.forEach((k, i) => console.log(`  ${i + 1}. ${k}`));

const placeholders = (migSrc.match(/^\s{8}\{\}$/gm) || []).length;
console.log(`\n{} placeholders in format string: ${placeholders}, schema:: args: ${order.length}`);
if (placeholders !== order.length) {
    console.error('MISMATCH: placeholder count != argument count — format! would not compile');
    process.exit(1);
}

const missing = order.filter(k => !consts[k]);
if (missing.length) { console.error('Referenced but not defined in schema.rs:', missing); process.exit(1); }

const batch = 'BEGIN;\n' + order.map(k => consts[k]).join('\n') +
              '\nPRAGMA user_version = 1;\nCOMMIT;';

const db = new DatabaseSync(':memory:');
db.exec('PRAGMA foreign_keys = ON;');
try {
    db.exec(batch);
    console.log('\nbatch executed successfully');
} catch (e) {
    console.error('\nBATCH FAILED:', e.message);
    process.exit(1);
}

const ver = db.prepare('PRAGMA user_version').get();
console.log('user_version after migration:', JSON.stringify(ver));
if (ver.user_version !== 1) { console.error('user_version not set to 1'); process.exit(1); }

const tables = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
).all().map(r => r.name);
console.log('tables:', tables.join(', '));
if (tables.length !== 8) { console.error('expected 8 tables, got', tables.length); process.exit(1); }

// Idempotency: running the batch a second time must not error or duplicate the
// seed row, since run_migrations guards on user_version but IF NOT EXISTS /
// INSERT OR IGNORE should hold regardless.
try {
    db.exec(batch);
    const seedCount = db.prepare('SELECT COUNT(*) AS n FROM media_types').get().n;
    console.log('re-running batch is safe; media_types rows:', seedCount);
    if (seedCount !== 1) { console.error('seed row duplicated on re-run'); process.exit(1); }
} catch (e) {
    console.error('re-running batch failed:', e.message);
    process.exit(1);
}

// Confirm no Scriptum-era flat tables were created
const legacy = ['books_read', 'reading_list', 'my_library'];
const found = legacy.filter(t => tables.includes(t));
if (found.length) { console.error('legacy flat tables present:', found); process.exit(1); }
console.log('confirmed: no legacy flat tables created');

console.log('\nALL MIGRATION TESTS PASSED');
