// ── Tags modals (Add/Rename, Delete) ────────────────────────────────────────
// Split out of tags.js for naming/structure consistency with the other
// collections' {collection}-modal.js files. Depends on TagsView
// (tags-view.js) and the chip-input helpers (tag-chip-input.js) — both
// must load first.

// One modal, two modes — Add (blank) and Rename (prefilled). Reuses
// validateTagName so standalone-created tags follow the same format rule
// as chip-input-created ones (lowercase, a-z0-9_- only).
const TagFormModal = {
    _mode: 'add',
    _tagId: null,
    _wired: false,

    // Attached once, lazily — every element here exists in the DOM from
    // page load and is never rebuilt, so there's nothing to re-wire per
    // open() call.
    _bindEvents() {
        if (this._wired) return;
        const modal = document.getElementById('tagFormModal');
        if (!modal) return;
        const nameInput = document.getElementById('tagFormName');
        if (nameInput) {
            nameInput.addEventListener('input', (event) => {
                const liveError = tagLiveFormatError(event.target.value);
                if (liveError) this._showError(liveError); else this._clearError();
            });
        }
        const form = document.getElementById('tagFormForm');
        if (form) form.addEventListener('submit', (event) => this.save(event));
        modal.addEventListener('click', (event) => {
            const btn = event.target.closest('[data-action]');
            if (!btn || !modal.contains(btn)) return;
            if (btn.dataset.action === 'close') this.close();
        });
        this._wired = true;
    },

    _showError(msg) {
        const errorEl = document.getElementById('tagFormNameError');
        if (errorEl) { errorEl.textContent = msg; errorEl.style.display = 'block'; }
    },

    _clearError() {
        const errorEl = document.getElementById('tagFormNameError');
        if (errorEl) { errorEl.textContent = ''; errorEl.style.display = 'none'; }
    },

    openAdd() {
        this._bindEvents();
        this._mode = 'add';
        this._tagId = null;
        document.getElementById('tagFormModalTitle').textContent = 'Add Tag';
        document.getElementById('tagFormName').value = '';
        this._clearError();
        document.getElementById('tagFormModal').classList.add('open');
    },

    openRename(tagId) {
        this._bindEvents();
        const tag = TagsView.getTag(tagId);
        if (!tag) return;
        this._mode = 'rename';
        this._tagId = tagId;
        document.getElementById('tagFormModalTitle').textContent = 'Rename Tag';
        document.getElementById('tagFormName').value = tag.Name;
        this._clearError();
        document.getElementById('tagFormModal').classList.add('open');
    },

    close() {
        document.getElementById('tagFormModal').classList.remove('open');
    },

    async save(event) {
        event.preventDefault();

        const originalName = this._mode === 'rename'
            ? ((TagsView.getTag(this._tagId) || {}).Name || null)
            : null;

        const existingMap = {};
        TagsView._tags.forEach(t => {
            if (this._mode === 'rename' && t.id === this._tagId) return;
            existingMap[t.Name] = true;
        });

        const validation = validateTagName(document.getElementById('tagFormName').value, existingMap, originalName);
        if (!validation.valid) {
            showMessage(validation.message, CONSTANTS.MESSAGE_TYPES.ERROR);
            this._showError(validation.message);
            return;
        }

        const payload = { Name: validation.cleanTag };
        if (this._mode === 'rename' && this._tagId) payload.id = this._tagId;

        try {
            await DBManager.saveTag(payload);
            this.close();
            showMessage(this._mode === 'rename' ? 'Tag renamed' : 'Tag added', CONSTANTS.MESSAGE_TYPES.SUCCESS);
            await TagsView.refreshAll();
        } catch (e) {
            console.error('TagFormModal.save failed', e);
            showMessage('Could not save tag — see console for details', CONSTANTS.MESSAGE_TYPES.ERROR);
        }
    }
};

// Delete-from-the-system, with an optional substitute tag (design doc
// §4.6). Deleting a single book's tag stays in that collection's own Edit
// modal — this always removes the tag entirely.
const TagDeleteModal = {
    _tagId: null,
    _wired: false,

    _bindEvents() {
        if (this._wired) return;
        const modal = document.getElementById('tagDeleteModal');
        if (!modal) return;
        modal.addEventListener('click', (event) => {
            const btn = event.target.closest('[data-action]');
            if (!btn || !modal.contains(btn)) return;
            const action = btn.dataset.action;
            if (action === 'confirm') this.confirm();
            else if (action === 'close') this.close();
        });
        this._wired = true;
    },

    open(tagId) {
        this._bindEvents();
        const tag = TagsView.getTag(tagId);
        if (!tag) return;
        this._tagId = tagId;

        document.getElementById('tagDeleteName').textContent = tag.Name;
        document.getElementById('tagDeleteCount').textContent = tag.Count || 0;

        const select = document.getElementById('tagDeleteSubstitute');
        const others = TagsView._tags
            .filter(t => t.id !== tagId)
            .slice()
            .sort((a, b) => a.Name.localeCompare(b.Name));
        select.innerHTML = '<option value="">No substitute</option>' +
            others.map(t => `<option value="${escapeHtml(t.id)}">${escapeHtml(t.Name)}</option>`).join('');
        select.value = '';

        document.getElementById('tagDeleteModal').classList.add('open');
    },

    close() {
        document.getElementById('tagDeleteModal').classList.remove('open');
    },

    async confirm() {
        if (!this._tagId) return;
        const substituteId = document.getElementById('tagDeleteSubstitute').value || null;

        try {
            const affected = await DBManager.deleteTag(this._tagId, substituteId);
            this.close();
            showMessage(`Tag deleted, removed from ${affected} book(s)`, CONSTANTS.MESSAGE_TYPES.SUCCESS);
            await TagsView.refreshAll();
        } catch (e) {
            console.error('TagDeleteModal.confirm failed', e);
            showMessage('Could not delete tag — see console for details', CONSTANTS.MESSAGE_TYPES.ERROR);
        }
    }
};

window.TagFormModal = TagFormModal;
window.TagDeleteModal = TagDeleteModal;
