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
            <span>Book</span>
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
            buttons.push(`<button type="button" class="btn btn-secondary" data-action="to-read">To Read</button>`);
        }
        if (!checkedOut) {
            buttons.push(`<button type="button" class="btn btn-secondary" data-action="checkout">C/O</button>`);
        } else {
            buttons.push(`<button type="button" class="btn btn-secondary" data-action="check-in">C/I</button>`);
        }

        return `
            <div class="collection-list-row owned-columns" data-id="${escapeHtml(record.id)}">
                <div class="col-stacked">
                    <div class="stacked-title">${escapeHtml(record.Title || '')}</div>
                    <div class="stacked-author">by ${escapeHtml(record.Author || '')}</div>
                </div>
                <span class="col-tags">${escapeHtml((record.Tags || []).join(', '))}</span>
                <span class="col-status">${statusText}</span>
                <span class="col-actions" data-action="noop">${buttons.join('')}</span>
            </div>
        `;
    }

    CollectionView.registerRenderer('owned', headerHtml, rowFn);
    CollectionView.registerAddHandler('owned', (containerId) => OwnedModal.open(null, containerId));
    CollectionView.registerRowOpenHandler('owned', (id, containerId) => OwnedModal.open(id, containerId));
    // 'noop' = click landed on the actions column but not on a button
    // (the gap between them) — original markup stopped propagation on
    // the whole wrapper, not just the buttons, so this deliberately does
    // nothing rather than falling through to row-open.
    CollectionView.registerRowActionHandler('owned', (action, id, containerId) => {
        if (action === 'to-read') OwnedView.addToReadingList(id, containerId);
        else if (action === 'checkout') OwnedView.openCheckout(id, containerId);
        else if (action === 'check-in') OwnedView.checkIn(id, containerId);
    });
})();

const OwnedView = {
    OWNED_CONTAINER_ID: 'ownedView',
    QUEUED_CONTAINER_ID: 'queuedView',

    _checkoutTarget: { recordId: null, containerId: null },

    async load(containerId) {
        try {
            const data = await DBManager.getCollection('owned');
            // Same discrepancy as consumed/queued — matched to Rust's
            // ORDER BY i.title ASC so both backends agree.
            data.sort((a, b) => (a.Title || '').localeCompare(b.Title || ''));
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

            // Authoritative check against a fresh fetch, not the render-time
            // isQueuedFromLibrary() hint — that reads CollectionView's
            // local cache, which is empty on a cold start straight into My
            // Library (COLLECTYX-SEC-39 finding 2). Without this, "To
            // Read" on an already-queued book silently created a second
            // queued row against the same item.
            const alreadyQueued = queuedData.some(r => r.ItemId === record.ItemId && r.Source === 'My Library');
            if (alreadyQueued) {
                showMessage(`Already in ${MediaLabels.QueuedLabel}`, CONSTANTS.MESSAGE_TYPES.INFO);
                await this.refreshAll();
                return;
            }

            const maxRank = queuedData.reduce((max, r) => (r.Rank != null && r.Rank > max ? r.Rank : max), 0);

            // saveCollectionRecord no longer writes Rank — reorderQueued
            // is the only path that sets it (COLLECTYX-SEC-32).
            const result = await DBManager.saveCollectionRecord('queued', {
                ItemId: record.ItemId,
                Title: record.Title,
                Author: record.Author,
                Source: 'My Library'
            });
            await DBManager.reorderQueued(result.id, maxRank + 1);

            showMessage(`Added to ${MediaLabels.QueuedLabel}`, CONSTANTS.MESSAGE_TYPES.SUCCESS);
            await this.refreshAll();
        } catch (e) {
            console.error('OwnedView.addToReadingList failed', e);
            showMessage('Could not add to reading list — see console for details', CONSTANTS.MESSAGE_TYPES.ERROR);
        }
    },

    // ── Read-only, fully functional ─────────────────────────────────────────

    // #checkoutModal and its form are static markup, never rebuilt — bind
    // once, guarded, same pattern as the collection views.
    _checkoutWired: false,
    _bindCheckoutEvents() {
        if (this._checkoutWired) return;
        const modal = document.getElementById('checkoutModal');
        if (!modal) return;
        const form = document.getElementById('checkoutForm');
        if (form) form.addEventListener('submit', (event) => this.confirmCheckout(event));
        modal.addEventListener('click', (event) => {
            const btn = event.target.closest('[data-action]');
            if (!btn || !modal.contains(btn)) return;
            if (btn.dataset.action === 'close') this.closeCheckout();
        });
        this._checkoutWired = true;
    },

    openCheckout(recordId, containerId) {
        this._bindCheckoutEvents();
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
        if (!patron) { showMessage('Patron name is required.', CONSTANTS.MESSAGE_TYPES.ERROR); return; }

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
        if (!await Confirm.open(`Check in "${record.Title}" from ${record.Patron}?`, 'Check In')) return;

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
