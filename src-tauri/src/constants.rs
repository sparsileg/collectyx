
/// Application name — used for the OS app data directory.
pub const APP_NAME: &str = "Scriptum";

/// SQLite database filename.
pub const DB_FILE_NAME: &str = "scriptum.db";

/// Current schema version. Increment when adding a new migration.
pub const CURRENT_SCHEMA_VERSION: u32 = 1;

/// Date format used throughout storage (YYYY-MM-DD).
#[allow(dead_code)]
pub const DATE_FORMAT: &str = "%Y-%m-%d";
