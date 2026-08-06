// items.rs — the canonical record, plus tag attachment and merge.

use rusqlite::{params, Result};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
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

/// What a merge actually moved. Returned so the UI can report it rather
/// than guess.
#[derive(Debug, Serialize, Deserialize, Clone, Default)]
pub struct MergeResult {
    #[serde(rename = "movedConsumed")]
    pub moved_consumed: i64,
    #[serde(rename = "movedQueued")]
    pub moved_queued: i64,
    #[serde(rename = "movedOwned")]
    pub moved_owned: i64,
    #[serde(rename = "movedTags")]
    pub moved_tags: i64,
    #[serde(rename = "droppedDuplicateTags")]
    pub dropped_duplicate_tags: i64,
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
    db.execute("DELETE FROM items WHERE id = ?1", params![id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn attach_tag(state: State<AppState>, item_id: String, tag_id: String) -> Result<(), String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
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
    db.execute(
        "DELETE FROM item_tags WHERE item_id = ?1 AND tag_id = ?2",
        params![item_id, tag_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Merges loser into survivor (design doc §3.3).
///
/// Runs as one transaction: every consumed/queued/owned/item_tags row is
/// reassigned and the loser deleted together, so a failure partway through
/// leaves nothing half-merged.
///
/// `field_resolutions` maps a column name to the winning value. Any field
/// where the two items genuinely disagree must appear there — a field one
/// side simply lacks is filled from the other and is not a conflict.
#[tauri::command]
pub fn merge_items(
    state: State<AppState>,
    survivor_id: String,
    loser_id: String,
    field_resolutions: HashMap<String, Option<String>>,
) -> Result<MergeResult, String> {
    if survivor_id == loser_id {
        return Err("Cannot merge an item into itself".to_string());
    }

    let mut db = state.db.lock().map_err(|e| e.to_string())?;
    let tx = db.transaction().map_err(|e| e.to_string())?;
    let now = today();

    let survivor = load_item_row(&tx, &survivor_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("Survivor item {} not found", survivor_id))?;
    let loser = load_item_row(&tx, &loser_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("Loser item {} not found", loser_id))?;

    // Resolve conflicting fields before touching anything.
    let mut merged = survivor.clone();
    let mut unresolved: Vec<String> = Vec::new();

    for field in ["title", "author", "author2", "pages", "isbn"] {
        let a = survivor.get(field).cloned().unwrap_or(None);
        let b = loser.get(field).cloned().unwrap_or(None);
        if a == b {
            continue;
        }
        let a_empty = a.as_ref().map(|s| s.is_empty()).unwrap_or(true);
        let b_empty = b.as_ref().map(|s| s.is_empty()).unwrap_or(true);
        if a_empty {
            merged.insert(field.to_string(), b);
        } else if b_empty {
            merged.insert(field.to_string(), a);
        } else if let Some(chosen) = field_resolutions.get(field) {
            merged.insert(field.to_string(), chosen.clone());
        } else {
            unresolved.push(field.to_string());
        }
    }

    if !unresolved.is_empty() {
        return Err(format!(
            "Merge needs a resolution for: {}",
            unresolved.join(", ")
        ));
    }

    tx.execute(
        "UPDATE items
            SET title = ?1, author = ?2, author2 = ?3, pages = ?4, isbn = ?5,
                modified = ?6
          WHERE id = ?7",
        params![
            merged.get("title").cloned().unwrap_or(None),
            merged.get("author").cloned().unwrap_or(None),
            merged.get("author2").cloned().unwrap_or(None),
            merged
                .get("pages")
                .cloned()
                .unwrap_or(None)
                .and_then(|s| s.parse::<i64>().ok()),
            merged.get("isbn").cloned().unwrap_or(None),
            now,
            survivor_id
        ],
    )
    .map_err(|e| e.to_string())?;

    // Reassign the membership rows.
    let moved_consumed = tx
        .execute(
            "UPDATE consumed SET item_id = ?1, modified = ?2 WHERE item_id = ?3",
            params![survivor_id, now, loser_id],
        )
        .map_err(|e| e.to_string())? as i64;
    let moved_queued = tx
        .execute(
            "UPDATE queued SET item_id = ?1, modified = ?2 WHERE item_id = ?3",
            params![survivor_id, now, loser_id],
        )
        .map_err(|e| e.to_string())? as i64;
    let moved_owned = tx
        .execute(
            "UPDATE owned SET item_id = ?1, modified = ?2 WHERE item_id = ?3",
            params![survivor_id, now, loser_id],
        )
        .map_err(|e| e.to_string())? as i64;

    // Tags union: move links the survivor doesn't already have, drop the
    // rest. Counted before the move so the report is accurate.
    let dropped: i64 = tx
        .query_row(
            "SELECT COUNT(*) FROM item_tags l
              WHERE l.item_id = ?1
                AND EXISTS (SELECT 1 FROM item_tags s
                             WHERE s.item_id = ?2 AND s.tag_id = l.tag_id)",
            params![loser_id, survivor_id],
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())?;

    let moved_tags = tx
        .execute(
            "INSERT OR IGNORE INTO item_tags (item_id, tag_id)
             SELECT ?1, tag_id FROM item_tags WHERE item_id = ?2",
            params![survivor_id, loser_id],
        )
        .map_err(|e| e.to_string())? as i64;

    tx.execute("DELETE FROM item_tags WHERE item_id = ?1", params![loser_id])
        .map_err(|e| e.to_string())?;

    tx.execute("DELETE FROM items WHERE id = ?1", params![loser_id])
        .map_err(|e| e.to_string())?;

    tx.commit().map_err(|e| e.to_string())?;

    Ok(MergeResult {
        moved_consumed,
        moved_queued,
        moved_owned,
        moved_tags,
        dropped_duplicate_tags: dropped,
    })
}

/// Loads an item as a column -> value map, so merge resolution can treat
/// fields uniformly. Numeric columns come back as strings and are converted
/// on the way out.
fn load_item_row(
    tx: &rusqlite::Transaction,
    id: &str,
) -> Result<Option<HashMap<String, Option<String>>>> {
    let mut stmt = tx.prepare(
        "SELECT title, author, author2, pages, isbn FROM items WHERE id = ?1",
    )?;

    let mut rows = stmt.query(params![id])?;
    if let Some(row) = rows.next()? {
        let mut map: HashMap<String, Option<String>> = HashMap::new();
        map.insert("title".into(), row.get::<_, Option<String>>(0)?);
        map.insert("author".into(), row.get::<_, Option<String>>(1)?);
        map.insert("author2".into(), row.get::<_, Option<String>>(2)?);
        map.insert(
            "pages".into(),
            row.get::<_, Option<i64>>(3)?.map(|v| v.to_string()),
        );
        map.insert("isbn".into(), row.get::<_, Option<String>>(4)?);
        Ok(Some(map))
    } else {
        Ok(None)
    }
}

/// Creates a bare item with no collection membership. Rarely needed
/// directly — the collection save commands upsert their own item — but
/// useful for the importer and for tests.
#[tauri::command]
pub fn save_item(state: State<AppState>, item: ItemRecord) -> Result<String, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    let now = today();
    let id = if item.id.is_empty() { new_uuid() } else { item.id.clone() };

    db.execute(
        "INSERT INTO items
           (id, owner, media_type_id, title, author, author2, pages, isbn,
            date_added, modified)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)
         ON CONFLICT(id) DO UPDATE SET
            owner         = excluded.owner,
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
