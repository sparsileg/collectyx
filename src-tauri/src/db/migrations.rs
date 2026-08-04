use rusqlite::{Connection, Result};
use crate::constants::{CURRENT_SCHEMA_VERSION, APP_NAME};
use crate::db::schema;

/// Runs all pending migrations against the open connection.
/// Uses SQLite's PRAGMA user_version to track the applied schema version.
pub fn run_migrations(conn: &Connection) -> Result<()> {
    let version = get_schema_version(conn)?;
    log::info!("Database schema version: {}", version);

    if version < 1 {
        migrate_v1(conn)?;
    }

    Ok(())
}

/// Migration v1 — the normalized Collectyx schema: all eight tables plus
/// the single seeded media_types row.
///
/// Scriptum's flat books_read/reading_list/my_library tables are not
/// created and not migrated from; Collectyx starts clean and takes
/// Scriptum data through the one-time importer instead.
fn migrate_v1(conn: &Connection) -> Result<()> {
    log::info!("Running migration v1 — creating {} tables", APP_NAME);

    conn.execute_batch(&format!(
        "BEGIN;
        {}
        {}
        {}
        {}
        {}
        {}
        {}
        {}
        {}
        {}
        PRAGMA user_version = 1;
        COMMIT;",
        schema::CREATE_MEDIA_TYPES,
        schema::CREATE_ITEMS,
        schema::CREATE_CONSUMED,
        schema::CREATE_QUEUED,
        schema::CREATE_OWNED,
        schema::CREATE_TAGS,
        schema::CREATE_ITEM_TAGS,
        schema::CREATE_SETTINGS,
        schema::CREATE_INDEXES,
        schema::SEED_MEDIA_TYPES,
    ))?;

    log::info!("Migration v1 complete");
    Ok(())
}

fn get_schema_version(conn: &Connection) -> Result<u32> {
    let version: u32 = conn.query_row(
        "PRAGMA user_version",
        [],
        |row| row.get(0),
    )?;
    Ok(version)
}

/// Returns the current schema version constant for reference.
#[allow(dead_code)]
pub fn current_version() -> u32 {
    CURRENT_SCHEMA_VERSION
}
