/**
 * Regression test for issue #72 (CTX-SEC-122). This project's test harness
 * cannot compile or execute Rust — see run-all.js's mode notes and
 * rust-sql-test.js's own precedent. This suite follows the same approach:
 *
 *   1. Static checks that common::validate_rank exists with the documented
 *      bounds, and that queued.rs actually calls it from write_one (restore
 *      path) and reorder_queued (direct invoke path).
 *   2. The overflow-guarded UPDATE statement's literal SQL text is
 *      extracted from queued.rs and executed for real against an in-memory
 *      SQLite (node:sqlite) — this is genuine behavioral coverage of the
 *      bound, not just a string match, without needing cargo.
 *   3. db-manager-web.js's reorderQueued range/precision guard, exercised
 *      directly (no IndexedDB needed — the guard is the first thing the
 *      method does, before any store access).
 *
 * What this suite does NOT cover: the full reorder_queued Rust command
 * end-to-end (needs a compiled binary), and db-manager-web.js's happy-path
 * shift behavior (needs a seeded IndexedDB/fake-indexeddb store) — both
 * remain manual-test territory per the issue's own acceptance criteria.
 */
const fs = require('fs');
const vm = require('vm');
const { DatabaseSync } = require('node:sqlite');

const R = process.env.COLLECTYX_ROOT || '../';

let failures = 0;
function ok(label, cond, detail) {
    if (cond) console.log('  ok   ' + label);
    else { console.log('  FAIL ' + label + (detail ? '\n         ' + detail : '')); failures++; }
}

const commonRs = fs.readFileSync(R + '/src-tauri/src/commands/common.rs', 'utf8');
const queuedRs = fs.readFileSync(R + '/src-tauri/src/commands/queued.rs', 'utf8');

(async function run() {

console.log('\n1. common::validate_rank — exists with documented bounds');
{
    ok('MIN_RANK = 1', /pub const MIN_RANK: i64 = 1;/.test(commonRs));
    ok('MAX_RANK = 1_000_000', /pub const MAX_RANK: i64 = 1_000_000;/.test(commonRs));
    ok('validate_rank function is defined', /pub fn validate_rank\(/.test(commonRs));
}

console.log('\n2. queued.rs — validate_rank is actually called on both write paths');
{
    ok('write_one validates rank when apply_rank (restore path)',
       /if apply_rank \{[\s\S]{0,120}?common::validate_rank\(record\.rank\)/.test(queuedRs));
    ok('reorder_queued validates new_rank up front (direct invoke path)',
       /pub fn reorder_queued[\s\S]{0,300}?common::validate_rank\(new_rank\)/.test(queuedRs));
}

console.log('\n3. reorder_queued — the (None, Some) shift SQL is bounded (real SQLite execution)');
{
    // Extract the literal SQL string for the unranked-to-ranked shift arm —
    // this is the one arm with real overflow exposure (see the issue: a
    // legacy row at a very large rank must not be incremented into the
    // i64 edge). Executed for real, not just string-matched.
    const m = queuedRs.match(/\(None, Some\(nr\)\) => tx\.execute\(\s*"((?:\\.|[^"\\])*)"/);
    ok('SQL for the (None, Some) arm was found in queued.rs', m !== null);

    if (m) {
        const sql = m[1].replace(/\\"/g, '"');
        ok('SQL text carries the MAX_RANK upper bound (rank < ?4)', /"rank"\s*<\s*\?4/.test(sql));

        // 5 billion, not i64::MAX — node:sqlite's JS-facing row values lose
        // precision/throw above Number.MAX_SAFE_INTEGER, so the true i64
        // edge case isn't reachable from this harness. 5 billion is still
        // 5000x past MAX_RANK, which is enough to prove the bound excludes
        // legacy out-of-range rows; it does not prove the exact i64::MAX
        // overflow scenario the issue originally described — that remains
        // cargo-test/manual-test territory.
        const db = new DatabaseSync(':memory:');
        db.exec(`
            CREATE TABLE items (id TEXT PRIMARY KEY, owner TEXT);
            CREATE TABLE queued (id TEXT PRIMARY KEY, item_id TEXT, "rank" INTEGER);
            INSERT INTO items VALUES ('i1','local'), ('i2','local'), ('i3','local'), ('i-target','local');
            INSERT INTO queued VALUES
                ('target', 'i-target', NULL),
                ('normal', 'i1', 5),
                ('at-max', 'i2', 1000000),
                ('above-max-legacy', 'i3', 5000000000);
        `);

        // Mirrors the Rust call: moving 'target' from unranked to rank 5,
        // shifting everything currently >= 5 up by one.
        const stmt = db.prepare(sql.replace('?1', "'target'").replace('?2', '5').replace('?3', "'local'").replace('?4', '1000000'));
        stmt.run();

        const rows = db.prepare('SELECT id, "rank" FROM queued').all();
        const byId = Object.fromEntries(rows.map(r => [r.id, r.rank]));

        ok('a normal row at rank 5 was shifted to 6', byId.normal === 6);
        ok('a row already at MAX_RANK (1,000,000) was excluded from the shift, not incremented',
           byId['at-max'] === 1000000);
        ok('a legacy row far above MAX_RANK was left untouched (no overflow attempted)',
           byId['above-max-legacy'] === 5000000000);

        db.close();
    }
}

console.log('\n4. db-manager-web.js reorderQueued — range/precision guard rejects before any store access');
{
    const sandbox = {
        console, indexedDB: {}, crypto: { randomUUID: () => 'x' },
        Promise, Set, Map, Array, Object, String, Number, Date, JSON, Error, Boolean,
    };
    sandbox.window = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(fs.readFileSync(R + '/src/js/constants.js', 'utf8') +
                    '\nthis.CONSTANTS = CONSTANTS;', sandbox);
    vm.runInContext(fs.readFileSync(R + '/src/js/db-manager-web.js', 'utf8') +
                    '\nthis.DBManagerWeb = DBManagerWeb;', sandbox);

    const cases = [
        ['0 (below MIN_RANK)', 0, false],
        ['-5 (negative)', -5, false],
        ['1000001 (above MAX_RANK)', 1000001, false],
        ['1.5 (non-integer)', 1.5, false],
        ['Number.MAX_SAFE_INTEGER + 10 (precision loss)', Number.MAX_SAFE_INTEGER + 10, false],
        ['500 (in range)', 500, 'no-throw-but-needs-store'],
    ];

    for (const [label, value, shouldRejectSynchronously] of cases) {
        if (shouldRejectSynchronously === false) {
            let rejected = false;
            try {
                await sandbox.DBManagerWeb.reorderQueued('some-id', value);
            } catch (e) {
                rejected = /out of range/.test(e.message);
            }
            ok('rejects ' + label, rejected);
        }
        // The in-range case can't be asserted here without a seeded
        // IndexedDB/fake-indexeddb store (this._load/_owner internals) —
        // left to web-backend-test.js's existing IndexedDB harness or a
        // manual pass, per this file's header note.
    }
}

console.log('\n' + (failures === 0
    ? 'ALL QUEUED-RANK TESTS PASSED'
    : failures + ' FAILURE(S)'));
process.exit(failures === 0 ? 0 : 1);

})().catch(e => {
    console.error('\nHARNESS ERROR:', e);
    process.exit(1);
});
