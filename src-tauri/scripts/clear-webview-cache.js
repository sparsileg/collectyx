/**
 * Runs via tauri.conf.json's beforeDevCommand, before every `tauri dev`
 * launch. Deletes the OS webview's on-disk asset cache so a stale build
 * can never be served after source files change — see Issue 40.
 *
 * Reads the app identifier from tauri.conf.json rather than hardcoding
 * it, so a future rename doesn't silently break this script.
 *
 * Best-effort: logs what it does, never throws past its own boundary.
 * A failure here should not block `tauri dev` from starting.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

function loadIdentifier() {
    const confPath = path.join(__dirname, '..', 'tauri.conf.json');
    const raw = fs.readFileSync(confPath, 'utf8');
    const conf = JSON.parse(raw);
    if (!conf.identifier) {
        throw new Error(`No "identifier" field found in ${confPath}`);
    }
    return conf.identifier;
}

function getCachePaths(identifier) {
    const home = os.homedir();
    const platform = os.platform();

    if (platform === 'linux') {
        return [
            path.join(home, '.local', 'share', identifier, 'WebKitCache')
        ];
    }

    if (platform === 'win32') {
        const localAppData = process.env.LOCALAPPDATA
            || path.join(home, 'AppData', 'Local');
        return [
            path.join(localAppData, identifier, 'EBWebView')
        ];
    }

    if (platform === 'darwin') {
        // WKWebView has no official clean-cache API and no documented
        // stable single path (see tauri-apps/wry#914). These two are
        // the best-known locations but are NOT independently verified
        // against a live macOS run  confirm on real hardware before
        // trusting this fully.
        return [
            path.join(home, 'Library', 'WebKit', identifier),
            path.join(home, 'Library', 'HTTPStorage', identifier)
        ];
    }

    console.warn(`[clear-webview-cache] Unrecognized platform "${platform}"  skipping.`);
    return [];
}

function clearCache() {
    let identifier;
    try {
        identifier = loadIdentifier();
    } catch (err) {
        console.warn(`[clear-webview-cache] Could not read identifier, skipping cache clear: ${err.message}`);
        return;
    }

    const targets = getCachePaths(identifier);

    for (const target of targets) {
        try {
            if (fs.existsSync(target)) {
                fs.rmSync(target, { recursive: true, force: true });
                console.log(`[clear-webview-cache] Cleared: ${target}`);
            } else {
                console.log(`[clear-webview-cache] Nothing to clear (not found): ${target}`);
            }
        } catch (err) {
            console.warn(`[clear-webview-cache] Failed to clear ${target}: ${err.message}`);
        }
    }
}

clearCache();
