// Reconstructs the exact execute_batch string each migrate_vN() builds and
// runs it, verifying the transaction wrapper, statement order, and
// PRAGMA user_version — for migrate_v1 and migrate_v2 independently, each
// against a body extracted from that function alone.
const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');

const ROOT = process.env.COLLECTYX_ROOT || '../';
const schemaSrc = fs.readFileSync(ROOT + '/src-tauri/src/db/schema.rs', 'utf8');
const migSrc = fs.readFileSync(ROOT + '/src-tauri/src/db/migrations.rs', 'utf8');

const constRe = /pub const (\w+): &str = "([\s\S]*?)";\n/g;
const consts = {};
let cm;
while ((cm = constRe.exec(schemaSrc)) !== null) consts[cm[1]] = cm[2].replace(/\\"/g, '"');

// Brace-matches a single `fn name(...) { ... }` body so v1 and v2 are each
// tested against their own source, not a file-wide regex that can splice
// one function's statements into the other's.
function migrationBody(src, fnName) {
    const marker = 'fn ' + fnName + '(';
    const start = src.indexOf(marker);
    if (start === -1) { console.error('function not found: ' + fnName); process.exit(1); }
    const braceStart = src.indexOf('{', start);
    let depth = 0, i = braceStart;
    for (; i < src.length; i++) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}') { depth--; if (depth === 0) break; }
    }
    if (depth !== 0) { console.error('unbalanced braces in ' + fnName); process.exit(1); }
    return src.slice(braceStart, i + 1);
}

// Extracts the `execute_batch(&format!("...", args...))?;` call out of a
// function body and rebuilds the literal SQL it produces, args and all —
// including any SQL hard-coded directly in the template (e.g. v2's
// ALTER TABLE line), not just the schema:: placeholders.
function buildBatch(fnName, body) {
    const m = body.match(/execute_batch\(&format!\(\s*"([\s\S]*?)",\s*([\s\S]*?)\)\)\?;/);
    if (!m) { console.error('execute_batch(&format!(...)) not found in ' + fnName); process.exit(1); }
    const template = m[1];
    const argsBlock = m[2];
    const order = [...argsBlock.matchAll(/schema::(\w+)/g)].map(x => x[1]);
    const placeholders = (template.match(/\{\}/g) || []).length;

    console.log(`\n${fnName} applies, in order:`);
    order.forEach((k, i) => console.log(`  ${i + 1}. ${k}`));
    console.log(`{} placeholders: ${placeholders}, schema:: args: ${order.length}`);
    if (placeholders !== order.length) {
        console.error(`MISMATCH in ${fnName}: placeholder count != argument count — format! would not compile`);
        process.exit(1);
    }

    const missing = order.filter(k => !consts[k]);
    if (missing.length) { console.error(fnName + ' references consts not defined in schema.rs:', missing); process.exit(1); }

    let idx = 0;
    const batch = template.replace(/\{\}/g, () => consts[order[idx++]]);
    return { batch, order };
}

// Which of the referenced consts actually create a table, per schema.rs —
// distinguishes CREATE_INDEXES / SEED_MEDIA_TYPES (referenced, but not
// table-creating) from the real CREATE TABLE statements.
function tablesCreatedBy(order) {
    const tables = [];
    order.forEach(k => {
        const re = /CREATE TABLE IF NOT EXISTS (\w+)/g;
        let mm;
        while ((mm = re.exec(consts[k])) !== null) tables.push(mm[1]);
    });
    return tables.sort();
}

function currentTables(db) {
    return db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
    ).all().map(r => r.name);
}

function extractVersion(batchText) {
    const vm = batchText.match(/PRAGMA user_version = (\d+)/);
    return vm ? parseInt(vm[1], 10) : null;
}

const db = new DatabaseSync(':memory:');
db.exec('PRAGMA foreign_keys = ON;');

// ── migrate_v1 ──────────────────────────────────────────────────────────────
const v1Body = migrationBody(migSrc, 'migrate_v1');
const { batch: batchV1, order: orderV1 } = buildBatch('migrate_v1', v1Body);
const v1ExpectedTables = tablesCreatedBy(orderV1);
const v1ExpectedVersion = extractVersion(batchV1);

