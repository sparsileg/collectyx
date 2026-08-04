# Scriptum — Current UI Inventory

Baseline reference for the v1.0.0 UI/menu-bar redesign. Reflects
`index.html` + JS as of this session. Mark up / correct before we
start making redesign decisions.

---

## 1. Global Chrome (present on every view)

**Header:** App title ("📚 Scriptum") + tagline. Static.

**Nav bar** — 6 buttons, single row, no grouping/overflow handling:
Dashboard | Finished Book | Books Read | To Read | My Library |
Statistics
- `showView()` swaps `.view.active` class, deactivates all nav
  buttons, activates the clicked one.
- Settings is **not** in the nav bar — only reachable via the
  Dashboard's "Settings" Quick Action button.

**Message area** — single-line status bar below nav. Shows most recent
action's result (timestamped). Success/info/error styled by left
border color. Errors auto-dismiss after 5s; success/info persist until
overwritten.

**Modals** (14 total, all `display:none` divs toggled via JS, no
backdrop-click-to-close, no ESC handling observed):
1. Reading List Edit Modal
2. My Library Category-Select Modal (CSV import pre-step)
3. My Library Add Modal
4. My Library Edit Modal
5. My Library Checkout Modal
6. Tag Management Modal
7. Category Management Modal
8. Restore Screen 1 (select file)
9. Restore Screen 2 (confirm)

Books Read Add/Edit are **not** modals — they're full nav views
(`enterFinishedView`, `editView`).

---

## 2. Dashboard View

**Displays** — 6 draggable/reorderable cards in a grid (order
persisted to settings):
| Card | Content |
|---|---|
| Quick Stats | Total books, total pages, this-year books, this-year pages, avg pages/day |
| Quick Actions | 4 buttons (see below) |
| Recently Finished | List of 5 most recent finished books (title + author) |
| Reading Goals | Daily goal display + line chart (goal pace vs. actual, current-day marker) |
| What's Next? | Top 4 reading-list items by rank |
| My Library Stats | Total books, no-category count, no-ISBN count, checked-out count |

**Operations:**
- Drag-and-drop card reordering (persists to
  `settings.dashboardCardOrder`)
- Quick Actions: → Settings, Export All Data (JSON), Backup Database,
  Restore from Backup

**Entry points:** All via the Quick Actions card; card reorder via
drag handles (whole card is draggable).

---

## 3. Finished Book View ("Enter" form)

**Displays:** Single full-page form, no list. Fields: Finished date,
Title*, Given/Surname (Author, required — at least one), Given/Surname
(Author2, optional), Pages, ISBN, Category (select), Recommend (Y/N
select), Tags (chip input w/ autocomplete), Comments (textarea).

**Operations:**
- Submit → `enterReadBook()` — validates author, builds record, saves,
  navigates to Books Read
- Cancel → clears form, clears any pending reading-list-removal flag,
  navigates to Dashboard
- Can arrive pre-populated from Reading List's "Finished" action
  (title/author/pages/category/ISBN carried over; triggers removal
  from Reading List on successful save)

**Entry points:** Nav bar "Finished Book"; Reading List item's
"Finished" button (pre-fills + flags removal).

---

## 4. Books Read View ("Review")

**Displays:**
- Fixed header: title + 🔍 search icon + Export dropdown (▼) + "Lookup
  ISBNs" button
- Filter panel (collapsed by default): quick search box + dynamic
  filter rows + Apply/Clear/Close
- Fixed table header, 6 sortable columns: Finished, Title, Author,
  Pages, Category, Like (Recommend)
- Scrollable table body. Each row: date, title + 📚/❓ ISBN indicator,
  combined author display ("Author & Author2"), pages, category,
  Y/N/blank recommend
- Optional grouped rendering (any column groupable via sort dropdown)
- Optional "Multiple Reads" special view — groups by normalized
  title+author when that filter is active, shows read count per group

**Operations:**
- **Row click** → edit (full-page Edit view)
- **Row right-click** → confirm + single-book ISBN lookup
- **Column header click** → dropdown: Ascending/Descending Sort,
  Ascending/Descending Group
- **Search icon** → toggle filter panel
- **Quick search** → debounced (300ms) full-text search across
  Title/Author/Author2/Category/Comments
- **Advanced filters** — add/remove filter rows; fields: Finished
  (between/isEmpty), Title/Author (contains/isEmpty), Pages
  (lte/gte/isEmpty), Category/Recommend (equals/isEmpty), ISBN
  (contains/isEmpty), Multiple Reads (gte, fixed at 2)
