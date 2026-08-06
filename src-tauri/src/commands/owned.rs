// owned.rs — the "My Library" collection.

use rusqlite::{params, Result};
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::commands::common::{
    self, owner_or_default, reconcile_tags, tags_by_item, today, upsert_item, ItemFields,
};
use crate::constants::DEFAULT_OWNER;
use crate::AppState;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct OwnedRecord {
    #[serde(default)]
    pub id: Option<String>,

    #[serde(flatten)]
    pub item: ItemFields,

    /// Bookshelf name or other free-text location
    #[serde(rename = "Location", default)]
    pub location: Option<String>,

    /// Set when checked out; null means available
    #[serde(rename = "Patron", default)]
    pub patron: Option<String>,

    #[serde(rename = "CheckedOutDate", default)]
    pub checked_out_date: Option<String>,

    #[serde(rename = "Comments", default)]
    pub comments: Option<String>,

    #[serde(rename = "DateAdded", default)]
    pub date_added: Option<String>,

    #[serde(rename = "Modified", default)]
    pub modified: Option<String>,
}

const SELECT_JOINED: &str = "
    SELECT o.id, o.item_id, i.owner, i.media_type_id, i.title, i.author,
           i.author2, i.pages, i.isbn, o.location, o.patron,
           o.checked_out_date, o.comments, o.date_added, o.modified,
           i.date_added, i.modified
      FROM owned o
      JOIN items i ON i.id = o.item_id
     WHERE i.owner = ?1
     ORDER BY i.title ASC";

fn row_to_record(row: &rusqlite::Row) -> Result<OwnedRecord> {
    Ok(OwnedRecord {
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
            item_date_added: row.get(15)?,
            item_modified: row.get(16)?,
        },
        location: row.get(9)?,
        patron: row.get(10)?,
        checked_out_date: row.get(11)?,
        comments: row.get(12)?,
        date_added: row.get(13)?,
        modified: row.get(14)?,
    })
}

#[tauri::command]
pub fn get_all_owned(state: State<AppState>) -> Result<Vec<OwnedRecord>, String> {
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
pub fn save_owned(state: State<AppState>, record: OwnedRecord) -> Result<String, String> {
    let mut db = state.db.lock().map_err(|e| e.to_string())?;
    let tx = db.transaction().map_err(|e| e.to_string())?;
    let now = today();

    let id = write_one(&tx, &record, &now, true).map_err(|e| e.to_string())?;

    tx.commit().map_err(|e| e.to_string())?;
    Ok(id)
}

fn write_one(tx: &rusqlite::Transaction, record: &OwnedRecord, now: &str, bump_modified_on_new_link: bool) -> Result<String> {
    let item_id = upsert_item(tx, &record.item, now)?;
    let owner = owner_or_default(&record.item.owner);
    let id = record.id.clone().unwrap_or_else(common::new_uuid);
    let date_added = record.date_added.clone().unwrap_or_else(|| now.to_string());

    tx.execute(
        "INSERT INTO owned
           (id, item_id, location, patron, checked_out_date, comments,
            date_added, modified)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8)
         ON CONFLICT(id) DO UPDATE SET
            item_id          = excluded.item_id,
            location         = excluded.location,
            patron           = excluded.patron,
            checked_out_date = excluded.checked_out_date,
            comments         = excluded.comments,
            modified         = excluded.modified",
        params![
            id,
            item_id,
            record.location,
            record.patron,
            record.checked_out_date,
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
pub fn delete_owned(state: State<AppState>, id: String) -> Result<(), String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.execute("DELETE FROM owned WHERE id = ?1", params![id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn replace_all_owned(
    state: State<AppState>,
    records: Vec<OwnedRecord>,
) -> Result<(), String> {
    let mut db = state.db.lock().map_err(|e| e.to_string())?;
    let tx = db.transaction().map_err(|e| e.to_string())?;
    let now = today();

    tx.execute("DELETE FROM owned", [])
        .map_err(|e| e.to_string())?;

    for record in &records {
        write_one(&tx, record, &now, false).map_err(|e| e.to_string())?;
    }

    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}
