# Scriptum — Tauri Migration Implementation Plan

**Version:** 1.1 **Date:** 2026-06-23 **Scope:** Electron → Tauri v2,
localStorage → SQLite/IndexedDB, cross-platform (Windows, Linux,
macOS, Android)

**NOTE:** The schema listed in this document may be in error. Always
use the actual schema as the source of truth.

---

## Guiding Principles

- Full web functionality preserved — the app runs in any browser
  without Tauri
- Single codebase targets browser, Windows, Linux, macOS, and Android
- SQLite schema is designed from day one for future Cloudflare D1 sync
- All book records use UUID primary keys (already in place) to support
  multi-device sync without autoincrement conflicts
- Astryx patterns are followed directly wherever applicable — no
  reinventing the wheel
- Each phase is independently testable and releasable
- **Existing backups must import without data loss or error** —
  backward compatibility with all prior Scriptum export files is
  non-negotiable and must be verified before any release

---

## Directory Structure (Target)

```
scriptum/
├── src/
│   ├── css/
│   │   ├── base.css
│   │   └── themes/
│   │       ├── dark.css
│   │       ├── light.css
│   │       └── matrix.css
│   ├── include/                        ← NEW: all third-party libraries
│   │   ├── chart.min.js
│   │   ├── pako.min.js
│   │   └── [other vendor libs]
│   ├── js/
│   │   ├── core.js
│   │   ├── config.js
│   │   ├── data-manager.js
│   │   ├── db-manager.js              ← NEW: runtime backend selector
│   │   ├── db-manager-web.js          ← NEW: IndexedDB backend
│   │   ├── db-manager-tauri.js        ← NEW: Tauri invoke backend
│   │   └── [other app JS files]
│   └── index.html
└── src-tauri/
    ├── src/
    │   ├── main.rs
    │   ├── lib.rs
    │   ├── constants.rs               ← NEW: app-wide Rust constants
    │   ├── commands/
    │   │   ├── mod.rs
    │   │   ├── books_read.rs
    │   │   ├── reading_list.rs
    │   │   ├── my_library.rs
    │   │   └── settings.rs
    │   └── db/
    │       ├── mod.rs
    │       ├── schema.rs
    │       └── migrations.rs
    ├── Cargo.toml
    ├── tauri.conf.json
    └── icons/
```

---

## Phase 1 — Project Restructure and Library Organisation

**Goal:** Clean up the source tree before any migration work
begins. No functional changes.

### Tasks

1. **Create `src/include/` folder** and move all third-party vendor
   libraries into it:

   - `chart.min.js`
   - `pako.min.js`
   - Any other vendor/library files currently in `src/` or `src/js/`

2. **Update `index.html`** script tags to reference the new `include/`
   paths:

   ```html
   <!-- Before -->
   <script src="chart.min.js"></script>
   <!-- After -->
   <script src="include/chart.min.js"></script>
   ```

3. **Move JS files into `src/js/`** if not already there, updating all
   references in `index.html`.

4. **Verify the web app still runs correctly** in a browser after the
   path changes.

### Acceptance Criteria

- App loads and functions identically in a browser
- No JS console errors related to missing files
- All vendor libraries load from `src/include/`

---

## Phase 2 — Backup Format Audit and Compatibility Test Suite

**Goal:** Before touching any data layer code, fully document the
existing backup format and build a test suite that proves import
fidelity. This suite runs against every subsequent phase and must pass
before any phase is considered complete.

### Background

Users have existing `.json` backup files exported from the current
Electron/localStorage version of Scriptum. These files must import
correctly into every future version without data loss, field
truncation, silent type coercion, or error. This phase establishes the
ground truth for what "correct" means.

### Tasks

1. **Collect representative backup samples** covering edge cases:

   - Books with all fields populated (Title, Author, Pages, Category,
     Recommend, ISBN, Comments, Finished date)
   - Books with only required fields (Title, Author) and all optional
     fields absent or null
   - Books with missing `id` field (pre-migration records that never
     received a UUID)
   - Books with dates in `DD-MMM-YYYY` format (legacy storage format)
   - Books with dates in `YYYY-MM-DD` format (if any exist)
   - ReadingList items with and without optional fields
   - MyLibrary books with Tags arrays (single tag, multiple tags,
     empty array, missing Tags field)
   - MyLibrary books with Bookshelf field populated
   - Settings section present and absent
   - Header section present and absent (older exports may lack it)
   - Completely empty collections (`"BooksRead": []`)
   - Very large libraries (stress test — 500+ books)

