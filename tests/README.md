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
| `schema-test.js` | Extracts the DDL from `schema.rs` and runs it: all 8 tables create, foreign keys enforce, `ON DELETE CASCADE` fires, `UNIQUE(owner,name)` holds, the quoted `"rank"` column round-trips, no `category` column exists anywhere |
| `migration-test.js` | Rebuilds the exact batch `migrate_v1()` assembles, checks `format!` placeholder count matches its arguments, confirms `PRAGMA user_version = 1`, re-run safety, and that no Scriptum flat tables get created |
| `join-test.js` | The Phase 1 join-simulation spike — `JoinHelpers` against a hand-seeded dataset covering re-reads, cross-collection identity, orphan rows, dangling tag links, round-trip fidelity, merge planning and conflict resolution |
| `web-backend-test.js` | `DBManagerWeb` end-to-end on a real IndexedDB: store creation, the join, cache invalidation, partial-payload preservation, tag substitution, merge, transaction atomicity |
| `parity-test.js` | Both backends expose the same methods with the same arity; every command the JS invokes is defined *and* registered; `mod.rs` matches the files on disk |
| `rust-sql-test.js` | Executes the SQL embedded in the Rust modules, verifies every `row.get(N)` index lines up with its `SELECT` list, and runs the `merge_items` statement sequence to check the end state |

## Limitation

The Rust itself is **not compiled** by these tests — only its SQL is
executed and its structure inspected. Run `cargo check` in `src-tauri/`
for the real thing.
