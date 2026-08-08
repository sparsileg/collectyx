#!/usr/bin/env node
// Runs every Collectyx data-layer test. From the repo root: node tests/run-all.js
const { execFileSync } = require('child_process');
const path = require('path');

const root = process.env.COLLECTYX_ROOT || path.resolve(__dirname, '..');
const tests = [
    ['schema-test.js',      'SQLite DDL creates, FKs enforce, cascades work'],
    ['migration-test.js',   'migrate_v1 batch executes, user_version set'],
    ['join-test.js',        'join-simulation helpers vs hand-seeded data'],
    ['web-backend-test.js', 'DBManagerWeb end-to-end against IndexedDB'],
    ['parity-test.js',      'backend interfaces + Rust command wiring'],
    ['rust-sql-test.js',    'SQL from the Rust modules, incl. merge_items'],
    ['dashboard-xss-test.js', 'dashboard.js escapes hostile record data (COLLECTYX-SEC-01)'],
    ['csp-test.js',           'CSP present in both builds and in sync (COLLECTYX-SEC-02)'],
    ['backup-restore-test.js', 'restore validation + snapshot/rollback (COLLECTYX-SEC-03)'],
];

let failed = 0;
tests.forEach(([file, desc]) => {
    process.stdout.write(file.padEnd(26));
    try {
        execFileSync('node', [path.join(__dirname, file)], {
            env: Object.assign({}, process.env, { COLLECTYX_ROOT: root }),
            stdio: 'pipe',
        });
        console.log('PASS  ' + desc);
    } catch (e) {
        failed++;
        console.log('FAIL  ' + desc);
        console.log(e.stdout ? e.stdout.toString().split('\n').filter(l => l.includes('FAIL')).join('\n') : '');
    }
});

console.log('\n' + (failed === 0 ? 'all suites passed' : failed + ' suite(s) failed'));
process.exit(failed === 0 ? 0 : 1);
