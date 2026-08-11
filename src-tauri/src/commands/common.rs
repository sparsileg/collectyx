// common.rs
//
// Shared pieces for the three collection command modules. The membership
// tables differ only in their own columns; everything to do with the parent
// items row, tag reconciliation, and owner scoping is identical, so it lives
// here rather than being copy-pasted three times.

use rusqlite::{params, Result, Transaction};
use serde::{Deserialize, Deserializer, Serialize};
use std::collections::HashMap;

use crate::constants::DEFAULT_OWNER;

// ── Validation (COLLECTYX-SEC-30) ───────────────────────────────────────────
//
// Rules the frontend enforced (tag format, date format, required Title) did
// not exist in either backend, so a restore file or a direct IPC call wrote
// them verbatim. These limits are mirrored in src/js/constants.js's
// CONSTANTS.VALIDATION and src/js/db-manager-web.js's Validation object —
// all three must agree or the backends diverge. Write-only: existing rows
// are never checked on read, only on the next write that touches them.

pub const MAX_SHORT_TEXT: usize = 500; // Title, Author, Author2, ISBN, Location, Patron, Source
pub const MAX_COMMENTS: usize = 10_000;
pub const MAX_TAG_NAME: usize = 64;
pub const MIN_PAGES: i64 = 0;
pub const MAX_PAGES: i64 = 100_000;
pub const MIN_RATING: i64 = 1;
pub const MAX_RATING: i64 = 5;
pub const MIN_YEAR: i64 = 1000;
pub const MAX_YEAR: i64 = 2200;
pub const MIN_RANK: i64 = 1;
pub const MAX_RANK: i64 = 1_000_000; // far above any realistic personal queue (CTX-SEC-122)

pub fn validate_tag_name(name: &str) -> std::result::Result<(), String> {
    if name.is_empty() {
        return Err("Tag name cannot be empty".to_string());
    }
    if name.chars().count() > MAX_TAG_NAME {
        return Err(format!("Tag name exceeds {} characters", MAX_TAG_NAME));
    }
    if !name
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
    {
        return Err(format!("Tag name \"{}\" contains invalid characters", name));
    }
    Ok(())
}

/// Strict YYYY-MM-DD shape with a plausible year range. Empty strings are
/// the caller's concern (an optional date field may legitimately be unset);
/// this only runs against a non-empty value.
pub fn validate_date(value: &str, field_name: &str) -> std::result::Result<(), String> {
    let bytes = value.as_bytes();
    let valid_shape = bytes.len() == 10
        && bytes[4] == b'-'
        && bytes[7] == b'-'
        && bytes[0..4].iter().all(u8::is_ascii_digit)
        && bytes[5..7].iter().all(u8::is_ascii_digit)
        && bytes[8..10].iter().all(u8::is_ascii_digit);
    if !valid_shape {
        return Err(format!("{} must be in YYYY-MM-DD format", field_name));
    }
    let year: i64 = value[0..4].parse().unwrap_or(0);
    let month: i64 = value[5..7].parse().unwrap_or(0);
    let day: i64 = value[8..10].parse().unwrap_or(0);
    if year < MIN_YEAR || year > MAX_YEAR {
        return Err(format!("{} year out of range", field_name));
    }
    if month < 1 || month > 12 {
        return Err(format!("{} month out of range", field_name));
    }
    if day < 1 || day > 31 {
        return Err(format!("{} day out of range", field_name));
    }
    Ok(())
}

pub fn validate_short_text(value: &Option<String>, field_name: &str) -> std::result::Result<(), String> {
    if let Some(v) = value {
        if v.chars().count() > MAX_SHORT_TEXT {
            return Err(format!("{} exceeds {} characters", field_name, MAX_SHORT_TEXT));
        }
    }
    Ok(())
}

pub fn validate_comments(value: &Option<String>) -> std::result::Result<(), String> {
    if let Some(v) = value {
        if v.chars().count() > MAX_COMMENTS {
            return Err(format!("Comments exceeds {} characters", MAX_COMMENTS));
        }
    }
    Ok(())
}

