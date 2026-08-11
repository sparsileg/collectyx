use rusqlite::{Connection, Result};
use crate::constants::{CURRENT_SCHEMA_VERSION, APP_NAME};
use crate::db::schema;

/// Runs all pending migrations against the open connection.
/// Uses SQLite's PRAGMA user_version to track the applied schema version.
pub fn run_migrations(conn: &Connection) -> Result<()> {
    let mut version = get_schema_version(conn)?;
    log::info!("Database schema version: {}", version);

    // A binary at CURRENT_SCHEMA_VERSION opening a database written by a
    // newer build must refuse outright rather than proceed against a
    // schema it doesn't understand — the shape that corrupts data on a
    // downgrade or a sync rollback (COLLECTYX-SEC-38 item 4). No migration
    // runs in this case.
    if version > CURRENT_SCHEMA_VERSION {
        log::error!(
            "{} database schema version {} is newer than this build supports (expected {})",
            APP_NAME, version, CURRENT_SCHEMA_VERSION
        );
        panic!(
            "This database was created by a newer version of {}. \
             Please update the application, or restore from a compatible backup.",
            APP_NAME
        );
    }

    if version < 1 {
        migrate_v1(conn)?;
        version = 1;
    }
    if version < 2 {
        migrate_v2(conn)?;
        version = 2;
    }
    if version < 3 {
        migrate_v3(conn)?;
        version = 3;
    }
    let _ = version;

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

/// Migration v2 — additive: the `app_meta` key/value table (owner-switch
/// testing, and a home for real auth state later) plus a
/// `currently_reading` flag on `queued`. Neither touches existing data.
fn migrate_v2(conn: &Connection) -> Result<()> {
    log::info!("Running migration v2 — app_meta table, queued.currently_reading");

    conn.execute_batch(&format!(
        "BEGIN;
        {}
        ALTER TABLE queued ADD COLUMN currently_reading INTEGER NOT NULL DEFAULT 0;
        PRAGMA user_version = 2;
        COMMIT;",
        schema::CREATE_APP_META,
    ))?;

    log::info!("Migration v2 complete");
    Ok(())
}

/// Migration v3 — drops consumed.recommend. Legacy field: superseded by
/// the 1-5 Rating column, never had a UI writer or reader in Collectyx,
/// and no data migration was ever built for it (CTX-SEC-121).
///
/// Guarded on the column actually existing: a fresh install runs
/// migrate_v1 against the current schema.rs, which no longer creates
/// this column at all — nothing to drop there. Only a database that ran
/// the old migrate_v1 (schema v1 or v2) has the column.
fn migrate_v3(conn: &Connection) -> Result<()> {
    log::info!("Running migration v3 — drop consumed.recommend (legacy field)");

    let has_recommend: bool = conn
        .prepare("SELECT 1 FROM pragma_table_info('consumed') WHERE name = 'recommend'")?
        .exists([])?;

    if has_recommend {
        // Requires SQLite 3.35.0+ (ALTER TABLE ... DROP COLUMN). rusqlite's
        // bundled SQLite is well past this; flagging for the record since
        // it's the first DROP COLUMN in this codebase.
        conn.execute_batch(
            "BEGIN;
            ALTER TABLE consumed DROP COLUMN recommend;
            PRAGMA user_version = 3;
            COMMIT;",
        )?;
    } else {
        conn.execute("PRAGMA user_version = 3", [])?;
    }

    log::info!("Migration v3 complete");
    Ok(())
}

fn get_schema_version(conn: &Connection) -> Result<u32> {
    // SQLite stores user_version as a signed 32-bit integer; reading it
    // directly as u32 fails with an opaque conversion error on a negative
    // value instead of a clear message (COLLECTYX-SEC-38 item 4).
    let version: i64 = conn.query_row(
        "PRAGMA user_version",
        [],
        |row| row.get(0),
    )?;
    if version < 0 {
        log::error!(
            "{} database schema version is negative ({}) — the database file is corrupt",
            APP_NAME, version
        );
        panic!("The {} database file appears to be corrupt", APP_NAME);
    }
    Ok(version as u32)
}

/// Returns the current schema version constant for reference.
#[allow(dead_code)]
pub fn current_version() -> u32 {
    CURRENT_SCHEMA_VERSION
}