2. **Document the canonical backup schema** — produce a written
   field-by-field specification of what the current export JSON
   contains, including:

   - All known field names and their types
   - Which fields are required vs optional
   - All observed date formats
   - The complete top-level structure (`Header`, `BooksRead`,
     `BooksReadInfo`, `ReadingList`, `ReadingListInfo`, `MyLibrary`,
     `MyLibraryInfo`, `TagsMetadata`, `Settings`)

3. **Define import rules** for every field and edge case:

   - Missing `id` → generate a new UUID on import
   - `DD-MMM-YYYY` date → convert to `YYYY-MM-DD` on import
   - `null` or missing optional fields → store as `null`, never error
   - Unknown top-level keys (future-proofing) → silently ignore, never
     error
   - Duplicate `id` values within the same import file →
     last-write-wins
   - `Tags` field missing entirely → treat as empty array `[]`
   - `Pages` as string vs integer → normalise to integer, treat
     non-numeric as `null`

4. **Create `test-imports/` folder** in the repo containing:

   - A set of representative sample backup files covering the cases
     above
   - A `IMPORT-TEST-CASES.md` documenting what each file tests and
     what the expected outcome is

5. **Write an import validator function** `validateImportFile(data)`
   in JS that:

   - Confirms the file is valid JSON
   - Confirms at least one of `BooksRead`, `ReadingList`, or
     `MyLibrary` is present
   - Reports (but does not block on) unexpected or missing fields
   - Returns a structured result: `{ valid, warnings[], errors[],
     counts: { booksRead, readingList, myLibrary } }`
   - Is used by the import UI to show the user a pre-import summary
     before committing

6. **Manual regression test protocol** — a written checklist to run
   after every phase:

   - Import each sample file from `test-imports/`
   - Verify record counts match expected values
   - Verify a spot-check of field values on known records
   - Verify no console errors during import
   - Verify export of the just-imported data round-trips cleanly back
     to equivalent JSON

### Acceptance Criteria

- All edge case backup files import without error or data loss
- `validateImportFile()` correctly identifies valid and invalid files
- Import test protocol is documented and executable in under 10
  minutes
- **No phase beyond Phase 2 is considered complete without passing the
  full import test protocol**

---

## Phase 3 — Data Layer Replacement (localStorage → IndexedDB)

> Import test protocol from Phase 2 must pass before this phase is
> complete.

**Goal:** Replace `localStorage` with IndexedDB using the same
three-file adapter pattern from Astryx. The Tauri backend is not wired
up yet — this phase targets the web version only.

### Background

Scriptum currently stores all data as a single JSON blob in
`localStorage` under the key `booksData`. This works but has a 5–10MB
browser limit and does not map cleanly to SQLite. This phase
introduces a proper store-per-collection architecture using IndexedDB,
matching the Astryx pattern exactly.

### Data Model

Three collections, each becoming an IndexedDB object store and later a
SQLite table:

| Store Name | Key | Description |
| ------------- | ---- | ------------------------------- |
| `booksRead` | `id` | Finished books |
| `readingList` | `id` | To-read list |
| `myLibrary` | `id` | Full personal library with tags |
| `settings` | `id` | App settings as JSON blob |

### Tasks

1. **Create `db-manager.js`** — runtime backend selector:

   ```js
   const DBManager = typeof window.__TAURI__ !== 'undefined'
       ? DBManagerTauri
       : DBManagerWeb;
   ```

2. **Create `db-manager-web.js`** — IndexedDB backend implementing:

   - `init()` — open/upgrade IndexedDB
   - `get(storeName, key)`
   - `getAll(storeName)`
   - `put(storeName, data)`
   - `delete(storeName, key)`
   - `clear(storeName)`
   - `putBulk(storeName, items)`
   - `close()`

