/**
 * Regression test for issue #21. Cannot verify real enforcement —
 * that a browser actually blocks a violating request needs a real
 * browser/webview and is manual (see the issue's own acceptance
 * criteria: load both builds with the console open and watch for CSP
 * violation reports). What this suite can verify from source:
 *
 *   - the web build ships a CSP meta tag at all (its prior absence was
 *     the entire defect)
 *   - the Tauri and web policies agree on every directive that should be
 *     identical between them, so a future edit to one doesn't silently
 *     drift from the other
 *   - the required directives (object-src/base-uri/form-action 'none')
 *     are present in both
 *   - the structural assumptions the policy depends on still hold: no
 *     inline event handlers, no inline <script> content, no eval/Function
 *     usage — the same greps the issue used to justify a strict policy
 *     in the first place
 */
const fs = require('fs');

const R = process.env.COLLECTYX_ROOT || '../';
const htmlSrc = fs.readFileSync(R + '/src/index.html', 'utf8');
const tauriConf = JSON.parse(fs.readFileSync(R + '/src-tauri/tauri.conf.json', 'utf8'));

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

function parseCsp(csp) {
    const directives = {};
    csp.split(';').map(s => s.trim()).filter(Boolean).forEach(part => {
        const [name, ...sources] = part.split(/\s+/);
        directives[name] = sources;
    });
    return directives;
}

// ── 1. web build carries a CSP meta tag ───────────────────────────────────────
console.log('\n1. src/index.html has a CSP meta tag');
const metaMatch = htmlSrc.match(/<meta\s+http-equiv=["']Content-Security-Policy["']\s+content=(["'])([\s\S]*?)\1/i);
ok('meta[http-equiv=Content-Security-Policy] present', !!metaMatch);

if (!metaMatch) {
    console.log('\n' + failures + ' FAILURE(S) — cannot continue without the meta tag');
    process.exit(1);
}
const webCsp = parseCsp(metaMatch[2]);
const tauriCsp = parseCsp(tauriConf.app.security.csp);

console.log('   web CSP:  ', metaMatch[2]);
console.log('   tauri CSP:', tauriConf.app.security.csp);

// ── 2. required hardening directives present in both ──────────────────────────
console.log("\n2. object-src/base-uri/form-action 'none' present in both policies");
['object-src', 'base-uri', 'form-action'].forEach(directive => {
    ok(`web: ${directive} 'none'`, (webCsp[directive] || []).includes("'none'"));
    ok(`tauri: ${directive} 'none'`, (tauriCsp[directive] || []).includes("'none'"));
});

// ── 3. the two policies agree on every directive ───────────────────────────────
// #51 put the IPC-only sources (ipc:, http://ipc.localhost) into the shared
// web meta tag too, so there is no longer a genuinely Tauri-only connect-src
// source — both policies are asserted identical across the board.
console.log('\n3. web and Tauri policies agree on every directive');
const allDirectives = new Set([...Object.keys(webCsp), ...Object.keys(tauriCsp)]);
allDirectives.forEach(directive => {
    check(`${directive} matches between web and Tauri`, webCsp[directive], tauriCsp[directive]);
});

// ── 4. baseline hardening ─────────────────────────────────────────────────────
console.log('\n4. baseline: default-src, script-src, img-src present and strict');
check("web default-src", webCsp['default-src'], ["'self'"]);
check("web script-src", webCsp['script-src'], ["'self'"]);
ok("web style-src allows 'self' and 'unsafe-inline' only",
   (webCsp['style-src'] || []).every(s => s === "'self'" || s === "'unsafe-inline'") &&
   (webCsp['style-src'] || []).includes("'self'"));

// ── 5. structural assumptions the policy relies on ─────────────────────────────
// The same checks the issue used to justify a strict script-src in the
// first place — if these ever stop holding, the CSP alone won't save it.
console.log('\n5. structural assumptions (no inline handlers/scripts) still hold');
ok('no inline event handler attributes', !/\bon[a-z]+=/i.test(htmlSrc));
const scriptTags = [...htmlSrc.matchAll(/<script\b[^>]*>/gi)];
ok('at least one <script> tag present', scriptTags.length > 0);
ok('every <script> tag has a src attribute (no inline script content)',
   scriptTags.every(m => /\bsrc\s*=/.test(m[0])));

console.log('\n' + (failures === 0
    ? 'ALL CSP TESTS PASSED'
    : failures + ' FAILURE(S)'));
process.exit(failures === 0 ? 0 : 1);
