# Scriptum Code Review — 2026-07-06

Review complete — I read every JS file, every Rust file, both configs, the
CSS entry points, and the migration plan. Full write-up is in the linked
report; here's the headline.

**The big finding: Tauri-mode CRUD has type mismatches between the JS
objects and the Rust structs, and the clear-then-rewrite save pattern turns
any of those failures into a table wipe.

** Specifically:

1. Forms produce `Pages` as a string (`"320"` or `""`); Rust expects
   `Option<i64>`. serde_json won't coerce, so the whole `Vec`
   deserialization fails, the invoke rejects — but `clear_books_read`
   already ran. That's a wipe. I suspect some of the wipes attributed
   purely to hot-reload were actually this.
2. In-memory `myLibrary` Tags are arrays (parsed on load), but
   `LibraryBook.tags` is `Option<String>` — so every `saveMyLibraryData()`
   in Tauri should fail deserialization. The restore path works only
   because `importUnifiedDatabase` stringifies Tags — which is itself
   evidence the CRUD paths never got the same treatment.
3. `ReadingListItem` has no `Source` or `IsCheckedOut` fields — Rust
   silently drops them, so after a Tauri restart every reading-list item
   shows "Source: undefined" and the auto check-in logic breaks.
4. Dashboard card reorder in Tauri **overwrites your entire app-settings
   row** (theme, categories, backup folder) because `save_settings` always
   writes the `'app-settings'` key regardless of the row id.

Also notable: `clearAllMyLibraryBooks` can never persist (the empty-array
guard blocks it), deleting your last book doesn't persist for the same
reason, editing a Books Read entry silently drops every field not in the
edit form, and the dashboard "This Year" stat reads the *day* instead of
the year from `YYYY-MM-DD` dates. The migration plan also has an unresolved
git merge conflict sitting in the Phase 4 schema section, and Phase 2's
`validateImportFile()` / `test-imports/` deliverables don't exist in the
source despite the phase being marked complete.

Two quick tests will confirm the critical items on your machine: in Tauri,
add a book via the form with Pages filled, restart, see if it survived; and
drag a dashboard card, restart, check your theme/categories.The report has
everything: 6 critical, 6 high, 14 medium, 9 low, the web/Tauri divergence
table, migration plan corrections, and a suggested work order that puts the
wipe-class fix (serialization shim + per-record saves + atomic import)
first.

One question before you plan next session: do the Phase 2 deliverables
(`validateImportFile()`, `test-imports/`) exist somewhere outside these
zips, or were they never built? That determines whether Phase 2 needs
reopening.


**Scope:** All files in `src.zip` and `src-tauri.zip`,
`tauri-migration-plan.md`, onboarding doc.  **Version reviewed:** 0.7.0
(per Cargo.toml)

Severity: **C** = Critical (data loss / broken persistence), **H** = High
(broken feature or security), **M** = Medium, **L** = Low.

---

## Critical — Tauri data integrity

### C1. JS↔Rust serialization mismatches cause save failures — and the clear-then-rewrite pattern turns them into table wipes

`saveData()`, `saveReadingListData()`, and `saveMyLibraryData()` all do
`clear()` then `putBulk()`. In Tauri, `putBulk` args are deserialized into
typed Rust structs **before the command runs**. If deserialization fails,
the invoke rejects — but the `clear` command already committed. Result:
**empty table, in-memory data only, silent loss on restart.** The specific
mismatches:

- **C1a — Pages is a string from forms.** `enterReadBook`,
  `saveEditReadBook`, and `addToMyLibrary` store `Pages` as the raw
  FormData/input string (`"320"` or `""`). Rust expects
  `Option<i64>`. serde_json does not coerce strings to integers, so the
  entire `Vec<BookRead>` (or `Vec<LibraryBook>`) fails to deserialize. Only
  `importUnifiedDatabase()` normalizes Pages with `parseInt` — the CRUD
  paths do not.
- **C1b — My Library Tags are arrays in memory.** `loadMyLibraryData()`
  parses Tags into arrays; `LibraryBook.tags` is `Option<String>`. Every
  `saveMyLibraryData()` call in Tauri (edit, checkout, check-in, tag
  rename/delete, CSV import) sends arrays and should fail
  deserialization. Restore works only because `importUnifiedDatabase()`
  stringifies Tags before writing.
- **C1c — Finished is a required `String` in `BookRead`.** A legacy backup
  record with no `Finished` field fails deserialization of the whole import
  batch. Your Phase 2 rules explicitly require "optional fields absent →
  null, never error."
