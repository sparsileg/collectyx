// ── Collection export/import ─────────────────────────────────────────────────
// Wired to each collection's hamburger contextual section (design doc §4.2,
// Phase 5 task 4). Exports the currently-loaded collection data (whatever
// CollectionView has for that view right now) — not re-fetched, since the
// view was just loaded when the hamburger opened. Import always creates new
// records (no attempt to match/dedupe against existing items) — same
// "import naively, let Find Duplicates clean up overlaps later" approach
// already established for Phase 6's Scriptum import.

const COLLECTION_IO_SPEC = {
    consumed: {
        containerId: 'consumedView',
        columns: ['Finished', 'Title', 'Author', 'Author2', 'Pages', 'ISBN', 'Rating', 'Comments', 'Tags'],
        toRow(r) {
            return {
                Finished: r.Finished || '',
                Title: r.Title || '',
                Author: r.Author || '',
                Author2: r.Author2 || '',
                Pages: r.Pages != null ? r.Pages : '',
                ISBN: r.ISBN || '',
                Rating: r.Rating != null ? r.Rating : '',
                Comments: r.Comments || '',
                Tags: CsvUtils.joinMulti(r.Tags)
            };
        },
        fromRow(row) {
            return {
                Title: (row.Title || '').trim(),
                Author: (row.Author || '').trim(),
                Author2: (row.Author2 || '').trim(),
                Pages: row.Pages ? (parseInt(row.Pages, 10) || null) : null,
                ISBN: (row.ISBN || '').trim(),
                // Storage-format (YYYY-MM-DD) regardless of the user's display
                // setting — a file interchange format should be unambiguous,
                // not tied to whichever format happened to be active on export.
                Finished: /^\d{4}-\d{2}-\d{2}$/.test(row.Finished || '') ? row.Finished : null,
                Rating: row.Rating ? (parseInt(row.Rating, 10) || null) : null,
                Comments: (row.Comments || '').trim(),
                Tags: CsvUtils.splitMulti(row.Tags)
            };
        }
    },
    queued: {
        containerId: 'queuedView',
        columns: ['Rank', 'Title', 'Author', 'Author2', 'Source', 'Tags'],
        toRow(r) {
            return {
                Rank: r.Rank != null ? r.Rank : '',
                Title: r.Title || '',
                Author: r.Author || '',
                Author2: r.Author2 || '',
                Source: r.Source || '',
                Tags: CsvUtils.joinMulti(r.Tags)
            };
        },
        fromRow(row) {
            return {
                Title: (row.Title || '').trim(),
                Author: (row.Author || '').trim(),
                Author2: (row.Author2 || '').trim(),
                Rank: row.Rank ? (parseInt(row.Rank, 10) || null) : null,
                Source: (row.Source || '').trim(),
                Tags: CsvUtils.splitMulti(row.Tags)
            };
            // Deliberately no rank-shift handling for bulk import — that
            // logic exists for the interactive Add/Edit flow (QueuedModal),
            // not for a batch of rows that may already collide with each
            // other. Imported ranks land as-is.
        }
    },
    owned: {
        containerId: 'ownedView',
        columns: ['Title', 'Author', 'Author2', 'Pages', 'ISBN', 'Location', 'Patron', 'CheckedOutDate', 'Tags'],
        toRow(r) {
            return {
                Title: r.Title || '',
                Author: r.Author || '',
                Author2: r.Author2 || '',
                Pages: r.Pages != null ? r.Pages : '',
                ISBN: r.ISBN || '',
                Location: r.Location || '',
                Patron: r.Patron || '',
                CheckedOutDate: r.CheckedOutDate || '',
                Tags: CsvUtils.joinMulti(r.Tags)
            };
        },
        fromRow(row) {
            // Patron/CheckedOutDate intentionally not imported — checkout
            // status is managed exclusively through the dedicated
            // checkout/check-in flow, same rule as the Edit modal.
            return {
                Title: (row.Title || '').trim(),
                Author: (row.Author || '').trim(),
                Author2: (row.Author2 || '').trim(),
                Pages: row.Pages ? (parseInt(row.Pages, 10) || null) : null,
                ISBN: (row.ISBN || '').trim(),
                Location: (row.Location || '').trim(),
                Tags: CsvUtils.splitMulti(row.Tags)
            };
        }
    }
};

const CollectionIO = {
    _importTarget: null,

    _timestamp() {
        const d = new Date();
        const pad = (n) => String(n).padStart(2, '0');
        return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
    },

    exportCSV(collection) {
        const spec = COLLECTION_IO_SPEC[collection];
        const data = CollectionView.getData(spec.containerId);
        const rows = data.map(r => spec.toRow(r));
        const csv = CsvUtils.toCSV(rows, spec.columns);
        downloadFile(`collectyx-${collection}-${this._timestamp()}.csv`, csv, 'text/csv');
    },

    exportJSON(collection) {
        const spec = COLLECTION_IO_SPEC[collection];
        const data = CollectionView.getData(spec.containerId);
        downloadFile(`collectyx-${collection}-${this._timestamp()}.json`, JSON.stringify(data, null, 2), 'application/json');
    },

    triggerImportCSV(collection) {
        this._importTarget = collection;
        const input = document.getElementById('csvImportInput');
        input.value = '';
        input.click();
    },

    async handleImportFileSelected(event) {
        const file = event.target.files[0];
        const collection = this._importTarget;
        if (!file || !collection) return;

        const text = await file.text();
        const spec = COLLECTION_IO_SPEC[collection];
        const rows = CsvUtils.parseCSV(text);

        if (rows.length === 0) {
            showMessage('No rows found in that CSV file', CONSTANTS.MESSAGE_TYPES.ERROR);
            return;
        }
        if (!('Title' in rows[0])) {
            showMessage('CSV must have a Title column', CONSTANTS.MESSAGE_TYPES.ERROR);
            return;
        }

        let successCount = 0;
        let skipCount = 0;
        for (const row of rows) {
            const payload = spec.fromRow(row);
            if (!payload.Title) { skipCount++; continue; }
            try {
                await DBManager.saveCollectionRecord(collection, payload);
                successCount++;
            } catch (e) {
                console.error('CollectionIO: import row failed', row, e);
                skipCount++;
            }
        }

        showMessage(
            `Imported ${successCount} record(s)` + (skipCount ? `, skipped ${skipCount}` : ''),
            successCount > 0 ? CONSTANTS.MESSAGE_TYPES.SUCCESS : CONSTANTS.MESSAGE_TYPES.ERROR
        );

        if (collection === 'consumed' && typeof ConsumedView !== 'undefined') ConsumedView.load(spec.containerId);
        else if (collection === 'queued' && typeof QueuedView !== 'undefined') QueuedView.load(spec.containerId);
        else if (collection === 'owned' && typeof OwnedView !== 'undefined') OwnedView.load(spec.containerId);
    }
};