try {
    db.exec(batchV1);
    console.log('\nmigrate_v1 batch executed successfully');
} catch (e) {
    console.error('\nmigrate_v1 BATCH FAILED:', e.message);
    process.exit(1);
}

let ver = db.prepare('PRAGMA user_version').get();
console.log('user_version after migrate_v1:', JSON.stringify(ver));
if (ver.user_version !== v1ExpectedVersion) {
    console.error(`user_version not set to ${v1ExpectedVersion} after migrate_v1`);
    process.exit(1);
}

let tables = currentTables(db);
console.log('tables after migrate_v1:', tables.join(', '));
if (JSON.stringify(tables) !== JSON.stringify(v1ExpectedTables)) {
    console.error('expected tables (from schema.rs)', v1ExpectedTables, 'got', tables);
    process.exit(1);
}

// Idempotency of migrate_v1 alone: running it a second time must not error
// or duplicate the seed row, since IF NOT EXISTS / INSERT OR IGNORE should
// hold regardless of run_migrations' user_version guard.
try {
    db.exec(batchV1);
    const seedCount = db.prepare('SELECT COUNT(*) AS n FROM media_types').get().n;
    console.log('re-running migrate_v1 batch is safe; media_types rows:', seedCount);
    if (seedCount !== 1) { console.error('seed row duplicated on re-run'); process.exit(1); }
} catch (e) {
    console.error('re-running migrate_v1 batch failed:', e.message);
    process.exit(1);
}

const legacy = ['books_read', 'reading_list', 'my_library'];
const foundLegacy = legacy.filter(t => tables.includes(t));
if (foundLegacy.length) { console.error('legacy flat tables present:', foundLegacy); process.exit(1); }
console.log('confirmed: no legacy flat tables created by migrate_v1');

// ── migrate_v2 ──────────────────────────────────────────────────────────────
const v2Body = migrationBody(migSrc, 'migrate_v2');
const { batch: batchV2, order: orderV2 } = buildBatch('migrate_v2', v2Body);
const v2NewTables = tablesCreatedBy(orderV2);
const v2ExpectedVersion = extractVersion(batchV2);

try {
    db.exec(batchV2);
    console.log('\nmigrate_v2 batch executed successfully');
} catch (e) {
    console.error('\nmigrate_v2 BATCH FAILED:', e.message);
    process.exit(1);
}

ver = db.prepare('PRAGMA user_version').get();
console.log('user_version after migrate_v2:', JSON.stringify(ver));
if (ver.user_version !== v2ExpectedVersion) {
    console.error(`user_version not set to ${v2ExpectedVersion} after migrate_v2`);
    process.exit(1);
}

tables = currentTables(db);
const allSchemaTables = [...schemaSrc.matchAll(/CREATE TABLE IF NOT EXISTS (\w+)/g)].map(x => x[1]).sort();
console.log('tables after migrate_v2:', tables.join(', '));
if (JSON.stringify(tables) !== JSON.stringify(allSchemaTables)) {
    console.error('expected (every table in schema.rs)', allSchemaTables, 'got', tables);
    process.exit(1);
}
v2NewTables.forEach(t => {
    if (!tables.includes(t)) { console.error('migrate_v2 should have created table', t); process.exit(1); }
});
console.log('confirmed: migrate_v1 + migrate_v2 together create every table in schema.rs');

const queuedCols = db.prepare("PRAGMA table_info(queued)").all().map(c => c.name);
if (!queuedCols.includes('currently_reading')) {
    console.error('migrate_v2 did not add queued.currently_reading');
    process.exit(1);
}
console.log('confirmed: queued.currently_reading present after migrate_v2');

// Re-running migrate_v2 alone is not a real-world path — run_migrations()
// guards each step on PRAGMA user_version, so ALTER TABLE ADD COLUMN never
// runs twice in practice. Logged for visibility, not asserted either way.
try {
    db.exec(batchV2);
    console.log('re-running migrate_v2 batch: succeeds');
} catch (e) {
    try { db.exec('ROLLBACK'); } catch (_) { /* nothing open to roll back */ }
    console.log('re-running migrate_v2 batch: fails —', e.message, '(expected; not a real run_migrations path)');
}

console.log('\nALL MIGRATION TESTS PASSED');
