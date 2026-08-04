# Collectyx Development Session Onboarding

**For:** Claude (next session)
**Purpose:** Get up to speed on Stan's project and working style immediately
**Project:** Collectyx — a physical and digital media tracking and library management application, starting with books, extending later to other forms of media
**Current version:** 0.1.0

---

## Who is Stan?

Stan is the sole developer of Collectyx. He is experienced, direct, and efficient. During active development he communicates tersely:

- "proceed" = continue with next change
- "tested" / "done" / "working" = confirmed good
- Detailed only when describing problems

He does not need pleasantries, preamble, or lengthy explanations. Match his energy — be concise and direct.

---

## What is Collectyx?

Collectyx is a browser-based and Tauri desktop media tracking and personal library management tool. Books are the first supported media type; the schema is built to extend to others (DVD/Blu-ray, CD, digital movies, etc.) later without a rework. For books specifically, it allows users to:

- Track books they have read (Books Read)
- Manage a prioritised to-be-read list (To Be Read)
- Catalogue their personal book collection (My Library)
- View statistics and reading goals on a dashboard
- Export/import/backup their data

Architecturally, this is a normalized schema — one canonical `items` table plus three collection-membership tables (`consumed`, `queued`, `owned`) rather than three independent flat tables. Full schema and rationale live in the design document, not here.

**Tech stack:** Vanilla JavaScript, CSS custom properties, IndexedDB (web) / SQLite (Tauri) — no frameworks. Source in `src/` subdirectory. Tauri v2 desktop build in `src-tauri/`.

**Dual-backend architecture:** A JavaScript manager selects the backend at runtime:

- `window.__TAURI__` present → `DBManagerTauri` → SQLite via Rust commands
- Browser → `DBManagerWeb` → IndexedDB

**Project status:** Freshly cloned from Scriptum's repo history; no functional Collectyx code has been written yet. See the phased implementation plan for current phase — starting point is Phase 0 (project identity & scaffold). `withGlobalTauri: true` will be required in `tauri.conf.json` once the Tauri scaffold exists, matching Scriptum's established pattern.

---

## Development Methodology — Read This Carefully

Stan has a well-established working methodology. Violating it causes friction.

### The Rhythm

**Plan → Discuss → Approve → One Change → Test → Confirm → Next**

### Git Patches

With rare exception, code changes are delivered as Git patches and Stan applies them. If, for some reason, a Git patch file cannot be used, use BEFORE/AFTER blocks with full code — no ellipsis, no placeholders, no `// ... existing code ...`. Every block must be complete and match disk exactly. **Always include the filename** above each BEFORE/AFTER pair.

```
**filename.js**

BEFORE:
[exact existing code]

AFTER:
[complete modified code]
```

### Hard Rules

- **Discuss before coding.** Propose the approach, get explicit go-ahead.
- **Never assume file state.** Ask Stan to upload the file before making changes to a file not recently seen.
- **Stop `npx tauri dev` before editing files.** Hot-reload while editing can trigger partial JS execution that clears SQLite tables. This has happened multiple times on Scriptum and the same risk applies here.

---

## Key Architecture Details

**Note:** Some specifics below may shift as Collectyx's actual implementation takes shape — check against the design document and current source rather than assuming this table is still accurate mid-project.

| Concern | Pattern |
|---|---|
| All constants | `CONSTANTS` object in `constants.js` |
| DB backend selector | `db-manager.js` — `DBManager` shim |
| Web persistence | `DBManagerWeb` → IndexedDB (`db-manager-web.js`) |
| Tauri persistence | `DBManagerTauri` → Rust invoke calls (`db-manager-tauri.js`) |
| Data layer | `data-manager.js` — all reads/writes go through `DBManager` |
| Themes | CSS custom properties; 3 themes: Dark (Nordic), Light (Nordic), Matrix |
| Backup | gzip-compressed to a configured backup folder, same pattern as Scriptum's `file.js` |
| Restore | Two-screen confirm modal, same pattern as Scriptum's `restore.js` |
| Tags | Relational — `tags` table + `item_tags` junction table, not a JSON array. Managed via the Tags CRUD view (design doc §4.6). |
| Statistics | Chart.js charts |
| File dialogs | `tauri-plugin-dialog` via `window.__TAURI_PLUGIN_DIALOG__` |
| File writes | `tauri-plugin-fs` via `window.__TAURI_PLUGIN_FS__` |