3. **Create `db-manager-tauri.js`** — stub file for now, Tauri backend
   wired in Phase 4. Contains `DBManagerTauri` with the same interface
   but all methods throwing `not yet implemented`.

4. **Rewrite `data-manager.js`** to use `DBManager` instead of
   `localStorage`:

   - `loadData()` → `await DBManager.getAll('booksRead')`
   - `saveData()` → `await DBManager.put('booksRead', book)`
   - `loadReadingListData()` / `saveReadingListData()` → equivalent
     calls
   - `loadMyLibraryData()` / `saveMyLibraryData()` → equivalent calls
   - Settings → `DBManager.get/put('settings', ...)`

5. **One-time migration on first run** — detect existing
   `localStorage` `booksData` key, import into IndexedDB, then clear
   localStorage:

   ```js
   async function migrateFromLocalStorage() {
       const legacy = localStorage.getItem('booksData');
       if (!legacy) return;
       const data = JSON.parse(legacy);
       if (data.BooksRead)   await DBManager.putBulk('booksRead', data.BooksRead);
       if (data.ReadingList) await DBManager.putBulk('readingList', data.ReadingList);
       if (data.MyLibrary)   await DBManager.putBulk('myLibrary', data.MyLibrary);
       // Migrate settings
       if (data.Settings) {
           await DBManager.put('settings', { id: 'app-settings', data: data.Settings });
       }
       localStorage.removeItem('booksData');
   }
   ```

6. **Date normalisation** — convert `DD-MMM-YYYY` to `YYYY-MM-DD`
   during migration. The existing `dateFromStorage()` /
   `dateToStorage()` functions in `core.js` handle this conversion and
   remain in place for display purposes.

7. **Update `core.js` `window.onload`** to `await DBManager.init()`
   before loading data.

8. **Update `config.js`** to add store name constants:

   ```js
   STORES: {
       BOOKS_READ:   'booksRead',
       READING_LIST: 'readingList',
       MY_LIBRARY:   'myLibrary',
       SETTINGS:     'settings'
   }
   ```

### Acceptance Criteria

- App loads correctly in a browser with no localStorage dependency
- Existing data migrates automatically and transparently on first load
- All CRUD operations (add book, edit, delete, move between lists)
  work correctly
- Export/import produces the same JSON structure as before
- No data loss on repeated loads

---

## Phase 4 — Tauri Project Scaffold

> Import test protocol from Phase 2 must pass before this phase is
> complete.

**Goal:** Set up the Tauri v2 project structure with SQLite, modelled
directly on Astryx.

### Tasks

1. **Initialise Tauri v2 project** in `src-tauri/` with `tauri init`.

2. **Create `Cargo.toml`** modelled on Astryx:

   ```toml
   [dependencies]
   rusqlite    = { version = "0.32", features = ["bundled"] }
   serde       = { version = "1.0", features = ["derive"] }
   serde_json  = "1.0"
   dirs-next   = "2"
   log         = "0.4"
   tauri       = { version = "2", features = [] }
   tauri-plugin-dialog = "2"
   tauri-plugin-fs     = "2"
   tauri-plugin-log    = "2"
   tauri-plugin-shell  = "2"
   ```

3. **Create `constants.rs`** — all app-wide Rust constants in one
   place:

   ```rust
   // src-tauri/src/constants.rs
   pub const APP_NAME:             &str = "Scriptum";
   pub const DB_FILE_NAME:         &str = "scriptum.db";
   pub const CURRENT_SCHEMA_VERSION: u32 = 1;
   // Date format used in storage
   pub const DATE_FORMAT:          &str = "%Y-%m-%d";
   ```

   Import with `use crate::constants::*;` wherever needed.

