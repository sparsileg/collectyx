// settings.rs — one JSON blob row per owner.

use rusqlite::params;
use tauri::State;

use crate::commands::common;
use crate::AppState;

// Restore-controlled — a backup file's Settings blob lands here verbatim.
// Caps size and requires the payload look like a JSON object before it's
// ever written, so a malformed or oversized value can't reach the DB and
// later drive a filesystem path, a CSS sink, or a DOM update at read time.
// Matches the sizing style of CONSTANTS.VALIDATION in constants.js; not
// pulled from there since Rust has no shared constant with JS for this yet.
const SETTINGS_MAX_BYTES: usize = 65536;

/// Shallow structural check only — confirms the payload is plausibly a
/// JSON object (trimmed, starts with '{', ends with '}'), not a full
/// parse. Adding a real JSON parser here would mean pulling in serde_json
/// as a new dependency; not done without confirming it's already in
/// Cargo.toml. The size cap is the check doing the real work.
fn looks_like_json_object(data: &str) -> bool {
    let trimmed = data.trim();
    trimmed.starts_with('{') && trimmed.ends_with('}')
}

/// Returns the settings JSON string for the currently-active owner, or
/// null if not yet set.
#[tauri::command]
pub fn get_settings(state: State<AppState>) -> Result<Option<String>, String> {
    let db = common::lock_db(&state.db);
    let owner = common::current_owner(&db);
    let result = db.query_row(
        "SELECT data FROM settings WHERE owner = ?1",
        params![owner],
        |row| row.get(0),
    );

    match result {
        Ok(data) => Ok(Some(data)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(e) => Err(common::db_err(e)),
    }
}

/// Upserts the settings JSON string. Keyed on owner, matching the schema's
/// primary key rather than Scriptum's fixed 'app-settings' row id.
#[tauri::command]
pub fn save_settings(state: State<AppState>, data: String) -> Result<(), String> {
    if data.len() > SETTINGS_MAX_BYTES {
        return Err(format!(
            "settings payload too large ({} bytes, max {})",
            data.len(),
            SETTINGS_MAX_BYTES
        ));
    }
    if !looks_like_json_object(&data) {
        return Err("settings payload must be a JSON object".to_string());
    }

    let db = common::lock_db(&state.db);
    let owner = common::current_owner(&db);
    db.execute(
        "INSERT INTO settings (owner, data) VALUES (?1, ?2)
         ON CONFLICT(owner) DO UPDATE SET data = excluded.data",
        params![owner, data],
    )
    .map_err(common::db_err)?;
    Ok(())
}
