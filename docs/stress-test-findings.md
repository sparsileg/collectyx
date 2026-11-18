# Stress test findings (#84)

Measured 2026-11-18 on one Linux machine. The measurements are repeatable,
and no fixture data is committed: both harnesses generate their data on the
fly into throwaway databases.

- **Desktop (Rust/SQLite):** `src-tauri/src/commands/stress.rs`
  `cd src-tauri && cargo test --release --lib stress -- --ignored --nocapture`
- **Web (real IndexedDB in headless Chromium):** `tests/stress/web-stress.js`
  `cd tests/stress && npm install && CHROME_PATH=/path/to/chrome node web-stress.js`

Data shape per scale point N: N items, every item in Books Read, 1 in 5 in
To Be Read, 1 in 2 in My Library, 200 tags, and 2 tags per item. Titles and
authors come from a word-list combinator, so search isn't matching
identical rows.

## In plain terms

- **Search is never the problem.** Quick search stays under ~70 ms per
  keystroke even at 100,000 books, because it only filters what's already
  loaded and only re-renders one page.
- **Rendering is never the problem at the default page size.** At 50 rows
  per page, rendering takes 10–20 ms at every scale. "Unlimited" rows per
  page is a different story: it passes 500 ms at around 5,000–10,000 books
  and takes 8.6 s at 100,000.
- **Web version: view load becomes noticeably slow (over 500 ms) at around
  20,000 books.** It falls off a cliff between 10,000 and 30,000 books,
  where cold load goes from about 50 ms to over 1 s, and it reaches about
  7 s at 100,000. This is the full-store IndexedDB load plus the in-memory
  join, the risk the design doc already flagged. At 250,000 books it takes
  about 21 s and the page holds about 195 MB of heap. A first 250k attempt,
  run in the same browser right after the 50k and 100k ones, stalled during
  the restore and was stopped after about 25 minutes. On its own, in a
  fresh browser, the same restore finished in 46 s.
- **Desktop version: view load passes 500 ms at around 75,000–100,000
  books** on the Rust side alone (0.23 s at 50k, 0.69 s at 100k, 1.8 s at
  250k). IPC transfer and the webview's JSON parse come on top of that and
  weren't measurable here. The JSON payload is about 37 MB at 100k, so
  expect a real cold load of over 1 s at 100k.
- **For a personal library (hundreds to a few thousand books), everything
  is instant on both builds.** No action is needed unless someone actually
  approaches these sizes.

## Desktop: Rust side of a collection load

Best of 3 runs, in ms. `sql+map` = the joined SELECT plus row mapping;
`tags` = `tags_by_item`, which every load runs for *all* of the owner's
items; `json` = serializing the result (the IPC payload).

| items | view | rows | sql+map | tags | json | Rust total | JSON MB |
|------:|------|-----:|--------:|-----:|-----:|-----------:|--------:|
| 1,000 | Books Read | 1,000 | 2.3 | 1.1 | 0.5 | 3.9 | 0.4 |
| 10,000 | Books Read | 10,000 | 25.9 | 11.1 | 4.8 | 41.8 | 3.6 |
| 50,000 | Books Read | 50,000 | 141.0 | 55.0 | 33.5 | 229.6 | 18.2 |
| 100,000 | Books Read | 100,000 | 338.7 | 274.2 | 75.2 | 688.0 | 36.5 |
| 250,000 | Books Read | 250,000 | 931.9 | 725.6 | 165.3 | 1,822.8 | 91.6 |
| 100,000 | To Be Read | 20,000 | 96.7 | 274.2 | 10.9 | 381.8 | 7.7 |
| 100,000 | My Library | 50,000 | 159.5 | 274.2 | 36.2 | 469.9 | 19.2 |

SQLite file: 3.8 MB at 10k, 39 MB at 100k, 100 MB at 250k.

## Web: Books Read view

`cold get` = `getCollection` right after a page reload. `view load` =
reload, then `ConsumedView.load()` until painted (nav click to rendered).
`render` = render alone with the data already in memory, at the default 50
per page. `search` = filter plus re-render per keystroke. `unlimited` =
render with Records Per Page set to Unlimited (skipped past 100k).

| items | seed (restore) | cold get | view load | render | search mean / max | unlimited | heap growth |
|------:|---------------:|---------:|----------:|-------:|------------------:|----------:|------------:|
| 1,000 | 0.2 s | 1 ms | 27 ms | 17 ms | 33 / 34 ms | 109 ms | 0.1 MB |
| 10,000 | 1.9 s | 12 ms | 53 ms | 10 ms | 33 / 33 ms | 853 ms | 4.8 MB |
| 20,000 | 3.6 s | 38 ms | 595 ms | 21 ms | 44 / 85 ms | 1.6 s | 12.2 MB |
| 30,000 | 5.4 s | 1.6 s | 1.1 s | 13 ms | 35 / 50 ms | 2.6 s | 14.0 MB |
| 50,000 | 9.6 s | 3.5 s | 2.9 s | 12 ms | 37 / 49 ms | 4.5 s | 33.8 MB |
| 100,000 | 18.1 s | 8.0 s | 7.0 s | 10 ms | 60 / 67 ms | 8.6 s | 73.4 MB |
| 250,000 | 45.6 s | 21.7 s | 21.3 s | 13 ms | 113 / 150 ms | skipped | 194.9 MB |

Individual cold timings vary run to run (at 20k, one run's cold get was
38 ms while the view load right after it was 595 ms), so read the trend,
not single numbers.

## Where follow-up work would go, if it's ever needed

These are not fixes, just the obvious levers the numbers point at:

1. **Web cold load (the first wall, around 20–30k).** Profile
   `DBManagerWeb.getCollection`'s full-store load and join. Likely options:
   load only the stores a view needs, use cursors or indexes instead of
   loading everything, or cache the joined result across view switches.
2. **Desktop `tags_by_item`.** It loads tags for every item the owner has,
   even for To Be Read, which uses a fifth of them, and its time grows
   faster than the row count (55 ms at 50k → 274 ms at 100k). Scoping it to
   the collection's own items, or doing the join in SQL, would cut it.
3. **IPC payload size on desktop.** 37 MB at 100k. Pagination or
   server-side search would avoid shipping the whole collection, but that's
   a bigger design change (search, sort and filter are all in-memory today).
4. **Unlimited rows per page.** It's the only setting that's slow at
   ordinary library sizes (about 1 s at 10k). A note in Settings, or
   virtualized rendering, would cover it.
