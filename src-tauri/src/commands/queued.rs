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
    self, reconcile_tags, tags_by_item, today, upsert_item, ItemFields,
};
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

    /// None means the payload said nothing about this — leave the stored
    /// value alone. The normal Add/Edit modal never sends this key;
    /// toggle_currently_reading() is the only intended writer of an
    /// explicit Some(value). Read side always returns Some(actual value).
    #[serde(rename = "CurrentlyReading", default)]
    pub currently_reading: Option<bool>,
}

const SELECT_JOINED: &str = "
    SELECT q.id, q.item_id, i.owner, i.media_type_id, i.title, i.author,
           i.author2, i.pages, i.isbn, q.\"rank\", q.source, q.comments,
           q.date_added, q.modified, i.date_added, i.modified,
           q.currently_reading
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
            author: Some(row.get(5)?),
            author2: Some(row.get(6)?),
            pages: Some(row.get(7)?),
            isbn: Some(row.get(8)?),
            tags: Some(Vec::new()),
            item_date_added: row.get(14)?,
            item_modified: row.get(15)?,
            client_today: None,
        },
        rank: row.get(9)?,
        source: row.get(10)?,
        comments: row.get(11)?,
        date_added: row.get(12)?,
        modified: row.get(13)?,
        currently_reading: Some(row.get(16)?),
    })
}

