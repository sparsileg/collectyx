// media_types.rs — read-only reference table.
//
// v1 seeds exactly one row (Books). There is no write path: adding a media
// type is a schema-seeded change, not a user action, until a second type
// actually ships.

use rusqlite::Result;
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::commands::common;
use crate::AppState;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct MediaType {
    pub id: i64,

    #[serde(rename = "Name")]
    pub name: String,

    #[serde(rename = "ConsumedLabel")]
    pub consumed_label: String,

    #[serde(rename = "QueuedLabel")]
    pub queued_label: String,

    #[serde(rename = "OwnedLabel")]
    pub owned_label: String,
}

#[tauri::command]
pub fn get_all_media_types(state: State<AppState>) -> Result<Vec<MediaType>, String> {
    let db = common::lock_db(&state.db);

    let mut stmt = db
        .prepare(
            "SELECT id, name, consumed_label, queued_label, owned_label
               FROM media_types
              ORDER BY id ASC",
        )
        .map_err(|e| e.to_string())?;

    let types = stmt
        .query_map([], |row| {
            Ok(MediaType {
                id: row.get(0)?,
                name: row.get(1)?,
                consumed_label: row.get(2)?,
                queued_label: row.get(3)?,
                owned_label: row.get(4)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>>>()
        .map_err(|e| e.to_string())?;

    Ok(types)
}
