// ── Rating (1–5, stars + word) ──────────────────────────────────────────────
// Replaces the old 1–10 numeric Rating. The separate 0/1 Recommend field
// it also superseded was dropped entirely (CTX-SEC-121) — no UI writer,
// no reader, no migration ever built for it.
// Numbers 1–5 are what's actually stored; stars/words are display-only.

const RatingUtils = {
    LABELS: [
        { value: 1, stars: '★',     word: 'Skip' },
        { value: 2, stars: '★★',    word: 'Okay' },
        { value: 3, stars: '★★★',   word: 'Good' },
        { value: 4, stars: '★★★★',  word: 'Excellent' },
        { value: 5, stars: '★★★★★', word: 'Essential' }
    ],

    // List/row display — stars only, no word. Used by consumed-view.js's
    // Books Read rows. The Add/Edit modal shows both (see optionsHtml
    // below); the list is meant to be scannable, not descriptive.
    display(value) {
        const entry = this.LABELS.find(r => r.value === value);
        return entry ? entry.stars : '—';
    },

    optionsHtml(selectedValue) {
        const blank = `<option value="">Select</option>`;
        const opts = this.LABELS.map(r =>
            `<option value="${r.value}"${selectedValue === r.value ? ' selected' : ''}>${r.stars} ${r.word}</option>`
        ).join('');
        return blank + opts;
    }
};

window.RatingUtils = RatingUtils;
