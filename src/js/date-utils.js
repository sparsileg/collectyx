// ── Date display formatting ─────────────────────────────────────────────────
// Storage is always YYYY-MM-DD (design doc §3.2). Display format is a user
// setting: 'MM-DD-YYYY' (default), 'DD-MM-YYYY', or 'YYYY-MM-DD'.

const DateUtils = {
    FORMATS: {
        MDY: 'MM-DD-YYYY',
        DMY: 'DD-MM-YYYY',
        ISO: 'YYYY-MM-DD'
    },
    DEFAULT_FORMAT: 'MM-DD-YYYY',

    // YYYY-MM-DD (storage) -> display string in the given format.
    // Returns '' for empty/malformed input rather than throwing, so callers
    // can render blank fields for missing dates without a guard every time.
    formatDate(isoString, format) {
        if (!isoString) return '';
        const match = String(isoString).match(/^(\d{4})-(\d{2})-(\d{2})$/);
        if (!match) return '';
        const [, y, mo, d] = match;
        switch (format) {
            case this.FORMATS.DMY: return `${d}-${mo}-${y}`;
            case this.FORMATS.ISO: return `${y}-${mo}-${d}`;
            case this.FORMATS.MDY:
            default: return `${mo}-${d}-${y}`;
        }
    },

    // Display string (in the given format) -> YYYY-MM-DD (storage), with
    // range validation (month 1-12, day valid for that month/year).
    // Returns '' if the input doesn't parse or fails validation — callers
    // treat '' as "invalid, don't save" the same way core.js's existing
    // validateDateInput()/dateToStorage() do for MM/DD/YYYY today.
    parseDateInput(displayString, format) {
        if (!displayString) return '';
        const parts = String(displayString).trim().split(/[-/]/);
        if (parts.length !== 3) return '';

        let y, mo, d;
        switch (format) {
            case this.FORMATS.DMY: [d, mo, y] = parts; break;
            case this.FORMATS.ISO: [y, mo, d] = parts; break;
            case this.FORMATS.MDY:
            default: [mo, d, y] = parts; break;
        }

        if (!/^\d{4}$/.test(y) || !/^\d{1,2}$/.test(mo) || !/^\d{1,2}$/.test(d)) return '';
        const yi = parseInt(y, 10), mi = parseInt(mo, 10), di = parseInt(d, 10);
        if (mi < 1 || mi > 12) return '';
        const daysInMonth = new Date(yi, mi, 0).getDate();
        if (di < 1 || di > daysInMonth) return '';
        if (yi < 1000 || yi > 2100) return '';

        return `${y}-${String(mi).padStart(2, '0')}-${String(di).padStart(2, '0')}`;
    },

    // For input placeholders — the format string itself doubles as the
    // placeholder text (e.g. "MM-DD-YYYY").
    placeholderFor(format) {
        return format || this.DEFAULT_FORMAT;
    }
};
