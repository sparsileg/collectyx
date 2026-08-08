// backup.rs — writes the Backup Database payload to the user-configured
// backup folder. Plain std::fs, not the fs plugin: Rust-side file I/O is
// not capability/scope-gated the way the JS-facing fs plugin is, so this
// avoids needing a broad filesystem scope grant for an arbitrary
// user-picked path (see issue 43).

use std::fs;

#[tauri::command]
pub fn save_backup_file(path: String, contents: Vec<u8>) -> Result<(), String> {
    fs::write(&path, contents).map_err(|e| e.to_string())
}
