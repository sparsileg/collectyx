# Collectyx — Phased Implementation Plan

**Version:** 1.0
**Companion document:** `collectyx-design.md` — this plan implements that
design; schema, view layouts, and open assumptions are defined there and
referenced by section number below rather than repeated here.
**Scope:** v1 (Books only), desktop (Tauri v2) + web, in a fresh repo
cloned from Scriptum. Scriptum itself is frozen and untouched by any of
this.

---

## Guiding principles

- Collectyx does **not** inherit Scriptum's "every past export must
  import forever" obligation. It needs a one-time Scriptum-import path
  (Phase 6), not permanent backward compatibility.
- **Full user separation** via `owner` on `items`/`tags`/`settings` — no
  shared data across users, even though multi-user sync isn't built yet.
- **No Category anywhere.** Tags are the only classification axis, first
  as a proper `tags`/`item_tags` schema from day one — no JSON-array
  legacy to carry.
- **No automatic ISBN lookup.** The field exists, populated manually or
  by scan only.
- **IndexedDB has no native joins.** This is the single highest
  technical-risk item in the whole plan — the web backend needs a
  hand-rolled join-simulation layer that Scriptum's flat-table schema
  never required. Prototype it before building on top of it (Phase 1).
- **Web and Tauri builds are regression-tested at the end of every
  phase**, not just at the end of the project — same discipline Scriptum
  has followed throughout.

## Working conventions (carried over from Scriptum)

- Patches (unified diffs), verified with `git apply --check` before
  being handed over, not BEFORE/AFTER blocks.
- One combined patch that contains all changes for all files for a given issue.
- No code comments unless something is genuinely complex — one or two
  lines max.
- Commit messages as two separate fenced code blocks (subject, body), no
  "Files changed" section.
- Fresh file uploads before any patch — no reconstructing "current
  state" from memory or from replaying earlier patches.
- **Stop `npx tauri dev` before editing or applying any patch.** Same
  hard rule as Scriptum, unchanged, still the cause of real data loss
  historically when skipped.

---

## Phase 0 — Project identity & scaffold

**Goal:** Collectyx exists as its own correctly-branded project, not a
renamed Scriptum.

### Tasks

1. Rename in `package.json`, `Cargo.toml` `[package].name`,
   `tauri.conf.json` `productName`/`identifier`.
2. `CONSTANTS.APP_NAME = 'Collectyx'` in `constants.js`.
3. New app icons, replacing Scriptum's.
4. Update the Tauri app-data directory name so the SQLite file lands
   under `Collectyx/`, not `Scriptum/`.
5. Review `capabilities/default.json` — confirm the plugin/permission
   list still matches actual needs; trim anything Scriptum-specific.
6. Confirm `cargo build`, `npx tauri dev`, and `npx serve src` all boot
   to an empty shell.

### Acceptance criteria

- `cargo build` succeeds.
- `tauri dev` opens a window titled Collectyx.
- Web build serves at `localhost:3000`.
- No remaining "Scriptum" string anywhere in source (grep clean).

---

## Phase 1 — Schema & data layer foundation (both backends)

**Goal:** implement the normalized schema from the design doc (§3.2) in
SQLite and IndexedDB, including the join-simulation layer IndexedDB
needs.

### Tasks

1. Rust `db/schema.rs` — `CREATE TABLE` for `media_types`, `items`,
   `consumed`, `queued`, `owned`, `tags`, `item_tags`, `settings`, per
   design doc §3.2. Foreign keys enabled, WAL mode, `synchronous=NORMAL`
   (Astryx pattern).
2. Rust `db/migrations.rs` — `PRAGMA user_version` runner; migration v1
   creates all eight tables and seeds the `media_types` row
   `(1, 'Books', 'Books Read', 'To Be Read', 'My Library')`.
3. Rust `constants.rs` — `APP_NAME`, `DB_FILE_NAME = "collectyx.db"`,
   `CURRENT_SCHEMA_VERSION = 1`, `DATE_FORMAT`.
