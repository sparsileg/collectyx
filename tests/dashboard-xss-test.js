/**
 * Regression test for issue #20. Loads the real dashboard.js and
 * feeds its renderers hostile record data — the kind a CSV import or a
 * restored backup can deliver — and checks that no markup survives into
 * innerHTML unescaped. Does not touch a real DOM or a real browser; that
 * verification is manual (see the issue's own acceptance criteria).
 *
 * Since #101 the escaping comes from the real html`` template tag in
 * src/js/safe-html.js (loaded into the sandbox), and markup only reaches
 * the DOM through setHtml(); section 1 checks the source keeps it that
 * way, so a future edit that bypasses it is caught here instead of in the
 * field.
 */
const fs = require('fs');
const vm = require('vm');
const { loadSafeHtml } = require('./lib/safe-html');

const R = process.env.COLLECTYX_ROOT || '../';
const src = fs.readFileSync(R + '/src/js/dashboard.js', 'utf8');

let failures = 0;
function check(label, actual, expected) {
    const a = JSON.stringify(actual), e = JSON.stringify(expected);
    if (a === e) console.log('  ok   ' + label);
    else { console.log('  FAIL ' + label + '\n         got:      ' + a + '\n         expected: ' + e); failures++; }
}
function ok(label, cond, detail) {
    if (cond) console.log('  ok   ' + label);
    else { console.log('  FAIL ' + label + (detail ? '\n         ' + detail : '')); failures++; }
}

// Minimal DOM shim. innerHTML is captured as a raw string — the same
// thing a real browser would parse and execute — so assertions can
// check literally whether markup reached it unescaped.
class El {
    constructor(tag) { this.tag = tag; this._html = ''; this._text = ''; this.children = []; this.className = ''; this.dataset = {}; }
    set innerHTML(v) { this._html = String(v); this.children = []; }
    // Children added via replaceChildren()/appendChild() serialize as
    // plain-text elements, so assertions can read empty-state text too.
    get innerHTML() {
        return this._html + this.children.map(c => `<${c.tag} class="${c.className}">${c._text}</${c.tag}>`).join('');
    }
    replaceChildren(...nodes) { this._html = ''; this.children = nodes; }
    set textContent(v) { this._text = v; this._html = ''; }
    get textContent() { return this._text; }
    appendChild(c) { this.children.push(c); }
    getContext() { return {}; }
    querySelectorAll() { return []; }
    querySelector() { return null; }
    addEventListener() {}
}

const domStore = {};
function freshDom() {
    for (const k in domStore) delete domStore[k];
    return {
        getElementById: (id) => domStore[id] || (domStore[id] = new El('div')),
        createElement: (tag) => new El(tag),
        querySelectorAll: () => [],
        querySelector: () => null,
    };
}

// authorGivenFirst()/splitAuthorName() also live in core.js — dashboard.js
// (issue #88) now calls authorGivenFirst() in renderCheckedOut(),
// renderRecentBooks(), and renderWhatsNext() to display "Given Surname"
// instead of the stored "Surname, Given". Same real implementation
// mirrored here, not a simplified stand-in — the escaping tests below
// need it to actually reverse the name, not just pass it through, or a
// bug that only shows up post-reversal (e.g. an unescaped join) would
// go undetected.
function splitAuthorName(combined) {
    const value = String(combined || '').trim();
    if (!value) return { surname: '', given: '' };
    const commaIndex = value.indexOf(',');
    if (commaIndex === -1) return { surname: value, given: '' };
    return { surname: value.slice(0, commaIndex).trim(), given: value.slice(commaIndex + 1).trim() };
}
function authorGivenFirst(name) {
    if (!name) return '';
    const { given, surname } = splitAuthorName(name);
    return [given, surname].filter(Boolean).join(' ');
}

function loadDashboard(dom) {
    const sandbox = {
        console,
        document: dom,
        CONSTANTS: {
            ROW_LIMITS: { CHECKED_OUT: 5, RECENT_FINISHED: 5, WHATS_NEXT: 4 },
            DEFAULT_DAILY_READING_GOAL: 30,
        },
        authorGivenFirst,
        DBManager: { getSettings: async () => ({}) },
        Chart: Object.assign(function () {}, { getChart: () => null }),
        getThemeColors: () => ({ primary: '#fff', secondary: '#000' }),
    };
    sandbox.window = sandbox;
    vm.createContext(sandbox);
    loadSafeHtml(sandbox);
    vm.runInContext(
        src +
        '\nthis.renderCheckedOut = renderCheckedOut;' +
        '\nthis.renderRecentBooks = renderRecentBooks;' +
        '\nthis.renderWhatsNext = renderWhatsNext;' +
        '\nthis.renderReadingGoals = renderReadingGoals;',
        sandbox
    );
    return sandbox;
}

const XSS_PAYLOAD = '<img src=x onerror=alert(1)>';
const SCRIPT_PAYLOAD = '<script>alert(1)</script>';

