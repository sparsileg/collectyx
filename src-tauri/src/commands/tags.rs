// tags.rs — first-class tag entity, the only classification axis.

use rusqlite::{params, Result};
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::commands::common::{self, new_uuid, today};
use crate::AppState;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct TagRecord {
    #[serde(default)]
    pub id: Option<String>,

    // Serialize-only: no write path may take ownership from the payload
    // (CTX-SEC-105/106, #55/#56).
    #[serde(rename = "Owner", default, skip_deserializing)]
    pub owner: Option<String>,

    #[serde(rename = "Name")]
    pub name: String,

    /// Usage count, computed on read; ignored on write.
    #[serde(rename = "Count", default)]
    pub count: i64,

    #[serde(rename = "DateAdded", default)]
    pub date_added: Option<String>,

    #[serde(rename = "Modified", default)]
    pub modified: Option<String>,
}

#[tauri::command]
pub fn get_all_tags(state: State<AppState>) -> Result<Vec<TagRecord>, String> {
    let db = common::lock_db(&state.db);
    let owner = common::current_owner(&db);

    let mut stmt = db
        .prepare(
            "SELECT t.id, t.owner, t.name, t.date_added, t.modified,
                    (SELECT COUNT(*) FROM item_tags it
                       JOIN items i ON i.id = it.item_id
                      WHERE it.tag_id = t.id AND i.owner = ?1)
               FROM tags t
              WHERE t.owner = ?1
              ORDER BY t.name ASC",
        )
        .map_err(|e| e.to_string())?;

    let tags = stmt
        .query_map(params![owner], |row| {
            Ok(TagRecord {
                id: Some(row.get(0)?),
                owner: Some(row.get(1)?),
                name: row.get(2)?,
                date_added: row.get(3)?,
                modified: row.get(4)?,
                count: row.get(5)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>>>()
        .map_err(|e| e.to_string())?;

    Ok(tags)
}

/// Creates or renames a tag. Renaming needs no cascade — item_tags
/// references tag_id, not the name.
#[tauri::command]
pub fn save_tag(state: State<AppState>, tag: TagRecord) -> Result<String, String> {
    let db = common::lock_db(&state.db);
    let now = today();

    let name = tag.name.trim().to_lowercase();
    common::validate_tag_name(&name)?;

    // Never taken from the payload (CTX-SEC-106 / #56).
    let owner = common::current_owner(&db);
    let id = tag.id.clone().unwrap_or_else(new_uuid);

    // Only relevant when id names an existing row — a fresh id is a create,
    // nothing to protect yet.
    if tag.id.is_some() {
        common::assert_tag_owned(&db, &id)?;
    }

    let clash: Option<String> = db
        .query_row(
            "SELECT id FROM tags WHERE owner = ?1 AND name = ?2 AND id <> ?3",
            params![owner, name, id],
            |row| row.get(0),
        )
        .ok();
    if clash.is_some() {
        return Err(format!("Tag \"{}\" already exists", name));
    }

    db.execute(
        "INSERT INTO tags (id, owner, name, date_added, modified)
         VALUES (?1,?2,?3,?4,?5)
         ON CONFLICT(id) DO UPDATE SET
            name     = excluded.name,
            modified = excluded.modified",
        params![
            id,
            owner,
            name,
            tag.date_added.clone().unwrap_or_else(|| now.clone()),
            now
        ],
    )
    .map_err(|e| e.to_string())?;

    Ok(id)
}

/// Deletes a tag, optionally reassigning its links to a substitute first
/// (design doc §4.6). Runs as one transaction so a book that carried only
/// the deleted tag can never end up untagged partway through.
#[tauri::command]
pub fn delete_tag(
    state: State<AppState>,
    id: String,
    substitute_tag_id: Option<String>,
) -> Result<i64, String> {
    let mut db = common::lock_db(&state.db);
    let tx = db.transaction().map_err(|e| e.to_string())?;

    common::assert_tag_owned(&tx, &id)?;

    let owner = common::current_owner(&tx);
    let affected: i64 = tx
        .query_row(
            "SELECT COUNT(*) FROM item_tags it
               JOIN items i ON i.id = it.item_id
              WHERE it.tag_id = ?1 AND i.owner = ?2",
            params![id, owner],
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())?;

    if let Some(substitute) = &substitute_tag_id {
        if substitute == &id {
            return Err("Substitute tag cannot be the tag being deleted".to_string());
        }
        common::assert_tag_owned(&tx, substitute)?;
        // INSERT OR IGNORE handles items that already carry the substitute.
        tx.execute(
            "INSERT OR IGNORE INTO item_tags (item_id, tag_id)
             SELECT item_id, ?1 FROM item_tags WHERE tag_id = ?2",
            params![substitute, id],
        )
        .map_err(|e| e.to_string())?;
    }

    // item_tags rows go via ON DELETE CASCADE on tags.id.
    tx.execute("DELETE FROM tags WHERE id = ?1", params![id])
        .map_err(|e| e.to_string())?;

    tx.commit().map_err(|e| e.to_string())?;
    Ok(affected)
}

struct PreparedTag {
    id: String,
    owner: String,
    name: String,
    date_added: String,
}

/// Replaces the full tag set for the active owner. Only deletes tags
/// genuinely absent from the incoming list — a surviving tag (matched by
/// id) is upserted in place and never deleted, so its item_tags rows never
/// see the ON DELETE CASCADE fire. The previous delete-then-reinsert
/// approach cascaded every link away before the reinsert ran
/// (COLLECTYX-SEC-33). Identity is by id, not name: a backup entry that
/// reuses an existing name under a new id is rejected by UNIQUE(owner,
/// name), same as any other tag creation.
#[tauri::command]
pub fn replace_all_tags(state: State<AppState>, tags: Vec<TagRecord>) -> Result<(), String> {
    let mut db = common::lock_db(&state.db);
    let owner = common::current_owner(&db);
    let tx = db.transaction().map_err(|e| e.to_string())?;
    let now = today();

    let mut prepared: Vec<PreparedTag> = Vec::new();
    for tag in &tags {
        let name = tag.name.trim().to_lowercase();
        if name.is_empty() {
            continue;
        }
        // A restore is all-or-nothing (COLLECTYX-SEC-30) — one invalid tag
        // name aborts the whole transaction rather than being silently
        // skipped, since a partial restore is a worse outcome than an
        // explicit error naming the offending row.
        if let Err(msg) = common::validate_tag_name(&name) {
            return Err(msg);
        }

        // An id naming an existing row must be one we own — a fresh id
        // is a create (CTX-SEC-105 / #55).
        if let Some(id) = &tag.id {
            let existing_owner: Option<String> = tx
                .query_row("SELECT owner FROM tags WHERE id = ?1", params![id], |r| r.get(0))
                .ok();
            match existing_owner {
                None => {}
                Some(o) if o == owner => {}
                Some(_) => return Err("Tag not found".to_string()),
            }
        }

        prepared.push(PreparedTag {
            id: tag.id.clone().unwrap_or_else(new_uuid),
            owner: owner.clone(), // never tag.owner
            name,
            date_added: tag.date_added.clone().unwrap_or_else(|| now.clone()),
        });
    }

    let incoming_ids: std::collections::HashSet<&str> =
        prepared.iter().map(|p| p.id.as_str()).collect();

    let existing_ids: Vec<String> = {
        let mut stmt = tx
            .prepare("SELECT id FROM tags WHERE owner = ?1")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params![owner], |row| row.get(0))
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>>>()
            .map_err(|e| e.to_string())?;
        rows
    };

    for existing_id in &existing_ids {
        if !incoming_ids.contains(existing_id.as_str()) {
            tx.execute("DELETE FROM tags WHERE id = ?1", params![existing_id])
                .map_err(|e| e.to_string())?;
        }
    }

    for p in &prepared {
        tx.execute(
            "INSERT INTO tags (id, owner, name, date_added, modified)
             VALUES (?1,?2,?3,?4,?5)
             ON CONFLICT(id) DO UPDATE SET
                name     = excluded.name,
                modified = excluded.modified
              WHERE tags.owner = ?2",
            params![p.id, p.owner, p.name, p.date_added, now],
        )
        .map_err(|e| e.to_string())?;
    }

    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}