4. **IndexedDB join-simulation spike — do this before building the full
   web data layer on top of it.** Prototype resolving "all `consumed`
   rows with their parent `items` row" and "all `tags` for a given item
   via `item_tags`" entirely in JS, against a small hand-seeded dataset,
   with no real join available. Prove the approach works before
   committing `db-manager-web.js` to it. There's no existing pattern to
   copy here — Scriptum's flat tables never needed this.
5. `db-manager-web.js` — object stores for all eight
   collections/tables (`item_tags` keyed on a compound or synthetic id),
   built on the join-simulation helpers from step 4.
6. `db-manager-tauri.js` — stub methods per table; real `invoke()`
   wiring comes in Phase 2.
7. `db-manager.js` — runtime selector, same pattern as Scriptum.

### Acceptance criteria

- Schema creates cleanly on first launch in both builds.
- The join-simulation helpers return correct results against the
  hand-seeded test dataset.
- Schema version tracked via `PRAGMA user_version`.

---

## Phase 2 — Rust commands & backend wiring

**Goal:** full CRUD for every table, both backends functionally
equivalent.

### Tasks

1. `commands/items.rs`, `consumed.rs`, `queued.rs`, `owned.rs`,
   `tags.rs`, `settings.rs` — `get_all`/`save`/`delete`/`replace_all` per
   table, same atomic-transaction pattern as Scriptum's `replace_all_*`
   commands.
2. Tag assignment (`item_tags` rows) handled inside `items.rs`'s
   attach/detach-tag commands, not as a standalone CRUD surface.
3. `media_types` — read-only `get_all_media_types`; no write path needed
   in v1 (one seeded row).
4. Register all commands in `lib.rs`'s `invoke_handler`.
5. `db-manager-tauri.js` — replace Phase 1 stubs with real `invoke()`
   calls.
6. `merge_items(survivor_id, loser_id, field_resolutions)` — single Rust
   transaction reassigning `consumed`/`queued`/`owned`/`item_tags` rows
   from loser to survivor and deleting the loser, per design doc §3.3.

### Acceptance criteria

- Full CRUD works in the Tauri desktop build for every table.
- `merge_items` correctly reassigns all four related tables in one
  transaction; a failure partway through leaves nothing half-merged.
- Web build (IndexedDB) has equivalent behavior via Phase 1's
  join-simulation layer.

---

## Phase 3 — Sidebar chrome & navigation shell

**Goal:** the sidebar and hamburger menu exist and route between empty
placeholder views.

### Tasks

1. `index.html` — sidebar markup per design doc §4.1: logo, app name,
   hamburger, theme dropdown, font-size stepper (stacked), six nav rows.
2. Nav routing, adapted from Scriptum's `showView()` pattern in
   `core.js`.
3. Hamburger menu — context-aware Global + per-view section per design
   doc §4.2, via a view-name → menu-items lookup.
4. Theme switching — reuse Scriptum's CSS-custom-property theme
   approach; at least one theme ships, others can follow.
5. Font-size stepper — new in Collectyx. Persists to `settings`; applied
   via a root font-size CSS custom property.
6. Placeholder content (heading only) in each of the six views — real
   content arrives in later phases.
7. **Confirm the two open assumptions from design doc §7** (nav labels
   sourced from `media_types`; Settings as a modal) before building
   further on top of them.

### Acceptance criteria

- Every nav item shows its placeholder view and highlights correctly.
- Hamburger menu opens/closes without navigating away from the current
  view.
- Contextual section appears only on Books Read/To Be Read/My Library,
  correctly empty on Dashboard/Tags/Statistics.
- Font-size stepper visibly changes text size and persists across
  reload.

---

## Phase 4 — Shared collection view & Add/Edit modal

**Goal:** build the reusable components once, per design doc §4.4–4.5,
before wiring any real collection to them.

### Tasks

1. Generic list-view component: header (title, search icon, Add
   button), quick search bar, sortable list body — parameterized by
   which store and columns it's displaying.
2. Generic Add/Edit modal: shared fields (Title, Author, Author2, Tags
   chip input) plus a type-specific fields slot each collection
   populates differently.
