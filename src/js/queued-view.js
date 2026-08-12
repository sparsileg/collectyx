// ── To Be Read (queued) view ─────────────────────────────────────────────────
// Two-panel layout (TBR prototype): left panel is the normal CollectionView
// list (Tags column dropped — Stan's call, keep the row lean); right panel
// is a static synopsis card for one random queued book, rendered directly
// (NOT through CollectionView — it takes no clicks, no row-open, no
// row-action, so none of that shared plumbing applies to it). The two
// panels live in separate DOM containers under a shared wrapper — see
// index.html's #queuedView markup.

(function registerQueuedView() {
    const headerHtml = `
        <div class="collection-list-header queued-columns">
            <span>Order</span>
            <span>Book</span>
            <span></span>
        </div>
    `;

    function rowFn(record, containerId) {
        const reading = !!record.CurrentlyReading;
        return `
            <div class="collection-list-row queued-columns${reading ? ' currently-reading' : ''}" data-id="${escapeHtml(record.id)}">
                <span class="col-extra">${record.Rank != null ? escapeHtml(String(record.Rank)) : 'Unranked'}</span>
                <div class="col-stacked">
                    <div class="stacked-title">${escapeHtml(record.Title || '')}
                        <button type="button" class="tbr-lookup-icon" data-action="lookup-book" title="Show in discovery card">?</button>
                    </div>
                    <div class="stacked-author">by ${escapeHtml(authorGivenFirst(record.Author))}${record.Author2 ? ' &amp; ' + escapeHtml(authorGivenFirst(record.Author2)) : ''}</div>
                    <div class="stacked-source">${reading ? '<span class="currently-reading-badge">Currently Reading</span> ' : ''}Source: ${escapeHtml(record.Source || '')}</div>
                </div>
                <div class="col-actions">
                    <button type="button" class="btn btn-secondary queued-reading-btn"
                            data-action="toggle-reading">${reading ? 'Stop Reading' : 'Start Reading'}</button>
                    <button type="button" class="btn btn-secondary queued-finished-btn"
                            data-action="mark-finished">Finished</button>
                </div>
            </div>
        `;
    }

    CollectionView.registerRenderer('queued', headerHtml, rowFn);
    CollectionView.registerAddHandler('queued', (containerId) => QueuedModal.open(null, containerId));
    CollectionView.registerRowOpenHandler('queued', (id, containerId) => QueuedModal.open(id, containerId));
    CollectionView.registerRowActionHandler('queued', (action, id, containerId) => {
        if (action === 'toggle-reading') {
            const record = CollectionView.getRecord(containerId, id);
            QueuedView.toggleCurrentlyReading(id, containerId, !(record && record.CurrentlyReading));
        } else if (action === 'mark-finished') {
            QueuedView.markFinished(id, containerId);
        } else if (action === 'lookup-book') {
            const record = CollectionView.getRecord(containerId, id);
            if (!record) return;
            const outerContainerId = QueuedView._outerIdFrom(containerId);
            QueuedDiscovery.renderInto(`${outerContainerId}-discovery`, record);
        }
    });
})();

