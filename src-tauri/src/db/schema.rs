/// Creates all Collectyx tables.
/// Called from migrations.rs — do not call directly.
///
/// Schema is the normalized design from collectyx-design.md §3.2: one
/// canonical `items` row per physical/logical thing, with `consumed`,
/// `queued`, and `owned` recording collection membership against it.
/// There is deliberately no `category` column anywhere — classification
/// is tags-only, via `tags` + `item_tags`.

/// Reference table, one row per media type. v1 seeds exactly one (Books).
/// The three *_label columns drive UI naming so a second media type is a
/// new row rather than new code.
pub const CREATE_MEDIA_TYPES: &str = "
CREATE TABLE IF NOT EXISTS media_types (
    id              INTEGER PRIMARY KEY,
    name            TEXT NOT NULL,
    consumed_label  TEXT NOT NULL,
    queued_label    TEXT NOT NULL,
    owned_label     TEXT NOT NULL
);";

/// The canonical record. Fields here are intrinsic to the item itself,
/// not to any particular collection membership.
pub const CREATE_ITEMS: &str = "
CREATE TABLE IF NOT EXISTS items (
    id             TEXT PRIMARY KEY,
    owner          TEXT NOT NULL,
    media_type_id  INTEGER NOT NULL REFERENCES media_types(id),
    title          TEXT NOT NULL,
    author         TEXT,
    author2        TEXT,
    pages          INTEGER,
    isbn           TEXT,
    date_added     TEXT,
    modified       TEXT
);";

/// One row per consume event (a read). A re-read is a second row with the
/// same item_id, not a duplicate item.
pub const CREATE_CONSUMED: &str = "
CREATE TABLE IF NOT EXISTS consumed (
    id          TEXT PRIMARY KEY,
    item_id     TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
    finished    TEXT NOT NULL,
    rating      INTEGER,
    comments    TEXT,
    date_added  TEXT,
    modified    TEXT
);";

/// Membership in the to-consume list. No my_library_id column: a queued
/// row and an owned row for the same physical book already share item_id.
pub const CREATE_QUEUED: &str = "
CREATE TABLE IF NOT EXISTS queued (
    id          TEXT PRIMARY KEY,
    item_id     TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
    \"rank\"      INTEGER,
    source      TEXT,
    comments    TEXT,
    date_added  TEXT,
    modified    TEXT
);";

/// Membership in the personal collection.
pub const CREATE_OWNED: &str = "
CREATE TABLE IF NOT EXISTS owned (
    id                TEXT PRIMARY KEY,
    item_id           TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
    location          TEXT,
    patron            TEXT,
    checked_out_date  TEXT,
    comments          TEXT,
    date_added        TEXT,
    modified          TEXT
);";

/// First-class tag entity, not a JSON array on the item.
pub const CREATE_TAGS: &str = "
CREATE TABLE IF NOT EXISTS tags (
    id          TEXT PRIMARY KEY,
    owner       TEXT NOT NULL,
    name        TEXT NOT NULL,
    date_added  TEXT,
    modified    TEXT,
    UNIQUE (owner, name)
);";

pub const CREATE_ITEM_TAGS: &str = "
CREATE TABLE IF NOT EXISTS item_tags (
    item_id  TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
    tag_id   TEXT NOT NULL REFERENCES tags(id)  ON DELETE CASCADE,
    PRIMARY KEY (item_id, tag_id)
);";

/// One row per owner. `data` is a JSON blob (theme, font size, backup
/// folder, dashboard card order, etc).
pub const CREATE_SETTINGS: &str = "
CREATE TABLE IF NOT EXISTS settings (
    owner  TEXT PRIMARY KEY,
    data   TEXT NOT NULL
);";

/// Process-level key/value state — deliberately NOT owner-scoped, since
/// its first use (the `current_owner` testing switch) is exactly the
/// owner-independent bootstrap value that `settings` can't hold without a
/// chicken-and-egg problem. Generic key/value shape so a real auth
/// mechanism (session token, API key hash) can reuse this table later
/// without another migration.
pub const CREATE_APP_META: &str = "
CREATE TABLE IF NOT EXISTS app_meta (
    key    TEXT PRIMARY KEY,
    value  TEXT NOT NULL
);";

/// Indexes on the foreign keys every join traverses.
pub const CREATE_INDEXES: &str = "
CREATE INDEX IF NOT EXISTS idx_items_owner       ON items(owner);
CREATE INDEX IF NOT EXISTS idx_items_media_type  ON items(media_type_id);
CREATE INDEX IF NOT EXISTS idx_consumed_item     ON consumed(item_id);
CREATE INDEX IF NOT EXISTS idx_queued_item       ON queued(item_id);
CREATE INDEX IF NOT EXISTS idx_owned_item        ON owned(item_id);
CREATE INDEX IF NOT EXISTS idx_tags_owner        ON tags(owner);
CREATE INDEX IF NOT EXISTS idx_item_tags_tag     ON item_tags(tag_id);";

/// Seed row for the one media type v1 ships with.
pub const SEED_MEDIA_TYPES: &str = "
INSERT OR IGNORE INTO media_types (id, name, consumed_label, queued_label, owned_label)
VALUES (1, 'Books', 'Books Read', 'To Be Read', 'My Library');";
