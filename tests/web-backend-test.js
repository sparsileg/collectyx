/**
 * End-to-end test of DBManagerWeb against a real IndexedDB implementation.
 * Exercises store creation, the join layer, writes, cache invalidation,
 * transaction atomicity, tag reconciliation, and merge.
 */
const fs = require('fs');
const vm = require('vm');
try {
    require('fake-indexeddb/auto');
} catch (e) {
    console.error('This suite needs fake-indexeddb.  Run:  cd tests && npm install');
    process.exit(1);
}

const constantsSrc = fs.readFileSync((process.env.COLLECTYX_ROOT || '../') + '/src/js/constants.js', 'utf8');
const webSrc = fs.readFileSync((process.env.COLLECTYX_ROOT || '../') + '/src/js/db-manager-web.js', 'utf8');

let uuidN = 0;
const sandbox = {
    console,
    indexedDB,
    IDBKeyRange,
    crypto: { randomUUID: () => 'uuid-' + String(++uuidN).padStart(4, '0') },
    Promise, Set, Map, Array, Object, String, Number, Date, JSON, Error, Boolean,
};
sandbox.window = sandbox;
vm.createContext(sandbox);
vm.runInContext(constantsSrc + '\nthis.CONSTANTS = CONSTANTS;', sandbox);
vm.runInContext(webSrc + '\nthis.DBManagerWeb = DBManagerWeb;\nthis.JoinHelpers = JoinHelpers;', sandbox);

const DB = sandbox.DBManagerWeb;
const CONSTANTS = sandbox.CONSTANTS;

let failures = 0;
function check(label, actual, expected) {
    const a = JSON.stringify(actual), e = JSON.stringify(expected);
    if (a === e) console.log('  ok   ' + label);
    else { console.log('  FAIL ' + label + '\n         got:      ' + a + '\n         expected: ' + e); failures++; }
}
function ok(label, cond) {
    if (cond) console.log('  ok   ' + label);
    else { console.log('  FAIL ' + label); failures++; }
}

