// ── Safe HTML templating + Trusted Types (#101) ─────────────────────────────
//
// Both CSPs carry `require-trusted-types-for 'script'`, so the browser
// refuses a plain string at innerHTML (and every other HTML/script sink).
// Markup reaches the DOM one of two ways instead:
//
//   1. Direct DOM building (textContent, createElement, replaceChildren)
//      for anything small — placeholders, clearing a container, <option>
//      lists.
//   2. The html`` tagged template below, then setHtml(el, html`...`), for
//      the larger row/card/panel templates.
//
// html`` escapes every interpolated value automatically. The only things
// it passes through unescaped are other html`` results (and arrays of
// them), so markup can only come from template literals written in this
// codebase — never from a record, a setting or an imported file. Don't
// call escapeHtml() inside an html`` template: the value would be escaped
// twice and show up as "&amp;amp;".
//
// setHtml() is the only code that can reach the 'collectyx' Trusted Types
// policy, and it only accepts SafeHtml values, so a raw string can't be
// smuggled through it. Browsers without Trusted Types (and the Node test
// harness) get the same checks, with a plain string assignment at the end.

const _token = Symbol('SafeHtml');

class SafeHtml {
    #html;
    constructor(token, htmlText) {
        if (token !== _token) throw new TypeError('SafeHtml can only be created with the html`` template tag');
        this.#html = htmlText;
    }
    toString() { return this.#html; }
}

function _escape(value) {
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function _interpolate(value) {
    if (value === null || value === undefined || value === false) return '';
    if (value instanceof SafeHtml) return value.toString();
    if (Array.isArray(value)) return value.map(_interpolate).join('');
    return _escape(value);
}

// Template literals' strings arrays are frozen and carry .raw; a plain
// array or string passed by mistake (html(someString)) is rejected rather
// than trusted.
function html(strings, ...values) {
    if (!Array.isArray(strings) || !Array.isArray(strings.raw) || !Object.isFrozen(strings)) {
        throw new TypeError('html must be used as a template tag: html`...`');
    }
    let out = strings[0];
    for (let i = 0; i < values.length; i++) {
        out += _interpolate(values[i]) + strings[i + 1];
    }
    return new SafeHtml(_token, out);
}

// Created once, on first use. If the CSP doesn't list the policy name
// (or the browser has no Trusted Types) this stays null and setHtml()
// falls back to a plain assignment, which an enforcing browser would
// then block — the CSP and this name must stay in sync (tests/csp-test.js).
const TRUSTED_TYPES_POLICY = 'collectyx';
let _policy;
function _getPolicy() {
    if (_policy !== undefined) return _policy;
    _policy = null;
    const tt = globalThis.trustedTypes;
    if (tt && typeof tt.createPolicy === 'function') {
        _policy = tt.createPolicy(TRUSTED_TYPES_POLICY, { createHTML: (s) => s });
    }
    return _policy;
}

function setHtml(el, safe) {
    if (!(safe instanceof SafeHtml)) {
        throw new TypeError('setHtml() only accepts html`` templates, not plain strings');
    }
    const policy = _getPolicy();
    el.innerHTML = policy ? policy.createHTML(safe.toString()) : safe.toString();
}

// Replaces el's contents with a single element holding plain text — the
// common "empty state" placeholder, without any markup string.
function setPlaceholder(el, tagName, className, text) {
    const node = document.createElement(tagName);
    if (className) node.className = className;
    node.textContent = text;
    el.replaceChildren(node);
}

// Replaces a <select>'s options. items: [{ value, label, selected? }].
function setOptions(select, items) {
    select.replaceChildren(...items.map(({ value, label, selected }) => {
        const opt = document.createElement('option');
        opt.value = value;
        opt.textContent = label;
        if (selected) opt.selected = true;
        return opt;
    }));
}

window.html = html;
window.setHtml = setHtml;
window.SafeHtml = SafeHtml;
window.setPlaceholder = setPlaceholder;
window.setOptions = setOptions;
window.TRUSTED_TYPES_POLICY = TRUSTED_TYPES_POLICY;
