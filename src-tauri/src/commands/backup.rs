// backup.rs — writes the Backup Database payload to the user-configured
// backup folder. Plain std::fs, not the fs plugin: Rust-side file I/O is
// not capability/scope-gated the way the JS-facing fs plugin is, so this
// avoids needing a broad filesystem scope grant for an arbitrary
// user-picked path (see issue 43).
//
// CTX-SEC-101: the destination directory is never accepted from the
// caller. It is read from the active owner's own settings row, which
// this backend already controls. The caller supplies only a bare
// filename, validated and confined to that directory.

use std::fs;
use std::path::{Component, Path};

use rusqlite::params;
use tauri::State;

use crate::commands::common;
use crate::AppState;

const MAX_BACKUP_BYTES: usize = 100 * 1024 * 1024;

/// Filename only — no separators, no traversal, no absolute paths.
fn validate_filename(name: &str) -> Result<(), String> {
    if name.is_empty() || name.len() > 255 {
        return Err("Invalid backup filename".to_string());
    }
    if Path::new(name).components().count() != 1
        || name.contains('/')
        || name.contains('\\')
        || name.contains("..")
        || name.contains('\0')
    {
        return Err("Invalid backup filename".to_string());
    }
    if !(name.ends_with(".json") || name.ends_with(".json.gz")) {
        return Err("Backup filename must end in .json or .json.gz".to_string());
    }
    Ok(())
}

/// Reads the active owner's configured backup folder out of the settings
/// row this backend already owns — never trusted from the payload.
fn backup_folder(conn: &rusqlite::Connection, owner: &str) -> Result<String, String> {
    let data: Option<String> = conn
        .query_row(
            "SELECT data FROM settings WHERE owner = ?1",
            params![owner],
            |row| row.get(0),
        )
        .ok();

    let data = data.ok_or_else(|| {
        "Backup folder is not set — set it in Settings before backing up.".to_string()
    })?;

    let json: serde_json::Value =
        serde_json::from_str(&data).map_err(|_| "Could not read settings".to_string())?;

    let folder = json
        .get("backupFolder")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();

    if folder.is_empty() {
        return Err("Backup folder is not set — set it in Settings before backing up.".to_string());
    }
    Ok(folder)
}

#[tauri::command]
pub fn save_backup_file(
    state: State<AppState>,
    filename: String,
    contents: Vec<u8>,
) -> Result<(), String> {
    validate_filename(&filename)?;
    if contents.len() > MAX_BACKUP_BYTES {
        return Err("Backup exceeds maximum size".to_string());
    }

    let conn = common::lock_db(&state.db);
    let owner = common::current_owner(&conn);
    let folder = backup_folder(&conn, &owner)?;
    drop(conn);

    let base = fs::canonicalize(&folder)
        .map_err(|_| "Backup folder is missing or inaccessible".to_string())?;
    if !base.is_dir() {
        return Err("Backup folder is not a directory".to_string());
    }

    let target = base.join(&filename);

    let parent = target.parent().ok_or("Invalid backup path")?;
    let parent = fs::canonicalize(parent)
        .map_err(|_| "Backup folder is missing or inaccessible".to_string())?;
    if parent != base {
        return Err("Refusing to write outside the backup folder".to_string());
    }
    if target
        .components()
        .any(|c| matches!(c, Component::ParentDir))
    {
        return Err("Refusing to write outside the backup folder".to_string());
    }
    if target
        .symlink_metadata()
        .map(|m| m.file_type().is_symlink())
        .unwrap_or(false)
    {
        return Err("Refusing to overwrite a symlink".to_string());
    }

    fs::write(&target, contents).map_err(|e| e.to_string())
}