(async function run() {

    // ── 1. init / schema ──────────────────────────────────────────────────────
    console.log('\n1. init & object stores');
    await DB.init();
    const stores = Array.from(DB.db.objectStoreNames).sort();
    // Derived from CONSTANTS.STORES rather than a hard-coded array, so
    // adding a store there doesn't also require editing this assertion.
    const expectedStores = Object.values(CONSTANTS.STORES).sort();
    check('all stores in CONSTANTS.STORES are created', stores, expectedStores);
    ok('app_meta store present', stores.includes('app_meta'));

    const mt = await DB.getAllMediaTypes();
    check('media_types seeded on init', mt.length, 1);
    check('seeded labels match the SQLite seed row',
          [mt[0].Name, mt[0].ConsumedLabel, mt[0].QueuedLabel, mt[0].OwnedLabel],
          ['Books', 'Books Read', 'To Be Read', 'My Library']);

    // Compound key on item_tags
    const itTx = DB.db.transaction(['item_tags'], 'readonly');
    check('item_tags uses a compound key',
          itTx.objectStore('item_tags').keyPath, ['item_id', 'tag_id']);
    check('settings keyed on owner',
          DB.db.transaction(['settings'], 'readonly').objectStore('settings').keyPath, 'owner');

    // ── 1b. app_meta store ────────────────────────────────────────────────────
    // app_meta is deliberately not owner-scoped (schema.rs doc comment on
    // CREATE_APP_META); exercised here via the raw primitives only, since
    // that's the layer this suite can verify without assuming a specific
    // higher-level API shape.
    console.log('\n1b. app_meta store');
    await DB._rawWrite(['app_meta'], [
        { store: 'app_meta', action: 'put', value: { key: 'test_key', value: 'test_value' } },
    ]);
    const metaRow = await DB._rawGet('app_meta', 'test_key');
    check('app_meta round-trips via raw primitives', metaRow && metaRow.value, 'test_value');

    // ── 2. save a record ──────────────────────────────────────────────────────
    console.log('\n2. saveCollectionRecord');
    const saved = await DB.saveCollectionRecord('consumed', {
        Title: 'Dune', Author: 'Herbert, Frank', Pages: 412, ISBN: '9780441013593',
        Finished: '2020-06-01', Rating: 9, Recommend: 1, Comments: 'first read',
        Tags: ['SciFi', 'classic'],
    });
    ok('returns generated ids', !!saved.id && !!saved.ItemId);

    let consumed = await DB.getCollection('consumed');
    check('one record readable back', consumed.length, 1);
    check('Title round-trips through storage', consumed[0].Title, 'Dune');
    check('Rating round-trips', consumed[0].Rating, 9);
    check('tags lowercased and sorted', consumed[0].Tags, ['classic', 'scifi']);
    check('tag rows created', (await DB.getAllTags()).length, 2);

    // ── 3. the re-read case ───────────────────────────────────────────────────
    console.log('\n3. re-read against the same item');
    const itemId = consumed[0].ItemId;
    await DB.saveCollectionRecord('consumed', {
        ItemId: itemId, Title: 'Dune', Author: 'Herbert, Frank', Pages: 412,
        Finished: '2025-03-15', Rating: 10, Recommend: 1, Comments: 're-read',
        Tags: ['scifi', 'classic'],
    });
    consumed = await DB.getCollection('consumed');
    check('two consumed rows', consumed.length, 2);
    ok('both share one ItemId', consumed[0].ItemId === consumed[1].ItemId);
    check('items table still holds one row', (await DB.getAllItems()).length, 1);
    check('no duplicate tags created', (await DB.getAllTags()).length, 2);

    // ── 4. cross-collection membership ────────────────────────────────────────
    console.log('\n4. same item across collections (mark-finished payoff)');
    await DB.saveCollectionRecord('queued', {
        ItemId: itemId, Title: 'Dune', Author: 'Herbert, Frank',
        Rank: 2, Source: 'a podcast', Tags: ['scifi', 'classic'],
    });
    await DB.saveCollectionRecord('owned', {
        ItemId: itemId, Title: 'Dune', Author: 'Herbert, Frank',
        Location: 'Shelf A', Tags: ['scifi', 'classic'],
    });
    const q = await DB.getCollection('queued');
    const o = await DB.getCollection('owned');
    check('queued Rank persisted (SQL keyword column)', q[0].Rank, 2);
    check('owned Location persisted', o[0].Location, 'Shelf A');
    ok('all three collections share the same ItemId',
       q[0].ItemId === itemId && o[0].ItemId === itemId);
    check('still exactly one items row', (await DB.getAllItems()).length, 1);

    // ── 4b. partial payloads must not blank shared item fields ───────────────
    // Regression: saving a queued record that carries only Rank/Source used
    // to wipe the Pages and ISBN the consumed record had set on the shared
    // items row.
    console.log('\n4b. partial payload preserves fields owned by other collections');
    const sharedItem = await DB._rawGet('items', itemId);
    check('Pages survived the queued/owned saves', sharedItem.pages, 412);
    check('ISBN survived the queued/owned saves', sharedItem.isbn, '9780441013593');
    check('Title still intact', sharedItem.title, 'Dune');

    console.log('\n   explicit null still clears');
    await DB.saveCollectionRecord('queued', {
        id: q[0].id, ItemId: itemId, Pages: null, Rank: 5,
    });
    const cleared = await DB._rawGet('items', itemId);
    check('explicitly-null Pages is honoured as a clear', cleared.pages, null);
    check('ISBN untouched by that write', cleared.isbn, '9780441013593');
    check('Rank updated', (await DB.getCollection('queued'))[0].Rank, 5);
    // restore for later assertions
    await DB.saveCollectionRecord('queued', { id: q[0].id, ItemId: itemId, Pages: 412 });
    check('Pages restored', (await DB._rawGet('items', itemId)).pages, 412);

    console.log('\n   omitting Tags leaves them alone');
    const tagsBefore = (await DB.getCollection('queued'))[0].Tags.slice();
    await DB.saveCollectionRecord('queued', { id: q[0].id, ItemId: itemId, Source: 'a friend' });
    const afterNoTags = (await DB.getCollection('queued'))[0];
    check('tags preserved when payload omits Tags', afterNoTags.Tags, tagsBefore);
    check('Source updated', afterNoTags.Source, 'a friend');

    console.log('\n   empty Tags array clears them');
    await DB.saveCollectionRecord('queued', { id: q[0].id, ItemId: itemId, Tags: [] });
    check('empty array removes all tags', (await DB.getCollection('queued'))[0].Tags, []);
    await DB.saveCollectionRecord('queued', { id: q[0].id, ItemId: itemId, Tags: ['scifi', 'classic'] });

    // ── 5. cache invalidation ─────────────────────────────────────────────────
    console.log('\n5. cache invalidation on write');
    const before = (await DB.getCollection('consumed'))[0];
    await DB.saveCollectionRecord('consumed',
        Object.assign({}, before, { Rating: 3, Comments: 'downgraded' }));
    const after = (await DB.getCollection('consumed')).find(r => r.id === before.id);
    check('updated value visible immediately, no stale read', after.Rating, 3);
    check('comment updated too', after.Comments, 'downgraded');
    check('no extra row created by the update', (await DB.getCollection('consumed')).length, 2);

    console.log('\n   tag edits invalidate too');
    await DB.saveCollectionRecord('consumed',
        Object.assign({}, after, { Tags: ['scifi', 'desert'] }));
    const retagged = (await DB.getCollection('consumed')).find(r => r.id === before.id);
    check('tag set replaced, not merged', retagged.Tags, ['desert', 'scifi']);
    const otherRead = (await DB.getCollection('consumed')).find(r => r.id !== before.id);
    check('sibling record sees the shared item new tags', otherRead.Tags, ['desert', 'scifi']);

    // ── 6. delete semantics ───────────────────────────────────────────────────
    console.log('\n6. delete membership vs delete item');
    await DB.deleteCollectionRecord('consumed', before.id);
    check('membership row gone', (await DB.getCollection('consumed')).length, 1);
    check('items row survives — other collections still need it',
          (await DB.getAllItems()).length, 1);
    check('queued membership untouched', (await DB.getCollection('queued')).length, 1);

    // ── 7. tags ───────────────────────────────────────────────────────────────
    console.log('\n7. tag CRUD & substitution');
    let tags = await DB.getAllTags();
    const scifi = tags.find(t => t.Name === 'scifi');
    const desert = tags.find(t => t.Name === 'desert');
    ok('usage counts computed', scifi.Count === 1 && desert.Count === 1);

    let threw = false;
    try { await DB.saveTag({ Name: 'SciFi' }); } catch (e) { threw = true; }
    ok('duplicate tag name rejected within owner', threw);

    const affected = await DB.deleteTag(desert.id, scifi.id);
    check('substitution reported affected rows', affected, 1);
    tags = await DB.getAllTags();
    ok('deleted tag gone', !tags.find(t => t.Name === 'desert'));
    const stillTagged = (await DB.getCollection('consumed'))[0];
    check('book kept a tag via substitution', stillTagged.Tags, ['scifi']);

    // ── 8. merge ──────────────────────────────────────────────────────────────
    console.log('\n8. mergeItems (design doc §3.3)');
    const dup = await DB.saveCollectionRecord('consumed', {
        Title: 'Dune', Author: 'Herbert, Frank', Finished: '2018-01-01',
        Rating: 8, Tags: ['paperback'],
    });
    check('two items before merge', (await DB.getAllItems()).length, 2);

    const result = await DB.mergeItems(itemId, dup.ItemId, {});
    check('one consumed row moved', result.movedConsumed, 1);
    check('one tag link moved', result.movedTags, 1);
    check('loser item deleted', (await DB.getAllItems()).length, 1);

    const merged = await DB.getCollection('consumed');
    check('both consumed rows survive the merge', merged.length, 2);
    ok('every consumed row now points at the survivor',
       merged.every(r => r.ItemId === itemId));
    check('tags unioned onto the survivor',
          merged[0].Tags.slice().sort(), ['paperback', 'scifi']);

    console.log('\n   conflict handling');
    const conflict = await DB.saveCollectionRecord('owned', {
        Title: 'Dune', Author: 'Herbert, Frank', Pages: 999, Location: 'Box',
    });
    let mergeErr = null;
    try { await DB.mergeItems(itemId, conflict.ItemId, {}); }
    catch (e) { mergeErr = e.message; }
    ok('unresolved field conflict blocks the merge', mergeErr && mergeErr.includes('pages'));
    check('nothing merged while unresolved', (await DB.getAllItems()).length, 2);

    const okMerge = await DB.mergeItems(itemId, conflict.ItemId, { pages: 999 });
    check('explicit resolution lets it through', okMerge.movedOwned, 1);
    const finalItems = await DB.getAllItems();
    check('resolution value applied', finalItems[0].Pages, 999);
    check('back to one item', finalItems.length, 1);

    // ── 9. transaction atomicity ──────────────────────────────────────────────
    console.log('\n9. transaction atomicity');
    const itemsBefore = (await DB.getAllItems()).length;
    let abortErr = null;
    try {
        await DB._rawWrite(['items', 'consumed'], [
            { store: 'items', action: 'put', value: { id: 'bad-1', owner: 'local', media_type_id: 1, title: 'Ghost' } },
            { store: 'consumed', action: 'nonsense' },
        ]);
    } catch (e) { abortErr = e.message; }
    ok('invalid op rejects', !!abortErr);
    check('failed transaction wrote nothing — no half-applied state',
          (await DB._rawGetAll('items')).length, itemsBefore);

    // ── 10. settings ──────────────────────────────────────────────────────────
    console.log('\n10. settings (keyed on owner)');
    check('absent settings return null', await DB.getSettings(), null);
    await DB.saveSettings({ dailyReadingPages: 50, displayTheme: 'css/themes/nordic-dark.css' });
    const s = await DB.getSettings();
    check('settings round-trip as an object', s.dailyReadingPages, 50);
    check('theme round-trips', s.displayTheme, 'css/themes/nordic-dark.css');
    const rawRow = await DB._rawGet('settings', CONSTANTS.DEFAULT_OWNER);
    ok('stored as a JSON string, matching SQLite TEXT', typeof rawRow.data === 'string');
    check('stored under the default owner', rawRow.owner, 'local');

    // ── 11. orphan handling ───────────────────────────────────────────────────
    console.log('\n11. orphan membership row');
    await DB._rawWrite(['consumed'], [{
        store: 'consumed', action: 'put',
        value: { id: 'orphan-1', item_id: 'NOPE', finished: '2000-01-01' },
    }]);
    DB._invalidate();
    const withOrphan = await DB.getCollection('consumed');
    ok('orphan omitted from results rather than yielding undefined Title',
       !withOrphan.find(r => r.id === 'orphan-1'));
    ok('valid rows still returned', withOrphan.length >= 1);

    // ── 12. replaceCollection ─────────────────────────────────────────────────
    console.log('\n12. replaceCollection (bulk)');
    await DB.replaceCollection('queued', [
        { Title: 'Emma', Author: 'Austen, Jane', Rank: 1, Tags: ['classic'] },
        { Title: 'Ulysses', Author: 'Joyce, James', Rank: 2, Tags: ['classic', 'modernist'] },
    ]);
    const bulk = await DB.getCollection('queued');
    check('collection replaced wholesale', bulk.length, 2);
    check('ranks preserved', bulk.map(r => r.Rank).sort(), [1, 2]);
    const classicTag = (await DB.getAllTags()).find(t => t.Name === 'classic');
    ok('shared tag reused across bulk rows, not duplicated', classicTag.Count >= 2);
    check('no duplicate modernist tags',
          (await DB.getAllTags()).filter(t => t.Name === 'modernist').length, 1);

    console.log('\n' + (failures === 0
        ? 'ALL WEB BACKEND TESTS PASSED'
        : failures + ' FAILURE(S)'));
    process.exit(failures === 0 ? 0 : 1);

})().catch(e => {
    console.error('\nHARNESS ERROR:', e);
    process.exit(1);
});
