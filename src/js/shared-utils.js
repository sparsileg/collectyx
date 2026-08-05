// ── Shared utilities ─────────────────────────────────────────────────────────
// Small, self-contained copies of core.js utilities (escapeHtml,
// formatAuthorName, generateBookId), plus MediaLabels for the three
// collection display names. Kept separate from core.js because core.js's
// window.onload calls DBManager.init(), which doesn't exist in this
// standalone harness — Phase 5's real wiring uses core.js's originals
// directly instead of these.

function escapeHtml(str) {
    if (str === null || str === undefined) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function formatAuthorName(surname, given) {
    const s = (surname || '').trim();
    const g = (given || '').trim();
    if (s && g) return `${s}, ${g}`;
    return s || g;
}

// Inverse of formatAuthorName — splits a stored "Surname, Given" string
// back into its two parts for repopulating an Edit form. A name with no
// comma (only surname or only given was ever entered) is treated as
// surname-only, matching formatAuthorName's own fallback behavior.
function splitAuthorName(combined) {
    const value = (combined || '').trim();
    if (!value) return { surname: '', given: '' };
    const commaIndex = value.indexOf(',');
    if (commaIndex === -1) return { surname: value, given: '' };
    return {
        surname: value.slice(0, commaIndex).trim(),
        given: value.slice(commaIndex + 1).trim()
    };
}

function generateBookId() {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) {
        return crypto.randomUUID();
    }
    return 'id_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
}

// media_types labels (design doc §4.1 — sourced from the DB at runtime in
// the real app; the harness sets these directly since there's no
// DBManager here). Used in modal titles ("Add to {QueuedLabel}") and the
// sidebar nav in the real app.
const MediaLabels = {
    ConsumedLabel: 'Books Read',
    QueuedLabel: 'To Be Read',
    OwnedLabel: 'My Library',

    todayISO() {
        const d = new Date();
        const y = d.getFullYear();
        const m = String(d.getMonth() + 1).padStart(2, '0');
        const day = String(d.getDate()).padStart(2, '0');
        return `${y}-${m}-${day}`;
    }
};
