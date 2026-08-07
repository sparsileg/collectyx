// ── Books Read (consumed) modal ─────────────────────────────────────────────
// Finished, Title, Author, Author 2, Pages, ISBN, Rating (1-5 stars/word,
// replaces the old 1-10 + Recommend), Tags, Comments. Finished defaults to
// today when adding. Can be opened pre-filled with Title/Author (and the
// source item's ItemId, so it links to the same book rather than minting a
// duplicate) from the To Be Read view's Finished button.
//
// save()/deleteRecord() always send the record's existing ItemId when
// editing — saveCollectionRecord() mints a fresh random ItemId for any
// payload that omits one, which for an edit would silently orphan the
// record from its real item. New-from-scratch records correctly omit both
// id and ItemId so the backend mints fresh ones.

const ConsumedModal = {
    _tagsController: null,
    _current: { recordId: null, containerId: null, itemId: null },
    _onSaved: null,

    _init() {
        if (!this._tagsController) {
            this._tagsController = initTagChipInput({
                input: 'cbrTagsInput', suggestions: 'cbrTagsSuggestions', chipRow: 'cbrTagsChipRow', hidden: 'cbrTags'
            });
        }
        this._bindEvents();
    },

    // #cbrModal and its form are static markup, never rebuilt — bind once,
    // guarded, same pattern as the collection views.
    _wired: false,
    _bindEvents() {
        if (this._wired) return;
        this._wired = true;
        const form = document.getElementById('cbrForm');
        if (form) form.addEventListener('submit', (event) => this.save(event));
        const modal = document.getElementById('cbrModal');
        if (!modal) return;
        modal.addEventListener('click', (event) => {
            const btn = event.target.closest('[data-action]');
            if (!btn || !modal.contains(btn)) return;
            const action = btn.dataset.action;
            if (action === 'close') this.close();
            else if (action === 'delete') this.deleteRecord();
        });
    },

    // prefill: optional { Title, Author, ItemId } — used by the To Be Read
    // view's Finished button. onSaved: optional callback(record) fired
    // after a successful save — e.g. removing the source queued row.
    open(recordId, containerId, prefill, onSaved) {
        this._init();
        const record = recordId ? CollectionView.getRecord(containerId, recordId) : null;
        this._current = {
            recordId,
            containerId,
            itemId: record ? record.ItemId : ((prefill && prefill.ItemId) || null)
        };
        this._onSaved = onSaved || null;

        const format = CollectionView._dateFormat();

        // Item-level fields (Title/Author/Author2/Pages/ISBN/Tags) come from
        // whichever of record/prefill is present — both carry the same
        // field names since prefill is itself built from a joined record
        // (see QueuedView.markFinished). Using one shared source object
        // instead of a separate record-then-prefill fallback per field is
        // deliberate: the previous per-field version silently missed
        // Author2/Pages/ISBN, defaulting them to blank whenever prefilled,
        // which then saved as explicit nulls and wiped them from the item.
        const source = record || prefill || {};

        document.getElementById('cbrModalTitle').textContent = record
            ? `Edit ${MediaLabels.ConsumedLabel}`
            : `Add to ${MediaLabels.ConsumedLabel}`;

        document.getElementById('cbrTitle').value = source.Title || '';
        const author = splitAuthorName(source.Author);
        document.getElementById('cbrAuthorGiven').value = author.given;
        document.getElementById('cbrAuthorSurname').value = author.surname;
        const author2 = splitAuthorName(source.Author2);
        document.getElementById('cbrAuthor2Given').value = author2.given;
        document.getElementById('cbrAuthor2Surname').value = author2.surname;
        document.getElementById('cbrPages').value = source.Pages != null ? source.Pages : '';
        document.getElementById('cbrISBN').value = source.ISBN || '';

        // Default to today when adding — whether from scratch or pre-filled
        // from a To Be Read item, this is still a new Books Read entry.
        const finishedIso = record ? record.Finished : MediaLabels.todayISO();
        document.getElementById('cbrFinished').value = DateUtils.formatDate(finishedIso, format);

        document.getElementById('cbrRating').innerHTML = RatingUtils.optionsHtml(record ? record.Rating : null);
        document.getElementById('cbrComments').value = record ? (record.Comments || '') : '';

        this._tagsController.setTags(source.Tags || []);
        this._tagsController.refreshSuggestions();

        document.getElementById('cbrDeleteBtn').style.display = record ? '' : 'none';
        document.getElementById('cbrModal').classList.add('open');
    },

    close() {
        document.getElementById('cbrModal').classList.remove('open');
    },

    async save(event) {
        event.preventDefault();
        const { recordId, containerId, itemId } = this._current;
        const format = CollectionView._dateFormat();

        const title = document.getElementById('cbrTitle').value.trim();
        if (!title) { showMessage('Title is required.', CONSTANTS.MESSAGE_TYPES.ERROR); return; }

        const finishedInput = document.getElementById('cbrFinished').value;
        const finished = DateUtils.parseDateInput(finishedInput, format);
        if (finishedInput && !finished) {
            showMessage(`Invalid date — please use ${DateUtils.placeholderFor(format)}`, CONSTANTS.MESSAGE_TYPES.ERROR);
            return;
        }

        const payload = {
            Title: title,
            Author: formatAuthorName(document.getElementById('cbrAuthorSurname').value, document.getElementById('cbrAuthorGiven').value),
            Author2: formatAuthorName(document.getElementById('cbrAuthor2Surname').value, document.getElementById('cbrAuthor2Given').value),
            Pages: document.getElementById('cbrPages').value ? parseInt(document.getElementById('cbrPages').value, 10) : null,
            ISBN: document.getElementById('cbrISBN').value.trim(),
            Finished: finished || null,
            Rating: document.getElementById('cbrRating').value ? parseInt(document.getElementById('cbrRating').value, 10) : null,
            Comments: document.getElementById('cbrComments').value.trim(),
            Tags: this._tagsController.getTags()
        };
        if (recordId) payload.id = recordId;
        if (itemId) payload.ItemId = itemId;

        try {
            const result = await DBManager.saveCollectionRecord('consumed', payload);
            this.close();
            showMessage(`Saved to ${MediaLabels.ConsumedLabel}`, CONSTANTS.MESSAGE_TYPES.SUCCESS);
            if (typeof ConsumedView !== 'undefined') ConsumedView.load(containerId);
            if (this._onSaved) this._onSaved(result);
        } catch (e) {
            console.error('ConsumedModal.save failed', e);
            showMessage('Could not save — see console for details', CONSTANTS.MESSAGE_TYPES.ERROR);
        }
    },

    async deleteRecord() {
        const { recordId, containerId } = this._current;
        if (!recordId) return;
        if (!await Confirm.open('Delete this record?', 'Delete')) return;

        try {
            await DBManager.deleteCollectionRecord('consumed', recordId);
            this.close();
            showMessage('Deleted', CONSTANTS.MESSAGE_TYPES.SUCCESS);
            if (typeof ConsumedView !== 'undefined') ConsumedView.load(containerId);
        } catch (e) {
            console.error('ConsumedModal.deleteRecord failed', e);
            showMessage('Could not delete — see console for details', CONSTANTS.MESSAGE_TYPES.ERROR);
        }
    }
};