pub fn validate_rating(value: Option<i64>) -> std::result::Result<(), String> {
    if let Some(r) = value {
        if r < MIN_RATING || r > MAX_RATING {
            return Err(format!("Rating out of range ({}-{})", MIN_RATING, MAX_RATING));
        }
    }
    Ok(())
}

/// Rejects out-of-range rank values, including the ones that overflow the
/// unguarded +1/-1 shift arithmetic in reorder_queued/delete_queued when
/// left unchecked (CTX-SEC-122). None (unranked) always passes.
pub fn validate_rank(value: Option<i64>) -> std::result::Result<(), String> {
    if let Some(r) = value {
        if r < MIN_RANK || r > MAX_RANK {
            return Err(format!("Rank out of range ({}-{})", MIN_RANK, MAX_RANK));
        }
    }
    Ok(())
}

/// Validates the item half of a joined record: Title (non-empty, bounded,
/// required only when this save has no ItemId — i.e. is minting a new
/// item), Author/Author2/ISBN length, Pages range, ItemDateAdded/
/// ItemModified format if present, and each tag name.
///
/// A Title key absent from the payload is fine when updating an existing
/// item via ItemId — upsert_item's own CASE WHEN keeps the stored title.
/// It is only an error when there is no existing item to fall back to.
pub fn validate_item_fields(fields: &ItemFields) -> std::result::Result<(), String> {
    match &fields.title {
        Some(t) => {
            if t.trim().is_empty() {
                return Err("Title cannot be empty".to_string());
            }
            if t.chars().count() > MAX_SHORT_TEXT {
                return Err(format!("Title exceeds {} characters", MAX_SHORT_TEXT));
            }
        }
        None => {
            if fields.item_id.is_none() {
                return Err("Title cannot be empty".to_string());
            }
        }
    }
    if let Some(Some(a)) = &fields.author {
        validate_short_text(&Some(a.clone()), "Author")?;
    }
    if let Some(Some(a2)) = &fields.author2 {
        validate_short_text(&Some(a2.clone()), "Author2")?;
    }
    if let Some(Some(isbn)) = &fields.isbn {
        validate_short_text(&Some(isbn.clone()), "ISBN")?;
    }
    if let Some(Some(pages)) = &fields.pages {
        if *pages < MIN_PAGES || *pages > MAX_PAGES {
            return Err(format!("Pages out of range ({}-{})", MIN_PAGES, MAX_PAGES));
        }
    }
    if let Some(d) = &fields.item_date_added {
        if !d.is_empty() {
            validate_date(d, "ItemDateAdded")?;
        }
    }
    if let Some(d) = &fields.item_modified {
        if !d.is_empty() {
            validate_date(d, "ItemModified")?;
        }
    }
    if let Some(tags) = &fields.tags {
        for name in tags {
            validate_tag_name(&name.trim().to_lowercase())?;
        }
    }
    Ok(())
}

/// Distinguishes an absent JSON key (deserializes to None — leave the
/// stored value alone) from a key explicitly present as null (deserializes
/// to Some(None) — clear it) from a key present with a value (Some(Some(v))).
/// A plain `Option<T>` with `#[serde(default)]` cannot tell the first two
/// apart; both collapse to None. See design doc §6.3.
fn double_option<'de, T, D>(deserializer: D) -> std::result::Result<Option<Option<T>>, D::Error>
where
    T: Deserialize<'de>,
    D: Deserializer<'de>,
{
    Ok(Some(Option::deserialize(deserializer)?))
}

/// The item half of a joined record. Every collection record carries these.
#[derive(Debug, Serialize, Deserialize, Clone, Default)]
pub struct ItemFields {
    #[serde(rename = "ItemId", default)]
    pub item_id: Option<String>,

    // Serialize-only: no write path may take ownership from the payload
    // (CTX-SEC-101/104, #52/#54). Kept for read-side responses only.
    #[serde(rename = "Owner", default, skip_deserializing)]
    pub owner: Option<String>,

    #[serde(rename = "MediaTypeId", default)]
    pub media_type_id: Option<i64>,

    #[serde(rename = "Title", default)]
    pub title: Option<String>,

