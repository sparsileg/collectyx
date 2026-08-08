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

// Only current_owner exists today. Allow-listing both read and write now,
// while there is one key, avoids an unrestricted read becoming a bigger
// problem than the unrestricted write once real auth state lives here
// (COLLECTYX-SEC-35).
const ALLOWED_KEYS: &[&str] = &["current_owner"];

// Mirrors CONSTANTS.VALIDATION.SHORT_TEXT_MAX (constants.js) — app_meta
// values are short keys/tokens, not free text, so the general short-text
// cap is the right ceiling. common.rs's own validation consts weren't
// available this session to import directly; keep this in sync by hand
// until that's confirmed.
const APP_META_VALUE_MAX: usize = 500;

#[tauri::command]
pub fn get_app_meta(state: State<AppState>, key: String) -> Result<Option<String>, String> {
    if !ALLOWED_KEYS.contains(&key.as_str()) {
        return Err(format!("Unknown app_meta key \"{}\"", key));
    }
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
    if !ALLOWED_KEYS.contains(&key.as_str()) {
        return Err(format!("Unknown app_meta key \"{}\"", key));
    }
    if value.len() > APP_META_VALUE_MAX {
        return Err(format!("Value exceeds {} characters", APP_META_VALUE_MAX));
    }
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.execute(
        "INSERT INTO app_meta (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![key, value],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}
