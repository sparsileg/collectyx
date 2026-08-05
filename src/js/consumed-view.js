// ── Books Read (consumed) view ───────────────────────────────────────────────

(function registerConsumedView() {
    const headerHtml = `
        <div class="collection-list-header consumed-columns">
            <span>Finished</span>
            <span>Title</span>
            <span>Author</span>
            <span>Tags</span>
            <span>Rating</span>
        </div>
    `;

    function rowFn(record, containerId) {
        const format = CollectionView._dateFormat();
        return `
            <div class="collection-list-row consumed-columns" onclick="ConsumedModal.open('${record.id}', '${containerId}')">
                <span class="col-extra">${escapeHtml(DateUtils.formatDate(record.Finished, format))}</span>
                <span class="col-title">${escapeHtml(record.Title || '')}</span>
                <span class="col-author">${escapeHtml(record.Author || '')}</span>
                <span class="col-tags">${escapeHtml((record.Tags || []).join(', '))}</span>
                <span class="col-rating">${escapeHtml(RatingUtils.display(record.Rating))}</span>
            </div>
        `;
    }

    CollectionView.registerRenderer('consumed', headerHtml, rowFn);
    CollectionView.registerAddHandler('consumed', (containerId) => ConsumedModal.open(null, containerId));
})();

const ConsumedView = {
    // Called by showView() (core.js) whenever the Books Read nav item is
    // clicked. Always re-fetches rather than caching at this layer — reads
    // are cheap locally (SQLite/IndexedDB) and a second cache on top of
    // DBManager's own would just be one more thing to keep in sync.
    async load(containerId) {
        try {
            const data = await DBManager.getCollection('consumed');
            CollectionView.render(containerId, 'consumed', data);
        } catch (e) {
            console.error('ConsumedView.load: could not load Books Read', e);
            if (typeof showMessage === 'function') {
                showMessage('Could not load Books Read — see console for details', CONSTANTS.MESSAGE_TYPES.ERROR);
            }
            CollectionView.render(containerId, 'consumed', []);
        }
    }
};
