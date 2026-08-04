// settings.rs — one JSON blob row per owner.

use rusqlite::params;
use tauri::State;

use crate::constants::DEFAULT_OWNER;
use crate::AppState;

/// Returns the settings JSON string for an owner, or null if not yet set.
#[tauri::command]
pub fn get_settings(state: State<AppState>) -> Result<Option<String>, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    let result = db.query_row(
        "SELECT data FROM settings WHERE owner = ?1",
        params![DEFAULT_OWNER],
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
    db.execute(
        "INSERT INTO settings (owner, data) VALUES (?1, ?2)
         ON CONFLICT(owner) DO UPDATE SET data = excluded.data",
        params![DEFAULT_OWNER, data],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}
