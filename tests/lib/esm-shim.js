// tests/lib/esm-shim.js
//
// Several src/js files became real ES modules under #66 (full ESM
// conversion, withGlobalTauri: false) and now carry a top-level
// `import { ... } from './vendor/tauri-api/core.js';` line. The test
// harness loads source via fs.readFileSync + vm.runInContext, which has
// no ESM loader — `import` is a SyntaxError there. This shim strips those
// import lines before the source runs, and supplies stub bindings for
// whatever names were imported so the script doesn't ReferenceError the
// moment it references them.
//
// No test suite in this project exercises real Tauri IPC — every stub
// therefore throws if actually called, except isTauri(), which returns
// false (tests target backend-agnostic logic paths; a call reaching a
// real isTauri()-gated branch would mean the test silently started
// exercising a path it isn't asserting against).

const IMPORT_LINE = /^import\s*\{([^}]+)\}\s*from\s*['"][^'"]+['"];?\s*$/gm;

function stripEsmImports(src) {
    const bindings = new Set();
    const stripped = src.replace(IMPORT_LINE, (_, names) => {
        names.split(',').forEach(part => {
            const m = part.trim().match(/^(\w+)(?:\s+as\s+(\w+))?$/);
            if (m) bindings.add(m[2] || m[1]);
        });
        return '';
    });
    return { stripped, bindings: [...bindings] };
}

function esmStubs(bindings) {
    const stubs = {};
    bindings.forEach(name => {
        stubs[name] = name === 'isTauri'
            ? () => false
            : (...args) => {
                  throw new Error(name + '() called — real IPC is not exercised by this test harness');
              };
    });
    return stubs;
}

module.exports = { stripEsmImports, esmStubs };
