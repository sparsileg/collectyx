// common.rs
//
// Shared pieces for the three collection command modules. The membership
// tables differ only in their own columns; everything to do with the parent
// items row, tag reconciliation, and owner scoping is identical, so it lives
// here rather than being copy-pasted three times.

use rusqlite::{params, Result, Transaction};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

use crate::constants::DEFAULT_OWNER;

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

    #[serde(rename = "Author", default)]
    pub author: Option<String>,

    #[serde(rename = "Author2", default)]
    pub author2: Option<String>,

    #[serde(rename = "Pages", default)]
    pub pages: Option<i64>,

    #[serde(rename = "ISBN", default)]
    pub isbn: Option<String>,

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

pub fn owner_or_default(owner: &Option<String>) -> String {
    owner.clone().unwrap_or_else(|| DEFAULT_OWNER.to_string())
}

/// Upserts the parent items row for a joined record.
///
/// Unlike db-manager-tauri.js's own "complete a partial payload" step —
/// which only works when the payload carries the *membership* row's own
/// id, since that is what it looks up to fill in gaps — there is no
/// equivalent completion for the *item* half of a payload. A payload that
/// references an existing item via ItemId without repeating that item's
/// Title/Author/Author2/Pages/ISBN is a normal, expected case (checkout/
/// check-in, "To Read", or a bulk import writing several memberships
/// against one item), not a request to blank those fields. So this
/// function falls back to the stored value for any column the payload
/// didn't supply, rather than assuming the caller always sent a complete
/// row — which was the actual bug: a Scriptum-converted import's Consumed
/// entries correctly carry only ItemId (no item fields, by design, since
/// the item was already written first via saveItem()), and the old
/// unconditional UPDATE wiped Title/Author/Pages/ISBN right back out the
/// moment the first Consumed row for that item was written.
///
/// Absent and explicit-null aren't distinguished here (both fall back to
/// the stored value) — nothing on the JS side currently tries to
/// explicitly null Title/Author/Author2/Pages/ISBN, so this is safe for
/// every real caller today. A fully correct distinction would need
/// ItemFields' Option types to become double-Options (Some(None) = clear,
/// None = leave alone) — a larger, separate change than this fix.
pub fn upsert_item(tx: &Transaction, fields: &ItemFields, now: &str) -> Result<String> {
    let item_id = fields
        .item_id
        .clone()
        .unwrap_or_else(|| new_uuid());
    let owner = owner_or_default(&fields.owner);
    let media_type_id = fields.media_type_id.unwrap_or(1);
    let date_added = fields
        .item_date_added
        .clone()
        .unwrap_or_else(|| now.to_string());

    tx.execute(
        "INSERT INTO items
           (id, owner, media_type_id, title, author, author2, pages, isbn,
            date_added, modified)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)
         ON CONFLICT(id) DO UPDATE SET
            owner         = excluded.owner,
            media_type_id = excluded.media_type_id,
            title         = CASE WHEN excluded.title != '' THEN excluded.title ELSE items.title END,
            author        = COALESCE(excluded.author, items.author),
            author2       = COALESCE(excluded.author2, items.author2),
            pages         = COALESCE(excluded.pages, items.pages),
            isbn          = COALESCE(excluded.isbn, items.isbn),
            modified      = excluded.modified",
        params![
            item_id,
            owner,
            media_type_id,
            fields.title.clone().unwrap_or_default(),
            fields.author,
            fields.author2,
            fields.pages,
            fields.isbn,
            date_added,
            now
        ],
    )?;

    Ok(item_id)
}

/// Sets an item's tags to exactly `names`, creating tag rows as needed and
/// removing links the item no longer has. Names are lowercased and
/// deduplicated, matching the tags table's UNIQUE(owner, name).
pub fn reconcile_tags(
    tx: &Transaction,
    item_id: &str,
    owner: &str,
    names: &[String],
    now: &str,
) -> Result<()> {
    let mut wanted: Vec<String> = names
        .iter()
        .map(|n| n.trim().to_lowercase())
        .filter(|n| !n.is_empty())
        .collect();
    wanted.sort();
    wanted.dedup();

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
            Some(id) => id,
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
    let mut stmt = tx.prepare("SELECT tag_id FROM item_tags WHERE item_id = ?1")?;
    let current: Vec<String> = stmt
        .query_map(params![item_id], |row| row.get(0))?
        .collect::<Result<Vec<_>>>()?;
    drop(stmt);

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
