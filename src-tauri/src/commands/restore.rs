// restore.rs — atomic full-database restore (#40).
//
// Wraps the wipe-and-write of items/consumed/queued/owned/tags/item_tags
// (plus settings) in one transaction, so a failure partway through leaves
// the pre-restore state completely unchanged — replacing the old
// per-collection replace_all_* sequence backup-restore.js drove
// individually, and the JS-level snapshot/rollback simulation that sat in
// front of it.
//
// Tags: the incoming Tags array is not written directly here, matching
// the existing restore contract confirmed under #80 — tags are recreated
// implicitly through each Consumed/Queued/Owned record's own embedded
// Tags list, via reconcile_tags (the same helper write_one already uses).
// RestorePayload therefore has no Tags field.
//
// replace_all_consumed/queued/owned/tags stay registered and unchanged —
// they still cover single-collection use cases (e.g. a future CSV import
// into one collection) that don't need cross-table atomicity. This
// command is additive, not a replacement for those.

use rusqlite::{params, Result};
use serde::Deserialize;
use serde_json::Map as JsonMap;
use tauri::State;

use crate::commands::common;
use crate::commands::consumed::{self, ConsumedRecord};
use crate::commands::items::{self, ItemRecord};
use crate::commands::owned::{self, OwnedRecord};
use crate::commands::queued::{self, QueuedRecord};
use crate::AppState;

#[derive(Debug, Deserialize)]
pub struct RestorePayload {
    #[serde(rename = "Items", default)]
    pub items: Vec<ItemRecord>,

    #[serde(rename = "Consumed", default)]
    pub consumed: Vec<ConsumedRecord>,

    #[serde(rename = "Queued", default)]
    pub queued: Vec<QueuedRecord>,

    #[serde(rename = "Owned", default)]
    pub owned: Vec<OwnedRecord>,

    // Raw JSON, filtered through ALLOWED_SETTINGS_KEYS before it's ever
    // written — same allow-list backup-restore.js's pre-#40 _writeAll()
    // used (CTX-SEC-111 / #61). backupFolder is never restored from a
    // file (CTX-SEC-101); it isn't in the allow-list at all.
    #[serde(rename = "Settings", default)]
    pub settings: Option<serde_json::Value>,
}

const ALLOWED_SETTINGS_KEYS: &[&str] = &[
    "dailyReadingGoal",
    "dateFormat",
    "fontSize",
    "displayTheme",
    "dashboardCardOrder",
];

#[tauri::command]
pub fn restore_all(state: State<AppState>, payload: RestorePayload) -> Result<(), String> {
    let mut db = common::lock_db(&state.db);
    let owner = common::current_owner(&db);
    // Whole-database delete + rewrite — the single worst-case write-
    // contention path in the app, now spanning six tables in one
    // transaction instead of one. Immediate for the same reason as every
    // other whole-collection rewrite (CTX-SEC-113 / #63): this reads
    // nothing before writing, but takes the write lock upfront rather
    // than risking a mid-transaction SQLITE_BUSY escalation.
    let tx = db
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(common::db_err)?;
    let now = common::today();

    // Wipe, scoped to the active owner. consumed/queued/owned/item_tags
    // rows cascade via ON DELETE CASCADE on items.id (schema.rs) — the
    // same cascade delete_item() already relies on for a single row, here
    // firing once for the whole owner instead of once per item.
    tx.execute("DELETE FROM items WHERE owner = ?1", params![owner])
        .map_err(common::db_err)?;
    tx.execute("DELETE FROM tags WHERE owner = ?1", params![owner])
        .map_err(common::db_err)?;

    // Items first — memberships reference them by ItemId, ids preserved
    // verbatim from the source so those references resolve correctly with
    // no remapping step, same ordering the old _writeAll() used.
    for item in &payload.items {
        items::write_item(&tx, item, &now).map_err(common::db_err)?;
    }

    for record in &payload.consumed {
        consumed::write_one(&tx, record, &now, false).map_err(common::db_err)?;
    }
    for record in &payload.queued {
        // apply_rank = true: restore reproduces exact prior state, so
        // incoming rank is honored verbatim, same as replace_all_queued.
        queued::write_one(&tx, record, &now, false, true).map_err(common::db_err)?;
    }
    for record in &payload.owned {
        owned::write_one(&tx, record, &now, false).map_err(common::db_err)?;
    }

    if let Some(settings_val) = &payload.settings {
        if let Some(obj) = settings_val.as_object() {
            let mut filtered = JsonMap::new();
            for key in ALLOWED_SETTINGS_KEYS {
                if let Some(v) = obj.get(*key) {
                    filtered.insert(key.to_string(), v.clone());
                }
            }
            let data = serde_json::to_string(&filtered).map_err(|e| e.to_string())?;
            tx.execute(
                "INSERT INTO settings (owner, data) VALUES (?1, ?2)
                 ON CONFLICT(owner) DO UPDATE SET data = excluded.data",
                params![owner, data],
            )
            .map_err(common::db_err)?;
        }
    }

    tx.commit().map_err(common::db_err)?;
    Ok(())
}
