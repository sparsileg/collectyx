/**
 * Phase 1, task 4 — the join-simulation spike.
 * Loads the real JoinHelpers out of db-manager-web.js and exercises them
 * against a hand-seeded dataset. Proves the approach before db-manager-web.js
 * is built on top of it.
 */
const fs = require('fs');
const vm = require('vm');

const src = fs.readFileSync((process.env.COLLECTYX_ROOT || '../') + '/src/js/db-manager-web.js', 'utf8');
const constantsSrc = fs.readFileSync((process.env.COLLECTYX_ROOT || '../') + '/src/js/constants.js', 'utf8');

// Evaluate both files in a sandbox with the browser globals they expect.
const sandbox = {
    console,
    indexedDB: undefined,
    crypto: { randomUUID: (() => { let n = 0; return () => 'uuid-' + (++n); })() },
};
sandbox.window = sandbox;
vm.createContext(sandbox);
// Top-level `const` in a vm script stays lexically scoped rather than
// becoming a property of the context, so re-export explicitly.
vm.runInContext(constantsSrc + '\nthis.CONSTANTS = CONSTANTS;', sandbox);
vm.runInContext(
    src + '\nthis.JoinHelpers = JoinHelpers;' +
          '\nthis.ITEM_FIELD_MAP = ITEM_FIELD_MAP;' +
          '\nthis.COLLECTION_FIELD_MAPS = COLLECTION_FIELD_MAPS;' +
          '\nthis.DBManagerWeb = DBManagerWeb;',
    sandbox
);

const { JoinHelpers, ITEM_FIELD_MAP, COLLECTION_FIELD_MAPS, CONSTANTS } = sandbox;

let failures = 0;
function check(label, actual, expected) {
    const a = JSON.stringify(actual);
    const e = JSON.stringify(expected);
    if (a === e) {
        console.log('  ok   ' + label);
    } else {
        console.log('  FAIL ' + label + '\n         got:      ' + a + '\n         expected: ' + e);
        failures++;
    }
}
function ok(label, cond) {
    if (cond) console.log('  ok   ' + label);
    else { console.log('  FAIL ' + label); failures++; }
}

// ── Hand-seeded dataset ───────────────────────────────────────────────────────
// Two books. "Dune" is in all three collections and read twice (a re-read is
// a second consumed row against the same item_id — the case Scriptum's flat
// schema could not represent). "Emma" is only owned, and untagged.

const items = [
    { id: 'itm-dune', owner: 'local', media_type_id: 1, title: 'Dune',
      author: 'Herbert, Frank', author2: null, pages: 412, isbn: '9780441013593',
      date_added: '2026-01-01', modified: '2026-01-02' },
    { id: 'itm-emma', owner: 'local', media_type_id: 1, title: 'Emma',
      author: 'Austen, Jane', author2: null, pages: 474, isbn: null,
      date_added: '2026-02-01', modified: '2026-02-01' },
];

const tags = [
    { id: 'tag-scifi',   owner: 'local', name: 'scifi',   date_added: '2026-01-01', modified: '2026-01-01' },
    { id: 'tag-classic', owner: 'local', name: 'classic', date_added: '2026-01-01', modified: '2026-01-01' },
    { id: 'tag-orphan',  owner: 'local', name: 'unused',  date_added: '2026-01-01', modified: '2026-01-01' },
];

const itemTags = [
    { item_id: 'itm-dune', tag_id: 'tag-scifi' },
    { item_id: 'itm-dune', tag_id: 'tag-classic' },
    { item_id: 'itm-dune', tag_id: 'tag-ghost' },   // tag no longer exists
];

const consumed = [
    { id: 'con-1', item_id: 'itm-dune', finished: '2020-06-01', rating: 9, recommend: 1,
      comments: 'first read', date_added: '2020-06-01', modified: '2020-06-01' },
    { id: 'con-2', item_id: 'itm-dune', finished: '2025-03-15', rating: 10, recommend: 1,
      comments: 're-read', date_added: '2025-03-15', modified: '2025-03-15' },
    { id: 'con-x', item_id: 'itm-GONE', finished: '2019-01-01', rating: null, recommend: null,
      comments: null, date_added: null, modified: null },  // orphan
];

