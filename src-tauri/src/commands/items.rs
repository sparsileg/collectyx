// items.rs — the canonical record, plus tag attachment.

use rusqlite::{params, Result};
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::commands::common::{self, new_uuid, tags_by_item, today};
use crate::AppState;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ItemRecord {
    pub id: String,

    // Serialize-only: meaningful on read, never settable on write
    // (CTX-SEC-101 / #52). save_item derives owner server-side instead.
    #[serde(rename = "Owner", default, skip_deserializing)]
    pub owner: String,

    #[serde(rename = "MediaTypeId")]
    pub media_type_id: i64,

    #[serde(rename = "Title")]
    pub title: String,

    #[serde(rename = "Author", default)]
    pub author: Option<String>,

    #[serde(rename = "Author2", default)]
    pub author2: Option<String>,

    #[serde(rename = "Pages", default)]
    pub pages: Option<i64>,

    #[serde(rename = "ISBN", default)]
    pub isbn: Option<String>,

    #[serde(rename = "Tags", default)]
    pub tags: Vec<String>,

    #[serde(rename = "DateAdded", default)]
    pub date_added: Option<String>,

    #[serde(rename = "Modified", default)]
    pub modified: Option<String>,
}

#[tauri::command]
pub fn get_all_items(state: State<AppState>) -> Result<Vec<ItemRecord>, String> {
    let db = common::lock_db(&state.db);
    let owner = common::current_owner(&db);

    let mut stmt = db
        .prepare(
            "SELECT id, owner, media_type_id, title, author, author2, pages,
                    isbn, date_added, modified
               FROM items
              WHERE owner = ?1
              ORDER BY title ASC",
        )
        .map_err(common::db_err)?;

    let mut items = stmt
        .query_map(params![owner], |row| {
            Ok(ItemRecord {
                id: row.get(0)?,
                owner: row.get(1)?,
                media_type_id: row.get(2)?,
                title: row.get(3)?,
                author: row.get(4)?,
                author2: row.get(5)?,
                pages: row.get(6)?,
                isbn: row.get(7)?,
                tags: Vec::new(),
                date_added: row.get(8)?,
                modified: row.get(9)?,
            })
        })
        .map_err(common::db_err)?
        .collect::<Result<Vec<_>>>()
        .map_err(common::db_err)?;
    drop(stmt);

    let tag_map = tags_by_item(&db, &owner).map_err(common::db_err)?;
    for item in items.iter_mut() {
        item.tags = tag_map.get(&item.id).cloned().unwrap_or_default();
    }

    Ok(items)
}

/// Counts items with no membership row in any of the three collections
/// (COLLECTYX-SEC-39 finding 3). Design doc §6.3 treats these as valid,
/// intentionally-retained catalogue entries — restore's replace_all_*
/// never deletes an items row, only its memberships — so this is a count,
/// not a cleanup. Not called from anywhere in the current UI; it exists
/// for the admin interface's planned Find Orphans capability.
#[tauri::command]
pub fn count_orphan_items(state: State<AppState>) -> Result<i64, String> {
    let db = common::lock_db(&state.db);
    let owner = common::current_owner(&db);
    let count: i64 = db
        .query_row(
            "SELECT COUNT(*) FROM items i
              WHERE i.owner = ?1
                AND NOT EXISTS (SELECT 1 FROM consumed c WHERE c.item_id = i.id)
                AND NOT EXISTS (SELECT 1 FROM queued q WHERE q.item_id = i.id)
                AND NOT EXISTS (SELECT 1 FROM owned o WHERE o.item_id = i.id)",
            params![owner],
            |row| row.get(0),
        )
        .map_err(common::db_err)?;
    Ok(count)
}

/// Deletes an item and everything hanging off it. The membership and
/// junction rows go via ON DELETE CASCADE.
#[tauri::command]
pub fn delete_item(state: State<AppState>, id: String) -> Result<(), String> {
    let db = common::lock_db(&state.db);
    common::assert_item_owned(&db, &id)?;
    db.execute("DELETE FROM items WHERE id = ?1", params![id])
        .map_err(common::db_err)?;
    Ok(())
}

#[tauri::command]
pub fn attach_tag(state: State<AppState>, item_id: String, tag_id: String) -> Result<(), String> {
    let db = common::lock_db(&state.db);
    common::assert_item_owned(&db, &item_id)?;
    common::assert_tag_owned(&db, &tag_id)?;
    db.execute(
        "INSERT OR IGNORE INTO item_tags (item_id, tag_id) VALUES (?1, ?2)",
        params![item_id, tag_id],
    )
    .map_err(common::db_err)?;
    Ok(())
}

#[tauri::command]
pub fn detach_tag(state: State<AppState>, item_id: String, tag_id: String) -> Result<(), String> {
    let db = common::lock_db(&state.db);
    common::assert_item_owned(&db, &item_id)?;
    common::assert_tag_owned(&db, &tag_id)?;
    db.execute(
        "DELETE FROM item_tags WHERE item_id = ?1 AND tag_id = ?2",
        params![item_id, tag_id],
    )
    .map_err(common::db_err)?;
    Ok(())
}

/// Creates a bare item with no collection membership. Rarely needed
/// directly — the collection save commands upsert their own item — but
/// useful for the importer and for tests.
#[tauri::command]
pub fn save_item(state: State<AppState>, item: ItemRecord) -> Result<String, String> {
    let db = common::lock_db(&state.db);
    let now = today();
    // Never taken from the payload (CTX-SEC-101 / #52) — same rule
    // upsert_item applies to the item row on every collection save path.
    let owner = common::current_owner(&db);

    if item.title.trim().is_empty() {
        return Err("Title cannot be empty".to_string());
    }
    common::validate_short_text(&Some(item.title.clone()), "Title")?;
    common::validate_short_text(&item.author, "Author")?;
    common::validate_short_text(&item.author2, "Author2")?;
    common::validate_short_text(&item.isbn, "ISBN")?;
    if let Some(p) = item.pages {
        if p < common::MIN_PAGES || p > common::MAX_PAGES {
            return Err(format!(
                "Pages out of range ({}-{})",
                common::MIN_PAGES,
                common::MAX_PAGES
            ));
        }
    }
    if let Some(d) = &item.date_added {
        if !d.is_empty() {
            common::validate_date(d, "DateAdded")?;
        }
    }

    let id = if item.id.is_empty() { new_uuid() } else { item.id.clone() };
    if !item.id.is_empty() {
        common::assert_item_id_writable(&db, &item.id)?;
    }

    db.execute(
        "INSERT INTO items
           (id, owner, media_type_id, title, author, author2, pages, isbn,
            date_added, modified)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)
         ON CONFLICT(id) DO UPDATE SET
            media_type_id = excluded.media_type_id,
            title         = CASE WHEN excluded.title != '' THEN excluded.title ELSE items.title END,
            author        = excluded.author,
            author2       = excluded.author2,
            pages         = excluded.pages,
            isbn          = excluded.isbn,
            modified      = excluded.modified",
        params![
            id,
            owner,
            item.media_type_id,
            item.title,
            item.author,
            item.author2,
            item.pages,
            item.isbn,
            item.date_added.clone().unwrap_or_else(|| now.clone()),
            now
        ],
    )
    .map_err(common::db_err)?;

    Ok(id)
}