    #[serde(rename = "Author", default, deserialize_with = "double_option")]
    pub author: Option<Option<String>>,

    #[serde(rename = "Author2", default, deserialize_with = "double_option")]
    pub author2: Option<Option<String>>,

    #[serde(rename = "Pages", default, deserialize_with = "double_option")]
    pub pages: Option<Option<i64>>,

    #[serde(rename = "ISBN", default, deserialize_with = "double_option")]
    pub isbn: Option<Option<String>>,

    /// None means the payload said nothing about tags — leave existing links
    /// alone. Some(list) sets the item's tags to exactly that list.
    #[serde(rename = "Tags", default)]
    pub tags: Option<Vec<String>>,

    #[serde(rename = "ItemDateAdded", default)]
    pub item_date_added: Option<String>,

    #[serde(rename = "ItemModified", default)]
    pub item_modified: Option<String>,

    /// The client's own local calendar date (YYYY-MM-DD), attached by
    /// db-manager-tauri.js on every write via MediaLabels.todayISO()
    /// (COLLECTYX-SEC-37). Rust's own today() is UTC by construction —
    /// for a user east of UTC that can date a record a day earlier than
    /// what they see on screen. Preferred over the server date when
    /// present and well-formed; see resolve_today().
    #[serde(rename = "ClientToday", default)]
    pub client_today: Option<String>,
}

/// Today's date in the YYYY-MM-DD storage format, in UTC. Prefer
/// `resolve_today()` for anything that should reflect the user's local
/// calendar date (COLLECTYX-SEC-37) — this is the server-side fallback,
/// used when no client-supplied date is available (an old client, or a
/// bare Rust-side caller like the importer).
pub fn today() -> String {
    // Avoids pulling in chrono for one formatting call.
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        // A broken clock (before the UNIX epoch) must not panic while this
        // runs with the database lock held (CTX-SEC-110 / #60) — a panic
        // here poisons the mutex and, pre-#60, permanently broke
        // get_settings/save_settings/get_all_media_types for the rest of
        // the process. Fall back to the epoch and log loudly instead.
        .unwrap_or_else(|_| {
            log::error!("today(): system clock is set before the UNIX epoch; using 1970-01-01");
            0
        });
    let days = secs / 86_400;

    // Civil-from-days (Howard Hinnant's algorithm), epoch 1970-01-01.
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };

    format!("{:04}-{:02}-{:02}", y, m, d)
}

/// Resolves the date to stamp date_added/modified with: the client's own
/// local calendar date when present and well-formed, otherwise the
/// server's UTC calculation (COLLECTYX-SEC-37). A malformed client_today
/// (clock skew, a tampered payload) falls back rather than being trusted
/// or rejecting the whole save — this is a display-quality date, not a
/// security-relevant one.
pub fn resolve_today(client_today: &Option<String>) -> String {
    if let Some(d) = client_today {
        if validate_date(d, "ClientToday").is_ok() {
            return d.clone();
        }
    }
    today()
}

pub fn owner_or_default(owner: &Option<String>, fallback: &str) -> String {
    owner.clone().unwrap_or_else(|| fallback.to_string())
}

/// The currently-active owner, per app_meta's `current_owner` key, falling
/// back to DEFAULT_OWNER if unset (v1's untouched, no-testing-switch path).
///
/// app_meta is deliberately not owner-scoped — it's what lets the app know
/// which owner's rows every other query should scope to.
pub fn current_owner(conn: &rusqlite::Connection) -> String {
    conn.query_row(
        "SELECT value FROM app_meta WHERE key = ?1",
        params![crate::constants::APP_META_CURRENT_OWNER_KEY],
        |row| row.get::<_, String>(0),
    )
    .unwrap_or_else(|_| DEFAULT_OWNER.to_string())
}