const queued = [
    { id: 'que-1', item_id: 'itm-dune', rank: 2, source: 'a podcast',
      comments: null, date_added: '2026-01-01', modified: '2026-01-01' },
];

const owned = [
    { id: 'own-1', item_id: 'itm-dune', location: 'Shelf A', patron: null,
      checked_out_date: null, comments: null, date_added: '2026-01-01', modified: '2026-01-01' },
    { id: 'own-2', item_id: 'itm-emma', location: 'Shelf B', patron: 'Dana',
      checked_out_date: '2026-07-04', comments: null, date_added: '2026-02-01', modified: '2026-02-01' },
];

// ── 1. indexById ──────────────────────────────────────────────────────────────
console.log('\n1. indexById');
const byId = JoinHelpers.indexById(items);
check('finds Dune by id', byId.get('itm-dune').title, 'Dune');
check('size', byId.size, 2);

// ── 2. tagNamesByItem ─────────────────────────────────────────────────────────
console.log('\n2. tagNamesByItem');
const tagMap = JoinHelpers.tagNamesByItem(itemTags, tags);
check('Dune tags resolved and sorted', tagMap.get('itm-dune'), ['classic', 'scifi']);
ok('dangling tag_id skipped, not undefined', !(tagMap.get('itm-dune') || []).includes(undefined));
ok('untagged item absent from map', tagMap.get('itm-emma') === undefined);

// ── 3. tagUsageCounts ─────────────────────────────────────────────────────────
console.log('\n3. tagUsageCounts');
const counts = JoinHelpers.tagUsageCounts(itemTags);
check('scifi used once', counts.get('tag-scifi'), 1);
check('unused tag has no entry', counts.get('tag-orphan'), undefined);

// ── 4. joinCollection — the core case ─────────────────────────────────────────
console.log('\n4. joinCollection (consumed)');
const orphans = [];
const joinedConsumed = JoinHelpers.joinCollection(
    'consumed', consumed, items, itemTags, tags,
    (c, r) => orphans.push(r.id)
);
check('two valid rows, orphan dropped', joinedConsumed.length, 2);
check('orphan reported not silently dropped', orphans, ['con-x']);

const first = joinedConsumed[0];
check('joined Title from parent item', first.Title, 'Dune');
check('joined Author from parent item', first.Author, 'Herbert, Frank');
check('joined Pages from parent item', first.Pages, 412);
check('membership field Finished', first.Finished, '2020-06-01');
check('membership field Rating', first.Rating, 9);
check('Tags resolved onto record', first.Tags, ['classic', 'scifi']);
check('ItemId exposed', first.ItemId, 'itm-dune');
check('membership timestamps are the record own', first.DateAdded, '2020-06-01');
check('item timestamps preserved separately', first.ItemDateAdded, '2026-01-01');

console.log('\n   re-read case (the reason for normalization)');
check('both reads present', joinedConsumed.map(r => r.Finished), ['2020-06-01', '2025-03-15']);
check('both point at the same item',
      joinedConsumed[0].ItemId === joinedConsumed[1].ItemId, true);
check('ratings differ per read', joinedConsumed.map(r => r.Rating), [9, 10]);
check('titles identical, stored once',
      joinedConsumed[0].Title === joinedConsumed[1].Title, true);

// ── 5. joinCollection across all three collections ────────────────────────────
console.log('\n5. joinCollection (queued / owned)');
const joinedQueued = JoinHelpers.joinCollection('queued', queued, items, itemTags, tags, null);
check('queued Rank', joinedQueued[0].Rank, 2);
check('queued Source', joinedQueued[0].Source, 'a podcast');
check('queued inherits Title', joinedQueued[0].Title, 'Dune');
ok('queued record has no consumed-only fields',
   !('Finished' in joinedQueued[0]) && !('Rating' in joinedQueued[0]));