// ── TBR synopsis card (prototype) ────────────────────────────────────────────
// One queued book — random on view load, or a specific one when the person
// clicks a row's lookup icon. Stacked: cover, title, author, source,
// synopsis. Fully static otherwise — no click handling of its own, per
// Stan; only the left-list row icon drives what's shown here.
const QueuedDiscovery = {
    _lastFeatured: null,

    // Renders directly into discoveryContainerId — a plain div, not a
    // CollectionView-managed container. No delegated click listener is
    // ever bound here, so the card genuinely does nothing when clicked.
    // featured is the explicit record to show — QueuedView.load() picks
    // one randomly on initial view load; a row's lookup icon passes a
    // specific record instead (see QueuedView's row-action handler).
    renderInto(discoveryContainerId, featured) {
        const container = document.getElementById(discoveryContainerId);
        if (!container) return;

        this._lastFeatured = featured;

        if (!featured) {
            container.innerHTML = `<div class="tbr-discovery-empty">Nothing queued yet.</div>`;
            return;
        }

        const comments = (featured.Comments || '').trim();

        container.innerHTML = `
            <div class="tbr-discovery-card">
                <div class="tbr-featured-title">${escapeHtml(featured.Title || '')}</div>
                <div class="tbr-featured-author">by ${escapeHtml(authorGivenFirst(featured.Author))}${featured.Author2 ? ' &amp; ' + escapeHtml(authorGivenFirst(featured.Author2)) : ''}</div>
                ${featured.Source ? `<div class="tbr-featured-source">Source: ${escapeHtml(featured.Source)}</div>` : ''}
                <div class="tbr-featured-synopsis" data-role="discovery-synopsis">${comments ? escapeHtml(comments) : 'Loading synopsis…'}</div>
            </div>
        `;

        this._afterRender(discoveryContainerId, featured);
    },

    // Populates the synopsis (if no self-authored comment) once the card
    // is in the DOM. Guards against a stale fetch resolving after a newer
    // random pick has already replaced this card — checks object identity
    // against the featured record this fetch was for, not just DOM
    // presence, since the container id is stable across reloads.
    async _afterRender(discoveryContainerId, featured) {
        const container = document.getElementById(discoveryContainerId);
        if (!container) return;
        const isbn = featured.ISBN;

        const hasComments = (featured.Comments || '').trim().length > 0;
        if (!hasComments) {
            const synEl = container.querySelector('[data-role="discovery-synopsis"]');
            const synopsis = isbn ? await MetadataFetcher.fetchSynopsis(isbn) : null;
            if (this._lastFeatured !== featured) return;
            if (synEl) synEl.textContent = synopsis || '(No synopsis available)';
        }
    }
};

const QueuedView = {
    CONSUMED_CONTAINER_ID: 'consumedView',

    // core.js calls QueuedView.load('queuedView') — the outer wrapper id.
    // List and discovery panels live in '{outer}-list' / '{outer}-discovery'
    // (see index.html). Row-level handlers below receive the *list*
    // container id back from CollectionView, so they convert back to the
    // outer id before calling load() again — see _outerIdFrom().
    _outerIdFrom(listContainerId) {
        return listContainerId.endsWith('-list') ? listContainerId.slice(0, -5) : listContainerId;
    },

    async toggleCurrentlyReading(id, listContainerId, value) {
        try {
            await DBManager.setCurrentlyReading(id, value);
            this.load(this._outerIdFrom(listContainerId));
        } catch (e) {
            console.error('QueuedView.toggleCurrentlyReading failed', e);
            showMessage('Could not update Currently Reading — see console for details', CONSTANTS.MESSAGE_TYPES.ERROR);
        }
    },

    async load(outerContainerId) {
        const listContainerId = `${outerContainerId}-list`;
        const discoveryContainerId = `${outerContainerId}-discovery`;
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
            CollectionView.render(listContainerId, 'queued', data);
            const featured = data.length ? data[Math.floor(Math.random() * data.length)] : null;
            QueuedDiscovery.renderInto(discoveryContainerId, featured);
        } catch (e) {
            console.error('QueuedView.load: could not load To Be Read', e);
            if (typeof showMessage === 'function') {
                showMessage('Could not load To Be Read — see console for details', CONSTANTS.MESSAGE_TYPES.ERROR);
            }
            CollectionView.render(listContainerId, 'queued', []);
            const discoveryEl = document.getElementById(discoveryContainerId);
            if (discoveryEl) discoveryEl.innerHTML = '';
        }
    },

    // Opens the Books Read modal pre-filled with this item's Title/Author,
    // reusing its ItemId (design doc's "mark finished" cross-collection
    // action). Only removes the queued entry after Save actually succeeds
    // — if the save fails, the book correctly stays on To Be Read.
    markFinished(queuedRecordId, listContainerId) {
        const queuedRecord = CollectionView.getRecord(listContainerId, queuedRecordId);
        if (!queuedRecord) return;
        const outerContainerId = this._outerIdFrom(listContainerId);

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
                this.load(outerContainerId);
                if (queuedRecord.Source === 'My Library' && typeof OwnedView !== 'undefined') {
                    OwnedView.load(OwnedView.OWNED_CONTAINER_ID);
                }
            }
        );
    }
};

window.QueuedView = QueuedView;
