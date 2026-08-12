# To Be Read — Discovery-First Prototype Design

**Status:** Prototype
**Scope:** To Be Read view only, explore feasibility before applying to Books Read/My Library
**Goal:** Replace ranked-list-dump with discovery-default UX: featured top TBR item + related books by author + ranked queue below. Search hides discovery, shows filtered results.

---

## 1. Layout

One screen, two modes:

### 1.1 Discovery mode (default)

```
[Header: "To Be Read" | search icon]
[Discovery Cards]
  ├─ Top Item (ranked #1)
  │  ├─ Cover image (external fetch, or placeholder)
  │  ├─ Title, Author
  │  ├─ Synopsis (from comments, or external fetch)
  │  ├─ Source
  │  └─ "Start" button
  ├─ Related by Author
  │  ├─ Up to 3 other books by same author
  │  │  (any collection: queued, consumed, or owned)
  │  │  Queued: rank badge
  │  │  Consumed: finished date
  │  │  Owned: location
  │  └─ Author link → filtered queue (future)
[Ranked Queue List]
  ├─ All ranked items, #1–Nth
  ├─ Unranked section below
[Quick search bar]
[Filter icon] (future, for #49)
[Status bar]
```

### 1.2 Search mode (active search or filter)

```
[Header: "To Be Read" | search icon]
[Quick search bar] (focused, showing current query)
[Search results list]
  ├─ Matching ranked items
  ├─ Matching unranked items
  ├─ "(N matches)" in status bar
[Status bar]
```

Discovery cards hidden when search is active.

---

## 2. External metadata

### 2.1 Cover art

**Source:** GoodReads, ISBN route.

**Approach:**
1. Item has `isbn` (nullable). If present:
   - Construct GoodReads cover URL: `https://covers.openlibrary.org/b/isbn/{isbn}-M.jpg` (OpenLibrary public API, no auth)
   - Attempt async `fetch()` with short timeout (2s).
   - On success: show image.
   - On timeout/404/error: show placeholder (empty grey box, inline icon "📚").
2. If no ISBN: skip fetch, show placeholder immediately.

**Caching:** One per app session, in-memory `Map<itemId, imageUrl>`. No persistence (fresh random on reload = fresh fetch).

**Rate limit:** One fetch at a time per view (debounce concurrent requests). Not a problem for small featured-item set.

### 2.2 Synopsis

**Source:** Comments field (self-authored), or external fetch.

**Approach:**
1. If `consumed.comments` or `queued.comments` exists and is non-empty: use it (user's own notes).
2. Otherwise: attempt fetch from GoodReads via ISBN (same fetch as cover, parse different data).
3. On failure/missing ISBN: show "(No synopsis available)" placeholder.

**Truncation:** Cap displayed synopsis at 200 chars, ellipsis if longer.

---

## 3. "Other books by author" query

### 3.1 Schema support

Add index on `items(author)` for query speed. No schema change otherwise.

### 3.2 At render time

When rendering the featured top-TBR item:
1. Extract `author` (given name).
2. Query `items WHERE author = <name> AND media_type_id = 1` (Books only, v1).
3. Return up to 3 rows (limit constant `TOP_RELATED_COUNT`).
4. Group by collection:
   - Queued rows: show rank badge.
   - Consumed rows: show finished date.
   - Owned rows: show location.
5. If a book is in multiple collections (e.g. owned + consumed), show only the "primary" membership (priority: queued > consumed > owned).

**Performance:** Index on `author` makes this fast. At v1 scale (hundreds–low-thousands books), no observable lag.

---

## 4. Search integration

### 4.1 Quick search

Existing `CollectionView.filter()` logic applies to ranked/unranked queue only — does *not* re-fetch or re-render discovery cards. Discovery cards unmount (CSS `display: none`) when search is active.

### 4.2 Search state persistence

One view, persistent `_state`. When user types search query:
1. Set `_state[containerId].searchActive = true`.
2. Render discovery hidden, filtered queue visible.
3. User clears search: `_state.searchActive = false`, discovery re-renders (picks new random top item), queue resets to full ranked list.

---

## 5. Random selection

### 5.1 "Top item" randomness

Every time the view is mounted (nav into TBR, or refresh):
1. If queued collection is empty: show empty state, no discovery cards.
2. Otherwise: pick a random `queued` row via `Math.floor(Math.random() * queuedRows.length)`.
3. Fetch its parent `items` row (already loaded, no extra query).
4. Render featured card around it.

No sticky state. Navigation away → back picks a different random item.

### 5.2 Related-by-author

Deterministic (same author query every render), so shown item is consistent as long as the featured book is the same in that render.

---

## 6. Implementation sketch

### 6.1 Files touched

- `src/js/queued-view.js` — restructure `render()`/`_renderRows()` to split discovery-mode from search-mode rendering.
- `src/js/collection-view.js` — add `searchActive` state tracking.
- `src/js/metadata-fetcher.js` (new) — `fetchCoverArt(isbn)`, `fetchSynopsis(isbn)` — Promise-based, memoized per session.
- `src/css/queued-view.css` (new or expand existing) — card styling, placeholder image, layout.
- `src/js/constants.js` — `TOP_RELATED_COUNT`, `METADATA_FETCH_TIMEOUT_MS`, `COVER_PLACEHOLDER_CLASS`.

### 6.2 No DB changes

Index on `items(author)` is optional (query works without it, just slower). Prototype can skip the index and add it later if performance proves necessary.

---

## 7. Testing approach

### 7.1 Prototype scope

Build TBR view only. No changes to Books Read or My Library yet.

Success criteria:
- Featured card renders with cover placeholder + fallback synopsis.
- "Other books by author" query surfaces related items correctly.
- Search hides discovery, shows filtered results.
- Navigation away and back picks a new random item.
- Both web (IndexedDB) and Tauri (SQLite) builds show identical behavior.

### 7.2 Feasibility assessment

After TBR prototype works, evaluate:
- **Cover fetch latency:** does 2s timeout feel right, or do images appear too slow?
- **Related-by-author UX:** is "up to 3" the right number? Does it feel cluttered?
- **Cards vs. list balance:** do discovery cards push ranked queue too far down?

Then decide: proceed to Books Read/My Library with same pattern, or iterate TBR further first?

---

## 8. Future considerations (out of scope for prototype)

- Author link → filtered queue (show all books by this author).
- Cover image caching to IndexedDB/file system (persist across sessions).
- GoodReads/Amazon direct links (affiliate, if applicable).
- Reading progress on featured item (if consumed with partial mark).
- "Mark as read" quick action on featured card.

---

## 9. Open questions / unknowns

1. **OpenLibrary cover URL reliability?** Fallback plan if API changes or uptime issues?
2. **GoodReads synopsis fetch:** requires HTML parsing or is there a public API? (Confirm before coding.)
3. **Author name normalization:** "Frank Herbert" vs. "Herbert, Frank" — how strict should matching be? Current schema has `author` as free text, so exact match only for now, OK?
4. **Mobile layout:** cards full-width or side-by-side? Defer to CSS once prototype lands.