const joinedOwned = JoinHelpers.joinCollection('owned', owned, items, itemTags, tags, null);
check('owned Location', joinedOwned[0].Location, 'Shelf A');
check('owned Patron on checked-out copy', joinedOwned[1].Patron, 'Dana');
check('owned CheckedOutDate', joinedOwned[1].CheckedOutDate, '2026-07-04');
check('untagged item yields empty Tags array', joinedOwned[1].Tags, []);
check('null isbn surfaces as null not undefined', joinedOwned[1].ISBN, null);

console.log('\n   cross-collection identity (the payoff)');
ok('same book in all three collections shares one ItemId',
   joinedConsumed[0].ItemId === joinedQueued[0].ItemId &&
   joinedQueued[0].ItemId === joinedOwned[0].ItemId);

ok('unknown collection rejected', (() => {
    try { JoinHelpers.joinCollection('nope', [], [], [], [], null); return false; }
    catch (e) { return true; }
})());

// ── 6. splitRecord — the inverse ──────────────────────────────────────────────
console.log('\n6. splitRecord (round-trip)');
const defaults = { owner: 'local', mediaTypeId: 1, today: '2026-08-04' };
const split = JoinHelpers.splitRecord('consumed', first, defaults);
check('item id preserved', split.item.id, 'itm-dune');
check('item title mapped back to snake_case', split.item.title, 'Dune');
check('item pages mapped back', split.item.pages, 412);
check('membership id preserved', split.membership.id, 'con-1');
check('membership finished mapped back', split.membership.finished, '2020-06-01');
check('membership item_id set', split.membership.item_id, 'itm-dune');
check('tag names lowercased + deduped', split.tagNames, ['classic', 'scifi']);
check('modified stamped to today', split.membership.modified, '2026-08-04');
ok('item row carries no membership fields', !('finished' in split.item));
ok('membership row carries no item fields', !('title' in split.membership));

console.log('\n   round-trip fidelity');
const rejoined = JoinHelpers.toRecord(
    'consumed', split.membership, split.item, split.tagNames
);
['Title', 'Author', 'Pages', 'ISBN', 'Finished', 'Rating', 'Recommend', 'Comments', 'ItemId']
    .forEach(f => check('round-trips ' + f, rejoined[f], first[f]));

console.log('\n   messy input');
const messy = JoinHelpers.splitRecord('consumed', {
    id: 'c9', ItemId: 'i9', Title: 'X', Tags: ['  SciFi  ', 'scifi', 'CLASSIC', ''],
}, defaults);
check('tags trimmed, lowercased, deduped, blanks dropped',
      messy.tagNames, ['scifi', 'classic']);
check('missing owner falls back to default', messy.item.owner, 'local');
check('missing media type falls back to default', messy.item.media_type_id, 1);
check('absent field becomes null not undefined', messy.membership.rating, null);

// ── 7. reconcileTags ──────────────────────────────────────────────────────────
console.log('\n7. reconcileTags');
let idn = 0;
const newId = () => 'new-' + (++idn);
const rec = JoinHelpers.reconcileTags(
    'itm-emma', ['classic', 'romance'], tags, 'local', newId, '2026-08-04'
);
check('reuses the existing classic tag', rec.links[0].tag_id, 'tag-classic');
check('creates only the genuinely new tag', rec.newTags.length, 1);
check('new tag name', rec.newTags[0].name, 'romance');
check('new tag owner', rec.newTags[0].owner, 'local');
check('two links produced', rec.links.length, 2);

const otherOwner = JoinHelpers.reconcileTags(
    'itm-x', ['classic'], tags, 'someone-else', newId, '2026-08-04'
);
check('a different owner gets their own tag row, not the shared one',
      otherOwner.newTags.length, 1);
ok('owner separation holds', otherOwner.links[0].tag_id !== 'tag-classic');

