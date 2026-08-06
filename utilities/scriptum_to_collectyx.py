#!/usr/bin/env python3
"""
scriptum_to_collectyx.py — one-time conversion of a Scriptum backup into a
Collectyx-native backup file, ready to import through Collectyx's own
"Restore from Backup" (hamburger menu).

Scope (extended from the original Books-Read-only Phase 6 script, confirmed
with Stan):
  - Books Read, Reading List, and My Library all convert now.
  - Reading List's MyLibraryId is the ONLY cross-section link honored.
    When a Reading List entry has one, its Queued row shares the same
    Item as the matching My Library entry's Owned row -- normalization's
    payoff. No other cross-section identity matching is attempted: a
    book appearing in both Books Read and My Library, with no explicit
    link, becomes two separate Items. That's deliberate (design doc's
    "fuzzy title+author matching belongs to Find Duplicates, not a
    one-time import") -- run Collectyx's own Find Duplicates afterward
    to clean those up, same as Books Read re-reads across a botched
    import always could.
  - Category becomes a tag (lowercased, whitespace stripped) on both
    Books Read and My Library items. My Library's own Tags array (seen
    on some records) merges in too. Reading List has no tag source in
    Scriptum and gets none here -- if it shares an Item with a My
    Library entry, that Item's tags already cover it.
  - Reading List's IsCheckedOut is dropped -- not a stored Collectyx
    field, it's derived live from the linked Owned row's Patron/
    CheckedOutDate wherever a link exists.
  - Recommend maps to Rating: No -> 1, Yes -> 4 (confirmed with Stan).
    The raw Recommend value is also preserved on the record, normalized
    to a plain 0/1 -- the schema still has that column even though the
    UI no longer shows it. My Library and Reading List have no Recommend
    field in Scriptum, so nothing to map there.
  - Real Scriptum data is messier than the schema suggests: Recommend
    shows up as both an int (0/1) and a string ("Y"), Pages shows up as
    both an int and a numeric string, and Finished dates are D-Mon-YYYY
    (e.g. "9-Sep-2025") as well as already-ISO -- this script handles
    all of that defensively rather than assuming clean input.
  - Settings are NOT converted -- Scriptum's Settings shape (theme as a
    CSS path, dailyReadingPages, old dashboard card ids) doesn't match
    Collectyx's, and re-entering a handful of preferences by hand is
    simpler than a lossy field-by-field translation. Output Settings is
    always {}, which Collectyx's restore leaves untouched.

Usage:
    python3 scriptum_to_collectyx.py scriptum-backup.json.gz collectyx-import.json.gz
    python3 scriptum_to_collectyx.py scriptum-backup.json collectyx-import.json

Reads and writes both plain .json and gzipped .json.gz -- whichever
extension you give each path -- matching what Collectyx's Restore screen
itself accepts.

Importing the output WILL WIPE all current Collectyx data before
restoring (Collectyx's restore is wipe-then-replace, confirmed with Stan
as the intended, checkbox-gated behavior) -- back up first if you have
anything in Collectyx already that you want to keep.
"""

import sys
import gzip
import json
import re
import uuid
from datetime import datetime, timezone

MONTHS = {
    'jan': '01', 'feb': '02', 'mar': '03', 'apr': '04',
    'may': '05', 'jun': '06', 'jul': '07', 'aug': '08',
    'sep': '09', 'oct': '10', 'nov': '11', 'dec': '12',
}

APP_NAME = 'Collectyx'
SCHEMA_VERSION = 1


def parse_scriptum_date(raw):
    """Scriptum stores Finished as D-Mon-YYYY or DD-Mon-YYYY (e.g.
    '9-Sep-2025'), confirmed against a real backup -- not the YYYY-MM-DD
    the schema's own comments might suggest. Some backups may already
    carry ISO dates (core.js's getYearFromFinishedDate() handles both,
    so evidently this has happened before). Returns YYYY-MM-DD, or None
    if the value can't be parsed at all -- a None Finished date is kept
    rather than dropping the whole record; better to import a book with
    a blank date than to silently lose it."""
    if not raw:
        return None
    raw = raw.strip()

    if re.match(r'^\d{4}-\d{2}-\d{2}$', raw):
        return raw

    m = re.match(r'^(\d{1,2})-([A-Za-z]{3})-(\d{4})$', raw)
    if m:
        day, mon, year = m.groups()
        mon_num = MONTHS.get(mon.lower())
        if mon_num:
            return f'{year}-{mon_num}-{int(day):02d}'

    return None


def recommend_to_rating(raw):
    """No -> 1, Yes -> 4 (confirmed with Stan). Handles the 0/1 int form
    and the 'Y'/'N'-style string form -- both appear in real data."""
    if raw is None:
        return None
    if isinstance(raw, bool):
        return 4 if raw else 1
    if isinstance(raw, (int, float)):
        return 4 if raw else 1
    if isinstance(raw, str):
        return 4 if raw.strip().lower() in ('y', 'yes', '1', 'true') else 1
    return None