4. **Create `db/schema.rs`** — all `CREATE TABLE IF NOT EXISTS`
   statements:

   ```sql
   -- books_read
   CREATE TABLE IF NOT EXISTS books_read (
    id          TEXT PRIMARY KEY,
    title       TEXT NOT NULL,
    author      TEXT NOT NULL,
    author2     TEXT,
    pages       INTEGER,
    category    TEXT,
    recommend   INTEGER,              -- 0/1 boolean
    isbn        TEXT,
    comments    TEXT,
    tags            TEXT,           -- JSON array e.g. '["fiction","sci-fi"]'
    finished    TEXT NOT NULL,        -- YYYY-MM-DD
    rating      INTEGER,              -- 1-10
    cover_url   TEXT,
    date_added  TEXT,                 -- YYYY-MM-DD
    modified    TEXT                  -- YYYY-MM-DD
    );

   -- reading_list
   CREATE TABLE IF NOT EXISTS reading_list (
    id           TEXT PRIMARY KEY,
    title        TEXT NOT NULL,
    author       TEXT NOT NULL,
    author2      TEXT,
    pages        INTEGER,
    category     TEXT,
    isbn         TEXT,
    comments     TEXT,
    tags         TEXT,
    rank         INTEGER,
    my_library_id TEXT,
    date_added   TEXT,
    modified     TEXT
    );

   -- my_library
   CREATE TABLE IF NOT EXISTS my_library (
    id           TEXT PRIMARY KEY,
    title        TEXT NOT NULL,
    author       TEXT NOT NULL,
    author2      TEXT,
    pages        INTEGER,
    category     TEXT,
    isbn         TEXT,
    comments     TEXT,
    tags         TEXT,
    location     TEXT,
    patron       TEXT,
    checked_out  TEXT,
    date_added   TEXT,
    modified     TEXT
    );

   -- settings: JSON blob store, keyed by id
   -- 'app-settings' row holds all settings as JSON
   CREATE TABLE IF NOT EXISTS settings (
       id          TEXT PRIMARY KEY,
       data        TEXT NOT NULL
   );
   ```

5. **Create `db/migrations.rs`** — same `PRAGMA user_version` runner
   as Astryx, migration v1 creates all four tables.

6. **Create `db/mod.rs`** — `open_db()` with WAL mode, foreign keys,
   synchronous=NORMAL, same as Astryx. Database file stored in OS app
   data dir under `Scriptum/`.

7. **Create `main.rs`** — identical to Astryx's `main.rs`.

8. **Create `lib.rs`** — `ScriptumState` holding `Mutex<Connection>`,
   plugin registration, command handler registration (populated in
   Phase 4).

9. **Create `tauri.conf.json`** — product name Scriptum,
   `frontendDist` pointing to `../src`, Android target enabled.

### Acceptance Criteria

- `cargo build` succeeds
- `tauri dev` opens the web app in a Tauri window
- SQLite database file is created at the correct OS path on first
  launch
- Schema migrations run cleanly

---

## Phase 5 — Rust Commands and Tauri Backend Wiring

> Import test protocol from Phase 2 must pass before this phase is
> complete.

**Goal:** Implement all Rust `#[tauri::command]` handlers and wire up
`db-manager-tauri.js` to replace the Phase 2 stubs.

### Commands (per module)

**`commands/settings.rs`**

- `get_settings` → returns settings JSON string or null
- `save_settings(data: String)` → upserts `app-settings` row

**`commands/books_read.rs`**

- `get_all_books_read` → `Vec<Book>`
- `save_book_read(book: Book)` → INSERT OR REPLACE
- `delete_book_read(id: String)`
- `save_books_read_bulk(books: Vec<Book>)`

**`commands/reading_list.rs`**

- `get_all_reading_list` → `Vec<ReadingListItem>`
- `save_reading_list_item(item: ReadingListItem)` → INSERT OR REPLACE
- `delete_reading_list_item(id: String)`
- `save_reading_list_bulk(items: Vec<ReadingListItem>)`

**`commands/my_library.rs`**

- `get_all_my_library` → `Vec<LibraryBook>`
- `save_library_book(book: LibraryBook)` → INSERT OR REPLACE
- `delete_library_book(id: String)`
- `save_library_bulk(books: Vec<LibraryBook>)`

### Tasks

1. **Implement all command modules** above with `#[tauri::command]`
   and `#[tauri::State]` access to `ScriptumState`.

2. **Register all commands** in `lib.rs` `invoke_handler`.

3. **Implement `db-manager-tauri.js`** fully — replace Phase 2 stubs
   with real `invoke()` calls, one handler object per store, following
   the Astryx `_getHandler()` / per-store handler pattern exactly.

