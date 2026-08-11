/**
 * Regression test for issue #68 (CTX-SEC-118). Loads the real csv-utils.js
 * and collection-io.js and exercises:
 *
 *   1. CsvUtils.parseCSV — duplicate-header rejection, null-prototype rows
 *      (a "__proto__"/"constructor" header must not touch Object.prototype).
 *   2. CollectionIO.handleImportFileSelected — row-count cap, re-entry
 *      guard, and that a parseCSV rejection surfaces as a message rather
 *      than an uncaught exception.
 *
 * DBManager, showMessage, and the view reload hooks are mocked — this is
 * exercising collection-io.js's own control flow, not a real save.
 */
const fs = require('fs');
const vm = require('vm');

const R = process.env.COLLECTYX_ROOT || '../';

let failures = 0;
function ok(label, cond, detail) {
    if (cond) console.log('  ok   ' + label);
    else { console.log('  FAIL ' + label + (detail ? '\n         ' + detail : '')); failures++; }
}
function contains(label, haystack, needle) {
    ok(label, typeof haystack === 'string' && haystack.includes(needle),
       'expected to contain: ' + JSON.stringify(needle) + '\n         got: ' + JSON.stringify(haystack));
}

function makeSandbox() {
    const messages = [];
    const saved = [];
    const sandbox = {
        console,
        setTimeout,
        showMessage: (text, type) => messages.push({ text, type }),
        downloadFile: () => {},
        DBManager: {
            saveCollectionRecord: async (collection, payload) => {
                saved.push({ collection, payload });
                return { id: 'r' + saved.length, item_id: 'i' + saved.length };
            },
        },
    };
    sandbox.window = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(fs.readFileSync(R + '/src/js/constants.js', 'utf8') +
                    '\nthis.CONSTANTS = CONSTANTS;', sandbox);
    vm.runInContext(fs.readFileSync(R + '/src/js/csv-utils.js', 'utf8') +
                    '\nthis.CsvUtils = CsvUtils;', sandbox);
    vm.runInContext(fs.readFileSync(R + '/src/js/collection-io.js', 'utf8') +
                    '\nthis.CollectionIO = CollectionIO;\nthis.COLLECTION_IO_SPEC = COLLECTION_IO_SPEC;', sandbox);
    return { sandbox, messages, saved };
}

function fakeFile(text, size) {
    return { text: async () => text, size: size != null ? size : text.length };
}

(async function run() {

console.log('\n1. CsvUtils.parseCSV — duplicate headers rejected');
{
    const { sandbox } = makeSandbox();
    let threw = null;
    try {
        sandbox.CsvUtils.parseCSV('Title,Author,Title\nDune,Herbert,Dune\n');
    } catch (e) { threw = e; }
    ok('throws on duplicate column', threw !== null);
    contains('error names the duplicate column', threw ? threw.message : '', 'Title');
}

console.log('\n2. CsvUtils.parseCSV — "__proto__" header cannot pollute Object.prototype');
{
    const { sandbox } = makeSandbox();
    const before = Object.prototype.polluted;
    const rows = sandbox.CsvUtils.parseCSV('__proto__,Title\n{"polluted":true},Dune\n');
    ok('row is a null-prototype object', Object.getPrototypeOf(rows[0]) === null);
    ok('"__proto__" landed as a plain own key, not the prototype accessor',
       typeof rows[0].__proto__ === 'string' && rows[0].__proto__.includes('polluted'));
    ok('Object.prototype was not touched', Object.prototype.polluted === before);
}

console.log('\n3. CollectionIO.handleImportFileSelected — row cap rejects an oversized file');
{
    const { sandbox, messages, saved } = makeSandbox();
    sandbox.CollectionIO._importTarget = 'consumed';
    const max = sandbox.CONSTANTS.MAX_IMPORT_ROWS;
    const rows = ['Title'];
    for (let i = 0; i <= max; i++) rows.push('Book ' + i);
    const csv = rows.join('\n') + '\n';
    const event = { target: { files: [fakeFile(csv)] } };

    await sandbox.CollectionIO.handleImportFileSelected(event);

    ok('no records saved', saved.length === 0);
    ok('an error message was shown', messages.some(m => m.type === 'error'));
    contains('message names the row cap', messages[messages.length - 1].text, String(max));
    ok('_importing reset to false after rejection', sandbox.CollectionIO._importing === false);
}

console.log('\n4. CollectionIO.handleImportFileSelected — concurrent import is rejected');
{
    const { sandbox, messages, saved } = makeSandbox();
    sandbox.CollectionIO._importTarget = 'consumed';
    const csv = 'Title\nBook A\nBook B\n';
    const event1 = { target: { files: [fakeFile(csv)] } };
    const event2 = { target: { files: [fakeFile(csv)] } };

    const p1 = sandbox.CollectionIO.handleImportFileSelected(event1);
    const p2 = sandbox.CollectionIO.handleImportFileSelected(event2);
    await Promise.all([p1, p2]);

    ok('exactly one import ran to completion (2 rows saved, not 4)', saved.length === 2,
       'saved.length = ' + saved.length);
    ok('the second call was told an import is already running',
       messages.some(m => m.type === 'error' && m.text.includes('already running')));
}

console.log('\n5. CollectionIO.handleImportFileSelected — duplicate header in a real import surfaces as a message, not a crash');
{
    const { sandbox, messages, saved } = makeSandbox();
    sandbox.CollectionIO._importTarget = 'consumed';
    const csv = 'Title,Title\nDune,Dune\n';
    const event = { target: { files: [fakeFile(csv)] } };

    let threw = null;
    try {
        await sandbox.CollectionIO.handleImportFileSelected(event);
    } catch (e) { threw = e; }

    ok('does not throw out of handleImportFileSelected', threw === null);
    ok('no records saved', saved.length === 0);
    contains('duplicate-column error shown to the user',
             messages[messages.length - 1].text, 'Duplicate column');
    ok('_importing reset to false after the caught error', sandbox.CollectionIO._importing === false);
}

console.log('\n6. CollectionIO.handleImportFileSelected — normal import still works');
{
    const { sandbox, messages, saved } = makeSandbox();
    sandbox.CollectionIO._importTarget = 'consumed';
    const csv = 'Title,Author\nDune,Herbert\n,No Title\n';
    const event = { target: { files: [fakeFile(csv)] } };

    await sandbox.CollectionIO.handleImportFileSelected(event);

    ok('one valid row saved, one empty-title row skipped', saved.length === 1,
       'saved.length = ' + saved.length);
    ok('success message shown', messages.some(m => m.type === 'success'));
}

console.log('\n' + (failures === 0
    ? 'ALL CSV IMPORT TESTS PASSED'
    : failures + ' FAILURE(S)'));
process.exit(failures === 0 ? 0 : 1);

})().catch(e => {
    console.error('\nHARNESS ERROR:', e);
    process.exit(1);
});
