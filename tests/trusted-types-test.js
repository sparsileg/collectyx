/**
 * Issue #101 — Trusted Types.
 *
 * Both CSPs now carry `require-trusted-types-for 'script'`, so a plain
 * string assigned to innerHTML throws in an enforcing browser. This suite
 * checks the two halves of what keeps the app working under that:
 *
 *   1. src/js/safe-html.js itself — html`` escapes every interpolation,
 *      nests and joins its own results without re-escaping, refuses to be
 *      called as a plain function, and setHtml() only accepts html``
 *      results and routes them through the 'collectyx' policy when the
 *      browser has Trusted Types (a plain assignment otherwise).
 *   2. A source scan of every app file in src/js: no remaining direct
 *      HTML/script sinks, no escapeHtml() (it would double-escape inside
 *      html``), and every template literal that starts with markup is
 *      html-tagged, so none can reach setHtml() as an untagged string.
 *
 * Whether a real browser accepts every screen under enforcement is
 * checked by hand / headless browser, not here.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { SAFE_HTML_SRC } = require('./lib/safe-html');

const R = process.env.COLLECTYX_ROOT || path.resolve(__dirname, '..');

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
function throws(label, fn, match) {
    try { fn(); } catch (e) {
        ok(label, !match || match.test(e.message), 'wrong error: ' + e.message);
        return;
    }
    ok(label, false, 'did not throw');
}

// Fresh sandbox per scenario; trustedTypes optional.
function load(trustedTypes) {
    const sandbox = { console, document: {
        createElement: (tag) => ({ tag, className: '', textContent: '', value: '', selected: false }),
    } };
    if (trustedTypes) sandbox.trustedTypes = trustedTypes;
    sandbox.window = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(SAFE_HTML_SRC, sandbox);
    return sandbox;
}
const el = () => {
    const e = { innerHTML: '', children: null };
    e.replaceChildren = (...nodes) => { e.children = nodes; };
    return e;
};

const HOSTILE = `<img src=x onerror="alert('1')">&`;
const ESCAPED = '&lt;img src=x onerror=&quot;alert(&#39;1&#39;)&quot;&gt;&amp;';

console.log('\n1. html`` escapes interpolations, keeps the template literal as markup');
{
    const { html } = load();
    check('hostile value escaped (all five characters)', String(html`<b>${HOSTILE}</b>`), `<b>${ESCAPED}</b>`);
    check('attribute value escaped', String(html`<div data-x="${'" onclick="x'}"></div>`),
          '<div data-x="&quot; onclick=&quot;x"></div>');
    check('numbers render as text, 0 included', String(html`${0}|${42}`), '0|42');
    check('null, undefined and false render as nothing', String(html`[${null}${undefined}${false}]`), '[]');
    check('the literal parts are not escaped', String(html`<p>&amp; &lt;</p>`), '<p>&amp; &lt;</p>');
}

console.log('\n2. nesting and arrays pass html`` results through once, escape everything else');
{
    const { html } = load();
    const inner = html`<i>${'<x>'}</i>`;
    check('nested html`` not re-escaped', String(html`<b>${inner}</b>`), '<b><i>&lt;x&gt;</i></b>');
    check('array of html`` joined with nothing', String(html`${['a', 'b'].map(x => html`<li>${x}</li>`)}`), '<li>a</li><li>b</li>');
    check('plain strings inside an array are escaped', String(html`${['<a>', html`<b></b>`]}`), '&lt;a&gt;<b></b>');
    check('a plain string that looks like markup is escaped', String(html`${'<b>bold</b>'}`), '&lt;b&gt;bold&lt;/b&gt;');
}

console.log('\n3. html`` and SafeHtml cannot be used to launder a plain string');
{
    const { html, SafeHtml } = load();
    throws('html(string) rejected', () => html('<b>x</b>'), /template tag/);
    throws('html([string]) rejected', () => html(['<b>x</b>']), /template tag/);
    throws('fake strings array (unfrozen, with raw) rejected', () => {
        const a = ['<b>x</b>']; a.raw = ['<b>x</b>']; html(a);
    }, /template tag/);
    throws('new SafeHtml() rejected', () => new SafeHtml(Symbol('SafeHtml'), '<b>'), /html`` template tag/);
}

console.log('\n4. setHtml() without Trusted Types: html`` only, plain assignment');
{
    const { html, setHtml } = load();
    const e = el();
    setHtml(e, html`<p>${HOSTILE}</p>`);
    check('assigned as a plain escaped string', e.innerHTML, `<p>${ESCAPED}</p>`);
    throws('plain string rejected', () => setHtml(el(), '<p>x</p>'), /only accepts html``/);
    throws('String(html``) rejected — the brand is lost once stringified', () => setHtml(el(), String(html`<p></p>`)), /only accepts html``/);
}

console.log('\n5. setHtml() with Trusted Types: one named policy, created once, used for every write');
{
    const created = [];
    const tt = {
        createPolicy(name, rules) {
            created.push(name);
            return { createHTML: (s) => ({ trusted: rules.createHTML(s) }) };
        },
    };
    const { html, setHtml, TRUSTED_TYPES_POLICY } = load(tt);
    check('nothing created until first use', created, []);
    const a = el(), b = el();
    setHtml(a, html`<p>${'<x>'}</p>`);
    setHtml(b, html`<q></q>`);
    check('policy created once, under the CSP name', created, ['collectyx']);
    check('exported policy name matches', TRUSTED_TYPES_POLICY, 'collectyx');
    check('innerHTML receives the TrustedHTML object, escaped content', a.innerHTML, { trusted: '<p>&lt;x&gt;</p>' });
    check('second write reuses it', b.innerHTML, { trusted: '<q></q>' });
}

console.log('\n6. setPlaceholder() and setOptions() build elements, no markup');
{
    const { setPlaceholder, setOptions } = load();
    const e = el();
    setPlaceholder(e, 'p', 'goal-placeholder', HOSTILE);
    check('one element, text set via textContent', e.children.map(c => [c.tag, c.className, c.textContent]),
          [['p', 'goal-placeholder', HOSTILE]]);
    check('no innerHTML touched', e.innerHTML, '');
    const s = el();
    setOptions(s, [{ value: '', label: 'Select' }, { value: '3', label: HOSTILE, selected: true }]);
    check('options built with value/text/selected', s.children.map(o => [o.tag, o.value, o.textContent, o.selected]),
          [['option', '', 'Select', false], ['option', '3', HOSTILE, true]]);
}

console.log('\n7. no app file writes HTML or script anywhere except through safe-html.js');
{
    const dir = path.join(R, 'src/js');
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.js') && f !== 'safe-html.js');
    ok('found the app modules', files.length >= 20, 'only ' + files.length);
    const SINKS = [
        [/\.(innerHTML|outerHTML)\s*=(?!=)/, 'innerHTML/outerHTML assignment'],
        [/\binsertAdjacentHTML\s*\(/, 'insertAdjacentHTML'],
        [/\bdocument\.write(ln)?\s*\(/, 'document.write'],
        [/\bcreateContextualFragment\s*\(/, 'createContextualFragment'],
        [/\bDOMParser\b/, 'DOMParser'],
        [/\.srcdoc\s*=/, 'srcdoc'],
        [/\beval\s*\(|\bnew Function\s*\(/, 'eval / new Function'],
        [/\bset(Timeout|Interval)\s*\(\s*['"`]/, 'string setTimeout/setInterval'],
        [/createElement\(\s*['"]script['"]/, 'dynamic <script>'],
        [/\bescapeHtml\s*\(/, 'escapeHtml() (double-escapes inside html``)'],
    ];
    const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    for (const f of files) {
        const src = strip(fs.readFileSync(path.join(dir, f), 'utf8'));
        const hits = SINKS.filter(([re]) => re.test(src)).map(([, name]) => name);
        check(`${f}: no raw sinks`, hits, []);
        const untagged = [...src.matchAll(/(\w*)`\s*</g)].filter(m => m[1] !== 'html').map(m => m[0]);
        check(`${f}: every markup template literal is html-tagged`, untagged, []);
    }
    const vendor = path.join(dir, 'vendor');
    const vendorFiles = fs.existsSync(vendor) ? fs.readdirSync(vendor, { recursive: true }).filter(f => String(f).endsWith('.js')) : [];
    for (const f of vendorFiles) {
        const src = strip(fs.readFileSync(path.join(vendor, String(f)), 'utf8'));
        check(`vendor/${f}: no HTML sinks`, /\.(innerHTML|outerHTML)\s*=|insertAdjacentHTML|document\.write/.test(src), false);
    }
}

console.log('\n' + (failures === 0 ? 'ALL TRUSTED TYPES TESTS PASSED' : failures + ' FAILURE(S)'));
process.exit(failures === 0 ? 0 : 1);
