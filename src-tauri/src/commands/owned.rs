// owned.rs — the "My Library" collection.

use rusqlite::{params, Result};
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::commands::common::{
    self, reconcile_tags, tags_by_item, today, upsert_item, ItemFields,
};
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
            author: Some(row.get(5)?),
            author2: Some(row.get(6)?),
            pages: Some(row.get(7)?),
            isbn: Some(row.get(8)?),
            tags: Some(Vec::new()),
            item_date_added: row.get(15)?,
            item_modified: row.get(16)?,
            client_today: None,
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
pub fn save_owned(state: State<AppState>, record: OwnedRecord) -> Result<common::SaveResult, String> {
    let mut db = common::lock_db(&state.db);
    let tx = db.transaction().map_err(common::db_err)?;
    let now = common::resolve_today(&record.item.client_today);

    let (id, item_id) = write_one(&tx, &record, &now, true).map_err(common::db_err)?;

    tx.commit().map_err(common::db_err)?;
    Ok(common::SaveResult { id, item_id })
}

fn write_one(tx: &rusqlite::Transaction, record: &OwnedRecord, now: &str, bump_modified_on_new_link: bool) -> Result<(String, String)> {
    if let Err(msg) = common::validate_short_text(&record.location, "Location") {
        return Err(rusqlite::Error::ToSqlConversionFailure(Box::from(msg)));
    }
    if let Err(msg) = common::validate_short_text(&record.patron, "Patron") {
        return Err(rusqlite::Error::ToSqlConversionFailure(Box::from(msg)));
    }
    if let Err(msg) = common::validate_comments(&record.comments) {
        return Err(rusqlite::Error::ToSqlConversionFailure(Box::from(msg)));
    }
    if let Some(d) = &record.checked_out_date {
        if !d.is_empty() {
            if let Err(msg) = common::validate_date(d, "CheckedOutDate") {
                return Err(rusqlite::Error::ToSqlConversionFailure(Box::from(msg)));
            }
        }
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
        if let Err(msg) = common::assert_membership_writable(tx, "owned", &id) {
            return Err(rusqlite::Error::ToSqlConversionFailure(Box::from(msg)));
        }
    }
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
        reconcile_tags(tx, &item_id, names, now, bump_modified_on_new_link)?;
    }

    Ok((id, item_id))
}

#[tauri::command]
pub fn delete_owned(state: State<AppState>, id: String) -> Result<(), String> {
    let db = common::lock_db(&state.db);
    let owner = common::current_owner(&db);
    let affected = db
        .execute(
            "DELETE FROM owned
              WHERE id = ?1 AND item_id IN (SELECT id FROM items WHERE owner = ?2)",
            params![id, owner],
        )
        .map_err(common::db_err)?;
    if affected == 0 {
        return Err("Record not found".to_string());
    }
    Ok(())
}

#[tauri::command]
pub fn replace_all_owned(
    state: State<AppState>,
    records: Vec<OwnedRecord>,
) -> Result<(), String> {
    let mut db = common::lock_db(&state.db);
    let owner = common::current_owner(&db);
    // Whole-collection delete + rewrite, restore's worst-case write
    // contention path — Immediate for the same reason as queued.rs's
    // delete_queued (CTX-SEC-113 / #63).
    let tx = db.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate).map_err(common::db_err)?;
    let now = today();

    tx.execute(
        "DELETE FROM owned WHERE item_id IN (SELECT id FROM items WHERE owner = ?1)",
        params![owner],
    )
    .map_err(common::db_err)?;

    for record in &records {
        write_one(&tx, record, &now, false).map_err(common::db_err)?;
    }

    tx.commit().map_err(common::db_err)?;
    Ok(())
}
