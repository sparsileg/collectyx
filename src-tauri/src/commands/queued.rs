// queued.rs — the "To Be Read" collection.
//
// No my_library_id column: a queued row and an owned row for the same
// physical book already share item_id, so the link is implicit.
//
// `rank` is quoted throughout — SQLite treats RANK as a window function
// name, and quoting keeps it unambiguously a column reference.

use rusqlite::{params, Result};
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::commands::common::{
    self, owner_or_default, reconcile_tags, tags_by_item, today, upsert_item, ItemFields,
};
use crate::constants::DEFAULT_OWNER;
use crate::AppState;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct QueuedRecord {
    #[serde(default)]
    pub id: Option<String>,

    #[serde(flatten)]
    pub item: ItemFields,

    /// nullable = unranked
    #[serde(rename = "Rank", default)]
    pub rank: Option<i64>,

    #[serde(rename = "Source", default)]
    pub source: Option<String>,

    #[serde(rename = "Comments", default)]
    pub comments: Option<String>,

    #[serde(rename = "DateAdded", default)]
    pub date_added: Option<String>,

    #[serde(rename = "Modified", default)]
    pub modified: Option<String>,
}

const SELECT_JOINED: &str = "
    SELECT q.id, q.item_id, i.owner, i.media_type_id, i.title, i.author,
           i.author2, i.pages, i.isbn, q.\"rank\", q.source, q.comments,
           q.date_added, q.modified, i.date_added, i.modified
      FROM queued q
      JOIN items i ON i.id = q.item_id
     WHERE i.owner = ?1
     ORDER BY CASE WHEN q.\"rank\" IS NULL THEN 1 ELSE 0 END, q.\"rank\" ASC, i.title ASC";

fn row_to_record(row: &rusqlite::Row) -> Result<QueuedRecord> {
    Ok(QueuedRecord {
        id: Some(row.get(0)?),
        item: ItemFields {
            item_id: Some(row.get(1)?),
            owner: Some(row.get(2)?),
            media_type_id: Some(row.get(3)?),
            title: Some(row.get(4)?),
            author: row.get(5)?,
            author2: row.get(6)?,
            pages: row.get(7)?,
            isbn: row.get(8)?,
            tags: Some(Vec::new()),
            item_date_added: row.get(14)?,
            item_modified: row.get(15)?,
        },
        rank: row.get(9)?,
        source: row.get(10)?,
        comments: row.get(11)?,
        date_added: row.get(12)?,
        modified: row.get(13)?,
    })
}

#[tauri::command]
pub fn get_all_queued(state: State<AppState>) -> Result<Vec<QueuedRecord>, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    let owner = DEFAULT_OWNER;

    let mut stmt = db.prepare(SELECT_JOINED).map_err(|e| e.to_string())?;
    let mut records = stmt
        .query_map(params![owner], |row| row_to_record(row))
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>>>()
        .map_err(|e| e.to_string())?;
    drop(stmt);

    let tag_map = tags_by_item(&db, owner).map_err(|e| e.to_string())?;
    for record in records.iter_mut() {
        if let Some(item_id) = &record.item.item_id {
            record.item.tags = Some(tag_map.get(item_id).cloned().unwrap_or_default());
        }
    }

    Ok(records)
}

#[tauri::command]
pub fn save_queued(state: State<AppState>, record: QueuedRecord) -> Result<String, String> {
    let mut db = state.db.lock().map_err(|e| e.to_string())?;
    let tx = db.transaction().map_err(|e| e.to_string())?;
    let now = today();

    let id = write_one(&tx, &record, &now, true).map_err(|e| e.to_string())?;

    tx.commit().map_err(|e| e.to_string())?;
    Ok(id)
}

fn write_one(tx: &rusqlite::Transaction, record: &QueuedRecord, now: &str, bump_modified_on_new_link: bool) -> Result<String> {
    let item_id = upsert_item(tx, &record.item, now)?;
    let owner = owner_or_default(&record.item.owner);
    let id = record.id.clone().unwrap_or_else(common::new_uuid);
    let date_added = record.date_added.clone().unwrap_or_else(|| now.to_string());

    tx.execute(
        "INSERT INTO queued
           (id, item_id, \"rank\", source, comments, date_added, modified)
         VALUES (?1,?2,?3,?4,?5,?6,?7)
         ON CONFLICT(id) DO UPDATE SET
            item_id  = excluded.item_id,
            \"rank\"   = excluded.\"rank\",
            source   = excluded.source,
            comments = excluded.comments,
            modified = excluded.modified",
        params![
            id,
            item_id,
            record.rank,
            record.source,
            record.comments,
            date_added,
            now
        ],
    )?;

    if let Some(names) = &record.item.tags {
        reconcile_tags(tx, &item_id, &owner, names, now, bump_modified_on_new_link)?;
    }

    Ok(id)
}

#[tauri::command]
pub fn delete_queued(state: State<AppState>, id: String) -> Result<(), String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.execute("DELETE FROM queued WHERE id = ?1", params![id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn replace_all_queued(
    state: State<AppState>,
    records: Vec<QueuedRecord>,
) -> Result<(), String> {
    let mut db = state.db.lock().map_err(|e| e.to_string())?;
    let tx = db.transaction().map_err(|e| e.to_string())?;
    let now = today();

    tx.execute("DELETE FROM queued", [])
        .map_err(|e| e.to_string())?;

    for record in &records {
        write_one(&tx, record, &now, false).map_err(|e| e.to_string())?;
    }

    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}
