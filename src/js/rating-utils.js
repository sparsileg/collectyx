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
    // Books Read rows. The Add/Edit modal shows both (see fillSelect
    // below); the list is meant to be scannable, not descriptive.
    display(value) {
        const entry = this.LABELS.find(r => r.value === value);
        return entry ? entry.stars : '—';
    },

    // Fills the Add/Edit modal's Rating <select> — stars and word.
    fillSelect(select, selectedValue) {
        setOptions(select, [{ value: '', label: 'Select' }].concat(this.LABELS.map(r => ({
            value: String(r.value),
            label: `${r.stars} ${r.word}`,
            selected: selectedValue === r.value,
        }))));
    }
};

window.RatingUtils = RatingUtils;