- **Export dropdown** → Save Data (JSON, filtered), Export CSV
  (filtered) — both timestamped, `_filtered` suffix when a filter is
  active
- **Bulk ISBN lookup** → confirms, iterates books without ISBN,
  rate-limited, periodic autosave + status messages
- **Edit view**: full field set (same as Add) pre-populated; Save /
  Cancel / Delete ("Remove from Books Read", with confirm)

**Entry points:** Nav bar "Books Read"; row click/right-click within
the table; header row for sort/group.

---

## 5. To Read View (Reading List)

**Displays:**
- Two-pane layout: Add form (left/top) + list display (right/bottom) —
  not a table, card-list instead
- Add form: Title*, Rank (optional, capped at current-max+1),
  Given/Surname ×2 (Author required, Author2 optional), Source (free
  text)
- List items: drag handle (⋮⋮), rank badge (or "Unranked"), title,
  combined author, source, action buttons

**Operations:**
- Add → validates author + rank bounds, inserts at rank (shifting
  others) or appends unranked
- Per-item actions (delegated click handler): **Finished** (ranked
  items only — pre-fills Finished Book form, flags for removal,
  attempts ISBN/page lookup either from linked My Library record or
  live ISBN API), **Edit** (modal), **Remove** (confirm, shifts ranks)
- **Drag-and-drop reordering** — complex rank-swap/shift logic
  depending on ranked/unranked source and target
- Edit modal: Title, Author ×2 given/surname pairs, Source, Rank (+
  "Unrank" button to clear)

**Entry points:** Nav bar "To Read"; My Library row's "To Read" button
(adds with Source="My Library", linked via `MyLibraryId`, appended at
bottom rank).

---

## 6. My Library View

**Displays:**
- Fixed header: title + 🔍 + Export dropdown + Add Book + Import CSV +
  Lookup ISBNs + **Clear All Books** (danger)
- Filter panel: quick search (supports `#tag` token syntax alongside
  free text) + dynamic filter rows
- Fixed table header, 4 sortable columns + Actions: Title, Author,
  Category, Status
- Scrollable table body. Each row: title + 📚/❓, combined author,
  category, checked-out status ("Available" / "C/O {patron}"), and
  contextual action buttons (**To Read** if not checked out and not
  already on reading list; **C/O** or **C/I** depending on status)
- Optional grouped rendering

**Operations:**
- **Row click** (non-button area) → edit modal
- **Row right-click** → confirm + ISBN lookup
- **Add modal**: Title*, Author ×2 given/surname (required), Category,
  ISBN, Pages, Tags (chip input), Location Type (Bookshelf/Other) →
  conditional Bookshelf select (39 fixed shelf locations) or free-text
  Location field
- **Edit modal**: same fields + Patron + Checked Out Date; **Delete
  Book** (confirm)
- **Checkout modal**: Patron name → sets Patron + today's date as
  CheckedOutDate
- **Check-in** → clears Patron/CheckedOutDate (confirm)
- **To Read** → creates linked Reading List entry (`MyLibraryId` set,
  Source="My Library", appended at bottom rank)
- **CSV Import** — two-step: category-select modal first (single
  default category applied to all imported rows) → file picker →
  parses (custom quote-aware CSV parser), requires
  Title/Author/ISBN/Location headers, optional Pages/Author2/Tags
  columns
- **CSV Export** — Title, Author, Author2, Category, ISBN, Pages,
  Location, Patron, CheckedOutDate, Tags
- **JSON Export** — filtered records + metadata (counts, applied
  filters, quick search)
- **Clear All Books** — confirm, wipes entire collection
- **Bulk ISBN lookup** — same pattern as Books Read
- **Quick search** — free text + `#tag` tokens (AND logic on tags,
  separate from text match)
- **Advanced filters** — fields: Title/Author/Location/Patron
  (contains/isEmpty), Category (equals/isEmpty), CheckedOut (equals:
  Available/Checked Out), ISBN (isEmpty only)

**Entry points:** Nav bar "My Library"; Reading List linkage (My
Library → To Read); Category Management "Edit" links here for category
conflicts.

---

## 7. Statistics View

**Displays:** Two stacked sections:
1. Totals (Books Read, Pages Read) + bar chart, Books by Category
   (excludes empty categories, custom label-on-bar plugin)
2. Yearly Statistics — combo line/bar chart: Books Read (line), Pages
   ÷1000 (line), Recommend:Yes count (bar), gap-filled for years with
   no books

**Operations:** None beyond viewing — no export, no interaction, no
drill-down/click-through from chart to underlying books.

**Entry points:** Nav bar "Statistics" only.

---

## 8. Settings View

