#!/usr/bin/env node
// Runs every Collectyx data-layer test. From the repo root:
//   node tests/run-all.js --mode=notional|disk|d1
//
// --mode is required — no default. A silent default risks disk mode
// (which touches the real database, even though it always rolls back)
// running unintentionally, or notional mode running when disk coverage
// was actually wanted. Pick one explicitly every time.
//
// --mode=notional — in-memory SQLite / fake-indexeddb, nothing real
//   touched.
// --mode=disk — the real SQLite file the desktop app uses. Every Rust
//   suite runs inside one transaction that is ALWAYS rolled back — see
//   tests/lib/datasource.js. web-backend-test.js is unaffected by this
//   flag (see the note it prints) — IndexedDB has no equivalent primitive
//   at this scope yet.
// --mode=d1 — stub, fails loudly. D1 sync is out of current scope.
const { execFileSync } = require('child_process');
const path = require('path');

const root = process.env.COLLECTYX_ROOT || path.resolve(__dirname, '..');

const modeArg = process.argv.find(a => a.startsWith('--mode'));
const VALID_MODES = ['notional', 'disk', 'd1'];

if (!modeArg) {
    console.error('--mode is required — expected one of: ' + VALID_MODES.join(', '));
    console.error('e.g. node tests/run-all.js --mode=notional');
    process.exit(1);
}

const mode = modeArg.includes('=') ? modeArg.split('=')[1] : process.argv[process.argv.indexOf(modeArg) + 1];

if (!mode || !VALID_MODES.includes(mode)) {
    console.error('Unknown --mode "' + (mode || '') + '" — expected one of: ' + VALID_MODES.join(', '));
    process.exit(1);
}

if (mode === 'disk') {
    console.log('mode: disk — running against the real database, wrapped in transactions that are always rolled back.\n');
} else if (mode === 'd1') {
    console.log('mode: d1 — stub only, every D1-aware suite will fail fast (D1 sync not yet implemented).\n');
}

const tests = [
    ['schema-test.js',      'SQLite DDL creates, FKs enforce, cascades work'],
    ['migration-test.js',   'migrate_v1 batch executes, user_version set'],
    ['join-test.js',        'join-simulation helpers vs hand-seeded data'],
    ['web-backend-test.js', 'DBManagerWeb end-to-end against IndexedDB'],
    ['parity-test.js',      'backend interfaces + Rust command wiring'],
    ['rust-sql-test.js',    'SQL from the Rust modules, issues #23/#24/#27'],
    ['dashboard-xss-test.js', 'dashboard.js escapes hostile record data (issue #20)'],
    ['csp-test.js',           'CSP present in both builds and in sync (issue #21)'],
    ['backup-restore-test.js', 'restore validation + snapshot/rollback (issue #22)'],
];

let failed = 0;
tests.forEach(([file, desc]) => {
    process.stdout.write(file.padEnd(26));
    try {
        execFileSync('node', [path.join(__dirname, file)], {
            env: Object.assign({}, process.env, { COLLECTYX_ROOT: root, COLLECTYX_TEST_MODE: mode }),
            stdio: 'pipe',
        });
        console.log('PASS  ' + desc);
    } catch (e) {
        failed++;
        console.log('FAIL  ' + desc);
        console.log(e.stdout ? e.stdout.toString().split('\n').filter(l => l.includes('FAIL')).join('\n') : '');
        if (e.stderr) {
            const stderrText = e.stderr.toString().trim();
            if (stderrText) console.log(stderrText.split('\n').slice(0, 3).join('\n'));
        }
    }
});

console.log('\n' + (failed === 0 ? 'all suites passed' : failed + ' suite(s) failed'));
process.exit(failed === 0 ? 0 : 1);
