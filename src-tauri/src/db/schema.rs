/// Creates all Collectyx tables.
/// Called from migrations.rs — do not call directly.
pub const CREATE_BOOKS_READ: &str = "
CREATE TABLE IF NOT EXISTS books_read (
    id            TEXT PRIMARY KEY,
    title         TEXT NOT NULL,
    author        TEXT NOT NULL,
    author2       TEXT,
    pages         INTEGER,
    category      TEXT,
    recommend     INTEGER,          -- 0/1 boolean
    isbn          TEXT,
    comments      TEXT,
    tags          TEXT,             -- JSON array e.g. '[\"fiction\",\"sci-fi\"]'
    finished      TEXT NOT NULL,    -- YYYY-MM-DD
    rating        INTEGER,          -- 1-10
    cover_url     TEXT,
    date_added    TEXT,             -- YYYY-MM-DD
    modified      TEXT              -- YYYY-MM-DD
);";

pub const CREATE_READING_LIST: &str = "
CREATE TABLE IF NOT EXISTS reading_list (
    id              TEXT PRIMARY KEY,
    title           TEXT NOT NULL,
    author          TEXT NOT NULL,
    author2         TEXT,
    pages           INTEGER,
    category        TEXT,
    isbn            TEXT,
    comments        TEXT,
    tags            TEXT,             -- JSON array e.g. '[\"to-read\",\"gift\"]'
    rank            INTEGER,          -- nullable = Unranked
    my_library_id   TEXT,             -- links to my_library.id if sourced from library
    date_added      TEXT,             -- YYYY-MM-DD
    modified        TEXT              -- YYYY-MM-DD
);";

pub const CREATE_MY_LIBRARY: &str = "
CREATE TABLE IF NOT EXISTS my_library (
    id            TEXT PRIMARY KEY,
    title         TEXT NOT NULL,
    author        TEXT NOT NULL,
    author2       TEXT,
    pages         INTEGER,
    category      TEXT,
    isbn          TEXT,
    comments      TEXT,
    tags          TEXT,             -- JSON array e.g. '[\"fiction\",\"sci-fi\"]'
    location      TEXT,             -- bookshelf name or other location (free text)
    patron        TEXT,             -- name of person who borrowed the book
    checked_out   TEXT,             -- YYYY-MM-DD
    date_added    TEXT,             -- YYYY-MM-DD
    modified      TEXT              -- YYYY-MM-DD
);";

/// Settings: single JSON blob row keyed by 'app-settings'.
/// Holds theme, daily_reading_pages, categories list, and any future settings.
pub const CREATE_SETTINGS: &str = "
CREATE TABLE IF NOT EXISTS settings (
    id    TEXT PRIMARY KEY,
    data  TEXT NOT NULL
);";
