// settings.rs — one JSON blob row per owner.

use rusqlite::params;
use tauri::State;

use crate::commands::common;
use crate::AppState;

/// Returns the settings JSON string for the currently-active owner, or
/// null if not yet set.
#[tauri::command]
pub fn get_settings(state: State<AppState>) -> Result<Option<String>, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    let owner = common::current_owner(&db);
    let result = db.query_row(
        "SELECT data FROM settings WHERE owner = ?1",
        params![owner],
        |row| row.get(0),
    );

    match result {
        Ok(data) => Ok(Some(data)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

/// Upserts the settings JSON string. Keyed on owner, matching the schema's
/// primary key rather than Scriptum's fixed 'app-settings' row id.
#[tauri::command]
pub fn save_settings(state: State<AppState>, data: String) -> Result<(), String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    let owner = common::current_owner(&db);
    db.execute(
        "INSERT INTO settings (owner, data) VALUES (?1, ?2)
         ON CONFLICT(owner) DO UPDATE SET data = excluded.data",
        params![owner, data],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}
