// ── External metadata fetch (OpenLibrary + Google Books) ─────────────────────
// Synopsis lookup by ISBN, for discovery-mode cards (TBR prototype). Cover
// art dropped (#87) — unreliable across sessions, and a keyed Google Books
// call isn't safe to ship in a distributed client-side app. Google Books
// is called keyless/anonymous now — the API key that used to raise the
// quota has been deleted from Google Cloud Console. Public APIs, no auth.
// Session-scoped in-memory cache only — no persistence, since discovery
// cards pick a new random item on every view load anyway. Every call is
// timeout-guarded so a slow/unreachable API degrades to "no synopsis"
// instead of blocking the card render.

const MetadataFetcher = {
    DETAILS_URL: (isbn) => `https://openlibrary.org/api/books?bibkeys=ISBN:${encodeURIComponent(isbn)}&jscmd=details&format=json`,
    SEARCH_URL: (title, author) => `https://openlibrary.org/search.json?title=${encodeURIComponent(title)}${author ? `&author=${encodeURIComponent(author)}` : ''}&limit=1&fields=isbn,title,author_name`,
    // Keyless/anonymous lookup — volumes.get-by-ISBN supports this. Lower,
    // shared quota than a keyed call, acceptable for this app's call
    // volume; no key to leak from a distributed client-side app.
    GOOGLE_BOOKS_URL: (isbn) => `https://www.googleapis.com/books/v1/volumes?q=isbn:${encodeURIComponent(isbn)}`,

    // Fallback if constants.js hasn't picked these up yet.
    FETCH_TIMEOUT_MS: (typeof CONSTANTS !== 'undefined' && CONSTANTS.METADATA && CONSTANTS.METADATA.FETCH_TIMEOUT_MS) || 2000,
    SYNOPSIS_MAX_CHARS: (typeof CONSTANTS !== 'undefined' && CONSTANTS.METADATA && CONSTANTS.METADATA.SYNOPSIS_MAX_CHARS) || 200,

    _synopsisCache: new Map(), // isbn -> string | null
    _googleBooksCache: new Map(), // isbn -> volumeInfo object | null

    // Anonymous (no API key) Google Books quota is small and shared
    // across all callers of this IP — a burst of reloads across several
    // uncached ISBNs can 429. Requests are serialized with a minimum gap
    // between them rather than fired in parallel; a single-featured-book
    // load never needed more than one anyway, so this only slows down
    // rapid-fire testing, not normal use.
    _googleBooksMinIntervalMs: (typeof CONSTANTS !== 'undefined' && CONSTANTS.METADATA && CONSTANTS.METADATA.GOOGLE_BOOKS_MIN_INTERVAL_MS) || 2000,
    _googleBooksLastCallAt: 0,
    _googleBooksQueue: Promise.resolve(),

    _withTimeout(promise, ms) {
        return Promise.race([
            promise,
            new Promise((_, reject) => setTimeout(() => reject(new Error('metadata fetch timeout')), ms))
        ]);
    },

    // Shared by fetchCoverArt/fetchSynopsis's Google Books fallback so a
    // book needing both only hits the API once. Returns the first result's
    // volumeInfo, or null (not found / error) — never throws. Calls are
    // chained through _googleBooksQueue so concurrent lookups (e.g. cover
    // check for one card racing a synopsis check for another) queue up
    // and get throttled together instead of bursting in parallel.
    _fetchGoogleBooksVolumeInfo(isbn) {
        if (this._googleBooksCache.has(isbn)) return Promise.resolve(this._googleBooksCache.get(isbn));

        this._googleBooksQueue = this._googleBooksQueue
            .catch(() => {}) // one slow/failed call must not stall the queue for the next
            .then(() => this._throttleGoogleBooks())
            .then(() => this._doFetchGoogleBooksVolumeInfo(isbn));
        return this._googleBooksQueue;
    },

    async _throttleGoogleBooks() {
        const wait = this._googleBooksLastCallAt + this._googleBooksMinIntervalMs - Date.now();
        if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait));
        this._googleBooksLastCallAt = Date.now();
    },

    async _doFetchGoogleBooksVolumeInfo(isbn) {
        const url = this.GOOGLE_BOOKS_URL(isbn);
        let res;
        try {
            res = await this._withTimeout(fetch(url, { method: 'GET' }), this.FETCH_TIMEOUT_MS);
        } catch (e) {
            // Network error / timeout — transient, don't cache. A retry
            // on the next featured-book pick may well succeed.
            return null;
        }
        if (!res.ok) {
            // 5xx/429 are transient server-side conditions, not "this
            // book has no data" — caching those as null would mean one
            // brief Google-side hiccup permanently hides a book's cover/
            // synopsis for the rest of the session. Only a genuine
            // client-side rejection is treated as a real answer worth
            // caching (uncommon for this endpoint, but not impossible).
            if (res.status >= 500 || res.status === 429) return null;
            this._googleBooksCache.set(isbn, null);
            return null;
        }
        try {
            const data = await res.json();
            const item = Array.isArray(data.items) ? data.items[0] : null;
            const volumeInfo = (item && item.volumeInfo) || null;
            this._googleBooksCache.set(isbn, volumeInfo);
            return volumeInfo;
        } catch (e) {
            // Malformed JSON — also transient, don't cache.
            return null;
        }
    },

    // Resolves to a truncated synopsis string, or null if unavailable
    // anywhere. Caller is expected to check consumed/queued `comments`
    // first and only call this when no self-authored note exists.
    //
    // OpenLibrary edition records (keyed by ISBN) rarely carry a
    // description — that usually lives on the parent work record instead,
    // which this doesn't chase. Google Books' per-ISBN description field
    // is populated far more consistently, so it's the fallback here too.
    async fetchSynopsis(isbn) {
        if (!isbn) return null;
        if (this._synopsisCache.has(isbn)) return this._synopsisCache.get(isbn);

        const url = this.DETAILS_URL(isbn);
        try {
            const res = await this._withTimeout(fetch(url, { method: 'GET' }), this.FETCH_TIMEOUT_MS);
            if (!res.ok) throw new Error(`details fetch ${res.status}`);
            const data = await res.json();
            const entry = data[`ISBN:${isbn}`];
            let description = entry && entry.details && entry.details.description;
            // description can be a string or an object with a `value` key
            // depending on the source record — normalize both shapes.
            if (description && typeof description === 'object' && description.value) {
                description = description.value;
            }
            if (typeof description === 'string' && description.trim()) {
                const truncated = this._truncateSynopsis(description.trim());
                this._synopsisCache.set(isbn, truncated);
                return truncated;
            }
        } catch (e) {
            // fall through to Google Books
        }

        try {
            const volumeInfo = await this._fetchGoogleBooksVolumeInfo(isbn);
            const description = volumeInfo && volumeInfo.description;
            if (typeof description === 'string' && description.trim()) {
                const truncated = this._truncateSynopsis(description.trim());
                this._synopsisCache.set(isbn, truncated);
                return truncated;
            }
        } catch (e) {
            // no-op — falls through to null below
        }

        this._synopsisCache.set(isbn, null);
        return null;
    },

    _truncateSynopsis(trimmed) {
        return trimmed.length > this.SYNOPSIS_MAX_CHARS
            ? trimmed.slice(0, this.SYNOPSIS_MAX_CHARS).trim() + '…'
            : trimmed;
    },

    // Resolves to an ISBN string for the best title(+author) match, or
    // null if nothing found / on error. Not cached — this is a one-off,
    // user-triggered lookup (Find ISBN button), not a per-render fetch
    // like fetchCoverArt/fetchSynopsis, so there's no repeat-call case
    // worth memoizing.
    async searchISBN(title, author) {
        const candidate = await this.searchISBNCandidate(title, author);
        return candidate ? candidate.isbn : null;
    },

    // Same search, but also returns the matched title/author OpenLibrary
    // actually found — needed by the bulk ISBN lookup to loosely verify a
    // match before auto-accepting it unattended. The single-book Find ISBN
    // button doesn't need this (the person sees and can undo the result),
    // so it stays on the plain searchISBN() above.
    async searchISBNCandidate(title, author) {
        if (!title) return null;

        const url = this.SEARCH_URL(title, author);
        try {
            const res = await this._withTimeout(fetch(url, { method: 'GET' }), this.FETCH_TIMEOUT_MS);
            if (!res.ok) throw new Error(`search fetch ${res.status}`);
            const data = await res.json();
            const docs = data && data.docs;
            if (!Array.isArray(docs) || docs.length === 0) return null;
            const doc = docs[0];
            const isbns = doc.isbn;
            if (!Array.isArray(isbns) || isbns.length === 0) return null;
            return {
                isbn: isbns[0],
                matchedTitle: doc.title || '',
                matchedAuthor: Array.isArray(doc.author_name) ? doc.author_name[0] || '' : ''
            };
        } catch (e) {
            return null;
        }
    },

    // Test/debug hook — clears memoized results so a manual retry can
    // re-hit the network. Not called anywhere in normal app flow.
    clearCache() {
        this._synopsisCache.clear();
        this._googleBooksCache.clear();
    }
};

window.MetadataFetcher = MetadataFetcher;