4. **Wire up the `invoke` helper** at the bottom of
   `db-manager-tauri.js`:

   ```js
   function invoke(command, args = {}) {
       return window.__TAURI__.core.invoke(command, args);
   }
   ```

5. **Test all data paths** in Tauri desktop mode:

   - Add / edit / delete in each collection
   - Settings save and reload
   - Export produces correct JSON
   - Import round-trips correctly

### Acceptance Criteria

- All CRUD operations work correctly in Tauri desktop build
- Web build (IndexedDB) continues to work unchanged
- Data persists across app restarts in Tauri
- No regressions in export/import

---

## Phase 6 — Export / Import and Backup

> Import test protocol from Phase 2 must pass before this phase is
> complete.

**Goal:** Restore full export/import functionality, now reading from
SQLite/IndexedDB rather than localStorage. This is the most critical
phase for backward compatibility — every existing backup file must
import cleanly.

### Tasks

1. **Update `generateUnifiedDatabase()`** in `data-manager.js` to load
   from `DBManager` rather than in-memory globals, producing the same
   JSON structure as today:

   ```json
   {
     "Header": { "appVersion": "...", "timestamp": "..." },
     "BooksRead": [...],
     "ReadingList": [...],
     "MyLibrary": [...],
     "Settings": { ... }
   }
   ```

   This format is the canonical Scriptum export format and will also
   serve as the D1 sync payload structure.

2. **Update import to use `validateImportFile()`** (from Phase 2)
   before writing any data — show the user a pre-import summary
   (record counts, any warnings) and require confirmation before
   committing.

3. **Implement all import rules** defined in Phase 2:

   - Generate UUID for any record missing `id`
   - Convert `DD-MMM-YYYY` dates to `YYYY-MM-DD`
   - Null-safe handling of all optional fields
   - Graceful ignore of unknown top-level keys
   - Tags missing → empty array

4. **Update import** to call `DBManager.putBulk()` per collection
   rather than writing to localStorage.

5. **Add Tauri-native file save/open dialogs** (via
   `tauri-plugin-dialog`) for export/import when running in Tauri. Web
   build retains the existing download-link / file-input approach.

6. **Implement backup reminder logic** if not already present — track
   last export date in settings.

### Acceptance Criteria

- Export produces valid JSON in both web and Tauri builds, matching
  the canonical format exactly
- Import correctly populates all three collections
- Tauri build uses native file dialogs
- **All sample files from `test-imports/` import without error or data
  loss**
- Import shows pre-import summary before committing
- Export of imported data round-trips cleanly

---

## Phase 7 — Android Build

**Goal:** Get Scriptum running on Android via Tauri v2's mobile
target.

### Tasks

1. **Add Android target** to `tauri.conf.json` and set up Android SDK
   prerequisites.

2. **Audit UI for touch/mobile usability:**

   - Tap target sizes (minimum 44×44px)
   - Scrollable lists on small screens
   - No hover-only interactions

3. **Add camera permission** to Android manifest for future scanner
   feature.

4. **Test all data operations** on Android — SQLite via Tauri behaves
   identically to desktop.

5. **Build and sideload** APK for testing.

### Acceptance Criteria

- App installs and runs on Android
- All CRUD, export, and import operations work
- UI is usable on a phone-sized screen
- Camera permission is declared (scanner not yet implemented)

---

## Phase 8 — ISBN Scanner (Android)

**Goal:** Add barcode/ISBN scanning to the Android build as a
Scriptum-native view, using the device camera to populate book
metadata automatically.

### Tasks

1. **Add ZXing-js** to `src/include/` for barcode decoding from the
   camera feed.

2. **Create scanner view** in `index.html` — camera preview, scan
   result display, book preview card, confirm/cancel actions.

3. **Implement scan flow:**

   - Open camera stream via `getUserMedia()`
   - ZXing-js decodes EAN-13 (ISBN-13) or UPC-A from video frames
   - On decode, fetch metadata from Open Library API:
     `https://openlibrary.org/api/books?bibkeys=ISBN:{isbn}&format=json&jscmd=data`
   - Fall back to Google Books API if Open Library returns no result
   - Display title, author, cover thumbnail, and other available
     fields for confirmation
   - On confirm, insert into selected collection (My Library or
     Reading List) via `DBManager.put()`

