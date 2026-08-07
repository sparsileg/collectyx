// ── My Library (owned) modal ────────────────────────────────────────────────
// Title, Author, Author 2, Pages, ISBN, Tags, Location. Patron/CheckedOutDate
// are deliberately absent from this payload — omitting a key means "leave
// it alone" (design doc §6.3), so editing catalog info here never touches
// checkout status. That's managed exclusively through OwnedView's
// checkout/check-in flow instead.

const OwnedModal = {
    _tagsController: null,
    _current: { recordId: null, containerId: null, itemId: null },

    _init() {
        if (!this._tagsController) {
            this._tagsController = initTagChipInput({
                input: 'mlTagsInput', suggestions: 'mlTagsSuggestions', chipRow: 'mlTagsChipRow', hidden: 'mlTags'
            });
        }
        this._bindEvents();
    },

    // #mlModal and its form are static markup, never rebuilt — bind once,
    // guarded, same pattern as the collection views.
    _wired: false,
    _bindEvents() {
        if (this._wired) return;
        this._wired = true;
        const form = document.getElementById('mlForm');
        if (form) form.addEventListener('submit', (event) => this.save(event));
        const modal = document.getElementById('mlModal');
        if (!modal) return;
        modal.addEventListener('click', (event) => {
            const btn = event.target.closest('[data-action]');
            if (!btn || !modal.contains(btn)) return;
            const action = btn.dataset.action;
            if (action === 'close') this.close();
            else if (action === 'delete') this.deleteRecord();
        });
    },

    open(recordId, containerId) {
        this._init();
        const record = recordId ? CollectionView.getRecord(containerId, recordId) : null;
        this._current = { recordId, containerId, itemId: record ? record.ItemId : null };

        document.getElementById('mlModalTitle').textContent = record
            ? `Edit ${MediaLabels.OwnedLabel}`
            : `Add to ${MediaLabels.OwnedLabel}`;

        document.getElementById('mlTitle').value = record ? (record.Title || '') : '';
        const author = splitAuthorName(record ? record.Author : '');
        document.getElementById('mlAuthorGiven').value = author.given;
        document.getElementById('mlAuthorSurname').value = author.surname;
        const author2 = splitAuthorName(record ? record.Author2 : '');
        document.getElementById('mlAuthor2Given').value = author2.given;
        document.getElementById('mlAuthor2Surname').value = author2.surname;
        document.getElementById('mlPages').value = record && record.Pages != null ? record.Pages : '';
        document.getElementById('mlISBN').value = record ? (record.ISBN || '') : '';
        document.getElementById('mlLocation').value = record ? (record.Location || '') : '';

        this._tagsController.setTags(record ? (record.Tags || []) : []);
        this._tagsController.refreshSuggestions();

        document.getElementById('mlDeleteBtn').style.display = record ? '' : 'none';
        document.getElementById('mlModal').classList.add('open');
    },

    close() {
        document.getElementById('mlModal').classList.remove('open');
    },

    async save(event) {
        event.preventDefault();
        const { recordId, containerId, itemId } = this._current;

        const title = document.getElementById('mlTitle').value.trim();
        if (!title) { showMessage('Title is required.', CONSTANTS.MESSAGE_TYPES.ERROR); return; }

        const payload = {
            Title: title,
            Author: formatAuthorName(document.getElementById('mlAuthorSurname').value, document.getElementById('mlAuthorGiven').value),
            Author2: formatAuthorName(document.getElementById('mlAuthor2Surname').value, document.getElementById('mlAuthor2Given').value),
            Pages: document.getElementById('mlPages').value ? parseInt(document.getElementById('mlPages').value, 10) : null,
            ISBN: document.getElementById('mlISBN').value.trim(),
            Location: document.getElementById('mlLocation').value.trim(),
            Tags: this._tagsController.getTags()
        };
        if (recordId) payload.id = recordId;
        if (itemId) payload.ItemId = itemId;

        try {
            await DBManager.saveCollectionRecord('owned', payload);
            this.close();
            showMessage(`Saved to ${MediaLabels.OwnedLabel}`, CONSTANTS.MESSAGE_TYPES.SUCCESS);
            if (typeof OwnedView !== 'undefined') OwnedView.load(containerId);
        } catch (e) {
            console.error('OwnedModal.save failed', e);
            showMessage('Could not save — see console for details', CONSTANTS.MESSAGE_TYPES.ERROR);
        }
    },

    async deleteRecord() {
        const { recordId, containerId } = this._current;
        if (!recordId) return;
        if (!await Confirm.open('Delete this record?', 'Delete')) return;

        try {
            await DBManager.deleteCollectionRecord('owned', recordId);
            this.close();
            showMessage('Deleted', CONSTANTS.MESSAGE_TYPES.SUCCESS);
            if (typeof OwnedView !== 'undefined') OwnedView.load(containerId);
        } catch (e) {
            console.error('OwnedModal.deleteRecord failed', e);
            showMessage('Could not delete — see console for details', CONSTANTS.MESSAGE_TYPES.ERROR);
        }
    }
};
