/**
 * db-manager.js
 * Selects the appropriate database backend at runtime.
 *
 * DBManagerTauri — Tauri desktop/mobile builds (SQLite via Rust commands)
 * DBManagerWeb   — Browser builds (IndexedDB)
 *
 * All code above this file uses DBManager exclusively and never
 * references either backend directly.
 */

// isTauri() is @tauri-apps/api's own detection function — reading
// globalThis.isTauri, a flag Tauri sets independent of withGlobalTauri.
// Sniffing window.__TAURI__ stopped working once withGlobalTauri went
// false (#66 / CTX-SEC-116); that global no longer exists at all.
import { isTauri } from './vendor/tauri-api/core.js';

const DBManager = isTauri() ? DBManagerTauri : DBManagerWeb;

window.DBManager = DBManager;
