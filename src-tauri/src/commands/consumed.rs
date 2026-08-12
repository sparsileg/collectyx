// consumed.rs — the "Books Read" collection.
//
// A re-read is a second row here against the same item_id, not a duplicate
// item. That is the case Scriptum's flat schema could not represent.

use rusqlite::{params, Result};
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::commands::common::{
    self, reconcile_tags, tags_by_item, today, upsert_item, ItemFields,
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

    #[serde(rename = "Comments", default)]
    pub comments: Option<String>,

    #[serde(rename = "DateAdded", default)]
    pub date_added: Option<String>,

    #[serde(rename = "Modified", default)]
    pub modified: Option<String>,
}

const SELECT_JOINED: &str = "
    SELECT c.id, c.item_id, i.owner, i.media_type_id, i.title, i.author,
           i.author2, i.pages, i.isbn, c.finished, c.rating,
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
            author: Some(row.get(5)?),
            author2: Some(row.get(6)?),
            pages: Some(row.get(7)?),
            isbn: Some(row.get(8)?),
            tags: Some(Vec::new()),
            item_date_added: row.get(14)?,
            item_modified: row.get(15)?,
            client_today: None,
        },
        finished: row.get(9)?,
        rating: row.get(10)?,
        comments: row.get(11)?,
        date_added: row.get(12)?,
        modified: row.get(13)?,
    })
}

#[tauri::command]
pub fn get_all_consumed(state: State<AppState>) -> Result<Vec<ConsumedRecord>, String> {
    let db = common::lock_db(&state.db);
    let owner = common::current_owner(&db);

    let mut stmt = db.prepare(SELECT_JOINED).map_err(common::db_err)?;
    let mut records = stmt
        .query_map(params![owner], |row| row_to_record(row))
        .map_err(common::db_err)?
        .collect::<Result<Vec<_>>>()
        .map_err(common::db_err)?;
    drop(stmt);

    let tag_map = tags_by_item(&db, &owner).map_err(common::db_err)?;
    for record in records.iter_mut() {
        if let Some(item_id) = &record.item.item_id {
            record.item.tags = Some(tag_map.get(item_id).cloned().unwrap_or_default());
        }
    }

    Ok(records)
}

#[tauri::command]
pub fn save_consumed(state: State<AppState>, record: ConsumedRecord) -> Result<common::SaveResult, String> {
    let mut db = common::lock_db(&state.db);
    let tx = db.transaction().map_err(common::db_err)?;
    // COLLECTYX-SEC-37: an interactive save reflects the user's own local
    // calendar date when the client supplied one; restore (replace_all_*
    // below) reproduces historical state instead and keeps the server date.
    let now = common::resolve_today(&record.item.client_today);

    let (id, item_id) = write_one(&tx, &record, &now, true).map_err(common::db_err)?;

    tx.commit().map_err(common::db_err)?;
    Ok(common::SaveResult { id, item_id })
}

/// Writes one record's item row, membership row, and tag links. Shared by
/// save_consumed and replace_all_consumed so both apply identical rules.
/// bump_modified_on_new_link is true only for the interactive single-save
/// path — restore reproduces historical state and shouldn't make every
/// reused tag look like fresh activity. Returns (membership id, item id) —
/// the latter lets callers report a real ItemId for a brand-new record
/// rather than echoing back whatever the caller sent in (COLLECTYX-SEC-39
/// finding 5).
/// pub(crate): also called directly by restore.rs's restore_all (#40),
/// which needs every collection's write_one inside its own single
/// transaction rather than going through a separate command.
pub(crate) fn write_one(
    tx: &rusqlite::Transaction,
    record: &ConsumedRecord,
    now: &str,
    bump_modified_on_new_link: bool,
) -> Result<(String, String)> {
    if let Err(msg) = common::validate_date(&record.finished, "Finished") {
        return Err(rusqlite::Error::ToSqlConversionFailure(Box::from(msg)));
    }
    if let Err(msg) = common::validate_rating(record.rating) {
        return Err(rusqlite::Error::ToSqlConversionFailure(Box::from(msg)));
    }
    if let Err(msg) = common::validate_comments(&record.comments) {
        return Err(rusqlite::Error::ToSqlConversionFailure(Box::from(msg)));
    }
    if let Some(d) = &record.date_added {
        if !d.is_empty() {
            if let Err(msg) = common::validate_date(d, "DateAdded") {
                return Err(rusqlite::Error::ToSqlConversionFailure(Box::from(msg)));
            }
        }
    }

    let item_id = upsert_item(tx, &record.item, now)?;
    let id = record.id.clone().unwrap_or_else(common::new_uuid);
    // An id naming an existing membership row must be one we own — the
    // ON CONFLICT below would otherwise repoint someone else's row
    // (CTX-SEC-103 / #53).
    if record.id.is_some() {
        if let Err(msg) = common::assert_membership_writable(tx, "consumed", &id) {
            return Err(rusqlite::Error::ToSqlConversionFailure(Box::from(msg)));
        }
    }
    let date_added = record.date_added.clone().unwrap_or_else(|| now.to_string());

    tx.execute(
        "INSERT INTO consumed
           (id, item_id, finished, rating, comments, date_added, modified)
         VALUES (?1,?2,?3,?4,?5,?6,?7)
         ON CONFLICT(id) DO UPDATE SET
            item_id   = excluded.item_id,
            finished  = excluded.finished,
            rating    = excluded.rating,
            comments  = excluded.comments,
            modified  = excluded.modified",
        params![
            id,
            item_id,
            record.finished,
            record.rating,
            record.comments,
            date_added,
            now
        ],
    )?;

    // None means the payload said nothing about tags — leave links alone.
    if let Some(names) = &record.item.tags {
        reconcile_tags(tx, &item_id, names, now, bump_modified_on_new_link)?;
    }

    Ok((id, item_id))
}

#[tauri::command]
pub fn delete_consumed(state: State<AppState>, id: String) -> Result<(), String> {
    let db = common::lock_db(&state.db);
    let owner = common::current_owner(&db);
    // Only the membership row goes; the item may belong to other collections.
    // Scoped through the item join (consumed has no owner column of its
    // own) — same error whether id is missing or belongs to another owner.
    let affected = db
        .execute(
            "DELETE FROM consumed
              WHERE id = ?1 AND item_id IN (SELECT id FROM items WHERE owner = ?2)",
            params![id, owner],
        )
        .map_err(common::db_err)?;
    if affected == 0 {
        return Err("Record not found".to_string());
    }
    Ok(())
}

/// Atomically replaces every consumed row: DELETE + INSERT in one
/// transaction, so a failed insert cannot leave the table empty.
#[tauri::command]
pub fn replace_all_consumed(
    state: State<AppState>,
    records: Vec<ConsumedRecord>,
) -> Result<(), String> {
    let mut db = common::lock_db(&state.db);
    let owner = common::current_owner(&db);
    // Whole-collection delete + rewrite, restore's worst-case write
    // contention path — Immediate for the same reason as queued.rs's
    // delete_queued (CTX-SEC-113 / #63).
    let tx = db.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate).map_err(common::db_err)?;
    let now = today();

    tx.execute(
        "DELETE FROM consumed WHERE item_id IN (SELECT id FROM items WHERE owner = ?1)",
        params![owner],
    )
    .map_err(common::db_err)?;

    for record in &records {
        write_one(&tx, record, &now, false).map_err(common::db_err)?;
    }

    tx.commit().map_err(common::db_err)?;
    Ok(())
}
