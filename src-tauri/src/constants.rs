
/// Application name — used for the OS app data directory.
pub const APP_NAME: &str = "Collectyx";

/// SQLite database filename.
pub const DB_FILE_NAME: &str = "collectyx.db";

/// Current schema version. Increment when adding a new migration.
pub const CURRENT_SCHEMA_VERSION: u32 = 2;

/// app_meta key holding the currently-active owner (testing feature —
/// switches which owner's rows every command scopes to). Not owner-scoped
/// itself; see db/schema.rs's CREATE_APP_META.
pub const APP_META_CURRENT_OWNER_KEY: &str = "current_owner";

/// Owner value used for every row in v1.
///
/// The schema carries `owner` on items/tags/settings from day one so a
/// future multi-user D1 sync doesn't require a migration, but v1 has no
/// auth and no user switching — every row is written and read under this
/// single value.
pub const DEFAULT_OWNER: &str = "local";

/// Date format used throughout storage (YYYY-MM-DD).
#[allow(dead_code)]
pub const DATE_FORMAT: &str = "%Y-%m-%d";
