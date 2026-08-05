// ── My Library (owned) view ─────────────────────────────────────────────────
// Status is derived from CheckedOutDate (Available / C/O by {Patron}).
// Actions column button visibility is recomputed fresh on every render from
// two independent facts, never stored as separate flags:
//   - checked out?              -> record.CheckedOutDate truthy
//   - already on To Be Read
//     via this same button?     -> a queued row with matching ItemId and
//                                  Source === 'My Library'
// Checked out hides both To Read and Check Out, shows Check In only,
// regardless of queued state — per Stan's spec, checkout takes priority.
//
// addToReadingList/confirmCheckout/checkIn are the mutating actions —
// stubbed in this patch (reads only); Patch B wires them to real
// DBManager writes.

(function registerOwnedView() {
    const headerHtml = `
        <div class="collection-list-header owned-columns">
            <span>Title</span>
            <span>Author</span>
            <span>Tags</span>
            <span>Status</span>
            <span>Actions</span>
        </div>
    `;

    function rowFn(record, containerId) {
        const checkedOut = !!record.CheckedOutDate;
        const statusText = checkedOut ? `C/O by ${escapeHtml(record.Patron || '')}` : 'Available';
        const showToRead = !checkedOut && !OwnedView.isQueuedFromLibrary(record.ItemId);

        const buttons = [];
        if (showToRead) {
            buttons.push(`<button type="button" class="btn btn-secondary" onclick="event.stopPropagation(); OwnedView.addToReadingList('${record.id}', '${containerId}')">To Read</button>`);
        }
        if (!checkedOut) {
            buttons.push(`<button type="button" class="btn btn-secondary" onclick="event.stopPropagation(); OwnedView.openCheckout('${record.id}', '${containerId}')">C/O</button>`);
        } else {
            buttons.push(`<button type="button" class="btn btn-secondary" onclick="event.stopPropagation(); OwnedView.checkIn('${record.id}', '${containerId}')">C/I</button>`);
        }

        return `
            <div class="collection-list-row owned-columns" onclick="OwnedModal.open('${record.id}', '${containerId}')">
                <span class="col-title">${escapeHtml(record.Title || '')}</span>
                <span class="col-author">${escapeHtml(record.Author || '')}</span>
                <span class="col-tags">${escapeHtml((record.Tags || []).join(', '))}</span>
                <span class="col-status">${statusText}</span>
                <span class="col-actions" onclick="event.stopPropagation()">${buttons.join('')}</span>
            </div>
        `;
    }

    CollectionView.registerRenderer('owned', headerHtml, rowFn);
    CollectionView.registerAddHandler('owned', (containerId) => OwnedModal.open(null, containerId));
})();

const OwnedView = {
    OWNED_CONTAINER_ID: 'ownedView',
    QUEUED_CONTAINER_ID: 'queuedView',

    _checkoutTarget: { recordId: null, containerId: null },

    async load(containerId) {
        try {
            const data = await DBManager.getCollection('owned');
            CollectionView.render(containerId, 'owned', data);
        } catch (e) {
            console.error('OwnedView.load: could not load My Library', e);
            if (typeof showMessage === 'function') {
                showMessage('Could not load My Library — see console for details', CONSTANTS.MESSAGE_TYPES.ERROR);
            }
            CollectionView.render(containerId, 'owned', []);
        }
    },

    // Reads CollectionView's already-loaded queued data (from QueuedView's
    // last load()) rather than fetching again — both views load once per
    // showView() call, and this only needs to be current as of render time.
    isQueuedFromLibrary(itemId) {
        const queuedData = CollectionView.getData(this.QUEUED_CONTAINER_ID);
        return queuedData.some(r => r.ItemId === itemId && r.Source === 'My Library');
    },

    async refreshAll() {
        if (typeof QueuedView !== 'undefined') await QueuedView.load(this.QUEUED_CONTAINER_ID);
        await this.load(this.OWNED_CONTAINER_ID);
    },

    // ── Real writes ──────────────────────────────────────────────────────────

    // Ranks against a fresh fetch, not CollectionView's local cache — if
    // the user goes straight to My Library without visiting To Be Read
    // first, that cache would be empty and understate the next rank.
    async addToReadingList(recordId, containerId) {
        const record = CollectionView.getRecord(containerId, recordId);
        if (!record) return;

        try {
            const queuedData = await DBManager.getCollection('queued');
            const maxRank = queuedData.reduce((max, r) => (r.Rank != null && r.Rank > max ? r.Rank : max), 0);

            await DBManager.saveCollectionRecord('queued', {
                ItemId: record.ItemId,
                Title: record.Title,
                Author: record.Author,
                Rank: maxRank + 1,
                Source: 'My Library'
            });

            showMessage(`Added to ${MediaLabels.QueuedLabel}`, CONSTANTS.MESSAGE_TYPES.SUCCESS);
            await this.refreshAll();
        } catch (e) {
            console.error('OwnedView.addToReadingList failed', e);
            showMessage('Could not add to reading list — see console for details', CONSTANTS.MESSAGE_TYPES.ERROR);
        }
    },

    // ── Read-only, fully functional ─────────────────────────────────────────

    openCheckout(recordId, containerId) {
        const record = CollectionView.getRecord(containerId, recordId);
        if (!record) return;
        this._checkoutTarget = { recordId, containerId };
        document.getElementById('checkoutBookTitle').textContent = record.Title;
        document.getElementById('checkoutPatron').value = '';
        document.getElementById('checkoutModal').classList.add('open');
    },

    closeCheckout() {
        document.getElementById('checkoutModal').classList.remove('open');
    },

    // ── Real writes ──────────────────────────────────────────────────────────
    // Both send id + ItemId explicitly — a partial payload missing ItemId
    // would make saveCollectionRecord mint a fresh one and orphan the
    // record from its real item (see Patch B's design notes).

    async confirmCheckout(event) {
        event.preventDefault();
        const patron = document.getElementById('checkoutPatron').value.trim();
        if (!patron) { alert('Patron name is required.'); return; }

        const { recordId, containerId } = this._checkoutTarget;
        const record = CollectionView.getRecord(containerId, recordId);
        if (!record) return;

        try {
            await DBManager.saveCollectionRecord('owned', {
                id: recordId,
                ItemId: record.ItemId,
                Patron: patron,
                CheckedOutDate: MediaLabels.todayISO()
            });
            this.closeCheckout();
            showMessage('Checked out', CONSTANTS.MESSAGE_TYPES.SUCCESS);
            this.load(containerId);
        } catch (e) {
            console.error('OwnedView.confirmCheckout failed', e);
            showMessage('Could not check out — see console for details', CONSTANTS.MESSAGE_TYPES.ERROR);
        }
    },

    async checkIn(recordId, containerId) {
        const record = CollectionView.getRecord(containerId, recordId);
        if (!record) return;
        if (!confirm(`Check in "${record.Title}" from ${record.Patron}?`)) return;

        try {
            await DBManager.saveCollectionRecord('owned', {
                id: recordId,
                ItemId: record.ItemId,
                Patron: null,
                CheckedOutDate: null
            });
            showMessage('Checked in', CONSTANTS.MESSAGE_TYPES.SUCCESS);
            this.load(containerId);
        } catch (e) {
            console.error('OwnedView.checkIn failed', e);
            showMessage('Could not check in — see console for details', CONSTANTS.MESSAGE_TYPES.ERROR);
        }
    }
};