/// Upserts the parent items row for a joined record.
///
/// A payload that references an existing item via ItemId without repeating
/// that item's Title/Author/Author2/Pages/ISBN is a normal, expected case
/// (checkout/check-in, "To Read", or a bulk import writing several
/// memberships against one item), not a request to blank those fields. So
/// this function falls back to the stored value for any column the payload
/// didn't supply.
///
/// Author/Author2/Pages/ISBN now distinguish "key absent" (None — keep the
/// stored value) from "key present as null" (Some(None) — clear it) via
/// ItemFields' double-Option fields and a CASE WHEN bound on whether the
/// caller actually set the key, rather than COALESCE, which could not tell
/// the two apart (design doc §6.3; COLLECTYX-SEC-08).
///
/// If fields.item_id names an existing item, that item must already belong
/// to the active owner (COLLECTYX-SEC-05) — checked before anything is
/// written, so a save against another owner's ItemId is rejected outright
/// rather than silently overwriting their record. Ownership itself is set
/// once, at insert, from the active owner; it is never taken from the
/// payload and never changed by a later save — an item cannot change
/// hands via a normal edit.
pub fn upsert_item(tx: &Transaction, fields: &ItemFields, now: &str) -> Result<String> {
    if let Err(msg) = validate_item_fields(fields) {
        return Err(rusqlite::Error::ToSqlConversionFailure(Box::from(msg)));
    }
    let item_id = match &fields.item_id {
        Some(id) => {
            if let Err(msg) = assert_item_id_writable(tx, id) {
                return Err(rusqlite::Error::ToSqlConversionFailure(Box::from(msg)));
            }
            id.clone()
        }
        None => new_uuid(),
    };
    let owner = current_owner(tx);
    let media_type_id = fields.media_type_id.unwrap_or(1);
    let date_added = fields
        .item_date_added
        .clone()
        .unwrap_or_else(|| now.to_string());

    let author_set = fields.author.is_some();
    let author_val = fields.author.clone().flatten();
    let author2_set = fields.author2.is_some();
    let author2_val = fields.author2.clone().flatten();
    let pages_set = fields.pages.is_some();
    let pages_val = fields.pages.flatten();
    let isbn_set = fields.isbn.is_some();
    let isbn_val = fields.isbn.clone().flatten();

    tx.execute(
        "INSERT INTO items
           (id, owner, media_type_id, title, author, author2, pages, isbn,
            date_added, modified)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)
         ON CONFLICT(id) DO UPDATE SET
            media_type_id = excluded.media_type_id,
            title         = CASE WHEN excluded.title != '' THEN excluded.title ELSE items.title END,
            author        = CASE WHEN ?11 THEN excluded.author ELSE items.author END,
            author2       = CASE WHEN ?12 THEN excluded.author2 ELSE items.author2 END,
            pages         = CASE WHEN ?13 THEN excluded.pages ELSE items.pages END,
            isbn          = CASE WHEN ?14 THEN excluded.isbn ELSE items.isbn END,
            modified      = excluded.modified",
        params![
            item_id,
            owner,
            media_type_id,
            fields.title.clone().unwrap_or_default(),
            author_val,
            author2_val,
            pages_val,
            isbn_val,
            date_added,
            now,
            author_set,
            author2_set,
            pages_set,
            isbn_set,
        ],
    )?;

    Ok(item_id)
}

/// Errors identically whether `item_id` doesn't exist or belongs to a
/// different owner — a mutating command must not confirm the existence of
/// rows the caller cannot see (COLLECTYX-SEC-05).
pub fn assert_item_owned(conn: &rusqlite::Connection, item_id: &str) -> std::result::Result<(), String> {
    let owner = current_owner(conn);
    let found: Option<String> = conn
        .query_row(
            "SELECT owner FROM items WHERE id = ?1",
            params![item_id],
            |row| row.get(0),
        )
        .ok();
    match found {
        Some(item_owner) if item_owner == owner => Ok(()),
        _ => Err("Item not found".to_string()),
    }
}

