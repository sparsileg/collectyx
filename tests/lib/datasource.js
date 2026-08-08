/**
 * Shared data-source abstraction for the Collectyx Rust/SQLite test suites.
 *
 * Mode is set via COLLECTYX_TEST_MODE (run-all.js's --mode flag sets this
 * before spawning each suite):
 *
 *   notional (default) — in-memory SQLite, schema built fresh from
 *     schema.rs/migrations.rs. Nothing real touched, nothing persists.
 *     Safe to run anytime, exactly today's behavior.
 *
 *   disk — the real SQLite file the desktop app actually uses. The whole
 *     suite runs inside one outer transaction opened here and ALWAYS
 *     rolled back in teardown() — never committed, regardless of whether
 *     the suite passed. Callers MUST run teardown() in a finally block so
 *     a thrown assertion can't leave the transaction open against the
 *     real file.
 *
 *   d1 — stub. D1 sync is out of current scope (collectyx-implementation-
 *     plan.md, Deferred). Fails loudly rather than faking a connection —
 *     see openRustDb() below for what a real implementation needs to
 *     provide.
 *
 * IndexedDB has no equivalent to SQLite's BEGIN/ROLLBACK at this scope, so
 * 'disk' mode is Rust/SQLite-only for now. web-backend-test.js always runs
 * against fake-indexeddb regardless of mode — flagged there, not silently
 * treated as equivalent safety.
 *
 * Every fixture row this suite writes uses TEST_OWNER (or TEST_OWNER_2),
 * never DEFAULT_OWNER ('local') — 'disk' mode runs against the real file,
 * where 'local' already holds real data. Scoping fixtures to a dedicated
 * owner keeps every count-based assertion valid whether the database is
 * empty (notional) or not (disk), and guarantees a rolled-back disk run
 * can never leave a fake row mixed into real data even transiently.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const MODE = process.env.COLLECTYX_TEST_MODE || 'notional';
const VALID_MODES = ['notional', 'disk', 'd1'];
const ROOT = process.env.COLLECTYX_ROOT || path.resolve(__dirname, '../..');

// Never a real owner — real owners come from settings/app_meta, entered
// by a person. This string is deliberately unlike a UUID or 'local' so it
// can never collide with either.
const TEST_OWNER = '__collectyx_test_fixture__';
const TEST_OWNER_2 = '__collectyx_test_fixture_2__';

/** Regex-extracts `pub const NAME: &str = "value";` from a Rust source
 *  file — same technique the suites already use for schema.rs, so path
 *  resolution never hardcodes what constants.rs actually defines. */
function rustConst(relPath, name) {
    const src = fs.readFileSync(path.join(ROOT, relPath), 'utf8');
    const m = src.match(new RegExp('pub const ' + name + ': &str = "([^"]*)"'));
    if (!m) throw new Error('Could not find pub const ' + name + ' in ' + relPath);
    return m[1];
}

/** Linux-only — matches the actual dev environment (onboarding.md).
 *  dirs_next::data_dir() resolves differently on macOS/Windows; extend
 *  this if disk-mode testing on those platforms is ever needed. */
function resolveDiskPath() {
    const appName = rustConst('src-tauri/src/constants.rs', 'APP_NAME');
    const dbFile = rustConst('src-tauri/src/constants.rs', 'DB_FILE_NAME');
    const xdg = process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
    return path.join(xdg, appName, dbFile);
}

function buildSchemaFromSource(db) {
    const schemaSrc = fs.readFileSync(path.join(ROOT, 'src-tauri/src/db/schema.rs'), 'utf8');
    const migSrc = fs.readFileSync(path.join(ROOT, 'src-tauri/src/db/migrations.rs'), 'utf8');
    const consts = {};
    let m;
    const re = /pub const (\w+): &str = "([\s\S]*?)";\n/g;
    while ((m = re.exec(schemaSrc)) !== null) consts[m[1]] = m[2].replace(/\\"/g, '"');

    db.exec('PRAGMA foreign_keys = ON;');
    [...schemaSrc.matchAll(/pub const (\w+): &str = /g)].map(x => x[1])
        .forEach(k => db.exec(consts[k]));

    const alterMatch = migSrc.match(/ALTER TABLE queued ADD COLUMN currently_reading[^;]*;/);
    if (!alterMatch) throw new Error('migrate_v2 ALTER TABLE not found in migrations.rs');
    db.exec(alterMatch[0]);
}

/**
 * Opens a Rust-side (SQLite) test database per the active mode.
 * Returns { db, mode, teardown() }. teardown() MUST run in a finally —
 * in 'disk' mode it's the only thing standing between a thrown assertion
 * and a stuck open transaction on the real file.
 */
function openRustDb() {
    if (!VALID_MODES.includes(MODE)) {
        throw new Error('Unknown COLLECTYX_TEST_MODE "' + MODE + '" — expected one of: ' + VALID_MODES.join(', '));
    }

    if (MODE === 'd1') {
        // Stub. A real implementation needs: a D1 HTTP/binding client,
        // equivalent BEGIN/ROLLBACK support (verify against current D1
        // docs — not guaranteed identical to local SQLite transactions;
        // see the standing note in onboarding), and TEST_OWNER-scoped
        // fixtures exactly as disk mode uses, since D1 is meant to hold
        // real synced multi-user data eventually.
        throw new Error(
            'D1 testing not yet implemented — see tests/lib/datasource.js. ' +
            'D1 sync is out of current scope (collectyx-implementation-plan.md, Deferred).'
        );
    }

    if (MODE === 'disk') {
        const dbPath = resolveDiskPath();
        if (!fs.existsSync(dbPath)) {
            throw new Error('disk mode: no database found at ' + dbPath + ' — run the app at least once first.');
        }
        const db = new DatabaseSync(dbPath);
        db.exec('PRAGMA foreign_keys = ON;');
        db.exec('BEGIN;');
        let closed = false;
        return {
            db,
            mode: MODE,
            teardown() {
                if (closed) return;
                closed = true;
                db.exec('ROLLBACK;');
                db.close();
            },
        };
    }

    // notional
    const db = new DatabaseSync(':memory:');
    buildSchemaFromSource(db);
    return {
        db,
        mode: MODE,
        teardown() { db.close(); },
    };
}

/**
 * Nested-transaction helpers. Individual test sections use their own
 * atomicity demonstrations (a merge, a restore, a rollback-on-failure
 * case); in 'disk' mode the whole suite is already inside one outer
 * transaction (see openRustDb), and SQLite doesn't allow a nested raw
 * BEGIN. SAVEPOINT works both standalone and nested, so every section
 * uses these instead of raw BEGIN/COMMIT/ROLLBACK.
 */
function savepoint(db, name) { db.exec('SAVEPOINT ' + name + ';'); }
function release(db, name) { db.exec('RELEASE SAVEPOINT ' + name + ';'); }
function rollbackTo(db, name) {
    db.exec('ROLLBACK TO SAVEPOINT ' + name + ';');
    db.exec('RELEASE SAVEPOINT ' + name + ';');
}

module.exports = {
    MODE, ROOT, TEST_OWNER, TEST_OWNER_2,
    openRustDb, savepoint, release, rollbackTo,
    rustConst, resolveDiskPath,
};
