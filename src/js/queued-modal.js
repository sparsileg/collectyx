// ── To Be Read (queued) modal ───────────────────────────────────────────────
// Title, Order (formerly Rank), Author, Author 2, Source. Deliberately no
// Tags/Pages/ISBN — Stan's spec for this one is lean by design (quick
// queue entry, not a full catalog record); omitting the Tags key entirely
// means an existing item's tags (set via another collection) are left
// alone, not wiped. Add mode: Save/Cancel only. Edit mode (opened from a
// row click): adds Delete.
//
// No Tags field here is a deliberate, standing decision, not a gap to
// eventually fill in: a To Be Read item typically graduates to Books Read
// eventually, which does have a Tags field — that's the natural point to
// tag it. A queue-only book that's deleted before ever being finished just
// never needed tags in the first place.
//
// Rank insertion/shifting (ported concept from Scriptum's reading-list.js,
// design doc §4.4/Phase 5): setting Order to an occupied rank shifts every
// other ranked item to make room, rather than creating a collision;
// removing a ranked item closes the gap behind it. Entered rank is capped
// at current-max+1, matching Scriptum's original bound. Unranked items
// (Order left blank) never participate in shifting.

const QueuedModal = {
    _current: { recordId: null, containerId: null, itemId: null },

    // #tbrModal and its form are static markup, never rebuilt — bind once,
    // guarded, same pattern as the collection views.
    _wired: false,
    _bindEvents() {
        if (this._wired) return;
        const modal = document.getElementById('tbrModal');
        if (!modal) return;
        const form = document.getElementById('tbrForm');
        if (form) form.addEventListener('submit', (event) => this.save(event));
        modal.addEventListener('click', (event) => {
            const btn = event.target.closest('[data-action]');
            if (!btn || !modal.contains(btn)) return;
            const action = btn.dataset.action;
            if (action === 'close') this.close();
            else if (action === 'delete') this.deleteRecord();
            else if (action === 'find-isbn') this.findIsbn(btn);
        });
        this._wired = true;
    },

    _showError(msg) {
        const el = document.getElementById('tbrModalError');
        if (!el) return;
        el.textContent = msg;
        el.style.display = '';
    },

    _clearError() {
        const el = document.getElementById('tbrModalError');
        if (!el) return;
        el.textContent = '';
        el.style.display = 'none';
    },

    open(recordId, containerId) {
        this._bindEvents();
        const record = recordId ? CollectionView.getRecord(containerId, recordId) : null;
        this._current = {
            recordId,
            containerId,
            itemId: record ? record.ItemId : null
        };
        this._clearError();

        document.getElementById('tbrModalTitle').textContent = record
            ? `Edit ${MediaLabels.QueuedLabel}`
            : `Add to ${MediaLabels.QueuedLabel}`;
        document.getElementById('tbrSaveBtn').textContent = record ? 'Save' : `Add to ${MediaLabels.QueuedLabel}`;

        document.getElementById('tbrTitle').value = record ? (record.Title || '') : '';
        document.getElementById('tbrISBN').value = record ? (record.ISBN || '') : '';
        const isbnStatusEl = document.getElementById('tbrIsbnStatus');
        if (isbnStatusEl) { isbnStatusEl.textContent = ''; isbnStatusEl.className = 'isbn-find-status'; }
        document.getElementById('tbrOrder').value = record && record.Rank != null ? record.Rank : '';
        const author = splitAuthorName(record ? record.Author : '');
        document.getElementById('tbrAuthorGiven').value = author.given;
        document.getElementById('tbrAuthorSurname').value = author.surname;
        const author2 = splitAuthorName(record ? record.Author2 : '');
        document.getElementById('tbrAuthor2Given').value = author2.given;
        document.getElementById('tbrAuthor2Surname').value = author2.surname;
        document.getElementById('tbrSource').value = record ? (record.Source || '') : '';

        document.getElementById('tbrDeleteBtn').style.display = record ? '' : 'none';
        document.getElementById('tbrModal').classList.add('open');
    },

    close() {
        document.getElementById('tbrModal').classList.remove('open');
    },

    async save(event) {
        event.preventDefault();
        const { recordId, containerId, itemId } = this._current;

        const title = document.getElementById('tbrTitle').value.trim();
        if (!title) {
            showMessage('Title is required.', CONSTANTS.MESSAGE_TYPES.ERROR);
            this._showError('Title is required.');
            return;
        }

        let allQueued;
        try {
            allQueued = await DBManager.getCollection('queued');
        } catch (e) {
            console.error('QueuedModal.save: could not load current ranks', e);
            showMessage('Could not save — see console for details', CONSTANTS.MESSAGE_TYPES.ERROR);
            this._showError('Could not save — see console for details');
            return;
        }

        const rankInput = document.getElementById('tbrOrder').value;
        let newRank = rankInput ? parseInt(rankInput, 10) : null;
        if (newRank != null) {
            const maxRank = allQueued.reduce((max, r) => (r.id !== recordId && r.Rank != null && r.Rank > max ? r.Rank : max), 0);
            const cap = maxRank + 1;
            if (newRank > cap) newRank = cap;
            if (newRank < 1) newRank = 1;
        }

        // No Rank here — save_queued/saveCollectionRecord never writes
        // rank; reorderQueued below is the only thing that moves it
        // (COLLECTYX-SEC-32), atomically and in one backend call.
        const payload = {
            Title: title,
            ISBN: document.getElementById('tbrISBN').value.trim() || null,
            Author: formatAuthorName(document.getElementById('tbrAuthorSurname').value, document.getElementById('tbrAuthorGiven').value),
            Author2: formatAuthorName(document.getElementById('tbrAuthor2Surname').value, document.getElementById('tbrAuthor2Given').value),
            Source: document.getElementById('tbrSource').value.trim()
        };
        if (recordId) payload.id = recordId;
        if (itemId) payload.ItemId = itemId;

        try {
            const result = await DBManager.saveCollectionRecord('queued', payload);
            // Idempotent — safe to call unconditionally whether or not the
            // rank actually changed.
            await DBManager.reorderQueued(result.id, newRank);
            this.close();
            showMessage(`Saved to ${MediaLabels.QueuedLabel}`, CONSTANTS.MESSAGE_TYPES.SUCCESS);
            if (typeof QueuedView !== 'undefined') QueuedView.load(QueuedView._outerIdFrom(containerId));
        } catch (e) {
            console.error('QueuedModal.save failed', e);
            showMessage('Could not save — see console for details', CONSTANTS.MESSAGE_TYPES.ERROR);
            this._showError('Could not save — see console for details');
        }
    },

    async findIsbn(btn) {
        const statusEl = document.getElementById('tbrIsbnStatus');
        const setStatus = (msg, cls) => {
            if (!statusEl) return;
            statusEl.textContent = msg;
            statusEl.className = 'isbn-find-status' + (cls ? ' ' + cls : '');
        };

        const title = document.getElementById('tbrTitle').value.trim();
        if (!title) {
            setStatus('Enter a title first.', 'error');
            return;
        }
        const given = document.getElementById('tbrAuthorGiven').value.trim();
        const surname = document.getElementById('tbrAuthorSurname').value.trim();
        const author = [given, surname].filter(Boolean).join(' ');

        const original = btn.textContent;
        btn.disabled = true;
        btn.textContent = 'Searching…';
        setStatus('Searching…');
        try {
            const isbn = await MetadataFetcher.searchISBN(title, author);
            if (isbn) {
                document.getElementById('tbrISBN').value = isbn;
                setStatus('ISBN found.', 'success');
            } else {
                setStatus('No ISBN match found.', 'info');
            }
        } catch (e) {
            console.error('QueuedModal.findIsbn failed', e);
            setStatus('Search failed — see console for details', 'error');
        } finally {
            btn.disabled = false;
            btn.textContent = original;
        }
    },

    async deleteRecord() {
        const { recordId, containerId } = this._current;
        if (!recordId) return;
        if (!await Confirm.open('Remove this record?', 'Remove')) return;

        // If this queued entry came from My Library's "To Read" button,
        // that row's button must reappear once it's gone.
        const record = CollectionView.getRecord(containerId, recordId);
        const wasFromLibrary = record && record.Source === 'My Library';

        try {
            // deleteCollectionRecord closes the rank gap atomically as
            // part of the same delete (COLLECTYX-SEC-32) — no separate
            // fetch-then-shift needed here anymore.
            await DBManager.deleteCollectionRecord('queued', recordId);

            this.close();
            showMessage('Removed', CONSTANTS.MESSAGE_TYPES.SUCCESS);
            if (typeof QueuedView !== 'undefined') QueuedView.load(QueuedView._outerIdFrom(containerId));
            if (wasFromLibrary && typeof OwnedView !== 'undefined') {
                OwnedView.load(OwnedView.OWNED_CONTAINER_ID);
            }
        } catch (e) {
            console.error('QueuedModal.deleteRecord failed', e);
            showMessage('Could not delete — see console for details', CONSTANTS.MESSAGE_TYPES.ERROR);
            this._showError('Could not delete — see console for details');
        }
    }
};

window.QueuedModal = QueuedModal;