/// Whether `item_id` can legitimately be written to: either it doesn't
/// exist yet (a create — e.g. restore recreating an item under its
/// original, now-deleted, ID) or it exists and belongs to the current
/// owner (an update). Only an ID that belongs to a *different* owner is
/// blocked. Deliberately looser than assert_item_owned, which requires
/// existence — that stricter check stays correct for delete/attach/detach,
/// where the row must already be there. COLLECTYX-SEC-05's ownership check
/// on write paths didn't anticipate restore needing to recreate items
/// under their original IDs after a wipe; this is the fix (COLLECTYX-SEC-41).
pub fn assert_item_id_writable(conn: &rusqlite::Connection, item_id: &str) -> std::result::Result<(), String> {
    let owner = current_owner(conn);
    let found: Option<String> = conn
        .query_row(
            "SELECT owner FROM items WHERE id = ?1",
            params![item_id],
            |row| row.get(0),
        )
        .ok();
    match found {
        None => Ok(()),
        Some(item_owner) if item_owner == owner => Ok(()),
        Some(_) => Err("Item not found".to_string()),
    }
}

/// Membership tables (consumed/queued/owned) carry no owner column of
/// their own — ownership is derived through the parent item. Same
/// missing-vs-forbidden-indistinguishable rule as assert_item_id_writable:
/// an id absent entirely is a create (allowed); an id present but
/// belonging to another owner is refused (CTX-SEC-103 / #53). `table` is
/// always an internal literal ("consumed" | "queued" | "owned"), never
/// caller input.
pub fn assert_membership_writable(
    conn: &rusqlite::Connection,
    table: &str,
    id: &str,
) -> std::result::Result<(), String> {
    debug_assert!(matches!(table, "consumed" | "queued" | "owned"));
    let owner = current_owner(conn);
    let sql = format!(
        "SELECT i.owner FROM {t} m JOIN items i ON i.id = m.item_id WHERE m.id = ?1",
        t = table
    );
    let found: Option<String> = conn.query_row(&sql, params![id], |r| r.get(0)).ok();
    match found {
        None => Ok(()),
        Some(row_owner) if row_owner == owner => Ok(()),
        Some(_) => Err("Record not found".to_string()),
    }
}

/// Tag equivalent of assert_item_owned.
pub fn assert_tag_owned(conn: &rusqlite::Connection, tag_id: &str) -> std::result::Result<(), String> {
    let owner = current_owner(conn);
    let found: Option<String> = conn
        .query_row(
            "SELECT owner FROM tags WHERE id = ?1",
            params![tag_id],
            |row| row.get(0),
        )
        .ok();
    match found {
        Some(tag_owner) if tag_owner == owner => Ok(()),
        _ => Err("Tag not found".to_string()),
    }
}

/// Sets an item's tags to exactly `names`, creating tag rows as needed and
/// removing links the item no longer has. Names are lowercased and
/// deduplicated, matching the tags table's UNIQUE(owner, name).
///
/// When `bump_modified_on_new_link` is true, a reused tag that's newly
/// linked to this item also gets its modified stamp bumped — otherwise a
/// tag's Last Updated only ever reflects its own creation or an explicit
/// rename, never actual usage, which defeats the point of the Tags view's
/// sort-by-last-updated. A tag the item already carried is left untouched
/// even if it's in `names` again — nothing changed for it.
///
/// Callers pass false for bulk/restore paths (replace_all_*) — restoring
/// a backup reproduces historical state and shouldn't make every reused
/// tag look like fresh activity, same reasoning as db-manager-web.js's
/// replaceCollection() on the web side.
pub fn reconcile_tags(
    tx: &Transaction,
    item_id: &str,
    names: &[String],
    now: &str,
    bump_modified_on_new_link: bool,
) -> Result<()> {
    // Owner is resolved here, not accepted as a parameter — a caller can
    // no longer hand this a payload-supplied owner (CTX-SEC-104 / #54).
    let owner = current_owner(tx);
    let mut wanted: Vec<String> = names
        .iter()
        .map(|n| n.trim().to_lowercase())
        .filter(|n| !n.is_empty())
        .collect();
    wanted.sort();
    wanted.dedup();

    // Fetched up front — needed both to know what to drop (below) and,
    // per reused tag, whether this save is a genuinely new attachment.
    let mut stmt = tx.prepare("SELECT tag_id FROM item_tags WHERE item_id = ?1")?;
    let current: Vec<String> = stmt
        .query_map(params![item_id], |row| row.get(0))?
        .collect::<Result<Vec<_>>>()?;
    drop(stmt);

    let mut tag_ids: Vec<String> = Vec::new();

    for name in &wanted {
        if let Err(msg) = validate_tag_name(name) {
            return Err(rusqlite::Error::ToSqlConversionFailure(Box::from(msg)));
        }

        let existing: Option<String> = tx
            .query_row(
                "SELECT id FROM tags WHERE owner = ?1 AND name = ?2",
                params![owner, name],
                |row| row.get(0),
            )
            .ok();

        let tag_id = match existing {
            Some(id) => {
                if bump_modified_on_new_link && !current.contains(&id) {
                    tx.execute(
                        "UPDATE tags SET modified = ?1 WHERE id = ?2",
                        params![now, id],
                    )?;
                }
                id
            }
            None => {
                let id = new_uuid();
                tx.execute(
                    "INSERT INTO tags (id, owner, name, date_added, modified)
                     VALUES (?1,?2,?3,?4,?5)",
                    params![id, owner, name, now, now],
                )?;
                id
            }
        };
        tag_ids.push(tag_id);
    }

    // Drop links that are no longer wanted. Done as a delete-then-insert
    // rather than a NOT IN with a built string, to keep the query bound.
    for existing_id in &current {
        if !tag_ids.contains(existing_id) {
            tx.execute(
                "DELETE FROM item_tags WHERE item_id = ?1 AND tag_id = ?2",
                params![item_id, existing_id],
            )?;
        }
    }

    for tag_id in &tag_ids {
        tx.execute(
            "INSERT OR IGNORE INTO item_tags (item_id, tag_id) VALUES (?1, ?2)",
            params![item_id, tag_id],
        )?;
    }

    Ok(())
}

