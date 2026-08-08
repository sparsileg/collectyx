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

    #[serde(rename = "Owner", default)]
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
}

/// Today's date in the YYYY-MM-DD storage format.
pub fn today() -> String {
    // Avoids pulling in chrono for one formatting call.
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
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
    let item_id = match &fields.item_id {
        Some(id) => {
            if let Err(msg) = assert_item_owned(tx, id) {
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
    owner: &str,
    names: &[String],
    now: &str,
    bump_modified_on_new_link: bool,
) -> Result<()> {
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

/// UUID v4, generated without pulling in the uuid crate for one call site.
pub fn new_uuid() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};

    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);

    // Mix the clock with the address of a local allocation so that two calls
    // in the same nanosecond still differ.
    let boxed = Box::new(0u8);
    let addr = &*boxed as *const u8 as usize as u128;
    let mut state = nanos ^ (addr << 32) ^ 0x9E37_79B9_7F4A_7C15;

    let mut next = || {
        state ^= state << 13;
        state ^= state >> 7;
        state ^= state << 17;
        state
    };

    let mut bytes = [0u8; 16];
    for chunk in bytes.chunks_mut(8) {
        let v = next() as u64;
        for (i, b) in chunk.iter_mut().enumerate() {
            *b = (v >> (8 * i)) as u8;
        }
    }

    bytes[6] = (bytes[6] & 0x0F) | 0x40; // version 4
    bytes[8] = (bytes[8] & 0x3F) | 0x80; // variant

    format!(
        "{:02x}{:02x}{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}",
        bytes[0], bytes[1], bytes[2], bytes[3], bytes[4], bytes[5], bytes[6], bytes[7],
        bytes[8], bytes[9], bytes[10], bytes[11], bytes[12], bytes[13], bytes[14], bytes[15]
    )
}
