pub mod migrations;
pub mod schema;

use rusqlite::{Connection, Result};
use tauri::AppHandle;
use crate::constants::{APP_NAME, DB_FILE_NAME};

/// Opens (or creates) the Collectyx SQLite database in the OS app data directory.
/// Enables WAL mode, foreign keys, and synchronous=NORMAL for performance.
pub fn open_db(_app: &AppHandle) -> Result<Connection> {
    let data_dir = dirs_next::data_dir()
        .unwrap_or_else(|| {
            log::error!("open_db: dirs_next::data_dir() returned None — could not resolve OS app data directory");
            panic!("Could not resolve the application data directory");
        })
        .join(APP_NAME);

    std::fs::create_dir_all(&data_dir).unwrap_or_else(|e| {
        log::error!("open_db: could not create data directory {}: {:?}", data_dir.display(), e);
        panic!("Could not create the application data directory");
    });

    let db_path = data_dir.join(DB_FILE_NAME);
    log::info!("Opening database at: {}", db_path.display());

    let conn = Connection::open(&db_path)?;

    // Waits up to 5s for a lock instead of failing immediately with
    // SQLITE_BUSY — the default is 0. Doesn't replace the single-instance
    // guard (lib.rs), which prevents the concurrent-writer case outright;
    // this is a second layer for any write contention that guard doesn't
    // cover, e.g. WAL checkpointing (CTX-SEC-113 / #63).
    conn.busy_timeout(std::time::Duration::from_secs(5))?;

    // Performance and reliability pragmas
    conn.execute_batch("
        PRAGMA journal_mode = WAL;
        PRAGMA foreign_keys = ON;
        PRAGMA synchronous = NORMAL;
    ")?;

    Ok(conn)
}