/// Loads item_id -> sorted tag names for every item belonging to an owner.
/// One query, grouped in Rust, rather than a correlated subquery per row.
pub fn tags_by_item(
    conn: &rusqlite::Connection,
    owner: &str,
) -> Result<HashMap<String, Vec<String>>> {
    let mut stmt = conn.prepare(
        "SELECT it.item_id, t.name
           FROM item_tags it
           JOIN tags t ON t.id = it.tag_id
          WHERE t.owner = ?1
          ORDER BY t.name ASC",
    )?;

    let rows = stmt.query_map(params![owner], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
    })?;

    let mut map: HashMap<String, Vec<String>> = HashMap::new();
    for row in rows {
        let (item_id, name) = row?;
        map.entry(item_id).or_default().push(name);
    }
    Ok(map)
}

/// Returned by each collection's save_* command. Web's saveCollectionRecord
/// always returns a real ItemId, minting one up front for a new record;
/// Tauri previously echoed back whatever ItemId the caller sent in — null
/// for a new record, since the caller doesn't know it yet. Both backends
/// now return the same shape (COLLECTYX-SEC-39 finding 5).
#[derive(Debug, Serialize)]
pub struct SaveResult {
    pub id: String,
    #[serde(rename = "itemId")]
    pub item_id: String,
}

/// Locks the shared connection, recovering the guard even if a prior panic
/// poisoned it. Without this, one panic while a command holds the lock
/// disables every subsequent command for the life of the process
/// (COLLECTYX-SEC-38 item 6) — returning an error rather than panicking
/// was already the right call for individual commands, but a poisoned
/// `Mutex` still needs an explicit recovery, since `.lock()` itself starts
/// erroring once poisoned. The connection is not left in a broken state by
/// a panic in Rust; only the guard's poison flag needs clearing.
pub fn lock_db(
    mutex: &std::sync::Mutex<rusqlite::Connection>,
) -> std::sync::MutexGuard<'_, rusqlite::Connection> {
    mutex.lock().unwrap_or_else(|poisoned| {
        log::warn!("lock_db: recovering a poisoned database lock");
        poisoned.into_inner()
    })
}

/// UUID v4, sourced from the OS CSPRNG via the `uuid` crate.
/// See COLLECTYX-SEC-26 — the prior clock-seeded xorshift generator was
/// deterministic and same-tick-collidable.
pub fn new_uuid() -> String {
    uuid::Uuid::new_v4().to_string()
}