// ── 8. planMerge ──────────────────────────────────────────────────────────────
console.log('\n8. planMerge (design doc §3.3)');
const dupItems = items.concat([
    { id: 'itm-dupe', owner: 'local', media_type_id: 1, title: 'Dune',
      author: 'Herbert, Frank', author2: null, pages: null, isbn: null,
      date_added: '2026-03-01', modified: '2026-03-01' },
]);
const dupConsumed = consumed.concat([
    { id: 'con-3', item_id: 'itm-dupe', finished: '2018-01-01', rating: 8,
      recommend: 1, comments: null, date_added: null, modified: null },
]);
const dupItemTags = itemTags.concat([
    { item_id: 'itm-dupe', tag_id: 'tag-scifi' },     // survivor already has it
    { item_id: 'itm-dupe', tag_id: 'tag-orphan' },    // genuinely new
]);

const plan = JoinHelpers.planMerge(
    'itm-dune', 'itm-dupe',
    { consumed: dupConsumed, queued: queued, owned: owned },
    dupItemTags
);
check('loser consumed row reassigned', plan.reassigned.consumed.length, 1);
check('reassigned row points at survivor', plan.reassigned.consumed[0].item_id, 'itm-dune');
check('reassigned row keeps its own data', plan.reassigned.consumed[0].finished, '2018-01-01');
check('non-loser rows untouched', plan.reassigned.queued.length, 0);
check('only the non-duplicate tag moves', plan.movedLinks.length, 1);
check('moved tag is the new one', plan.movedLinks[0].tag_id, 'tag-orphan');
check('duplicate tag dropped rather than doubled', plan.droppedLinks.length, 1);
check('loser marked for deletion', plan.deleteItemId, 'itm-dupe');
ok('self-merge rejected', (() => {
    try { JoinHelpers.planMerge('a', 'a', {}, []); return false; } catch (e) { return true; }
})());

// ── 9. resolveMergedItem ──────────────────────────────────────────────────────
console.log('\n9. resolveMergedItem');
const survivor = dupItems[0];
const loser = dupItems[2];

const r1 = JoinHelpers.resolveMergedItem(survivor, loser, {});
check('gap-filling is not a conflict', r1.unresolved, []);
check('survivor keeps its pages (loser had none)', r1.merged.pages, 412);
check('survivor keeps its isbn', r1.merged.isbn, '9780441013593');

const loserWithData = Object.assign({}, loser, { pages: 999, isbn: '1111111111111' });
const r2 = JoinHelpers.resolveMergedItem(survivor, loserWithData, {});
check('genuine disagreements are flagged', r2.unresolved.sort(), ['isbn', 'pages']);

const r3 = JoinHelpers.resolveMergedItem(survivor, loserWithData,
                                         { pages: 999, isbn: '9780441013593' });
check('explicit resolutions clear the conflict', r3.unresolved, []);
check('resolution applied — pages', r3.merged.pages, 999);
check('resolution applied — isbn', r3.merged.isbn, '9780441013593');

const emptySurvivor = Object.assign({}, survivor, { pages: null });
const r4 = JoinHelpers.resolveMergedItem(emptySurvivor, loserWithData, { isbn: 'x' });
check('null survivor field takes the loser value', r4.merged.pages, 999);

// ── 10. field-map integrity ───────────────────────────────────────────────────
console.log('\n10. field-map integrity');
ok('no Category field in ITEM_FIELD_MAP', !('Category' in ITEM_FIELD_MAP));
Object.keys(COLLECTION_FIELD_MAPS).forEach(c => {
    ok('no Category field in ' + c, !('Category' in COLLECTION_FIELD_MAPS[c]));
});
check('three collections mapped', Object.keys(COLLECTION_FIELD_MAPS).sort(),
      ['consumed', 'owned', 'queued']);
check('CONSTANTS.STORES has eight entries', Object.keys(CONSTANTS.STORES).length, 8);

// ── Result ───────────────────────────────────────────────────────────────────
console.log('\n' + (failures === 0
    ? 'ALL JOIN-SIMULATION TESTS PASSED'
    : failures + ' FAILURE(S)'));
process.exit(failures === 0 ? 0 : 1);
