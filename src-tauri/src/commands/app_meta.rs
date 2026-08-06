// app_meta.rs — process-level key/value state, deliberately not
// owner-scoped.
//
// First use is the `current_owner` testing switch (Settings → Owner
// (Testing), temporary UI). Kept generic — key/value, not a dedicated
// column — so a real auth mechanism (session token, API key hash) can
// reuse this table later without another migration.

use rusqlite::params;
use tauri::State;

use crate::AppState;

#[tauri::command]
pub fn get_app_meta(state: State<AppState>, key: String) -> Result<Option<String>, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    let result = db.query_row(
        "SELECT value FROM app_meta WHERE key = ?1",
        params![key],
        |row| row.get(0),
    );

    match result {
        Ok(value) => Ok(Some(value)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
pub fn set_app_meta(state: State<AppState>, key: String, value: String) -> Result<(), String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.execute(
        "INSERT INTO app_meta (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![key, value],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}