There is no Category concept anywhere in Collectyx. Tags are the only classification axis — see design doc §2 and §3.2.

**Naming conventions:**

- HTML IDs: kebab-case (new project, no legacy camelCase to carry forward)
- CSS classes: kebab-case
- JS functions/variables: camelCase
- DB stores/tables: camelCase or snake_case per backend convention — `items`, `consumed`, `queued`, `owned`, `tags`, `item_tags`, `media_types`, `settings`
- Rust commands: snake_case, table-scoped (e.g. `get_all_items`, `save_consumed`, `merge_items`)

**JS field names vs SQL columns:**

- JS objects use PascalCase field names (`Title`, `Author`, `Finished`, `Recommend`)
- SQL columns use lowercase (`title`, `author`, `finished`, `recommend`)
- Rust structs bridge these via `#[serde(rename = "Title")]` attributes

---

## Directory Structure

Not yet finalized. Will mirror Scriptum's `src/` + `src-tauri/` split in spirit, but Rust command files and JS data files are restructured around the normalized schema (`items`, `consumed`, `queued`, `owned`, `tags`, `media_types`) rather than Scriptum's three flat-table files. Don't assume a specific filename exists until it's been seen or confirmed this session — this is a standing hard rule, not specific to this doc.

---

## SQLite Schema

See the design document for the full schema, ER diagram, and rationale — not reproduced here.

**Schema version:** 1 (tracked via `PRAGMA user_version`)
**SQLite location:** `~/.local/share/Collectyx/collectyx.db` (Linux)

---

## Known Issues and Gotchas

- **Hot-reload data wipe risk:** If `npx tauri dev` is running when a source file is saved mid-edit, the app can hot-reload with incomplete JS, potentially triggering a destructive write. Always stop the dev server before editing. This has caused real data loss on Scriptum in the past — treat it as an active risk on Collectyx too, not a solved problem.
- **Tauri file dialog** is at `window.__TAURI_PLUGIN_DIALOG__`, not `window.__TAURI__.dialog`.
- **Tauri file system** is at `window.__TAURI_PLUGIN_FS__`, not `window.__TAURI__.fs`.
- **Capabilities file** (`src-tauri/capabilities/default.json`) must explicitly grant permissions for dialog and fs operations, including path scopes.
- **Date format convention** (carried forward from Scriptum, pending confirmation it still applies): stored as `YYYY-MM-DD`, displayed and entered as `MM/DD/YYYY`. Confirm this is still the intended convention before assuming it.

---

## Migration Plan Status

See the phased implementation plan for details.

---

## Open Items / What's Next

See the phased implementation plan for details.

---

## Things Claude Got Wrong (Learn From These)

- Forgot to include filename in BEFORE/AFTER blocks — Stan had to ask repeatedly.
- Generated BEFORE blocks that didn't match disk exactly.
- Used `window.__TAURI__.dialog` instead of `window.__TAURI_PLUGIN_DIALOG__`.
- Missed updating a call site when a previously-synchronous helper became async.
- Added `console.trace()` to a save function without removing it — caused a white page in Tauri due to an unrelated stray backtick introduced during editing.
- Batched multiple file changes without explicit per-file BEFORE/AFTER — caused confusion.
- Generated `mod.rs` with trailing `nn` characters — caused Rust compile errors.

---

## Principles Stan Cares About Most

1. **Patches, or filename-labeled BEFORE/AFTER when a patch isn't possible** — never an unlabeled or partial code block.
2. **Stop dev server before editing** — hot-reload has caused data loss before; treat the risk as live, not historical.
3. **No stale file assumptions** — view or ask for the file before touching it.
4. **Discuss before coding** — always.
5. **Collectyx does not carry Scriptum's forward-compatibility guarantee.** It needs one well-tested, one-time import path for Scriptum backups (phased plan, Phase 6) — not permanent backward compatibility for every future version of its own export format.
6. **Never silently drop data** — unknown or unexpected fields should be logged, not silently discarded, even if the exact mechanism differs from Scriptum's.
7. **Web build must always work** — after every major change, the browser version is regression-tested, not just Tauri.
8. **Clean, simple solutions** — park complexity that isn't worth it.
9. **The design document and phased implementation plan are the source of truth** for schema, view layout, and project status. This onboarding doc covers context and working process — check those documents, not this one, for what's actually being built and where things stand.
