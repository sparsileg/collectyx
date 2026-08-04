/**
 * Phase 2 parity checks.
 *  1. DBManagerWeb and DBManagerTauri expose the same method surface.
 *  2. Every command db-manager-tauri.js invokes is registered in lib.rs
 *     and actually defined as a #[tauri::command] in the commands modules.
 */
const fs = require('fs');
const vm = require('vm');

const R = (process.env.COLLECTYX_ROOT || '../') + '';
let failures = 0;
function ok(label, cond, detail) {
    if (cond) console.log('  ok   ' + label);
    else { console.log('  FAIL ' + label + (detail ? '\n         ' + detail : '')); failures++; }
}

// ── 1. Interface parity ───────────────────────────────────────────────────────
console.log('\n1. backend interface parity');

function loadBackend(file, exportName) {
    const sandbox = {
        console: { log() {}, warn() {}, error() {} },
        indexedDB: {}, crypto: { randomUUID: () => 'x' },
        Promise, Set, Map, Array, Object, String, Number, Date, JSON, Error, Boolean,
    };
    sandbox.window = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(fs.readFileSync(R + '/src/js/constants.js', 'utf8') +
                    '\nthis.CONSTANTS = CONSTANTS;', sandbox);
    vm.runInContext(fs.readFileSync(R + '/src/js/' + file, 'utf8') +
                    '\nthis.__B = ' + exportName + ';', sandbox);
    return sandbox.__B;
}

const web = loadBackend('db-manager-web.js', 'DBManagerWeb');
// db-manager-tauri.js references DBManagerWeb-free globals only, so it loads alone.
const tauri = loadBackend('db-manager-tauri.js', 'DBManagerTauri');

const methodsOf = (obj) => Object.keys(obj)
    .filter(k => typeof obj[k] === 'function' && !k.startsWith('_'))
    .sort();

const webMethods = methodsOf(web);
const tauriMethods = methodsOf(tauri);

const onlyWeb = webMethods.filter(m => !tauriMethods.includes(m));
const onlyTauri = tauriMethods.filter(m => !webMethods.includes(m));

console.log('   web   (' + webMethods.length + '): ' + webMethods.join(', '));
console.log('   tauri (' + tauriMethods.length + '): ' + tauriMethods.join(', '));

ok('no method exists only on web', onlyWeb.length === 0, 'web-only: ' + onlyWeb.join(', '));
ok('no method exists only on tauri', onlyTauri.length === 0, 'tauri-only: ' + onlyTauri.join(', '));

// Arity: a mismatch means one backend silently ignores an argument.
const arityMismatch = webMethods
    .filter(m => tauriMethods.includes(m))
    .filter(m => web[m].length !== tauri[m].length)
    .map(m => m + ' (web ' + web[m].length + ' vs tauri ' + tauri[m].length + ')');
ok('argument counts agree', arityMismatch.length === 0, arityMismatch.join('; '));

// ── 2. Rust command wiring ────────────────────────────────────────────────────
console.log('\n2. Rust command wiring');

const tauriJs = fs.readFileSync(R + '/src/js/db-manager-tauri.js', 'utf8');
const libRs = fs.readFileSync(R + '/src-tauri/src/lib.rs', 'utf8');

// Commands the JS actually calls: invoke('name') plus the per-collection table.
const invoked = new Set();
[...tauriJs.matchAll(/invoke\(\s*'([a-z_]+)'/g)].forEach(m => invoked.add(m[1]));
[...tauriJs.matchAll(/(?:getAll|save|remove|replaceAll):\s*'([a-z_]+)'/g)]
    .forEach(m => invoked.add(m[1]));

// Commands registered in lib.rs's invoke_handler.
const handlerBlock = libRs.slice(
    libRs.indexOf('invoke_handler'),
    libRs.indexOf('])', libRs.indexOf('invoke_handler'))
);
const registered = new Set(
    [...handlerBlock.matchAll(/commands::\w+::(\w+)/g)].map(m => m[1])
);

// Commands actually defined with #[tauri::command].
const defined = new Set();
const cmdDir = R + '/src-tauri/src/commands';
fs.readdirSync(cmdDir).filter(f => f.endsWith('.rs')).forEach(f => {
    const src = fs.readFileSync(cmdDir + '/' + f, 'utf8');
    [...src.matchAll(/#\[tauri::command\][\s\S]{0,80}?pub fn (\w+)/g)]
        .forEach(m => defined.add(m[1]));
});

console.log('   invoked by JS  (' + invoked.size + '): ' + [...invoked].sort().join(', '));
console.log('   registered     (' + registered.size + ')');
console.log('   defined in rs  (' + defined.size + ')');

const notRegistered = [...invoked].filter(c => !registered.has(c));
ok('every invoked command is registered in lib.rs',
   notRegistered.length === 0, 'missing: ' + notRegistered.join(', '));

const notDefined = [...invoked].filter(c => !defined.has(c));
ok('every invoked command is defined as #[tauri::command]',
   notDefined.length === 0, 'missing: ' + notDefined.join(', '));

const registeredNotDefined = [...registered].filter(c => !defined.has(c));
ok('every registered command exists (no dangling registration)',
   registeredNotDefined.length === 0, 'dangling: ' + registeredNotDefined.join(', '));

// A registered-but-never-invoked command is fine (attach_tag, save_item are
// for the importer), but a *deleted* module still referenced is not.
const modRs = fs.readFileSync(cmdDir + '/mod.rs', 'utf8');
const declaredMods = [...modRs.matchAll(/pub mod (\w+);/g)].map(m => m[1]).sort();
const filesOnDisk = fs.readdirSync(cmdDir)
    .filter(f => f.endsWith('.rs') && f !== 'mod.rs')
    .map(f => f.replace('.rs', '')).sort();
console.log('   modules declared: ' + declaredMods.join(', '));
ok('mod.rs matches the files on disk',
   JSON.stringify(declaredMods) === JSON.stringify(filesOnDisk),
   'declared: ' + declaredMods.join(',') + ' | disk: ' + filesOnDisk.join(','));

const modulesUsedInLib = new Set(
    [...libRs.matchAll(/commands::(\w+)::/g)].map(m => m[1])
);
const missingModules = [...modulesUsedInLib].filter(m => !declaredMods.includes(m));
ok('lib.rs references no undeclared module',
   missingModules.length === 0, 'missing: ' + missingModules.join(', '));

// Scriptum leftovers
const legacy = ['books_read', 'reading_list', 'my_library'];
ok('no Scriptum command modules remain',
   legacy.every(l => !filesOnDisk.includes(l)),
   'still present: ' + legacy.filter(l => filesOnDisk.includes(l)).join(', '));
ok('lib.rs no longer references Scriptum commands',
   legacy.every(l => !libRs.includes('commands::' + l)));

console.log('\n' + (failures === 0 ? 'ALL PARITY CHECKS PASSED' : failures + ' FAILURE(S)'));
process.exit(failures === 0 ? 0 : 1);
