// ── Bulk ISBN lookup modal (issue #85) ──────────────────────────────────────
// Hamburger Global-section action, not Settings. Books Read or My Library,
// searches only records currently missing an ISBN (a record already
// carrying the manual "NO_ISBN" sentinel counts as non-empty and is
// excluded automatically — no special-case code needed for that). Runs in
// batches of 25: after each batch, pauses with a Found/Not-found tally and
// asks whether to continue via the existing Confirm modal. The "remaining
// without ISBN" count updates live as each save lands.
//
// Auto-accept is gated on a loose title/author match against what
// OpenLibrary actually returned — this runs unattended across many books,
// so a wrong silent match here is worse than the interactive Find ISBN
// button's occasional miss, which the person sees and can undo immediately.

const BulkIsbnModal = {
    BATCH_SIZE: 25,

    _running: false,
    _cancelled: false,

    _wired: false,
    _bindEvents() {
        if (this._wired) return;
        const modal = document.getElementById('bulkIsbnModal');
        if (!modal) return;
        modal.addEventListener('click', (event) => {
            const btn = event.target.closest('[data-action]');
            if (!btn || !modal.contains(btn)) return;
            const action = btn.dataset.action;
            if (action === 'close') this.close();
            else if (action === 'execute') this.execute();
        });
        modal.querySelectorAll('input[name="bulkIsbnCollection"]').forEach(radio => {
            radio.addEventListener('change', () => this._refreshRemaining());
        });
        this._wired = true;
    },

    open() {
        this._bindEvents();
        this._setStatus('');
        document.getElementById('bulkIsbnRemaining').textContent = '–';
        document.getElementById('bulkIsbnModal').classList.add('open');
        this._refreshRemaining();
    },

    close() {
        if (this._running) {
            this._cancelled = true;
            return;
        }
        document.getElementById('bulkIsbnModal').classList.remove('open');
    },

    _selectedCollection() {
        const checked = document.querySelector('input[name="bulkIsbnCollection"]:checked');
        return checked ? checked.value : 'consumed';
    },

    _setStatus(msg) {
        const el = document.getElementById('bulkIsbnStatus');
        if (el) el.textContent = msg;
    },

    _candidates(data) {
        // Missing ISBN only — a record holding the literal "NO_ISBN"
        // sentinel has a non-empty ISBN value and is excluded by this
        // same falsy check, permanently, with no separate logic needed.
        return data.filter(r => !r.ISBN);
    },

    async _refreshRemaining() {
        const el = document.getElementById('bulkIsbnRemaining');
        if (!el) return;
        el.textContent = '…';
        try {
            const data = await DBManager.getCollection(this._selectedCollection());
            el.textContent = String(this._candidates(data).length);
        } catch (e) {
            console.error('BulkIsbnModal._refreshRemaining failed', e);
            el.textContent = '?';
        }
    },

    _setControlsDisabled(disabled) {
        const modal = document.getElementById('bulkIsbnModal');
        if (!modal) return;
        modal.querySelectorAll('input[name="bulkIsbnCollection"], [data-action="execute"]').forEach(el => {
            el.disabled = disabled;
        });
    },

    // Normalizes for loose comparison — lowercase, diacritics stripped,
    // punctuation collapsed to spaces.
    _normalize(str) {
        return (str || '')
            .toLowerCase()
            .normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
            .replace(/[^a-z0-9\s]/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
    },

    // Title: at least 60% of the stored title's significant (3+ char)
    // words must appear in the API-returned title. Author: the stored
    // surname must appear somewhere in the API-returned author string —
    // stored Author is "Surname, Given", API returns a plain display name,
    // so surname substring is the reliable comparison, not a full-string
    // match. No stored author at all doesn't block the match — nothing to
    // check against.
    _looseMatch(record, candidate) {
        const storedTitle = this._normalize(record.Title);
        const apiTitle = this._normalize(candidate.matchedTitle);
        if (!storedTitle || !apiTitle) return false;
        const words = storedTitle.split(' ').filter(w => w.length >= 3);
        const titleOk = words.length
            ? (words.filter(w => apiTitle.includes(w)).length / words.length) >= 0.6
            : storedTitle === apiTitle;
        if (!titleOk) return false;

        const { surname } = splitAuthorName(record.Author || '');
        if (!surname) return true;
        const storedSurname = this._normalize(surname);
        const apiAuthor = this._normalize(candidate.matchedAuthor);
        return apiAuthor.includes(storedSurname);
    },

    async execute() {
        if (this._running) return;
        const collection = this._selectedCollection();

        let data;
        try {
            data = await DBManager.getCollection(collection);
        } catch (e) {
            console.error('BulkIsbnModal.execute: could not load collection', e);
            showMessage('Could not load collection — see console for details', CONSTANTS.MESSAGE_TYPES.ERROR);
            return;
        }
        const candidates = this._candidates(data);
        if (candidates.length === 0) {
            this._setStatus('Nothing to search — every record already has an ISBN.');
            return;
        }

        this._running = true;
        this._cancelled = false;
        this._setControlsDisabled(true);

        let found = 0, notFound = 0, remaining = candidates.length, sinceBatch = 0;
        const remainingEl = document.getElementById('bulkIsbnRemaining');

        for (const record of candidates) {
            if (this._cancelled) break;

            const { given, surname } = splitAuthorName(record.Author || '');
            const authorQuery = [given, surname].filter(Boolean).join(' ');

            const candidate = await MetadataFetcher.searchISBNCandidate(record.Title, authorQuery);
            if (candidate && this._looseMatch(record, candidate)) {
                try {
                    await DBManager.saveCollectionRecord(collection, {
                        id: record.id,
                        ItemId: record.ItemId,
                        ISBN: candidate.isbn
                    });
                    found++;
                    remaining--;
                    if (remainingEl) remainingEl.textContent = String(remaining);
                } catch (e) {
                    console.error('BulkIsbnModal.execute: save failed for', record.Title, e);
                    notFound++;
                }
            } else {
                notFound++;
            }

            sinceBatch++;
            this._setStatus(`Processed ${found + notFound}/${candidates.length} — Found: ${found}, Not found: ${notFound}`);

            if (sinceBatch >= this.BATCH_SIZE && (found + notFound) < candidates.length) {
                sinceBatch = 0;
                const cont = await Confirm.open(
                    `Found: ${found}  Not found: ${notFound}  (${candidates.length - found - notFound} remaining). Continue?`,
                    'Continue'
                );
                if (!cont) { this._cancelled = true; break; }
            }
        }

        this._running = false;
        this._setControlsDisabled(false);
        this._setStatus(`Done. Found: ${found}, Not found: ${notFound}.`);
        showMessage(`ISBN lookup complete — Found: ${found}, Not found: ${notFound}`, CONSTANTS.MESSAGE_TYPES.SUCCESS);

        // Refresh whichever collection view is currently showing, if any,
        // so newly-found ISBNs (and their downstream cover/synopsis) show
        // up without the person having to navigate away and back.
        if (collection === 'consumed' && typeof ConsumedView !== 'undefined') {
            ConsumedView.load('consumedView');
        } else if (collection === 'owned' && typeof OwnedView !== 'undefined') {
            OwnedView.load(OwnedView.OWNED_CONTAINER_ID);
        }

        if (this._cancelled) {
            document.getElementById('bulkIsbnModal').classList.remove('open');
        }
    }
};

window.BulkIsbnModal = BulkIsbnModal;