// Structural guard (#101): markup reaches the DOM only via setHtml() with
// an html`` template, which escapes every interpolation itself. So: no
// direct innerHTML assignment, no escapeHtml() (it would double-escape
// inside html``), and every template literal that starts with markup is
// html-tagged.
console.log('\n1. markup only reaches the DOM through setHtml(html`...`)');
{
    ok('no direct innerHTML assignment', !/\.innerHTML\s*=/.test(src));
    ok('no escapeHtml() calls', !/escapeHtml\(/.test(src));
    const untagged = [...src.matchAll(/(\w*)`\s*</g)].filter(m => m[1] !== 'html');
    ok('every markup template literal is html-tagged', untagged.length === 0,
       'untagged: ' + untagged.map(m => m[0]).join(' | '));
    ok('setHtml() is used for the list renderers', (src.match(/setHtml\(/g) || []).length >= 3);
}

// ── 2. renderCheckedOut ───────────────────────────────────────────────────────
console.log('\n2. renderCheckedOut — hostile Title, Author, and Patron');
{
    const dom = freshDom();
    const sb = loadDashboard(dom);
    sb.renderCheckedOut([{
        id: 'b1', Title: XSS_PAYLOAD, Author: XSS_PAYLOAD, Patron: SCRIPT_PAYLOAD,
        CheckedOutDate: '2026-01-01'
    }]);
    const html = dom.getElementById('checkedOutContent').innerHTML;
    ok('img payload not present as a live tag', !html.includes('<img'));
    ok('script payload not present verbatim', !html.includes('<script>'));
    ok('escaped Title/Author payload present as literal text', (html.match(/&lt;img/g) || []).length === 2);
    ok('escaped Patron payload present as literal text', html.includes('&lt;script&gt;'));

    // A book with no CheckedOutDate is available, not checked out —
    // must be filtered out before ever reaching the renderer's output,
    // not merely escaped.
    const dom2 = freshDom();
    const sb2 = loadDashboard(dom2);
    sb2.renderCheckedOut([{ id: 'b2', Title: 'Dune', Author: 'Herbert, Frank', Patron: null, CheckedOutDate: null }]);
    const html2 = dom2.getElementById('checkedOutContent').innerHTML;
    ok('empty state shown when nothing is checked out', html2.includes('Nothing checked out'));
    ok('available (non-checked-out) book not rendered as a row', !html2.includes('Dune'));
}

// ── 3. renderRecentBooks ─────────────────────────────────────────────────────
console.log('\n3. renderRecentBooks — hostile Title and Author');
{
    const dom = freshDom();
    const sb = loadDashboard(dom);
    sb.renderRecentBooks([{ Title: XSS_PAYLOAD, Author: XSS_PAYLOAD, Finished: '2020-01-01' }]);
    const html = dom.getElementById('recentBooks').innerHTML;
    ok('img payload not present as a live tag', !html.includes('<img'));
    ok('escaped payload present as literal text', html.includes('&lt;img'));
    ok('escaped in both Title and Author slots', (html.match(/&lt;img/g) || []).length === 2);
}

// ── 4. renderWhatsNext ────────────────────────────────────────────────────────
console.log('\n4. renderWhatsNext — hostile Title, Author, and Rank');
{
    const dom = freshDom();
    const sb = loadDashboard(dom);
    sb.renderWhatsNext([{ Title: XSS_PAYLOAD, Author: XSS_PAYLOAD, Rank: null }]);
    const html = dom.getElementById('whatsNextContent').innerHTML;
    ok('img payload not present as a live tag', !html.includes('<img'));
    ok('escaped payload present as literal text', html.includes('&lt;img'));
    ok('Unranked fallback still renders when Rank is null', html.includes('Unranked'));

    const dom2 = freshDom();
    const sb2 = loadDashboard(dom2);
    sb2.renderWhatsNext([{ Title: 'Dune', Author: 'Herbert', Rank: SCRIPT_PAYLOAD }]);
    const html2 = dom2.getElementById('whatsNextContent').innerHTML;
    ok('hostile Rank value escaped too', !html2.includes('<script>') && html2.includes('&lt;script&gt;'));
}

// ── 5. renderReadingGoals ─────────────────────────────────────────────────────
console.log('\n5. renderReadingGoals — hostile dailyReadingGoal, and normal case');
{
    const dom = freshDom();
    const sb = loadDashboard(dom);
    sb.DBManager.getSettings = async () => ({ dailyReadingGoal: '<b>x</b>' });
    return sb.renderReadingGoals([]).then(() => {
        const gd = dom.getElementById('goalDisplay');
        ok('no raw HTML assigned to goalDisplay (content set via textContent instead)', gd._html === '');
        ok('a child element was appended rather than raw HTML injected', gd.children.length === 1);
        const child = gd.children[0];
        ok('no bold tag produced from the hostile value', !child.textContent.includes('<b>'));
        ok('falls back to the default goal since the hostile value is not numeric',
           child.textContent.includes('30 pages'));
        check('goal-current class preserved for styling', child.className, 'goal-current');

        // Normal case: existing behaviour unchanged for ordinary data.
        const dom2 = freshDom();
        const sb2 = loadDashboard(dom2);
        sb2.DBManager.getSettings = async () => ({ dailyReadingGoal: 45 });
        return sb2.renderReadingGoals([]).then(() => {
            const gd2 = dom2.getElementById('goalDisplay');
            check('ordinary numeric goal renders unchanged', gd2.children[0].textContent, 'Daily Goal: 45 pages');

            console.log('\n' + (failures === 0
                ? 'ALL DASHBOARD XSS TESTS PASSED'
                : failures + ' FAILURE(S)'));
            process.exit(failures === 0 ? 0 : 1);
        });
    });
}