- **C1d — Errors are invisible.** `saveData()` is called without `await` or
  `.catch()` from `enterReadBook`, `deleteReadBookById`, etc. A rejected
  save is an unhandled promise rejection; the UI shows "Book added
  successfully."

**Fix direction (discuss before coding):** add a serialization shim inside
`db-manager-tauri.js` — one place that coerces Pages to int-or-null,
stringifies Tags, defaults Finished to `''` — so app code stays
unchanged. Await and surface save errors via `showMessage`. Verify with:
*in Tauri, add a book via the form (Pages filled), restart, confirm it
survived.*

### C2. Rust `ReadingListItem` silently drops `Source` and `IsCheckedOut`

The struct has no fields for them and the table has no columns. In Tauri
they vanish on the first save: after restart, every item renders "Source:
undefined", the checked-out styling disappears, and
`checkInMyLibraryBook`'s `item.IsCheckedOut` match fails. In web mode
(IndexedDB is schemaless) they persist — so the two backends diverge. This
violates "never silently drop data."

**Fix direction:** add `source` and `is_checked_out` columns via a schema
v2 migration + struct fields, or fold them into an extras JSON column.

### C3. Dashboard reorder in Tauri destroys all settings

`saveDashboardOrder()` writes a settings-store row with `id:
'dashboard-order'`, but `DBManagerTauri._settings.put()` ignores `row.id`
and Rust `save_settings` always writes the `'app-settings'` key. So
dragging a dashboard card **replaces your entire settings JSON (theme,
categories, backup folder, daily pages) with the card-order array.** Also,
`loadDashboardOrder()` can never find `'dashboard-order'` in Tauri
(`_settings.getAll` returns only the app-settings row), so card order never
restores.

**Fix direction:** store `dashboardCardOrder` as a key inside the
app-settings object instead of a separate row (works identically in both
backends).

### C4. Empty-array guards block legitimate deletes and clears

- `clearAllMyLibraryBooks()` sets `myLibrary = []` then calls
  `saveMyLibraryData()`, which skips on empty — **Clear All never
  persists.** Books reappear on reload.
- Deleting the *last* remaining book in any collection never persists for
  the same reason.

**Fix direction:** give the destructive paths an explicit intentional-clear
route (e.g., call `DBManager.clear()` directly) instead of routing through
the guarded bulk save.

### C5. Editing a Books Read entry silently drops non-form fields

`saveEditReadBook()` rebuilds the book as `{ id }` plus form fields
only. Any field not in the edit form — `Rating`, `CoverUrl`, `DateAdded`,
`Modified`, `Tags`, `ISBN13`, anything from an import — is discarded on
every edit. Fix: start from `{ ...books[bookIndex] }` and overlay form
values.

### C6. Root architecture: clear+rewrite on every save

Beyond C1, rewriting the whole table on every single add/edit/delete is (a)
the enabler of the hot-reload wipe risk, (b) O(n) writes per
keystroke-level change, and (c) non-atomic across the clear/put
boundary. Per-record functions already exist (`saveBook`, `deleteBook`,
`saveReadingListItem`, ...) but are unused by the UI paths. Recommend
migrating UI operations to per-record put/delete, keeping bulk rewrite only
for import — and making import atomic with a single Rust command per table
(`replace_all_books_read`: DELETE + INSERT in one transaction) so a failed
import can't leave an empty table.

---

## High

### H1. Dashboard "This Year" stats are broken

`dashboard.js` lines 10 and 116: `book.Finished.split('-')[2]` — for
`YYYY-MM-DD` that's the **day**, not the year. "This Year" count, pages,
and the reading-goal chart's actual-pages all compute to
zero. `statistics.js` already has the correct dual-format logic
(`parts[0].length === 4 ? parts[0] : parts[2]`) — reuse it.

### H2. Restore leaves in-memory My Library Tags as JSON strings

`importUnifiedDatabase()` assigns `myLibrary = prepared` where Tags were
stringified for storage. Until reload: tag quick-search fails, and editing
a book pushes `''` through `tagsToString` → **tags lost on first
post-restore edit.** Fix: after import, re-run
`loadData()`/`loadReadingListData()`/`loadMyLibraryData()` (and re-render
reading list + library, not just books/dashboard).

### H3. Import doesn't convert legacy `DD-MMM-YYYY` dates

