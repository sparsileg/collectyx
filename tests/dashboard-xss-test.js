/**
 * Regression test for COLLECTYX-SEC-01. Loads the real dashboard.js and
 * feeds its renderers hostile record data — the kind a CSV import or a
 * restored backup can deliver — and checks that no markup survives into
 * innerHTML unescaped. Does not touch a real DOM or a real browser; that
 * verification is manual (see the issue's own acceptance criteria) —
 * this suite only proves the source keeps calling escapeHtml() at every
 * sink, so a future edit that drops one is caught here instead of in
 * the field.
 */
const fs = require('fs');
const vm = require('vm');

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
    constructor(tag) { this.tag = tag; this._html = ''; this._text = ''; this.children = []; this.className = ''; }
    set innerHTML(v) { this._html = v; this.children = []; }
    get innerHTML() { return this._html; }
    set textContent(v) { this._text = v; this._html = ''; }
    get textContent() { return this._text; }
    appendChild(c) { this.children.push(c); }
    getContext() { return {}; }
    querySelectorAll() { return []; }
    querySelector() { return null; }
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

// The real escapeHtml() lives in core.js, not uploaded for this suite —
// use the same entity-escaping contract dashboard.js's six sibling
// files already rely on (core.js ~line 212, per the issue).
function escapeHtml(str) {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function loadDashboard(dom) {
    const sandbox = {
        console,
        document: dom,
        CONSTANTS: {
            ROW_LIMITS: { TOP_TAGS: 7, RECENT_FINISHED: 5, WHATS_NEXT: 4 },
            DEFAULT_DAILY_READING_GOAL: 30,
        },
        escapeHtml,
        DBManager: { getSettings: async () => ({}) },
        Chart: Object.assign(function () {}, { getChart: () => null }),
        getThemeColors: () => ({ primary: '#fff', secondary: '#000' }),
    };
    sandbox.window = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(
        src +
        '\nthis.renderTopTags = renderTopTags;' +
        '\nthis.renderRecentBooks = renderRecentBooks;' +
        '\nthis.renderWhatsNext = renderWhatsNext;' +
        '\nthis.renderReadingGoals = renderReadingGoals;',
        sandbox
    );
    return sandbox;
}

const XSS_PAYLOAD = '<img src=x onerror=alert(1)>';
const SCRIPT_PAYLOAD = '<script>alert(1)</script>';

// grep-equivalent structural guard: every `${` in the file must be inside
// an escapeHtml(...) call or attached to a textContent assignment, never
// bare inside a template that flows into innerHTML. This is the same
// check the issue's acceptance criteria specify by hand
// (`grep -n '${' src/js/dashboard.js`), automated.
console.log('\n1. every template interpolation is escaped or routed through textContent');
{
    const lines = src.split('\n');
    let sawTextContentAssignment = false;
    lines.forEach((line, i) => {
        if (!line.includes('${')) return;
        if (/\.textContent\s*=/.test(line)) { sawTextContentAssignment = true; return; }
        const interpolations = [...line.matchAll(/\$\{([^}]*)\}/g)].map(m => m[1]);
        interpolations.forEach(expr => {
            ok(`line ${i + 1}: \${${expr}} is escaped`, /^escapeHtml\(/.test(expr.trim()),
               'raw interpolation: ' + line.trim());
        });
    });
    ok('at least one textContent-based assignment found (renderReadingGoals)', sawTextContentAssignment);
}

// ── 2. renderTopTags ─────────────────────────────────────────────────────────
console.log('\n2. renderTopTags — hostile tag name and count');
{
    const dom = freshDom();
    const sb = loadDashboard(dom);
    sb.renderTopTags([{ Name: SCRIPT_PAYLOAD, Count: 3 }]);
    const html = dom.getElementById('topTagsContent').innerHTML;
    ok('script payload not present verbatim', !html.includes('<script>'));
    ok('escaped payload present as literal text', html.includes('&lt;script&gt;'));
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
        ok('goalDisplay.innerHTML left empty (content set via textContent instead)', gd.innerHTML === '');
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
