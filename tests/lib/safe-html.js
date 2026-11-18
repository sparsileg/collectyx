// tests/lib/safe-html.js
//
// Loads the real src/js/safe-html.js (#101) into a vm sandbox, so suites
// that run renderers see the same html`` / setHtml() / setPlaceholder()
// the app uses — real escaping, not a test-local stand-in. Call it after
// vm.createContext(sandbox) and before running the code under test.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const R = process.env.COLLECTYX_ROOT || path.resolve(__dirname, '../..');
const SRC = fs.readFileSync(path.join(R, 'src/js/safe-html.js'), 'utf8');

function loadSafeHtml(sandbox) {
    if (!sandbox.window) sandbox.window = sandbox;
    vm.runInContext(SRC, sandbox, { filename: 'safe-html.js' });
}

module.exports = { loadSafeHtml, SAFE_HTML_SRC: SRC };
