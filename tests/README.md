# Collectyx data-layer tests

Verification for Phases 1 and 2. No browser and no `cargo` required — the
SQL is executed against Node's built-in SQLite, and the web backend runs
against `fake-indexeddb`.

## Setup

    cd tests && npm install fake-indexeddb

Requires Node 22+ (for `node:sqlite`).

## Run

    node tests/run-all.js

Or individually, from the repo root:

    node tests/join-test.js

## What each suite covers

| Suite | Covers |
|---|---|
| `schema-test.js` | Extracts the DDL from `schema.rs` and runs it: every table in `schema.rs` creates, foreign keys enforce, `ON DELETE CASCADE` fires, `UNIQUE(owner,name)` holds, the quoted `"rank"` column round-trips, no `category` column exists anywhere |
| `migration-test.js` | Rebuilds the exact batches `migrate_v1()` and `migrate_v2()` each assemble — from that function's body alone, not a file-wide scan — checks each `format!`'s placeholder count matches its own arguments, confirms `PRAGMA user_version` reaches 1 then 2, re-run safety, `queued.currently_reading` lands, and that no Scriptum flat tables get created |
| `join-test.js` | The Phase 1 join-simulation spike — `JoinHelpers` against a hand-seeded dataset covering re-reads, cross-collection identity, orphan rows, dangling tag links, round-trip fidelity, merge planning and conflict resolution. `CONSTANTS.STORES` is checked against the table set `schema.rs` actually creates, not a hard-coded count |
| `web-backend-test.js` | `DBManagerWeb` end-to-end on a real IndexedDB: store creation (checked against `CONSTANTS.STORES`, including `app_meta`), the join, cache invalidation, partial-payload preservation, tag substitution, merge, transaction atomicity |
| `parity-test.js` | Both backends expose the same methods with the same arity; every command the JS invokes is defined *and* registered; `mod.rs` matches the files on disk |
| `rust-sql-test.js` | Executes the SQL embedded in the Rust modules against a fixture built from every `schema.rs` table plus migration v2's `queued.currently_reading`, verifies every `row.get(N)` index lines up with its `SELECT` list for all three collections independently, and runs the `merge_items` statement sequence to check the end state |
| `dashboard-xss-test.js` | Regression test for COLLECTYX-SEC-01. Loads the real `dashboard.js` against a DOM shim and feeds its renderers hostile record data (`<img onerror>`, `<script>`); confirms every template interpolation reaching `innerHTML` is escaped, and that `renderReadingGoals` uses `textContent` rather than `innerHTML`. Cannot verify real browser rendering — that's manual, per the issue |
| `csp-test.js` | Regression test for COLLECTYX-SEC-02. Confirms `src/index.html` carries a CSP meta tag, that it agrees with `tauri.conf.json`'s policy on every directive except the Tauri-only `connect-src` sources, and that `object-src`/`base-uri`/`form-action` are `'none'` in both. Cannot verify real enforcement — that needs a browser console watch, which is manual, per the issue |
| `backup-restore-test.js` | Regression test for COLLECTYX-SEC-03. Runs `_validate()` against the issue's malformed-file corpus, and exercises `executeRestore()` against a mock `DBManager` to prove the snapshot-and-rollback path actually restores prior state on a mid-write failure, and logs a recoverable snapshot when rollback itself fails. Cannot verify the real Tauri/IndexedDB backends or gzip/truncated-file handling — that's the manual six-file corpus pass the issue specifies |

## Limitation

The Rust itself is **not compiled** by these tests — only its SQL is
executed and its structure inspected. Run `cargo check` in `src-tauri/`
for the real thing.
