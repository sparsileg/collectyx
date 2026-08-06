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
            // media_types (read-only reference table)
            commands::media_types::get_all_media_types,
            // items
            commands::items::get_all_items,
            commands::items::save_item,
            commands::items::delete_item,
            commands::items::attach_tag,
            commands::items::detach_tag,
            commands::items::merge_items,
            // consumed (Books Read)
            commands::consumed::get_all_consumed,
            commands::consumed::save_consumed,
            commands::consumed::delete_consumed,
            commands::consumed::replace_all_consumed,
            // queued (To Be Read)
            commands::queued::get_all_queued,
            commands::queued::save_queued,
            commands::queued::delete_queued,
            commands::queued::replace_all_queued,
            commands::queued::toggle_currently_reading,
            // owned (My Library)
            commands::owned::get_all_owned,
            commands::owned::save_owned,
            commands::owned::delete_owned,
            commands::owned::replace_all_owned,
            // tags
            commands::tags::get_all_tags,
            commands::tags::save_tag,
            commands::tags::delete_tag,
            commands::tags::replace_all_tags,
            // settings
            commands::settings::get_settings,
            commands::settings::save_settings,
            // app_meta (not owner-scoped — current_owner testing switch)
            commands::app_meta::get_app_meta,
            commands::app_meta::set_app_meta,
        ])
        .run(tauri::generate_context!())
        .unwrap_or_else(|e| panic!("error while running {}: {:?}", APP_NAME, e));
}