def recommend_to_flag(raw):
    """Normalizes Recommend to a plain 0/1 int for storage -- the schema
    still carries this column even though the UI doesn't show it."""
    if raw is None:
        return None
    if isinstance(raw, bool):
        return 1 if raw else 0
    if isinstance(raw, (int, float)):
        return 1 if raw else 0
    if isinstance(raw, str):
        return 1 if raw.strip().lower() in ('y', 'yes', '1', 'true') else 0
    return None


def coerce_pages(raw):
    if raw is None or raw == '':
        return None
    try:
        return int(raw)
    except (TypeError, ValueError):
        return None


def normalize_key(title, author):
    """Same-book detection for Books Read re-read grouping only --
    whitespace-collapsed, case-insensitive Title+Author match. Not used
    across sections (see module docstring) -- Collectyx's own Find
    Duplicates (Phase 9) is the right place for that, not this script."""
    return (
        re.sub(r'\s+', ' ', (title or '').strip().lower()),
        re.sub(r'\s+', ' ', (author or '').strip().lower()),
    )


def normalize_tag(name):
    return re.sub(r'\s+', '', (name or '').strip().lower())


def load_scriptum_backup(path):
    with open(path, 'rb') as f:
        raw = f.read()
    if path.endswith('.gz'):
        raw = gzip.decompress(raw)
    return json.loads(raw)


def write_collectyx_backup(data, path):
    text = json.dumps(data)
    if path.endswith('.gz'):
        with open(path, 'wb') as f:
            f.write(gzip.compress(text.encode('utf-8')))
    else:
        with open(path, 'w') as f:
            f.write(text)


def new_item(title, author, pages=None, isbn=None):
    return {
        'id': str(uuid.uuid4()),
        'Owner': 'local',
        'MediaTypeId': 1,
        'Title': title,
        'Author': author,
        'Author2': None,
        'Pages': pages,
        'ISBN': isbn or None,
    }


def convert_books_read(scriptum_data):
    """Unchanged from the original Phase 6 script: re-reads of the same
    (Title, Author) collapse onto one Item, multiple Consumed rows."""
    books_read = scriptum_data.get('BooksRead', [])

    items_by_key = {}
    consumed = []
    skipped = []

    for record in books_read:
        title = (record.get('Title') or '').strip()
        if not title:
            skipped.append(record.get('id', '<no id>'))
            continue
        author = (record.get('Author') or '').strip()

        key = normalize_key(title, author)
        if key not in items_by_key:
            item = new_item(title, author, coerce_pages(record.get('Pages')),
                             record.get('ISBN'))
            items_by_key[key] = item
            item_id = item['id']
        else:
            item_id = items_by_key[key]['id']
            if items_by_key[key]['Pages'] is None:
                items_by_key[key]['Pages'] = coerce_pages(record.get('Pages'))
            if not items_by_key[key]['ISBN']:
                items_by_key[key]['ISBN'] = record.get('ISBN') or None

        tags = set()
        category = (record.get('Category') or '').strip()
        if category:
            tags.add(normalize_tag(category))
        for t in (record.get('Tags') or []):
            if isinstance(t, str) and t.strip():
                tags.add(normalize_tag(t))

        consumed.append({
            'id': str(uuid.uuid4()),
            'ItemId': item_id,
            'Finished': parse_scriptum_date(record.get('Finished')),
            'Rating': recommend_to_rating(record.get('Recommend')),
            'Recommend': recommend_to_flag(record.get('Recommend')),
            'Comments': record.get('Comments') or None,
            'Tags': sorted(tags),
        })

    return list(items_by_key.values()), consumed, skipped


def convert_my_library(scriptum_data):
    """One Item + one Owned row per My Library record -- no dedup within
    the section, each entry is already a distinct physical copy. Returns
    the id_map (Scriptum My Library id -> new Item id) Reading List's
    MyLibraryId link needs."""
    my_library = scriptum_data.get('MyLibrary', [])

    items = []
    owned = []
    id_map = {}
    skipped = []

    for record in my_library:
        title = (record.get('Title') or '').strip()
        if not title:
            skipped.append(record.get('id', '<no id>'))
            continue
        author = (record.get('Author') or '').strip()

        item = new_item(title, author, coerce_pages(record.get('Pages')),
                         record.get('ISBN'))
        items.append(item)
        id_map[record.get('id')] = item['id']

        tags = set()
        category = (record.get('Category') or '').strip()
        if category:
            tags.add(normalize_tag(category))
        for t in (record.get('Tags') or []):
            if isinstance(t, str) and t.strip():
                tags.add(normalize_tag(t))

        owned.append({
            'id': str(uuid.uuid4()),
            'ItemId': item['id'],
            'Location': record.get('Location') or None,
            'Patron': record.get('Patron') or None,
            'CheckedOutDate': record.get('CheckedOutDate') or None,
            'Comments': record.get('Comments') or None,
            'Tags': sorted(tags),
        })

    return items, owned, id_map, skipped


