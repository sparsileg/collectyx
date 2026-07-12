// books_read.rs

use rusqlite::{params, Result};
use serde::{Deserialize, Serialize};
use tauri::State;
use crate::ScriptumState;

/// Mirrors the JS books_read object.
/// serde rename maps capitalised JS field names to lowercase SQL columns.
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct BookRead {
    pub id: String,

    #[serde(rename = "Title")]
    pub title: String,

    #[serde(rename = "Author")]
    pub author: String,

    #[serde(rename = "Author2", skip_serializing_if = "Option::is_none", default)]
    pub author2: Option<String>,

    #[serde(rename = "Pages", skip_serializing_if = "Option::is_none", default)]
    pub pages: Option<i64>,

    #[serde(rename = "Category", skip_serializing_if = "Option::is_none", default)]
    pub category: Option<String>,

    /// 0 = No, 1 = Yes
    #[serde(rename = "Recommend", skip_serializing_if = "Option::is_none", default)]
    pub recommend: Option<i64>,

    #[serde(rename = "ISBN", skip_serializing_if = "Option::is_none", default)]
    pub isbn: Option<String>,

    #[serde(rename = "Comments", skip_serializing_if = "Option::is_none", default)]
    pub comments: Option<String>,

    /// JSON array string e.g. '["fiction","sci-fi"]'
    #[serde(rename = "Tags", skip_serializing_if = "Option::is_none", default)]
    pub tags: Option<String>,

    /// YYYY-MM-DD
    #[serde(rename = "Finished")]
    pub finished: String,

    /// 1-10
    #[serde(rename = "Rating", skip_serializing_if = "Option::is_none", default)]
    pub rating: Option<i64>,

    #[serde(rename = "CoverUrl", skip_serializing_if = "Option::is_none", default)]
    pub cover_url: Option<String>,

    #[serde(rename = "DateAdded", skip_serializing_if = "Option::is_none", default)]
    pub date_added: Option<String>,

    #[serde(rename = "Modified", skip_serializing_if = "Option::is_none", default)]
    pub modified: Option<String>,
}

fn row_to_book(row: &rusqlite::Row) -> Result<BookRead> {
    Ok(BookRead {
        id:         row.get(0)?,
        title:      row.get(1)?,
        author:     row.get(2)?,
        author2:    row.get(3)?,
        pages:      row.get(4)?,
        category:   row.get(5)?,
        recommend:  row.get(6)?,
        isbn:       row.get(7)?,
        comments:   row.get(8)?,
        tags:       row.get(9)?,
        finished:   row.get(10)?,
        rating:     row.get(11)?,
        cover_url:  row.get(12)?,
        date_added: row.get(13)?,
        modified:   row.get(14)?,
    })
}

#[tauri::command]
pub fn get_all_books_read(state: State<ScriptumState>) -> Result<Vec<BookRead>, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    let mut stmt = db.prepare(
        "SELECT id, title, author, author2, pages, category, recommend,
                isbn, comments, tags, finished, rating, cover_url,
                date_added, modified
         FROM books_read
         ORDER BY finished DESC, date_added DESC"
    ).map_err(|e| e.to_string())?;

    let books = stmt.query_map([], |row| row_to_book(row))
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>>>()
        .map_err(|e| e.to_string())?;

    Ok(books)
}

#[tauri::command]
pub fn save_book_read(state: State<ScriptumState>, book: BookRead) -> Result<(), String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.execute(
        "INSERT OR REPLACE INTO books_read
         (id, title, author, author2, pages, category, recommend,
          isbn, comments, tags, finished, rating, cover_url,
          date_added, modified)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15)",
        params![
            book.id, book.title, book.author, book.author2,
            book.pages, book.category, book.recommend,
            book.isbn, book.comments, book.tags, book.finished,
            book.rating, book.cover_url, book.date_added, book.modified
        ],
    ).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn delete_book_read(state: State<ScriptumState>, id: String) -> Result<(), String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.execute("DELETE FROM books_read WHERE id = ?1", params![id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn save_books_read_bulk(state: State<ScriptumState>, books: Vec<BookRead>) -> Result<(), String> {
    let mut db = state.db.lock().map_err(|e| e.to_string())?;
    let tx = db.transaction().map_err(|e| e.to_string())?;
    {
        let mut stmt = tx.prepare(
            "INSERT OR REPLACE INTO books_read
             (id, title, author, author2, pages, category, recommend,
              isbn, comments, tags, finished, rating, cover_url,
              date_added, modified)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15)"
        ).map_err(|e| e.to_string())?;

        for book in &books {
            stmt.execute(params![
                book.id, book.title, book.author, book.author2,
                book.pages, book.category, book.recommend,
                book.isbn, book.comments, book.tags, book.finished,
                book.rating, book.cover_url, book.date_added, book.modified
            ]).map_err(|e| e.to_string())?;
        }
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn clear_books_read(state: State<ScriptumState>) -> Result<(), String> {
    log::warn!("clear_books_read called — deleting all rows from books_read");
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.execute("DELETE FROM books_read", [])
        .map_err(|e| e.to_string())?;
    log::warn!("clear_books_read complete");
    Ok(())
}

/// Atomically replaces all rows in books_read: DELETE + INSERT in a single
/// transaction. If any row fails to insert (e.g. serialization mismatch),
/// the whole transaction rolls back and the table is left unchanged —
/// unlike the old clear() + putBulk() two-invoke sequence, which could
/// leave the table empty if putBulk failed after clear() had already committed.
#[tauri::command]
pub fn replace_all_books_read(state: State<ScriptumState>, books: Vec<BookRead>) -> Result<(), String> {
    let mut db = state.db.lock().map_err(|e| e.to_string())?;
    let tx = db.transaction().map_err(|e| e.to_string())?;
    {
        tx.execute("DELETE FROM books_read", [])
            .map_err(|e| e.to_string())?;

        let mut stmt = tx.prepare(
            "INSERT OR REPLACE INTO books_read
             (id, title, author, author2, pages, category, recommend,
              isbn, comments, tags, finished, rating, cover_url,
              date_added, modified)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15)"
        ).map_err(|e| e.to_string())?;

        for book in &books {
            stmt.execute(params![
                book.id, book.title, book.author, book.author2,
                book.pages, book.category, book.recommend,
                book.isbn, book.comments, book.tags, book.finished,
                book.rating, book.cover_url, book.date_added, book.modified
            ]).map_err(|e| e.to_string())?;
        }
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}
