// ── Books Read (consumed) view ───────────────────────────────────────────────

(function registerConsumedView() {
    const headerHtml = `
        <div class="collection-list-header consumed-columns">
            <span>Finished</span>
            <span>Book</span>
            <span>Tags</span>
            <span>Rating</span>
        </div>
    `;

    function rowFn(record, containerId) {
        const format = CollectionView._dateFormat();
        return `
            <div class="collection-list-row consumed-columns" data-id="${escapeHtml(record.id)}">
                <span class="col-extra">${escapeHtml(DateUtils.formatDate(record.Finished, format))}</span>
                <div class="col-stacked">
                    <div class="stacked-title">${escapeHtml(record.Title || '')}</div>
                    <div class="stacked-author">by ${escapeHtml(record.Author || '')}${record.Author2 ? ' &amp; ' + escapeHtml(record.Author2) : ''}</div>
                </div>
                <span class="col-tags">${escapeHtml((record.Tags || []).join(', '))}</span>
                <span class="col-rating">${escapeHtml(RatingUtils.display(record.Rating))}</span>
            </div>
        `;
    }

    CollectionView.registerRenderer('consumed', headerHtml, rowFn);
    CollectionView.registerAddHandler('consumed', (containerId) => ConsumedModal.open(null, containerId));
    CollectionView.registerRowOpenHandler('consumed', (id, containerId) => ConsumedModal.open(id, containerId));

    // Advanced filter field set (issue #49). ISBN is isEmpty-only — Stan's
    // call, partial-ISBN search isn't a real use case here.
    CollectionView.registerFilterFields('consumed', [
        { key: 'Finished', label: 'Finished', operators: [
            { key: 'isEmpty', label: 'Is Empty', valueType: 'none' },
            { key: 'between', label: 'Between', valueType: 'dateRange' }
        ]},
        { key: 'Title', label: 'Title', operators: [
            { key: 'isEmpty', label: 'Is Empty', valueType: 'none' },
            { key: 'contains', label: 'Contains', valueType: 'text' }
        ]},
        { key: 'Author', label: 'Author', operators: [
            { key: 'isEmpty', label: 'Is Empty', valueType: 'none' },
            { key: 'contains', label: 'Contains', valueType: 'text' }
        ]},
        { key: 'Pages', label: 'Pages', operators: [
            { key: 'isEmpty', label: 'Is Empty', valueType: 'none' },
            { key: 'gte', label: 'Greater than or equal to', valueType: 'number' },
            { key: 'lt', label: 'Less than', valueType: 'number' }
        ]},
        { key: 'Tag', label: 'Tag', operators: [
            { key: 'isEmpty', label: 'Is Empty', valueType: 'none' },
            { key: 'equals', label: 'Equals', valueType: 'tagSelect' }
        ]},
        { key: 'Rating', label: 'Rating', operators: [
            { key: 'isEmpty', label: 'Is Empty', valueType: 'none' },
            { key: 'equals', label: 'Equals', valueType: 'ratingSelect' },
            { key: 'gte', label: 'Greater than or equal to', valueType: 'ratingSelect' },
            { key: 'lt', label: 'Less than', valueType: 'ratingSelect' }
        ]},
        { key: 'ISBN', label: 'ISBN', operators: [
            { key: 'isEmpty', label: 'Is Empty', valueType: 'none' }
        ]},
        { key: 'MultipleReads', label: 'Multiple Reads', operators: [
            { key: 'gte', label: 'Greater than or equal to', valueType: 'number', defaultValues: ['2'] }
        ]}
    ]);
})();

const ConsumedView = {
    // Called by showView() (core.js) whenever the Books Read nav item is
    // clicked. Always re-fetches rather than caching at this layer — reads
    // are cheap locally (SQLite/IndexedDB) and a second cache on top of
    // DBManager's own would just be one more thing to keep in sync.
    async load(containerId) {
        try {
            const data = await DBManager.getCollection('consumed');
            // The Tauri backend's SQL sorts (ORDER BY finished DESC,
            // date_added DESC); the web backend's IndexedDB join does
            // not sort at all. Sorting here means both backends show
            // the same order regardless of that discrepancy.
            data.sort((a, b) => {
                const f = (b.Finished || '').localeCompare(a.Finished || '');
                if (f !== 0) return f;
                return (b.DateAdded || '').localeCompare(a.DateAdded || '');
            });
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

window.ConsumedView = ConsumedView;