def convert_reading_list(scriptum_data, my_library_id_map):
    """A Reading List entry with a MyLibraryId that matches a converted
    My Library record reuses that Item (shared item_id) -- this is the
    one explicit cross-section link Scriptum provides, so it's the only
    one honored. Everything else mints its own Item."""
    reading_list = scriptum_data.get('ReadingList', [])

    items = []
    queued = []
    skipped = []
    linked_count = 0

    for record in reading_list:
        title = (record.get('Title') or '').strip()
        if not title:
            skipped.append(record.get('id', '<no id>'))
            continue
        author = (record.get('Author') or '').strip()

        linked_item_id = my_library_id_map.get(record.get('MyLibraryId'))
        if linked_item_id:
            item_id = linked_item_id
            linked_count += 1
        else:
            item = new_item(title, author)
            items.append(item)
            item_id = item['id']

        queued.append({
            'id': str(uuid.uuid4()),
            'ItemId': item_id,
            'Rank': record.get('Rank'),
            'Source': record.get('Source') or None,
            'Comments': None,
        })

    return items, queued, skipped, linked_count


def summarize_tags(consumed, owned):
    """Informational only -- Collectyx's restore recreates tag rows from
    each record's own Tags array, not from this top-level list. It only
    feeds the Current-vs-Backup count shown on the Restore confirm
    screen, so an approximate aggregate is fine."""
    all_tags = set()
    for c in consumed:
        all_tags |= set(c.get('Tags') or [])
    for o in owned:
        all_tags |= set(o.get('Tags') or [])
    return [
        {
            'id': name,
            'Name': name,
            'Count': sum(1 for c in consumed if name in (c.get('Tags') or []))
                    + sum(1 for o in owned if name in (o.get('Tags') or [])),
        }
        for name in sorted(all_tags)
    ]


def main():
    if len(sys.argv) != 3:
        print(f'Usage: {sys.argv[0]} <scriptum-backup.json[.gz]> <collectyx-import.json[.gz]>')
        sys.exit(1)

    in_path, out_path = sys.argv[1], sys.argv[2]

    print(f'Reading {in_path}...')
    scriptum_data = load_scriptum_backup(in_path)

    total_books_read = len(scriptum_data.get('BooksRead', []))
    total_reading_list = len(scriptum_data.get('ReadingList', []))
    total_my_library = len(scriptum_data.get('MyLibrary', []))
    print(f'Found {total_books_read} Books Read, {total_reading_list} Reading List, '
          f'{total_my_library} My Library records in the source file.')

    br_items, consumed, br_skipped = convert_books_read(scriptum_data)
    ml_items, owned, ml_id_map, ml_skipped = convert_my_library(scriptum_data)
    rl_items, queued, rl_skipped, linked_count = convert_reading_list(scriptum_data, ml_id_map)

    all_items = br_items + ml_items + rl_items
    tags_summary = summarize_tags(consumed, owned)

    skipped = br_skipped + ml_skipped + rl_skipped
    if skipped:
        print(f'Skipped {len(skipped)} record(s) with no Title: {skipped}')

    rereads = len(consumed) - len(br_items)
    print(f'Books Read -> {len(br_items)} item(s), {len(consumed)} entries '
          f'({rereads} re-read{"" if rereads == 1 else "s"}).')
    print(f'My Library -> {len(ml_items)} item(s), {len(owned)} entries.')
    print(f'Reading List -> {len(rl_items)} new item(s) + {linked_count} linked to '
          f'an existing My Library item, {len(queued)} entries.')
    print(f'Total: {len(all_items)} item(s), {len(tags_summary)} tag(s).')

    output = {
        'Header': {
            'appName': APP_NAME,
            'timestamp': datetime.now(timezone.utc).isoformat(),
            'appVersion': scriptum_data.get('Header', {}).get('appVersion', 'unknown'),
            'schemaVersion': SCHEMA_VERSION,
            'convertedFrom': 'Scriptum',
        },
        'Items': all_items,
        'Consumed': consumed,
        'Queued': queued,
        'Owned': owned,
        'Tags': tags_summary,
        'Settings': {},
    }

    write_collectyx_backup(output, out_path)
    print(f'Wrote {out_path}')
    print("Import this through Collectyx's hamburger menu -> Restore from Backup. "
          'That WIPES all current Collectyx data before restoring -- back up first '
          'if you have anything in Collectyx already that you want to keep.')


if __name__ == '__main__':
    main()
