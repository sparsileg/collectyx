// reading_list.rs

use rusqlite::{params, Result};
use serde::{Deserialize, Serialize};
use tauri::State;
use crate::ScriptumState;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ReadingListItem {
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

    /// JSON array string e.g. '["to-read","gift"]'
    #[serde(rename = "Tags", skip_serializing_if = "Option::is_none", default)]
    pub tags: Option<String>,

    /// nullable = Unranked
    #[serde(rename = "Rank", skip_serializing_if = "Option::is_none", default)]
    pub rank: Option<i64>,

    /// Links to my_library.id if sourced from library checkout
    #[serde(rename = "MyLibraryId", skip_serializing_if = "Option::is_none", default)]
    pub my_library_id: Option<String>,

    #[serde(rename = "DateAdded", skip_serializing_if = "Option::is_none", default)]
    pub date_added: Option<String>,

    #[serde(rename = "Modified", skip_serializing_if = "Option::is_none", default)]
    pub modified: Option<String>,

    #[serde(rename = "Source", skip_serializing_if = "Option::is_none", default)]
    pub source: Option<String>,

    #[serde(rename = "IsCheckedOut", skip_serializing_if = "Option::is_none", default)]
    pub is_checked_out: Option<bool>,
}

fn row_to_item(row: &rusqlite::Row) -> Result<ReadingListItem> {
    Ok(ReadingListItem {
        id:            row.get(0)?,
        title:         row.get(1)?,
        author:        row.get(2)?,
        author2:       row.get(3)?,
        pages:         row.get(4)?,
        category:      row.get(5)?,
        isbn:          row.get(6)?,
        comments:      row.get(7)?,
        tags:          row.get(8)?,
        rank:          row.get(9)?,
        my_library_id: row.get(10)?,
        date_added:    row.get(11)?,
        modified:      row.get(12)?,
        source:        row.get(13)?,
        is_checked_out: row.get(14)?,
    })
}

#[tauri::command]
pub fn get_all_reading_list(state: State<ScriptumState>) -> Result<Vec<ReadingListItem>, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    let mut stmt = db.prepare(
        "SELECT id, title, author, author2, pages, category, isbn,
                comments, tags, rank, my_library_id, date_added, modified,
                source, is_checked_out
         FROM reading_list
         ORDER BY rank ASC NULLS LAST"
    ).map_err(|e| e.to_string())?;

    let items = stmt.query_map([], |row| row_to_item(row))
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>>>()
        .map_err(|e| e.to_string())?;

    Ok(items)
}

#[tauri::command]
pub fn save_reading_list_item(state: State<ScriptumState>, item: ReadingListItem) -> Result<(), String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.execute(
        "INSERT OR REPLACE INTO reading_list
         (id, title, author, author2, pages, category, isbn,
          comments, tags, rank, my_library_id, date_added, modified,
          source, is_checked_out)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15)",
        params![
            item.id, item.title, item.author, item.author2,
            item.pages, item.category, item.isbn,
            item.comments, item.tags, item.rank,
            item.my_library_id, item.date_added, item.modified,
            item.source, item.is_checked_out
        ],
    ).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn delete_reading_list_item(state: State<ScriptumState>, id: String) -> Result<(), String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.execute("DELETE FROM reading_list WHERE id = ?1", params![id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn save_reading_list_bulk(state: State<ScriptumState>, items: Vec<ReadingListItem>) -> Result<(), String> {
    let mut db = state.db.lock().map_err(|e| e.to_string())?;
    let tx = db.transaction().map_err(|e| e.to_string())?;
    {
        let mut stmt = tx.prepare(
            "INSERT OR REPLACE INTO reading_list
             (id, title, author, author2, pages, category, isbn,
              comments, tags, rank, my_library_id, date_added, modified,
              source, is_checked_out)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15)"
        ).map_err(|e| e.to_string())?;

        for item in &items {
            stmt.execute(params![
                item.id, item.title, item.author, item.author2,
                item.pages, item.category, item.isbn,
                item.comments, item.tags, item.rank,
                item.my_library_id, item.date_added, item.modified,
                item.source, item.is_checked_out
            ]).map_err(|e| e.to_string())?;
        }
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn clear_reading_list(state: State<ScriptumState>) -> Result<(), String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.execute("DELETE FROM reading_list", [])
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Atomically replaces all rows in reading_list: DELETE + INSERT in a single
/// transaction. See replace_all_books_read for rationale.
#[tauri::command]
pub fn replace_all_reading_list(state: State<ScriptumState>, items: Vec<ReadingListItem>) -> Result<(), String> {
    let mut db = state.db.lock().map_err(|e| e.to_string())?;
    let tx = db.transaction().map_err(|e| e.to_string())?;
    {
        tx.execute("DELETE FROM reading_list", [])
            .map_err(|e| e.to_string())?;

        let mut stmt = tx.prepare(
            "INSERT OR REPLACE INTO reading_list
             (id, title, author, author2, pages, category, isbn,
              comments, tags, rank, my_library_id, date_added, modified,
              source, is_checked_out)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15)"
        ).map_err(|e| e.to_string())?;

        for item in &items {
            stmt.execute(params![
                item.id, item.title, item.author, item.author2,
                item.pages, item.category, item.isbn,
                item.comments, item.tags, item.rank,
                item.my_library_id, item.date_added, item.modified,
                item.source, item.is_checked_out
            ]).map_err(|e| e.to_string())?;
        }
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}
