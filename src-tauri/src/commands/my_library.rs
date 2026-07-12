// my_library.rs

use rusqlite::{params, Result};
use serde::{Deserialize, Serialize};
use tauri::State;
use crate::ScriptumState;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct LibraryBook {
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

    #[serde(rename = "ISBN", skip_serializing_if = "Option::is_none", default)]
    pub isbn: Option<String>,

    #[serde(rename = "Comments", skip_serializing_if = "Option::is_none", default)]
    pub comments: Option<String>,

    /// JSON array string e.g. '["fiction","sci-fi"]'
    #[serde(rename = "Tags", skip_serializing_if = "Option::is_none", default)]
    pub tags: Option<String>,

    /// Bookshelf name or other location (free text)
    #[serde(rename = "Location", skip_serializing_if = "Option::is_none", default)]
    pub location: Option<String>,

    #[serde(rename = "Patron", skip_serializing_if = "Option::is_none", default)]
    pub patron: Option<String>,

    /// YYYY-MM-DD
    #[serde(rename = "CheckedOutDate", skip_serializing_if = "Option::is_none", default)]
    pub checked_out: Option<String>,

    #[serde(rename = "DateAdded", skip_serializing_if = "Option::is_none", default)]
    pub date_added: Option<String>,

    #[serde(rename = "Modified", skip_serializing_if = "Option::is_none", default)]
    pub modified: Option<String>,
}

fn row_to_book(row: &rusqlite::Row) -> Result<LibraryBook> {
    Ok(LibraryBook {
        id:          row.get(0)?,
        title:       row.get(1)?,
        author:      row.get(2)?,
        author2:     row.get(3)?,
        pages:       row.get(4)?,
        category:    row.get(5)?,
        isbn:        row.get(6)?,
        comments:    row.get(7)?,
        tags:        row.get(8)?,
        location:    row.get(9)?,
        patron:      row.get(10)?,
        checked_out: row.get(11)?,
        date_added:  row.get(12)?,
        modified:    row.get(13)?,
    })
}

#[tauri::command]
pub fn get_all_my_library(state: State<ScriptumState>) -> Result<Vec<LibraryBook>, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    let mut stmt = db.prepare(
        "SELECT id, title, author, author2, pages, category, isbn,
                comments, tags, location, patron, checked_out,
                date_added, modified
         FROM my_library
         ORDER BY title ASC"
    ).map_err(|e| e.to_string())?;

    let books = stmt.query_map([], |row| row_to_book(row))
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>>>()
        .map_err(|e| e.to_string())?;

    Ok(books)
}

#[tauri::command]
pub fn save_library_book(state: State<ScriptumState>, book: LibraryBook) -> Result<(), String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.execute(
        "INSERT OR REPLACE INTO my_library
         (id, title, author, author2, pages, category, isbn,
          comments, tags, location, patron, checked_out,
          date_added, modified)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14)",
        params![
            book.id, book.title, book.author, book.author2,
            book.pages, book.category, book.isbn,
            book.comments, book.tags, book.location,
            book.patron, book.checked_out, book.date_added, book.modified
        ],
    ).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn delete_library_book(state: State<ScriptumState>, id: String) -> Result<(), String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.execute("DELETE FROM my_library WHERE id = ?1", params![id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn save_library_bulk(state: State<ScriptumState>, books: Vec<LibraryBook>) -> Result<(), String> {
    let mut db = state.db.lock().map_err(|e| e.to_string())?;
    let tx = db.transaction().map_err(|e| e.to_string())?;
    {
        let mut stmt = tx.prepare(
            "INSERT OR REPLACE INTO my_library
             (id, title, author, author2, pages, category, isbn,
              comments, tags, location, patron, checked_out,
              date_added, modified)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14)"
        ).map_err(|e| e.to_string())?;

        for book in &books {
            stmt.execute(params![
                book.id, book.title, book.author, book.author2,
                book.pages, book.category, book.isbn,
                book.comments, book.tags, book.location,
                book.patron, book.checked_out, book.date_added, book.modified
            ]).map_err(|e| e.to_string())?;
        }
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn clear_my_library(state: State<ScriptumState>) -> Result<(), String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.execute("DELETE FROM my_library", [])
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Atomically replaces all rows in my_library: DELETE + INSERT in a single
/// transaction. See replace_all_books_read for rationale.
#[tauri::command]
pub fn replace_all_my_library(state: State<ScriptumState>, books: Vec<LibraryBook>) -> Result<(), String> {
    let mut db = state.db.lock().map_err(|e| e.to_string())?;
    let tx = db.transaction().map_err(|e| e.to_string())?;
    {
        tx.execute("DELETE FROM my_library", [])
            .map_err(|e| e.to_string())?;

        let mut stmt = tx.prepare(
            "INSERT OR REPLACE INTO my_library
             (id, title, author, author2, pages, category, isbn,
              comments, tags, location, patron, checked_out,
              date_added, modified)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14)"
        ).map_err(|e| e.to_string())?;

        for book in &books {
            stmt.execute(params![
                book.id, book.title, book.author, book.author2,
                book.pages, book.category, book.isbn,
                book.comments, book.tags, book.location,
                book.patron, book.checked_out, book.date_added, book.modified
            ]).map_err(|e| e.to_string())?;
        }
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}