3. Reuse Scriptum's tag chip-input controller (`tags.js`) largely as-is
   — same interaction pattern, now backed by `tags`/`item_tags` instead
   of a JSON array.
4. Wire modal Save to the appropriate command for whichever collection
   opened it.

### Acceptance criteria

- The component renders, searches, and opens Add/Edit correctly against
  a test dataset.
- Not yet wired to a real nav destination — that's Phase 5.

---

## Phase 5 — Wire the three collection views

**Goal:** Books Read, To Be Read, and My Library fully functional using
the Phase 4 components.

### Tasks

1. Books Read (`consumed`) — list columns Finished/Title/Author/Tags;
   modal type-specific section: Finished date, Rating, Recommend.
2. To Be Read (`queued`) — list columns Rank/Title/Author/Tags; modal
   type-specific section: Rank, Source. Rank insertion/shifting logic
   ported from Scriptum's `reading-list.js`.
3. My Library (`owned`) — list columns Status/Title/Author/Tags; modal
   type-specific section: Location, Patron, Checked-out date.
   Checkout/check-in actions.
4. Contextual hamburger items wired per collection: Export (JSON/CSV),
   Import CSV.
5. Cross-collection "mark finished" action: a `queued` or `owned` item
   can be marked finished, creating a `consumed` row against the *same*
   `item_id` — no re-typing title/author. This is the concrete payoff of
   normalization the design discussion kept coming back to.

### Acceptance criteria

- Full CRUD works end-to-end, both builds, all three collections.
- Marking a queued or owned book finished creates a linked `consumed`
  row rather than a new duplicate item.
- CSV/JSON export and CSV import work per collection.

---

## Phase 6 — Import from Scriptum

**Goal:** get real data into Collectyx as early as practical, so
remaining phases can be dogfooded against it rather than synthetic data.

### Tasks

1. One-time importer: parse a Scriptum backup file (JSON or `.json.gz`).
2. Books Read → `items` + `consumed`, per design doc §5. Reading List
   and My Library sections of the backup are read but not migrated
   (explicitly treated as empty, per design decision).
3. Category → tag: lowercase, create-or-reuse the tag, attach via
   `item_tags`.
4. ISBN carried over as-is, no validation or enrichment attempted.
5. Pre-import summary (counts, warnings) before committing — lighter
   version of Scriptum's restore flow, since this only ever runs once
   per user.
6. A small set of representative Scriptum backup samples for testing —
   not a perpetual suite like Scriptum's own Phase 2, just enough to
   verify this one-time path.

### Acceptance criteria

- A real Scriptum backup imports cleanly; resulting `items`/`consumed`
  rows spot-check correctly against the source.
- Category values appear as tags.
- **Decide and document before building:** does running the importer
  twice on the same file get blocked, or does it create duplicate
  `items` rows that Phase 9's Find Duplicates is expected to clean up?
  Either is acceptable, but pick one deliberately.

---

## Phase 7 — Tags CRUD view

**Goal:** full Tags management per design doc §4.6.

### Tasks

1. List view: name, usage count, sort control (name / count /
   last-updated).
2. Add tag standalone, not only via a book's chip field.
3. Rename — updates `tags.name`; no cascading needed since `item_tags`
   references `tag_id`, not the name itself.
4. Delete, with an optional substitute-tag panel: if chosen, reassign
   that tag's `item_tags` rows to the substitute's `tag_id` before
   deleting; if declined, just delete.

### Acceptance criteria

- All four operations work correctly.
- Sort by last-updated reflects `tags.modified`.
- Deleting with a substitute leaves no book untagged that had only the
  deleted tag.

---

## Phase 8 — Dashboard & Statistics

**Goal:** per design doc §4.3 and §4.8.

### Tasks

1. Six dashboard cards: Quick Stats, Top Tags, Recently Finished,
   Reading Goals, What's Next, My Library Stats. Card drag-reorder
   ported from Scriptum's `dashboard.js`.
2. Top Tags — top N tags by count, N as a named constant, same
   underlying query Statistics also uses.
