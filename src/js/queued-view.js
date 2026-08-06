// ── To Be Read (queued) view ─────────────────────────────────────────────────

(function registerQueuedView() {
    const headerHtml = `
        <div class="collection-list-header queued-columns">
            <span>Order</span>
            <span>Book</span>
            <span>Tags</span>
            <span></span>
        </div>
    `;

    function rowFn(record, containerId) {
        const reading = !!record.CurrentlyReading;
        return `
            <div class="collection-list-row queued-columns${reading ? ' currently-reading' : ''}" onclick="QueuedModal.open('${record.id}', '${containerId}')">
                <span class="col-extra">${record.Rank != null ? escapeHtml(String(record.Rank)) : 'Unranked'}</span>
                <div class="col-stacked">
                    <div class="stacked-title">${escapeHtml(record.Title || '')}</div>
                    <div class="stacked-author">by ${escapeHtml(record.Author || '')}</div>
                    <div class="stacked-source">${reading ? '<span class="currently-reading-badge">Currently Reading</span> ' : ''}Source: ${escapeHtml(record.Source || '')}</div>
                </div>
                <span class="col-tags">${escapeHtml((record.Tags || []).join(', '))}</span>
                <div class="col-actions">
                    <button type="button" class="btn btn-secondary queued-reading-btn"
                            onclick="event.stopPropagation(); QueuedView.toggleCurrentlyReading('${record.id}', '${containerId}', ${!reading})">${reading ? 'Stop Reading' : 'Currently Reading'}</button>
                    <button type="button" class="btn btn-secondary queued-finished-btn"
                            onclick="event.stopPropagation(); QueuedView.markFinished('${record.id}', '${containerId}')">Finished</button>
                </div>
            </div>
        `;
    }

    CollectionView.registerRenderer('queued', headerHtml, rowFn);
    CollectionView.registerAddHandler('queued', (containerId) => QueuedModal.open(null, containerId));
})();

const QueuedView = {
    CONSUMED_CONTAINER_ID: 'consumedView',

    // Multiple books may be marked Currently Reading at once — no
    // single-book enforcement, per Stan. Direct write (setCurrentlyReading)
    // rather than a round trip through the Edit modal, matching the
    // "do one thing and leave" per-row-button pattern already used for
    // Finished.
    async toggleCurrentlyReading(id, containerId, value) {
        try {
            await DBManager.setCurrentlyReading(id, value);
            this.load(containerId);
        } catch (e) {
            console.error('QueuedView.toggleCurrentlyReading failed', e);
            showMessage('Could not update Currently Reading — see console for details', CONSTANTS.MESSAGE_TYPES.ERROR);
        }
    },

    async load(containerId) {
        try {
            const data = await DBManager.getCollection('queued');
            // Same discrepancy as consumed/owned — the web backend's join
            // doesn't sort; Rust's SQL does. Matched here so both backends
            // show identical order: ranked items first (ascending),
            // unranked last (alphabetical by title within each group).
            data.sort((a, b) => {
                const aUnranked = a.Rank == null ? 1 : 0;
                const bUnranked = b.Rank == null ? 1 : 0;
                if (aUnranked !== bUnranked) return aUnranked - bUnranked;
                if (aUnranked === 0) return a.Rank - b.Rank;
                return (a.Title || '').localeCompare(b.Title || '');
            });
            CollectionView.render(containerId, 'queued', data);
        } catch (e) {
            console.error('QueuedView.load: could not load To Be Read', e);
            if (typeof showMessage === 'function') {
                showMessage('Could not load To Be Read — see console for details', CONSTANTS.MESSAGE_TYPES.ERROR);
            }
            CollectionView.render(containerId, 'queued', []);
        }
    },

    // Opens the Books Read modal pre-filled with this item's Title/Author,
    // reusing its ItemId (design doc's "mark finished" cross-collection
    // action). Only removes the queued entry after Save actually succeeds
    // — if the save fails, the book correctly stays on To Be Read.
    markFinished(queuedRecordId, queuedContainerId) {
        const queuedRecord = CollectionView.getRecord(queuedContainerId, queuedRecordId);
        if (!queuedRecord) return;

        ConsumedModal.open(
            null,
            this.CONSUMED_CONTAINER_ID,
            {
                Title: queuedRecord.Title,
                Author: queuedRecord.Author,
                Author2: queuedRecord.Author2,
                Pages: queuedRecord.Pages,
                ISBN: queuedRecord.ISBN,
                ItemId: queuedRecord.ItemId,
                Tags: queuedRecord.Tags
            },
            async () => {
                try {
                    await DBManager.deleteCollectionRecord('queued', queuedRecordId);
                } catch (e) {
                    console.error('markFinished: saved to Books Read but could not remove the To Be Read entry', e);
                    showMessage('Saved, but could not remove it from To Be Read — see console', CONSTANTS.MESSAGE_TYPES.ERROR);
                }
                this.load(queuedContainerId);
                if (queuedRecord.Source === 'My Library' && typeof OwnedView !== 'undefined') {
                    OwnedView.load(OwnedView.OWNED_CONTAINER_ID);
                }
            }
        );
    }
};
