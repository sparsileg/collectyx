// consumed.rs — the "Books Read" collection.
//
// A re-read is a second row here against the same item_id, not a duplicate
// item. That is the case Scriptum's flat schema could not represent.

use rusqlite::{params, Result};
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::commands::common::{
    self, owner_or_default, reconcile_tags, tags_by_item, today, upsert_item, ItemFields,
};
use crate::AppState;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ConsumedRecord {
    #[serde(default)]
    pub id: Option<String>,

    #[serde(flatten)]
    pub item: ItemFields,

    #[serde(rename = "Finished")]
    pub finished: String,

    #[serde(rename = "Rating", default)]
    pub rating: Option<i64>,

    #[serde(rename = "Recommend", default)]
    pub recommend: Option<i64>,

    #[serde(rename = "Comments", default)]
    pub comments: Option<String>,

    #[serde(rename = "DateAdded", default)]
    pub date_added: Option<String>,

    #[serde(rename = "Modified", default)]
    pub modified: Option<String>,
}

const SELECT_JOINED: &str = "
    SELECT c.id, c.item_id, i.owner, i.media_type_id, i.title, i.author,
           i.author2, i.pages, i.isbn, c.finished, c.rating, c.recommend,
           c.comments, c.date_added, c.modified, i.date_added, i.modified
      FROM consumed c
      JOIN items i ON i.id = c.item_id
     WHERE i.owner = ?1
     ORDER BY c.finished DESC, c.date_added DESC";

fn row_to_record(row: &rusqlite::Row) -> Result<ConsumedRecord> {
    Ok(ConsumedRecord {
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
        finished: row.get(9)?,
        rating: row.get(10)?,
        recommend: row.get(11)?,
        comments: row.get(12)?,
        date_added: row.get(13)?,
        modified: row.get(14)?,
    })
}

#[tauri::command]
pub fn get_all_consumed(state: State<AppState>) -> Result<Vec<ConsumedRecord>, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    let owner = common::current_owner(&db);

    let mut stmt = db.prepare(SELECT_JOINED).map_err(|e| e.to_string())?;
    let mut records = stmt
        .query_map(params![owner], |row| row_to_record(row))
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>>>()
        .map_err(|e| e.to_string())?;
    drop(stmt);

    let tag_map = tags_by_item(&db, &owner).map_err(|e| e.to_string())?;
    for record in records.iter_mut() {
        if let Some(item_id) = &record.item.item_id {
            record.item.tags = Some(tag_map.get(item_id).cloned().unwrap_or_default());
        }
    }

    Ok(records)
}

#[tauri::command]
pub fn save_consumed(state: State<AppState>, record: ConsumedRecord) -> Result<String, String> {
    let mut db = state.db.lock().map_err(|e| e.to_string())?;
    let tx = db.transaction().map_err(|e| e.to_string())?;
    let now = today();

    let id = write_one(&tx, &record, &now, true).map_err(|e| e.to_string())?;

    tx.commit().map_err(|e| e.to_string())?;
    Ok(id)
}

/// Writes one record's item row, membership row, and tag links. Shared by
/// save_consumed and replace_all_consumed so both apply identical rules.
/// bump_modified_on_new_link is true only for the interactive single-save
/// path — restore reproduces historical state and shouldn't make every
/// reused tag look like fresh activity.
fn write_one(
    tx: &rusqlite::Transaction,
    record: &ConsumedRecord,
    now: &str,
    bump_modified_on_new_link: bool,
) -> Result<String> {
    let item_id = upsert_item(tx, &record.item, now)?;
    let owner = owner_or_default(&record.item.owner, &common::current_owner(tx));
    let id = record.id.clone().unwrap_or_else(common::new_uuid);
    let date_added = record.date_added.clone().unwrap_or_else(|| now.to_string());

    tx.execute(
        "INSERT INTO consumed
           (id, item_id, finished, rating, recommend, comments, date_added, modified)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8)
         ON CONFLICT(id) DO UPDATE SET
            item_id   = excluded.item_id,
            finished  = excluded.finished,
            rating    = excluded.rating,
            recommend = excluded.recommend,
            comments  = excluded.comments,
            modified  = excluded.modified",
        params![
            id,
            item_id,
            record.finished,
            record.rating,
            record.recommend,
            record.comments,
            date_added,
            now
        ],
    )?;

    // None means the payload said nothing about tags — leave links alone.
    if let Some(names) = &record.item.tags {
        reconcile_tags(tx, &item_id, &owner, names, now, bump_modified_on_new_link)?;
    }

    Ok(id)
}

#[tauri::command]
pub fn delete_consumed(state: State<AppState>, id: String) -> Result<(), String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    // Only the membership row goes; the item may belong to other collections.
    db.execute("DELETE FROM consumed WHERE id = ?1", params![id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Atomically replaces every consumed row: DELETE + INSERT in one
/// transaction, so a failed insert cannot leave the table empty.
#[tauri::command]
pub fn replace_all_consumed(
    state: State<AppState>,
    records: Vec<ConsumedRecord>,
) -> Result<(), String> {
    let mut db = state.db.lock().map_err(|e| e.to_string())?;
    let tx = db.transaction().map_err(|e| e.to_string())?;
    let now = today();

    tx.execute("DELETE FROM consumed", [])
        .map_err(|e| e.to_string())?;

    for record in &records {
        write_one(&tx, record, &now, false).map_err(|e| e.to_string())?;
    }

    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}