3. Statistics — totals and yearly chart largely ported as-is; the old
   category bar chart is replaced by a top-tags-by-count chart.

### Acceptance criteria

- All six cards render correct live data.
- Top Tags card and the Statistics chart agree with each other.
- Card reorder persists across reload.

---

## Phase 9 — Find Duplicates / Merge

**Goal:** per design doc §3.3 and §4.7.

### Tasks

1. Duplicate-candidate scan: fuzzy title+author matching, starting from
   Scriptum's `normalizeBookKey()` logic; a matching non-empty ISBN on
   both sides treated as corroborating, never sole, evidence.
2. Candidate list + field-by-field comparison/resolution UI, per design
   doc sketch.
3. Wire to the `merge_items` command from Phase 2 (and its IndexedDB
   equivalent).
4. Reachable from the hamburger's Global section.

### Acceptance criteria

- Running Find Duplicates against a dataset with known duplicates
  (including any produced by Phase 6's import) correctly surfaces them.
- Merging reassigns all related rows and removes the loser cleanly.
- Declining a candidate ("Not a match") leaves both records untouched.

---

## Phase 10 — Settings

**Goal:** per design doc §4.2's flagged assumption (modal, not a full
view) — confirm during Phase 3's review before building this out.

### Tasks

1. Settings modal: backup folder, daily reading goal, and anything not
   already sidebar-resident (theme/font size live in the sidebar
   itself, per §4.1).
2. Explicitly decide whether "daily reading pages" stays as-is for v1
   (book-specific but harmless while Books is the only media type) or
   gets renamed/generalized now.

### Acceptance criteria

- Settings persist correctly per `owner`.
- Backup folder picker works in Tauri; hidden/disabled in the web build,
  same pattern as Scriptum's existing Settings view.

---

## Phase 11 — Backup & restore

**Goal:** Collectyx's own native export/import round-trip — distinct
from Phase 6's one-time Scriptum importer.

### Tasks

1. Define the canonical export format against the normalized schema
   before building anything — this shape is also the future D1
   sync-payload structure, same constraint Scriptum operated under for
   its own export format.
2. Backup Database / Export All Data — same gzip-if-available pattern as
   Scriptum's `file.js`.
3. Restore — same two-screen confirm flow as Scriptum's `restore.js`,
   adapted to the new format.

### Acceptance criteria

- Export/import round-trips cleanly.
- Backup writes to the configured folder in Tauri; falls back to
  browser download on web.

---

## Deferred — explicitly out of scope for this plan

- **Second media type** (DVD/Blu-ray, CD, etc.) — the schema supports it
  (`media_types`, generic membership tables) but none ships in v1.
- **Android build** — same pending phase Scriptum has; revisit once
  desktop/web Collectyx is stable.
- **ISBN barcode scanner** — depends on Android; deferred alongside it.
- **Cloudflare D1 multi-user sync** — the `owner` field exists now
  specifically so this doesn't require a future migration, but no sync
  implementation, auth UI, or server component is part of this plan.

---

## Dependency summary

| Phase | Depends on                     |
| ----- | ------------------------------ |
| 0     | —                              |
| 1     | 0                              |
| 2     | 1                              |
| 3     | 0                              |
| 4     | 2, 3                           |
| 5     | 4                              |
| 6     | 5                              |
| 7     | 2                              |
| 8     | 5, 7                           |
| 9     | 2, 6 (for realistic test data) |
| 10    | 3                              |
| 11    | 2, 10 (backup-folder setting)  |

Phases 3 and 1–2 can proceed in parallel (chrome vs. data layer); 7 and
10 can slot in anytime after their listed dependency without blocking
the main 4→5→6→8→9 spine.

## Testing protocol

- Both web (`npx serve src`) and Tauri (`npx tauri dev`) regression-
  tested before any phase is considered done.
- Stop `npx tauri dev` before any edit or patch — non-negotiable, unchanged
  from Scriptum.
- From Phase 7 onward, prefer testing against the real data imported in
  Phase 6 rather than synthetic rows where practical — it's the first
  point genuine data exists to test against.