4. **Scanner is shown only on Android** — detected via Tauri mobile
   context or screen size heuristic; hidden on desktop.

5. **Rate limiting** — respect Open Library's request guidelines; add
   a 1-second delay between lookups.

### Acceptance Criteria

- Camera opens and decodes barcodes reliably
- Book metadata populates correctly from ISBN
- Confirmed books appear in the selected collection
- Graceful fallback message if ISBN is not found in either API
- Feature is not visible or accessible on desktop builds

---

## Phase 9 — Cloudflare D1 Sync (Future)

**Goal:** Add optional cloud sync across devices using Cloudflare
Workers + D1, gated behind a simple token-based login.

### Scope decision (established)

**Multi-tenant, not single-user.** Originally scoped as single-user
multi-device sync only. Revisited: the design as specced (random token
→ SHA-256 hash → partition key) is inherently capable of hosting
multiple independent users on one shared backend with no architectural
change — only additional discipline in the schema and API layer (see
below). Decision: build it multi-tenant from the start rather than
retrofitting later, since retrofitting means an owner-scoping
migration against live data instead of a clean initial schema.

"Multi-tenant" here means multiple people, each with their own
isolated library, sharing one deployed Workers + D1 backend — not
multiple people collaboratively editing one shared
library. Collaborative/shared-library editing is out of scope and not
addressed by this design.

### Design Decisions (established)

- **Auth:** Single random 256-bit token, **generated client-side via
  `crypto.getRandomValues()`** (or the Rust equivalent when generated
  from the Tauri side), never a user-chosen string or passphrase. This
  is a hard requirement, not a preference: the token is hashed with
  SHA-256 before use as a partition key, and SHA-256 is fast and
  unrateLimitable by design — safe only when the input has full
  256-bit entropy. A human-chosen string collapses that entropy to
  guessable levels and would let anyone precompute hashes of common
  passphrases and query D1 directly for a match, with no login attempt
  to detect or throttle. Token is stored in OS keychain via
  `tauri-plugin-stronghold` on desktop. User pastes it into a
  one-field login screen to link a device to their cloud instance.
- **Self-serve token generation:** a client-side JS tool (likely
  hosted alongside the app download page) generates the random token
  in-browser and displays it once for the user to save (password
  manager, printed, etc.). No server round-trip needed to provision a
  new user — the token isn't "registered" anywhere until its hash
  first appears in a D1 query, at which point that partition is
  implicitly created.
- **Backend:** Cloudflare Workers API layer + D1
  (SQLite-on-the-edge). Schema is identical to local SQLite — no
  translation layer needed.
- **Token handling:** Raw token is never stored server-side. A SHA-256
  hash of the token is used as the D1 partition key (`owner_key`, see
  schema note below).
- **Owner scoping is a server-side-only concern.** The Workers API
  must derive `owner_key` itself from the incoming token on every
  request — never accept an `owner_key` supplied by the client. This
  is the actual isolation boundary between users; a single endpoint
  that trusts a client-supplied owner key defeats the entire
  multi-tenancy model.
- **Sync model:** Last-write-wins per record, keyed by UUID. Suitable
  for multi-device use per user; not a solution for concurrent
  multi-person editing of the same record.
- **Web version:** Uses the same sync API, token stored in IndexedDB
  settings.
- **Why one shared D1 database instead of one database per user:**
  Cloudflare's Workers Free plan caps accounts at 10 D1 databases (500
  MB each, 5 GB total account storage, 100K rows written/day, 5M rows
  read/day — all shared account-wide, resets daily; checked against
  current Cloudflare pricing docs). A database-per-user design hits
  that 10-database ceiling almost immediately. A single shared
  database partitioned by `owner_key` is bounded only by the pooled
  storage/row limits instead, which — given this app's small,
  mostly-text records — comfortably supports a large number of users
  before the free tier becomes a constraint. Revisit if usage ever
  approaches those limits; Workers Paid removes them.

### Schema addition (established)

