// settings.rs

use rusqlite::params;
use tauri::State;
use crate::AppState;

const SETTINGS_KEY: &str = "app-settings";

/// Returns the settings JSON string, or null if not yet set.
#[tauri::command]
pub fn get_settings(state: State<AppState>) -> Result<Option<String>, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    let result = db.query_row(
        "SELECT data FROM settings WHERE id = ?1",
        params![SETTINGS_KEY],
        |row| row.get(0),
    );

    match result {
        Ok(data) => Ok(Some(data)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

/// Upserts the settings JSON string.
#[tauri::command]
pub fn save_settings(state: State<AppState>, data: String) -> Result<(), String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.execute(
        "INSERT OR REPLACE INTO settings (id, data) VALUES (?1, ?2)",
        params![SETTINGS_KEY, data],
    ).map_err(|e| e.to_string())?;
    Ok(())
}