**Displays:** Single form.
- Display Theme — 3 buttons (Dark/Light/Matrix), applies immediately
  on click (not gated by Save)
- Daily Reading Pages (number input)
- Backup Folder — text field (readonly) + Browse/Clear buttons; **web
  build hides Browse/Clear and shows "User downloads folder"
  placeholder** (no real picker available)
- Manage Tags / Manage Categories buttons (open modals)
- Save Settings / Reset to Defaults
- Version number footer

**Operations:**
- Save → persists dailyReadingPages + backupFolder, navigates to
  Dashboard
- Reset → clears form fields only (not saved until Save is pressed)
- Theme change → immediate, independent of form Save; re-renders
  Statistics charts live if that view is currently active
- Browse (Tauri only) → native folder picker
- Clear → empties the backup folder field

**Entry points:** Only reachable via Dashboard's Quick Actions
"Settings" button — **not in the main nav bar.**

---

## 9. Tag Management Modal

**Displays:** Flat list of all tags in use across Books Read + My
Library (per `TAGGABLE_COLLECTIONS` registry), each with usage count.

**Operations:**
- Rename (native `prompt()`) — validates, offers
  merge-into-existing-tag if collision, updates across both
  collections
- Delete (confirm) — removes tag from every book in both collections

**Entry points:** Settings → "Manage Tags". Also invoked inline via
the chip-input autocomplete when adding tags on any of the 4
tag-enabled forms (Books Read Add/Edit, My Library Add/Edit).

---

## 10. Category Management Modal

**Displays:** Flat list of all categories (from settings-stored
array), each with usage count across all 3 collections. Add-new row
(text input + Add button) at the bottom.

**Operations:**
- Add — validates non-empty, case-insensitive dedup
- Rename (native `prompt()`) — updates the category list + every book
  across all 3 collections
- Delete — **blocked if in use**: shows an inline sub-list of books
  using it (title + source collection) with an "Edit" action per book
  that closes this modal and opens the relevant collection's edit
  view/modal. Only deletable once usage is zero.

**Entry points:** Settings → "Manage Categories".

---

## 11. Restore / Backup Flow

**Backup (no modal, fire-and-forget):**
- "Backup Database" (Dashboard Quick Actions) → generates full unified
  JSON, gzip-compresses (pako) if available, writes directly to
  configured backup folder (Tauri) or triggers browser
  download. Filename always fully timestamped.
- "Export All Data (JSON)" (Dashboard Quick Actions) → uncompressed
  JSON download, same unified structure.

**Restore (2-screen modal flow):**
1. **Screen 1** — Browse Files button → hidden file input
   (`.json`/`.json.gz`), shows filename+size once selected, Continue
   parses (decompresses if `.gz`) and advances
2. **Screen 2** — shows file metadata (timestamp, app version), a
   Current→Backup count comparison table (Books Read, Reading List, My
   Library, Tags, Categories), a bold warning block, and a required
   confirmation checkbox that gates the Restore button. Restore
   replaces all three collections + reloads every view.

**Entry points:** Dashboard Quick Actions "Restore from Backup" only.

---

## 12. Cross-Collection Handoffs (not tied to one view)

- **Reading List → Books Read**: "Finished" button pre-fills the
  Finished Book form; on save, the Reading List item is removed.
- **My Library → Reading List**: "To Read" button creates a linked,
  bottom-ranked Reading List entry; the My Library row hides its "To
  Read" button once linked.
- **Reading List → My Library (indirect)**: if a Reading List item has
  `MyLibraryId`, "Finished" pulls Pages/Category/ISBN from the linked
  My Library record instead of an ISBN API call.
- **Category Management → any collection**: "Edit" link on a
  blocked-delete book jumps straight into that book's edit surface.

---

## Open Questions for Redesign Discussion

- Settings isn't in the nav bar — intentional, or an oversight to fix
  in the redesign?
- Books Read and Reading List/My Library use two different interaction
  patterns (full-page views vs. modals) for Add/Edit — worth unifying?
- 14 separate modals + 3 full-page form views — is this the right
  split, or does the redesign want to consolidate around one pattern
  (e.g. all modals, or a slide-over panel)?
- No keyboard navigation / ESC-to-close / focus trapping on any modal
  — in scope for this redesign or separate accessibility pass?
- Statistics view has zero interactivity (no drill-down, no export) —
  worth adding as part of the redesign, or explicitly out of scope?
- #1's original "too many export options" question is still open —
  this inventory shows Books Read and My Library each have 2 export
  formats × filtered/unfiltered, plus 2 whole-database exports (JSON +
  gzip backup) — 6 total export operations across the app.