- Every table (`books_read`, `reading_list`, `my_library`, `settings`)
  gains an `owner_key TEXT NOT NULL` column in the D1 schema (local
  SQLite schema is unaffected — `owner_key` is a D1-only, sync-layer
  concept, not part of the local per-device database). Every D1 query
  — read, write, delete, without exception — must be scoped `WHERE
  owner_key = ?`, with the value derived server-side from the
  authenticated token, never trusted from the request body/params.
- This is in addition to, not instead of, the previously-noted
  `modified TEXT` column needed for last-write-wins conflict
  resolution.

### Tasks (deferred — placeholder)

1. Set up Cloudflare Worker project with D1 binding
2. Design and implement the D1 schema with `owner_key` scoping on
   every table (see Schema addition above) — this is a D1-specific
   schema, distinct from the local SQLite schema
3. Implement token verification middleware in the Workers API: hash
   the incoming token, derive `owner_key`, reject/no-op if missing —
   applied to every endpoint, not opt-in per route
4. Implement sync endpoints: `GET /library`, `POST /library/sync`
5. Build the self-serve token generation tool (client-side JS, random
   token via `crypto.getRandomValues()`, display-once UX)
6. Add sync UI to Scriptum settings — token entry field, sync status,
   last-synced timestamp
7. Implement sync logic in a new `sync-manager.js`
8. Add conflict resolution (last-write-wins by `modified` timestamp —
   add `modified` column to all tables in a new migration)

### Notes

- Adding a `modified TEXT` column to all tables in a migration (Phase
  9, schema v2) is needed for conflict resolution; adding `owner_key
  TEXT NOT NULL` to the D1-side tables only is needed for
  multi-tenancy (see Schema addition above) — two separate additions,
  both required.
- This phase is explicitly deferred until after Android build is
  stable

---

## Dependency Reference

### Rust Crates

| Crate | Version | Purpose |
| --------------------- | ------- | -------------------------------- |
| `rusqlite` | 0.32 | SQLite with bundled amalgamation |
| `serde` | 1.0 | Serialisation |
| `serde_json` | 1.0 | JSON handling |
| `dirs-next` | 2 | OS app data directory |
| `log` | 0.4 | Logging |
| `tauri` | 2 | Core framework |
| `tauri-plugin-dialog` | 2 | Native file dialogs |
| `tauri-plugin-fs` | 2 | Filesystem access |
| `tauri-plugin-log` | 2 | Log output |
| `tauri-plugin-shell` | 2 | External links |

### JS Libraries (src/include/)

| File | Purpose |
| -------------- | ---------------------------- |
| `chart.min.js` | Chart.js — statistics charts |
| `pako.min.js` | Compression — backup/export |
| `zxing.min.js` | Barcode scanning (Phase 7) |

---

## Notes and Constraints

- **Backup compatibility is non-negotiable:** Every existing Scriptum
  export file must import into every future version without data loss
  or error. The Phase 2 test suite is the enforcement mechanism — it
  runs after every phase.
- **Never silently drop data:** If an import file contains a field the
  current code doesn't recognise, log a warning and preserve it if
  possible, but never discard it silently. Unknown top-level keys in
  the export JSON are ignored on import but must not cause errors.
- **Asset reference double-check:** After any file move, verify all
  `<script src="...">` and `<link href="...">` paths in
  `index.html`. The Astryx migration had a `chart_min.js` vs
  `chart.min.js` filename mismatch — worth keeping in mind.
- **`constants.rs` discipline:** Any magic string or numeric constant
  that appears in more than one Rust file goes in `constants.rs`, not
  inline. This includes the DB filename, app name, schema version, and
  date format string.
- **No `tauri-plugin-sql`:** Following Astryx's approach, raw
  `rusqlite` is used directly rather than the higher-level
  plugin. This gives full control over migrations and transaction
  handling.
- **Web build must always work:** After every phase, the web browser
  version is regression-tested before any Tauri work continues.
- **D1 schema compatibility:** Every schema decision made in Phase 4
  onwards should be considered in light of Phase 9. Specifically: UUID
  PKs (already in place), `YYYY-MM-DD` date strings, and JSON arrays
  for tags are all D1-friendly.