#[tauri::command]
pub fn get_all_queued(state: State<AppState>) -> Result<Vec<QueuedRecord>, String> {
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
pub fn save_queued(state: State<AppState>, record: QueuedRecord) -> Result<common::SaveResult, String> {
    let mut db = common::lock_db(&state.db);
    let tx = db.transaction().map_err(common::db_err)?;
    let now = common::resolve_today(&record.item.client_today);

    let (id, item_id) = write_one(&tx, &record, &now, true, false).map_err(common::db_err)?;

    tx.commit().map_err(common::db_err)?;
    Ok(common::SaveResult { id, item_id })
}

/// apply_rank controls whether record.rank is written to the "rank" column
/// at all. Normal saves (save_queued) ignore incoming rank entirely —
/// reorder_queued is the only path that changes rank thereafter, so a
/// brand-new row is inserted unranked and an edit never touches its rank.
/// Restore (replace_all_queued) is the one caller that must honor the
/// incoming rank verbatim, since it is reproducing exact prior state, not
/// performing a live reorder.
fn write_one(tx: &rusqlite::Transaction, record: &QueuedRecord, now: &str, bump_modified_on_new_link: bool, apply_rank: bool) -> Result<(String, String)> {
    if let Err(msg) = common::validate_short_text(&record.source, "Source") {
        return Err(rusqlite::Error::ToSqlConversionFailure(Box::from(msg)));
    }
    if let Err(msg) = common::validate_comments(&record.comments) {
        return Err(rusqlite::Error::ToSqlConversionFailure(Box::from(msg)));
    }
    // Only checked when this call will actually write rank (apply_rank —
    // i.e. restore) — a normal save's incoming rank is ignored below
    // regardless, so validating it here too would reject payloads that
    // are never written anyway (CTX-SEC-122).
    if apply_rank {
        if let Err(msg) = common::validate_rank(record.rank) {
            return Err(rusqlite::Error::ToSqlConversionFailure(Box::from(msg)));
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
        if let Err(msg) = common::assert_membership_writable(tx, "queued", &id) {
            return Err(rusqlite::Error::ToSqlConversionFailure(Box::from(msg)));
        }
    }
    let date_added = record.date_added.clone().unwrap_or_else(|| now.to_string());
    let rank_param: Option<i64> = if apply_rank { record.rank } else { None };

    // currently_reading is bound once (?8) and reused: COALESCE(?8, 0) for
    // a brand-new row (the column is NOT NULL), COALESCE(?8, queued.currently_reading)
    // on conflict — record.currently_reading is None on every normal
    // Add/Edit save, so an existing row's flag survives an unrelated edit.
    // toggle_currently_reading() is the only path that sends Some(value).
    //
    // "rank" on conflict is gated by ?9 (apply_rank): a normal save leaves
    // the stored rank untouched — COLLECTYX-SEC-32's reorder_queued is the
    // only thing that changes rank after insertion. On insert, rank_param
    // is NULL unless apply_rank (restore), so a new row starts unranked.
    tx.execute(
        "INSERT INTO queued
           (id, item_id, \"rank\", source, comments, date_added, modified, currently_reading)
         VALUES (?1,?2,?3,?4,?5,?6,?7,COALESCE(?8, 0))
         ON CONFLICT(id) DO UPDATE SET
            item_id  = excluded.item_id,
            \"rank\"   = CASE WHEN ?9 THEN excluded.\"rank\" ELSE queued.\"rank\" END,
            source   = excluded.source,
            comments = excluded.comments,
            modified = excluded.modified,
            currently_reading = COALESCE(?8, queued.currently_reading)",
        params![
            id,
            item_id,
            rank_param,
            record.source,
            record.comments,
            date_added,
            now,
            record.currently_reading,
            apply_rank
        ],
    )?;

    if let Some(names) = &record.item.tags {
        reconcile_tags(tx, &item_id, names, now, bump_modified_on_new_link)?;
    }

    Ok((id, item_id))
}

#[tauri::command]
pub fn delete_queued(state: State<AppState>, id: String) -> Result<(), String> {
    let mut db = common::lock_db(&state.db);
    let owner = common::current_owner(&db);
    // Immediate, not the default Deferred — this reads deleted_rank then
    // writes based on it. Deferred would escalate to a write lock only at
    // the first write, risking SQLITE_BUSY mid-transaction after the read
    // already happened; Immediate takes the write lock upfront instead
    // (CTX-SEC-113 / #63).
    let tx = db.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate).map_err(common::db_err)?;

    let deleted_rank: Option<i64> = tx
        .query_row(
            "SELECT q.\"rank\" FROM queued q
               JOIN items i ON i.id = q.item_id
              WHERE q.id = ?1 AND i.owner = ?2",
            params![id, owner],
            |row| row.get(0),
        )
        .map_err(|_| "Record not found".to_string())?;

    let affected = tx
        .execute(
            "DELETE FROM queued
              WHERE id = ?1 AND item_id IN (SELECT id FROM items WHERE owner = ?2)",
            params![id, owner],
        )
        .map_err(common::db_err)?;
    if affected == 0 {
        return Err("Record not found".to_string());
    }

    // Close the gap in the same transaction as the delete — a crash
    // between the two used to leave a permanent hole (COLLECTYX-SEC-32).
    if let Some(rank) = deleted_rank {
        tx.execute(
            "UPDATE queued SET \"rank\" = \"rank\" - 1
               WHERE \"rank\" > ?1
                 AND item_id IN (SELECT id FROM items WHERE owner = ?2)",
            params![rank, owner],
        )
        .map_err(common::db_err)?;
    }

    tx.commit().map_err(common::db_err)?;
    Ok(())
}

/// Atomically moves one queued row to new_rank, shifting every affected
/// row in the same transaction via a single set-based UPDATE — replaces
/// the old row-at-a-time JS loop (COLLECTYX-SEC-32). Idempotent: if
/// new_rank matches the row's current stored rank, this is a no-op, so
/// callers (QueuedModal.save()) can invoke it unconditionally.
#[tauri::command]
pub fn reorder_queued(
    state: State<AppState>,
    id: String,
    new_rank: Option<i64>,
) -> Result<(), String> {
    // Reject out-of-range targets up front — the modal already clamps, but
    // this command is also reachable directly by invoke() (CTX-SEC-122).
    common::validate_rank(new_rank)?;
    let mut db = common::lock_db(&state.db);
    let owner = common::current_owner(&db);
    // Reads old_rank then writes shifted rows based on it — same reasoning
    // as delete_queued above (CTX-SEC-113 / #63).
    let tx = db.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate).map_err(common::db_err)?;

    let old_rank: Option<i64> = tx
        .query_row(
            "SELECT q.\"rank\" FROM queued q
               JOIN items i ON i.id = q.item_id
              WHERE q.id = ?1 AND i.owner = ?2",
            params![id, owner],
            |row| row.get(0),
        )
        .map_err(|_| "Record not found".to_string())?;

    if old_rank == new_rank {
        tx.commit().map_err(common::db_err)?;
        return Ok(());
    }

    match (old_rank, new_rank) {
        // Bounded above by MAX_RANK — a legacy row stored above that (e.g.
        // from a pre-validation restore) is excluded from the +1 rather
        // than risking an integer overflow on the shift (CTX-SEC-122).
        // The other three arms are unbounded above/below by construction —
        // reviewed and confirmed not to reach either i64 edge from a
        // shift this size.
        (None, Some(nr)) => tx.execute(
            "UPDATE queued SET \"rank\" = \"rank\" + 1
               WHERE id <> ?1 AND \"rank\" >= ?2 AND \"rank\" < ?4
                 AND item_id IN (SELECT id FROM items WHERE owner = ?3)",
            params![id, nr, owner, common::MAX_RANK],
        ),
        (Some(or_), None) => tx.execute(
            "UPDATE queued SET \"rank\" = \"rank\" - 1
               WHERE id <> ?1 AND \"rank\" > ?2
                 AND item_id IN (SELECT id FROM items WHERE owner = ?3)",
            params![id, or_, owner],
        ),
        (Some(or_), Some(nr)) if nr > or_ => tx.execute(
            "UPDATE queued SET \"rank\" = \"rank\" - 1
               WHERE id <> ?1 AND \"rank\" > ?2 AND \"rank\" <= ?3
                 AND item_id IN (SELECT id FROM items WHERE owner = ?4)",
            params![id, or_, nr, owner],
        ),
        (Some(or_), Some(nr)) => tx.execute(
            "UPDATE queued SET \"rank\" = \"rank\" + 1
               WHERE id <> ?1 AND \"rank\" >= ?2 AND \"rank\" < ?3
                 AND item_id IN (SELECT id FROM items WHERE owner = ?4)",
            params![id, nr, or_, owner],
        ),
        _ => Ok(0),
    }
    .map_err(common::db_err)?;

    let now = today();
    let affected = tx
        .execute(
            "UPDATE queued SET \"rank\" = ?1, modified = ?2
               WHERE id = ?3 AND item_id IN (SELECT id FROM items WHERE owner = ?4)",
            params![new_rank, now, id, owner],
        )
        .map_err(common::db_err)?;
    if affected == 0 {
        return Err("Record not found".to_string());
    }

    tx.commit().map_err(common::db_err)?;
    Ok(())
}

/// Sets or clears the Currently Reading flag on one queued row. Multiple
/// books may be marked at once — no single-book enforcement, per Stan.
#[tauri::command]
pub fn toggle_currently_reading(
    state: State<AppState>,
    id: String,
    value: bool,
) -> Result<(), String> {
    let db = common::lock_db(&state.db);
    let owner = common::current_owner(&db);
    let now = today();
    let affected = db
        .execute(
            "UPDATE queued SET currently_reading = ?1, modified = ?2
              WHERE id = ?3 AND item_id IN (SELECT id FROM items WHERE owner = ?4)",
            params![value, now, id, owner],
        )
        .map_err(common::db_err)?;
    if affected == 0 {
        return Err("Record not found".to_string());
    }
    Ok(())
}

#[tauri::command]
pub fn replace_all_queued(
    state: State<AppState>,
    records: Vec<QueuedRecord>,
) -> Result<(), String> {
    let mut db = common::lock_db(&state.db);
    let owner = common::current_owner(&db);
    // Whole-collection delete + rewrite, restore's worst-case write
    // contention path — Immediate for the same reason as delete_queued
    // above (CTX-SEC-113 / #63).
    let tx = db.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate).map_err(common::db_err)?;
    let now = today();

    tx.execute(
        "DELETE FROM queued WHERE item_id IN (SELECT id FROM items WHERE owner = ?1)",
        params![owner],
    )
    .map_err(common::db_err)?;

    for record in &records {
        write_one(&tx, record, &now, false, true).map_err(common::db_err)?;
    }

    tx.commit().map_err(common::db_err)?;
    Ok(())
}
