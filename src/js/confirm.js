// ── Shared confirmation modal ────────────────────────────────────────────────
// Replaces native confirm(). Tauri v2 overrides window.confirm() with an
// async IPC call that also needs an ACL grant — so every existing
// `if (!confirm(...)) return;` guard silently never fired (a pending Promise
// is truthy). This is a plain in-app modal instead: no IPC, no ACL, and
// identical behaviour in the web build. Same pattern TagDeleteModal already
// used.
//
// One visual style — every current call site is destructive.

const Confirm = {
    _resolve: null,
    _wired: false,

    _bindEvents() {
        if (this._wired) return;
        const modal = document.getElementById('confirmModal');
        if (!modal) return;
        modal.addEventListener('click', (event) => {
            const btn = event.target.closest('[data-action]');
            if (!btn || !modal.contains(btn)) return;
            const action = btn.dataset.action;
            if (action === 'confirm') this._settle(true);
            else if (action === 'cancel') this._settle(false);
        });
        this._wired = true;
    },

    // Resolves true (confirmed) or false (cancelled). A second open() while
    // one is already pending cancels the first rather than leaving it
    // unresolved — nothing does that today, but an abandoned Promise would
    // hang its caller's async function forever.
    //
    // If binding failed (#confirmModal missing from the DOM), this must
    // read as "cancel" rather than a Promise nothing ever resolves — an
    // unanswerable confirmation hanging its caller forever is worse than a
    // wrongly-cancelled action (COLLECTYX-SEC-36).
    open(message, confirmLabel) {
        this._bindEvents();
        if (!this._wired) {
            console.error('Confirm.open: #confirmModal not found — treating as cancelled');
            return Promise.resolve(false);
        }
        if (this._resolve) this._settle(false);

        const messageEl = document.getElementById('confirmMessage');
        if (messageEl) messageEl.textContent = message;
        const confirmBtn = document.getElementById('confirmOkBtn');
        if (confirmBtn) confirmBtn.textContent = confirmLabel || 'Confirm';

        const modal = document.getElementById('confirmModal');
        if (!modal) return Promise.resolve(false);
        modal.classList.add('open');

        return new Promise((resolve) => { this._resolve = resolve; });
    },

    _settle(result) {
        const modal = document.getElementById('confirmModal');
        if (modal) modal.classList.remove('open');
        const resolve = this._resolve;
        this._resolve = null;
        if (resolve) resolve(result);
    }
};

window.Confirm = Confirm;