Phase 2 rules require conversion on import; `importUnifiedDatabase()` never
touches `Finished`. Legacy dates land raw in SQLite, breaking the `ORDER BY
finished DESC` in Rust and the schema contract. (The onboarding note "all
legacy dates converted" covered the existing DB, not future imports.)

### H4. Recommend filter can never match

`applyCurrentFilters` equals: `fieldValue === filter.values[0]` compares
integer `1`/`0` to string `"1"`/`"0"` — always false. And
`book[filter.field] || ''` coerces `Recommend: 0` to `''`, so "Is Empty"
wrongly matches every N book.

### H5. Unescaped `innerHTML` throughout (~50 sites)

Titles, authors, tags, categories, patrons are interpolated into
`innerHTML` and into inline `onclick='...('${value}')'` attributes across
read-books, reading-list, my-library, tags, category-management, restore. A
title containing `&`, `<`, `"` or `'` breaks rendering or the onclick
handlers at minimum; imported/API data could inject script — and with
`"csp": null` in `tauri.conf.json`, injected script has `invoke()` access
to the whole DB. Fix: one `escapeHtml()` helper applied at render sites,
replace inline-onclick string interpolation with `data-id` attributes +
event delegation, and set a basic CSP.

### H6. Bulk ISBN lookup matches by Title+Author, not id

`bulkISBNLookupGeneric` finds the target with `findIndex` on Title+Author —
with multiple reads of the same book it always updates the first
occurrence. The id is already on `bookWithoutISBN`; use it.

---

## Medium

- **M1. Duplicate function definitions.** `migrateReadingListItems` and
  `migrateMyLibraryItems` exist in both `data-manager.js` and
  `reading-list.js`/`my-library.js`; script order means the data-manager
  copies are dead. Keep one.
- **M2. Drag-and-drop listener accumulation.** `initializeDragAndDrop()`
  adds four listeners to `readingListContainer` on **every** render; they
  stack for the life of the page (leak + duplicate handler executions). Add
  once (init flag) or use `{ once: false }` with removal.
- **M3. CheckedOutDate format inconsistency.** Checkout stores
  `YYYY-MM-DD`; the edit modal displays it raw in an MM/DD/YYYY-validated
  input (blur validation will clear it) and saves whatever's typed without
  `dateToStorage()`. Route through `dateFromStorage`/`dateToStorage`.
- **M4. `populateFinishedBookForm` sets `finished` to `YYYY-MM-DD`** in the
  MM/DD/YYYY input — blur validation wipes it if the field is touched. Use
  `dateFromStorage(today)`.
- **M5. Author concatenation dangles commas.** `` `${surname},
  ${given}`.trim() `` produces `"Twain,"` or `", Mark"` when one part is
  empty. (Relevant to your upcoming Author2 work — worth fixing the helper
  once and reusing it.)
- **M6. `importUnifiedDatabase` writes `localStorage.selectedTheme`** —
  reintroducing a key the migration removed — and calls `loadTheme()`
  un-awaited. Drop both; the settings save covers it.
- **M7. `console.trace()` ×2 left in `saveData()`** — a known past failure
  class.
- **M8. Tag regex `^[a-z0-9]+$` forbids hyphens** — your own schema
  comments use `"sci-fi"` as the example tag.
- **M9. Rust structs silently drop unknown JSON fields** on save (serde
  default). For the Tauri path, that *is* the silent-drop mechanism behind
  C2. Decide a policy: extras column, explicit columns, or documented
  whitelist with a load-time warning.
- **M10. Missing 90% guard on reading list / library saves.** The
  onboarding claims all three have it; only `saveData()` does.
- **M11. Version skew.** `tauri.conf.json` = 0.1.0, `Cargo.toml` = 0.7.0,
  `constants.js` = '0.7'. Exported backups record `appVersion:
  0.7`. Single-source or at least sync at release time.
- **M12. Books Read table shows raw `YYYY-MM-DD`** while entry/edit use
  MM/DD/YYYY. Pick one display format (`dateFromStorage` in
  `createReadBookRow`).
- **M13. Dead code: dashboard `setTimeout` reads `dailyReadingPages` from
  localStorage** (migrated away) — that chart re-render branch never
  fires. `renderReadingGoals()` already handles it from the DB.
- **M14. `window.onclick` assignment in read-books.js** — a second
  assignment anywhere would clobber the export-dropdown close behavior. Use
  `addEventListener`.

## Low

- **L1.** `lookupBookISBNGeneric`: no null check on `book` before
  `book.Title` (throws if id not found).
- **L2.** Duplicate `case 'gte':` in `updateFilterValue` switch.
- **L3.** Duplicated comment line in `enterReadBook`.
- **L4.** `DBManagerTauri.get()` fetches all rows to find one — fine for
  settings, but a per-id Rust query would be cleaner if usage grows.
- **L5.** Window size 1700×1700 — taller than 1080p/1440p displays; the
  window will be clipped on most monitors.
- **L6.** `frontendDist: "../src"` bundles `utilities/*.py` into the
  app. Move utilities out of `src/` or exclude.
- **L7.** `fs` capability grants `$HOME/**` write. Acceptable for a
  personal app; could be narrowed to the backup folder's parent scope
  later.
- **L8.** `restore.js` interpolates the uploaded filename into `innerHTML`
  (same class as H5, lower exposure).
- **L9.** Native `prompt()`/`confirm()` for rename/delete flows — works,
  but inconsistent with your modal patterns and historically quirky on
  WebKitGTK. Candidate for the ongoing UI tweaks pass.

## Memory / performance notes

Chart.js cleanup is done correctly (getChart + destroy
everywhere). Dashboard drag-drop uses property assignment (no
accumulation). The two real items are **M2** (reading-list listener
accumulation) and **C6** (full-table rewrite per edit — the dominant
inefficiency; per-record ops fix perf and safety together). Rust side is
clean: single `Mutex<Connection>`, prepared statements inside transactions
for bulk ops.

## Web/Tauri divergences to be aware of

| Behavior | Web (IndexedDB) | Tauri (SQLite) |
|---|---|---|
| Pages as string | stored as-is | deserialization failure (C1a) |
| My Library Tags | stored as array | requires JSON string (C1b) |
| Source / IsCheckedOut | persisted | dropped (C2) |
| Unknown fields | persisted | dropped (M9) |
| dashboard-order row | separate settings row, works | clobbers app-settings (C3) |

The adapter promises "same interface, same behavior" — these are the places
it currently lies.

---

# Migration plan corrections

1. **Unresolved git merge conflict** in Phase 4's schema section (`<<<<<<<
   Updated upstream` / `=======` / `>>>>>>> Stashed changes`). The "Stashed
   changes" side is the obsolete pre-migration schema — delete it, keep the
   upstream block, remove the markers.
2. **Phase 2 marked complete, but deliverables are absent from the
   source:** no `validateImportFile()` in any JS file, no `test-imports/`
   folder, no `IMPORT-TEST-CASES.md`. Phase 6 task 2 depends on
   `validateImportFile()`. Either these live outside the zips (confirm), or
   Phase 2 should be reopened — the C1/H3 findings are exactly what that
   test suite exists to catch.
3. **Phase 5 acceptance criteria ("All CRUD operations work correctly in
   Tauri") appear unmet** given C1–C4. Suggest inserting a "Phase 5.5 —
   Tauri persistence hardening" covering the serialization shim, per-record
   saves, atomic import commands, and the Source/IsCheckedOut columns,
   gated by the Phase 2 test protocol.
4. **Phase 9 should be marked Dropped** in the plan (it still reads as
   "Future"), consistent with the status table and your decision. Also its
   note "adding a `modified` column is the only schema change needed" is
   stale — `modified` already exists in schema v1.
5. **Target directory structure is stale:** lists `config.js` (actual file
   is `constants.js`) and themes `dark.css`/`light.css` (actual:
   `nordic-dark.css`, `nordic-light.css`, `matrix.css`).
6. **Dependency table lists zxing as "Phase 7"** — the scanner is Phase 8.
7. **Onboarding doc corrections:** replace `config.js` references with
   `constants.js`; remove/amend the claim that the 90% guard exists on
   `saveReadingListData()`/`saveMyLibraryData()` (M10); note that Tags
   parsing happens on *load* but not after *import* (H2).

---

# Suggested work order

1. **C1 + C6 together** — serialization shim in `db-manager-tauri.js`,
   per-record saves for UI ops, atomic replace-all Rust commands for
   import. This closes the wipe class permanently.
2. **C3** — move dashboard order into app-settings (small, high damage
   potential until fixed).
3. **C4, C5** — delete/clear persistence and edit field preservation.
4. **H1–H4** — dashboard year parsing, post-restore reload, import date
   conversion, Recommend filter.
5. **H5** — escapeHtml pass + CSP (mechanical but touches many render
   sites; good candidate for one file at a time).
6. **Plan/doc corrections** (item list above) — cheap, do alongside.
7. Mediums/Lows opportunistically; M5 (author helper) is worth doing
   *before* the Author2 work since that feature touches the same code.

Then Author2 fields land on a stable foundation.
