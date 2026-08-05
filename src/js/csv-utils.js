// ── CSV utilities ────────────────────────────────────────────────────────────
// Quote-aware parse/format (handles commas, quotes, and newlines inside a
// field) — same substance as Scriptum's own CSV handling, just not copied
// verbatim since Collectyx's column sets differ.

const CsvUtils = {
    parseCSV(text) {
        const rows = [];
        let row = [];
        let field = '';
        let inQuotes = false;
        let i = 0;
        const len = text.length;

        while (i < len) {
            const char = text[i];
            if (inQuotes) {
                if (char === '"') {
                    if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
                    inQuotes = false; i++; continue;
                }
                field += char; i++; continue;
            }
            if (char === '"') { inQuotes = true; i++; continue; }
            if (char === ',') { row.push(field); field = ''; i++; continue; }
            if (char === '\r') { i++; continue; }
            if (char === '\n') { row.push(field); rows.push(row); row = []; field = ''; i++; continue; }
            field += char; i++;
        }
        if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
        if (rows.length === 0) return [];

        const headers = rows[0].map(h => h.trim());
        return rows.slice(1)
            .filter(r => r.some(c => c.trim() !== ''))
            .map(r => {
                const obj = {};
                headers.forEach((h, idx) => { obj[h] = r[idx] !== undefined ? r[idx] : ''; });
                return obj;
            });
    },

    _field(value) {
        const str = String(value == null ? '' : value);
        return /[",\n\r]/.test(str) ? '"' + str.replace(/"/g, '""') + '"' : str;
    },

    toCSV(rows, columns) {
        const lines = [columns.join(',')];
        rows.forEach(row => {
            lines.push(columns.map(c => this._field(row[c])).join(','));
        });
        return lines.join('\r\n');
    },

    // Multi-value fields (Tags) use "; " rather than "," so a comma inside
    // a tag list doesn't need CSV-quoting to stay readable in a spreadsheet.
    joinMulti(arr) {
        return (arr || []).join('; ');
    },

    splitMulti(str) {
        if (!str) return [];
        return str.split(';').map(t => t.trim().toLowerCase()).filter(t => /^[a-z0-9_-]+$/i.test(t));
    }
};

// ── File download ────────────────────────────────────────────────────────────
// Browser download (blob + anchor click) for both builds. Not using
// tauri-plugin-dialog/fs for a native save dialog in the Tauri build —
// their exact API shape hasn't been exercised anywhere in this codebase
// yet (selectBackupFolder() uses the dialog plugin's *open* method for
// folder picking, not *save* for a file), and guessing at an unverified
// API risks shipping something broken. The blob approach is simpler and
// Tauri's webview generally handles it the same as a browser. Worth
// revisiting for a native save dialog once that plugin surface is
// actually confirmed.
function downloadFile(filename, content, mimeType) {
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}
