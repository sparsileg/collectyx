// ── Rating (1–5, stars + word) ──────────────────────────────────────────────
// Replaces the old 1–10 numeric Rating and the separate Recommend field.
// Numbers 1–5 are what's actually stored; stars/words are display-only.

const RatingUtils = {
    LABELS: [
        { value: 1, stars: '★',     word: 'Skip' },
        { value: 2, stars: '★★',    word: 'Okay' },
        { value: 3, stars: '★★★',   word: 'Good' },
        { value: 4, stars: '★★★★',  word: 'Excellent' },
        { value: 5, stars: '★★★★★', word: 'Essential' }
    ],

    display(value) {
        const entry = this.LABELS.find(r => r.value === value);
        return entry ? `${entry.stars} ${entry.word}` : '—';
    },

    optionsHtml(selectedValue) {
        const blank = `<option value="">Select</option>`;
        const opts = this.LABELS.map(r =>
            `<option value="${r.value}"${selectedValue === r.value ? ' selected' : ''}>${r.stars} ${r.word}</option>`
        ).join('');
        return blank + opts;
    },

    // Recommend (0/1) -> Rating (1-5) mapping for the future one-time data
    // migration (No -> 1, Yes -> 4, confirmed with Stan). Not called
    // anywhere yet — there's no existing Recommend data in Collectyx to
    // convert until that migration is actually built. Recorded here so the
    // rule lives next to the rest of the rating logic rather than only in
    // chat history.
    fromRecommend(recommend) {
        if (recommend === 1) return 4;
        if (recommend === 0) return 1;
        return null;
    }
};

window.RatingUtils = RatingUtils;
