// items.rs — the canonical record, plus tag attachment.

use rusqlite::{params, Result};
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::commands::common::{self, new_uuid, tags_by_item, today};
use crate::AppState;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ItemRecord {
    pub id: String,

    #[serde(rename = "Owner")]
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
    let db = state.db.lock().map_err(|e| e.to_string())?;
    let owner = common::current_owner(&db);

    let mut stmt = db
        .prepare(
            "SELECT id, owner, media_type_id, title, author, author2, pages,
                    isbn, date_added, modified
               FROM items
              WHERE owner = ?1
              ORDER BY title ASC",
        )
        .map_err(|e| e.to_string())?;

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
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>>>()
        .map_err(|e| e.to_string())?;
    drop(stmt);

    let tag_map = tags_by_item(&db, &owner).map_err(|e| e.to_string())?;
    for item in items.iter_mut() {
        item.tags = tag_map.get(&item.id).cloned().unwrap_or_default();
    }

    Ok(items)
}

/// Deletes an item and everything hanging off it. The membership and
/// junction rows go via ON DELETE CASCADE.
#[tauri::command]
pub fn delete_item(state: State<AppState>, id: String) -> Result<(), String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    common::assert_item_owned(&db, &id)?;
    db.execute("DELETE FROM items WHERE id = ?1", params![id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn attach_tag(state: State<AppState>, item_id: String, tag_id: String) -> Result<(), String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    common::assert_item_owned(&db, &item_id)?;
    common::assert_tag_owned(&db, &tag_id)?;
    db.execute(
        "INSERT OR IGNORE INTO item_tags (item_id, tag_id) VALUES (?1, ?2)",
        params![item_id, tag_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn detach_tag(state: State<AppState>, item_id: String, tag_id: String) -> Result<(), String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    common::assert_item_owned(&db, &item_id)?;
    common::assert_tag_owned(&db, &tag_id)?;
    db.execute(
        "DELETE FROM item_tags WHERE item_id = ?1 AND tag_id = ?2",
        params![item_id, tag_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Creates a bare item with no collection membership. Rarely needed
/// directly — the collection save commands upsert their own item — but
/// useful for the importer and for tests.
#[tauri::command]
pub fn save_item(state: State<AppState>, item: ItemRecord) -> Result<String, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    let now = today();
    let id = if item.id.is_empty() { new_uuid() } else { item.id.clone() };
    if !item.id.is_empty() {
        common::assert_item_owned(&db, &item.id)?;
    }

    db.execute(
        "INSERT INTO items
           (id, owner, media_type_id, title, author, author2, pages, isbn,
            date_added, modified)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)
         ON CONFLICT(id) DO UPDATE SET
            media_type_id = excluded.media_type_id,
            title         = excluded.title,
            author        = excluded.author,
            author2       = excluded.author2,
            pages         = excluded.pages,
            isbn          = excluded.isbn,
            modified      = excluded.modified",
        params![
            id,
            item.owner,
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
    .map_err(|e| e.to_string())?;

    Ok(id)
}
