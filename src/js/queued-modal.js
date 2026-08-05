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
    _current: { recordId: null, containerId: null, itemId: null, oldRank: null },

    open(recordId, containerId) {
        const record = recordId ? CollectionView.getRecord(containerId, recordId) : null;
        this._current = {
            recordId,
            containerId,
            itemId: record ? record.ItemId : null,
            oldRank: record ? record.Rank : null
        };

        document.getElementById('tbrModalTitle').textContent = record
            ? `Edit ${MediaLabels.QueuedLabel}`
            : `Add to ${MediaLabels.QueuedLabel}`;
        document.getElementById('tbrSaveBtn').textContent = record ? 'Save' : `Add to ${MediaLabels.QueuedLabel}`;

        document.getElementById('tbrTitle').value = record ? (record.Title || '') : '';
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
        const { recordId, containerId, itemId, oldRank } = this._current;

        const title = document.getElementById('tbrTitle').value.trim();
        if (!title) { alert('Title is required.'); return; }

        let allQueued;
        try {
            allQueued = await DBManager.getCollection('queued');
        } catch (e) {
            console.error('QueuedModal.save: could not load current ranks', e);
            showMessage('Could not save — see console for details', CONSTANTS.MESSAGE_TYPES.ERROR);
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

        const payload = {
            Title: title,
            Rank: newRank,
            Author: formatAuthorName(document.getElementById('tbrAuthorSurname').value, document.getElementById('tbrAuthorGiven').value),
            Author2: formatAuthorName(document.getElementById('tbrAuthor2Surname').value, document.getElementById('tbrAuthor2Given').value),
            Source: document.getElementById('tbrSource').value.trim()
        };
        if (recordId) payload.id = recordId;
        if (itemId) payload.ItemId = itemId;

        try {
            const result = await DBManager.saveCollectionRecord('queued', payload);
            await this._shiftRanksAfterSave(allQueued, result.id, oldRank, newRank);
            this.close();
            showMessage(`Saved to ${MediaLabels.QueuedLabel}`, CONSTANTS.MESSAGE_TYPES.SUCCESS);
            if (typeof QueuedView !== 'undefined') QueuedView.load(containerId);
        } catch (e) {
            console.error('QueuedModal.save failed', e);
            showMessage('Could not save — see console for details', CONSTANTS.MESSAGE_TYPES.ERROR);
        }
    },

    // allBefore: the queued collection as it was BEFORE this save (fetched
    // in save(), used here to know every other record's rank without a
    // second fetch). savedRecordId/oldRank/newRank describe the just-saved
    // record's move. Always sends id + ItemId on every shift write — same
    // rule as everywhere else, a partial payload missing ItemId would
    // orphan that record's item.
    async _shiftRanksAfterSave(allBefore, savedRecordId, oldRank, newRank) {
        if (newRank == null) return;
        const shifts = [];

        if (oldRank == null) {
            // New insertion at newRank: make room by pushing newRank+ down.
            allBefore.forEach(r => {
                if (r.id !== savedRecordId && r.Rank != null && r.Rank >= newRank) {
                    shifts.push({ id: r.id, ItemId: r.ItemId, Rank: r.Rank + 1 });
                }
            });
        } else if (newRank > oldRank) {
            // Moved down the list: close the gap it left, shift (old, new] up.
            allBefore.forEach(r => {
                if (r.id !== savedRecordId && r.Rank != null && r.Rank > oldRank && r.Rank <= newRank) {
                    shifts.push({ id: r.id, ItemId: r.ItemId, Rank: r.Rank - 1 });
                }
            });
        } else if (newRank < oldRank) {
            // Moved up the list: make room, shift [new, old) down.
            allBefore.forEach(r => {
                if (r.id !== savedRecordId && r.Rank != null && r.Rank >= newRank && r.Rank < oldRank) {
                    shifts.push({ id: r.id, ItemId: r.ItemId, Rank: r.Rank + 1 });
                }
            });
        }

        for (const s of shifts) {
            await DBManager.saveCollectionRecord('queued', { id: s.id, ItemId: s.ItemId, Rank: s.Rank });
        }
    },

    async deleteRecord() {
        const { recordId, containerId } = this._current;
        if (!recordId) return;
        if (!confirm('Remove this record?')) return;

        // Needed before deleting: if this queued entry came from My
        // Library's "To Read" button, that row's button must reappear;
        // and if it was ranked, everything below needs to shift up.
        const record = CollectionView.getRecord(containerId, recordId);
        const wasFromLibrary = record && record.Source === 'My Library';
        const deletedRank = record ? record.Rank : null;

        try {
            let allBefore = [];
            if (deletedRank != null) {
                allBefore = await DBManager.getCollection('queued');
            }

            await DBManager.deleteCollectionRecord('queued', recordId);

            if (deletedRank != null) {
                const shifts = allBefore
                    .filter(r => r.id !== recordId && r.Rank != null && r.Rank > deletedRank)
                    .map(r => ({ id: r.id, ItemId: r.ItemId, Rank: r.Rank - 1 }));
                for (const s of shifts) {
                    await DBManager.saveCollectionRecord('queued', { id: s.id, ItemId: s.ItemId, Rank: s.Rank });
                }
            }

            this.close();
            showMessage('Removed', CONSTANTS.MESSAGE_TYPES.SUCCESS);
            if (typeof QueuedView !== 'undefined') QueuedView.load(containerId);
            if (wasFromLibrary && typeof OwnedView !== 'undefined') {
                OwnedView.load(OwnedView.OWNED_CONTAINER_ID);
            }
        } catch (e) {
            console.error('QueuedModal.deleteRecord failed', e);
            showMessage('Could not delete — see console for details', CONSTANTS.MESSAGE_TYPES.ERROR);
        }
    }
};
