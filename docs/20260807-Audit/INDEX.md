# Collectyx audit — issue index

Twenty issues from the 2026-08-07 security, correctness, and reliability audit.
Full analysis and evidence: `../SECURITY-AUDIT.md`.

| ID                          | Severity | Size | Title                                                                                    |
| --------------------------- | -------- | ---- | ---------------------------------------------------------------------------------------- |
| ~~COLLECTYX-SEC-01 (#20)~~  | Critical | S    | Escape user data in dashboard.js before interpolating it into innerHTML                  |
| ~~COLLECTYX-SEC-02 (#21)~~  | Critical | S    | Add a Content-Security-Policy meta tag so the web build has a CSP                        |
| ~~COLLECTYX-SEC-03 (#22)~~  | Critical | L    | Restore deletes everything before validating the replacement data                        |
| ~~COLLECTYX-SEC-04 (#23)~~  | High     | M    | replace_all_consumed/queued/owned delete every row regardless of owner                   |
| ~~COLLECTYX-SEC-05 (#24)~~  | High     | L    | Mutating IPC commands trust a client-supplied id; upsert_item transfers ownership        |
| ~~COLLECTYX-SEC-06 (#25)~~  | High     | S    | Trim Tauri capabilities and plugins to what the app actually calls                       |
| ~~COLLECTYX-SEC-07~~        | Medium   | S    | Replace the hand-rolled new_uuid() with a real UUID v4                                   |
| ~~COLLECTYX-SEC-08 (#27)~~  | Medium   | M    | Tauri cannot clear Pages, Author, Author2, or ISBN — COALESCE conflates absent with null |
| ~~COLLECTYX-SEC-09 (#28)~~  | Medium   | S    | Statistics gap-fill loop is unbounded; one bad Finished date freezes the app             |
| ~~COLLECTYX-SEC-10 *#29)*~~ | Medium   | S    | CSV export does not neutralise spreadsheet formula triggers                              |
| ~~COLLECTYX-SEC-11 (#30)~~  | Medium   | M    | No validation below the UI: import and restore bypass every input rule                   |
| ~~COLLECTYX-SEC-12 (#31)~~  | Medium   | M    | Repair the test suite: 4 of 6 suites fail and migration-test was never correct           |
| ~~COLLECTYX-SEC-13(#32~~)   | Medium   | M    | Rank shifting is non-atomic and O(n squared)                                             |
| ~~COLLECTYX-SEC-14(#33)~~   | Medium   | S    | replaceAllTags behaves differently on each backend; SQLite silently destroys tag links   |
| ~~COLLECTYX-SEC-15(#34)~~   | Medium   | S    | Web cache is mutated before the write commits and is not invalidated on failure          |
| ~~COLLECTYX-SEC-16(#35)~~   | Medium   | S    | Owner (Testing) ships an unauthenticated data-scope switch; set_app_meta accepts any key |
| COLLECTYX-SEC-17            | Low      | S    | Binding guards latch before the element lookup; a failed bind is permanent               |
| COLLECTYX-SEC-18            | Low      | S    | Rust stamps dates in UTC while JavaScript uses local time                                |
| COLLECTYX-SEC-19            | Low      | M    | Hardening and hygiene: CSP directives, dead code, migration guard, unbounded reads       |
| COLLECTYX-SEC-20            | Low–Med  | M    | Second-pass findings: TOCTOU on save, stale queued cache, orphan items, tag count leak   |

## Suggested order

1. ~~**-12** — test suite. Everything below ships unverified until it is green.~~
2. ~~**-01, -02** — dashboard escaping and web CSP. Two small patches, largest risk drop.~~
3. ~~**-03** — validate-then-snapshot in restore. Highest data-loss risk.~~
4. ~~**-06** — trim capabilities. One file, shrinks the blast radius of everything else.~~
5. ~~**-04, -05** — owner scoping. Must land before any D1 work starts.~~
6. ~~**-11, -09, -10**~~ — backend validation, statistics DoS, CSV export escaping.
7. **-07, -08, -13, -14, -15, -16**
8. **-17, -18, -19, -20**

## Sequencing constraints

- **-05 and -08 must be one change** — both rewrite `upsert_item`'s `ON CONFLICT` clause.
- **-04 before -05** — `-05` reuses the join-scoping expression `-04` introduces.
- **-20 finding 1 belongs with -08** — moving payload completion into Rust solves both.
- **-13 after -04 and -05** — the new `reorder_queued` command must carry owner scoping.
- **-02 and -19 item 2 overlap** — both edit CSP; keep the two policies identical.
- **-06 and -19 item 5 overlap** — both remove `dialog:allow-message` / `confirmDialog()`.
- **-18 after -08** — both touch `ItemFields` and the three record structs.
