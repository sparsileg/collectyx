// lib.rs

use std::sync::Mutex;
use rusqlite::Connection;
use tauri::Manager;

mod constants;
mod db;
mod commands;

use constants::APP_NAME;

/// Application state — a single SQLite connection shared across all commands.
pub struct AppState {
    pub db: Mutex<Connection>,
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            // Logging (debug builds only)
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }

            // Open (or create) the SQLite database and run migrations
            let conn = db::open_db(app.handle())
                .unwrap_or_else(|e| panic!("Failed to open {} database: {:?}", APP_NAME, e));

            db::migrations::run_migrations(&conn)
                .expect("Failed to run database migrations");

            app.manage(AppState {
                db: Mutex::new(conn),
            });

            Ok(())
        })
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_persisted_scope::init())
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![
            // books_read
            commands::books_read::get_all_books_read,
            commands::books_read::save_book_read,
            commands::books_read::delete_book_read,
            commands::books_read::save_books_read_bulk,
            commands::books_read::clear_books_read,
            commands::books_read::replace_all_books_read,
            // reading_list
            commands::reading_list::get_all_reading_list,
            commands::reading_list::save_reading_list_item,
            commands::reading_list::delete_reading_list_item,
            commands::reading_list::save_reading_list_bulk,
            commands::reading_list::clear_reading_list,
            commands::reading_list::replace_all_reading_list,
            // my_library
            commands::my_library::get_all_my_library,
            commands::my_library::save_library_book,
            commands::my_library::delete_library_book,
            commands::my_library::save_library_bulk,
            commands::my_library::clear_my_library,
            commands::my_library::replace_all_my_library,
            // settings
            commands::settings::get_settings,
            commands::settings::save_settings,
        ])
        .run(tauri::generate_context!())
        .unwrap_or_else(|e| panic!("error while running {}: {:?}", APP_NAME, e));
}
