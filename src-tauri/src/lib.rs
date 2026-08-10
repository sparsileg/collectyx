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
    let mut builder = tauri::Builder::default();

    // Second launch attempt is redirected into the running instance and
    // focuses its window instead of opening a second SQLite connection
    // against the same file — a second process writing concurrently is
    // the root cause of the SQLITE_BUSY exposure (CTX-SEC-113 / #63).
    // Desktop-only; the plugin does not target mobile.
    #[cfg(desktop)]
    {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_focus();
            }
        }));
    }

    let builder = builder
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
        .plugin(tauri_plugin_dialog::init());

    // set_app_meta is the current_owner switch (#59 / CTX-SEC-109). It is
    // only registered at all when the owner-test-switch Cargo feature is
    // on — a shipped build has no IPC path to it, full stop. get_app_meta
    // (read-only) is always registered.
    #[cfg(feature = "owner-test-switch")]
    let builder = builder.invoke_handler(tauri::generate_handler![
        // media_types (read-only reference table)
        commands::media_types::get_all_media_types,
        // items
        commands::items::get_all_items,
        commands::items::save_item,
        commands::items::delete_item,
        commands::items::attach_tag,
        commands::items::detach_tag,
        // count_orphan_items: backend-only for now (COLLECTYX-SEC-39
        // finding 3) — no UI caller yet. Intended for the admin
        // interface's planned Find Orphans capability.
        commands::items::count_orphan_items,
        // merge_items intentionally unregistered — Phase 9 dropped, no
        // caller. Function stays in items.rs, unused. Re-add the owner
        // check (COLLECTYX-SEC-05) if this is ever re-registered.
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
        commands::queued::reorder_queued,
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
        // backup (Tauri-only, writes to the user-configured backup folder)
        commands::backup::save_backup_file,
        // app_meta (not owner-scoped — current_owner testing switch)
        commands::app_meta::get_app_meta,
        commands::app_meta::set_app_meta,
    ]);

    #[cfg(not(feature = "owner-test-switch"))]
    let builder = builder.invoke_handler(tauri::generate_handler![
        // media_types (read-only reference table)
        commands::media_types::get_all_media_types,
        // items
        commands::items::get_all_items,
        commands::items::save_item,
        commands::items::delete_item,
        commands::items::attach_tag,
        commands::items::detach_tag,
        // count_orphan_items: backend-only for now (COLLECTYX-SEC-39
        // finding 3) — no UI caller yet. Intended for the admin
        // interface's planned Find Orphans capability.
        commands::items::count_orphan_items,
        // merge_items intentionally unregistered — Phase 9 dropped, no
        // caller. Function stays in items.rs, unused. Re-add the owner
        // check (COLLECTYX-SEC-05) if this is ever re-registered.
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
        commands::queued::reorder_queued,
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
        // backup (Tauri-only, writes to the user-configured backup folder)
        commands::backup::save_backup_file,
        // app_meta (not owner-scoped — current_owner testing switch).
        // set_app_meta is NOT registered here — see owner-test-switch
        // feature gate above (#59 / CTX-SEC-109).
        commands::app_meta::get_app_meta,
    ]);

    builder
        .run(tauri::generate_context!())
        .unwrap_or_else(|e| panic!("error while running {}: {:?}", APP_NAME, e));
}
