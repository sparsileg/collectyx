// stress.rs — scale measurement for the desktop data path (#84).
//
// Not part of the normal test run: the one test here is #[ignore]d and
// only runs when asked for explicitly:
//
//   cd src-tauri
//   cargo test --release --lib stress -- --ignored --nocapture
//
// Optional: COLLECTYX_STRESS_SCALES=1000,10000 to pick the scale points.
//
// For each scale point it builds a throwaway SQLite file in the system temp
// folder (never the real app database), seeds it under a dedicated owner,
// and times what a collection view load costs on the Rust side:
//
//   sql+map   the joined SELECT plus row mapping (load_all minus tags)
//   tags      tags_by_item, the per-owner tag lookup every load also runs
//   json      serializing the result to JSON, the payload that crosses IPC
//
// The IPC transfer itself and the webview's JSON parse + render aren't
// measurable here; the web-side harness (tests/stress/) measures render.

#[cfg(test)]
mod tests {
    use std::time::Instant;

    use rusqlite::{params, Connection};

    use crate::commands::{common, consumed, owned, queued};
    use crate::db::migrations;

    const OWNER: &str = "stress-test";

    const ADJ: &[&str] = &[
        "Silent", "Broken", "Golden", "Hidden", "Last", "Burning", "Distant", "Crimson",
        "Forgotten", "Iron", "Quiet", "Endless", "Northern", "Hollow", "Bright", "Shattered",
    ];
    const NOUN: &[&str] = &[
        "River", "Empire", "Garden", "Mountain", "Library", "Winter", "Harbor", "Machine",
        "Kingdom", "Mirror", "Forest", "Station", "Lantern", "Ocean", "Tower", "Archive",
    ];
    const SUFFIX: &[&str] = &[
        "", " of Ash", " at Dawn", " Returns", " in Exile", " and the Sea", " Rising", " Book II",
    ];
    const GIVEN: &[&str] = &[
        "Ada", "Brian", "Chen", "Dolores", "Emeka", "Farah", "Gustav", "Hana", "Ivan", "Jun",
        "Kofi", "Lena", "Mateo", "Nadia", "Oren", "Priya",
    ];
    const SURNAME: &[&str] = &[
        "Abara", "Bergstrom", "Castillo", "Dubois", "Eriksen", "Fujita", "Gallagher", "Haddad",
        "Iwu", "Jansen", "Kowalski", "Lindqvist", "Moreau", "Nakamura", "Okafor", "Petrov",
        "Quinn", "Rossi", "Sato", "Tanaka",
    ];
    const TAG_COUNT: usize = 200;

    // Small deterministic PRNG so runs are repeatable without a rand crate.
    struct Lcg(u64);
    impl Lcg {
        fn next(&mut self) -> u64 {
            self.0 = self.0.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
            self.0 >> 33
        }
        fn pick<'a>(&mut self, xs: &'a [&'a str]) -> &'a str {
            xs[(self.next() as usize) % xs.len()]
        }
    }

    fn seed(conn: &mut Connection, n: usize) {
        let mut rng = Lcg(42);
        let tx = conn.transaction().unwrap();
        tx.execute(
            "INSERT OR REPLACE INTO app_meta (key, value) VALUES (?1, ?2)",
            params![crate::constants::APP_META_CURRENT_OWNER_KEY, OWNER],
        )
        .unwrap();
        for t in 0..TAG_COUNT {
            tx.execute(
                "INSERT INTO tags (id, owner, name) VALUES (?1, ?2, ?3)",
                params![format!("t{t}"), OWNER, format!("tag-{t}")],
            )
            .unwrap();
        }
        {
            let mut item = tx
                .prepare(
                    "INSERT INTO items (id, owner, media_type_id, title, author, author2, pages, isbn, date_added, modified)
                     VALUES (?1, ?2, 1, ?3, ?4, NULL, ?5, ?6, '2024-01-01', '2024-01-01')",
                )
                .unwrap();
            let mut cons = tx
                .prepare(
                    "INSERT INTO consumed (id, item_id, finished, rating, comments, date_added, modified)
                     VALUES (?1, ?2, ?3, ?4, NULL, '2024-01-01', '2024-01-01')",
                )
                .unwrap();
            let mut que = tx
                .prepare(
                    "INSERT INTO queued (id, item_id, \"rank\", source, comments, date_added, modified)
                     VALUES (?1, ?2, ?3, 'stress', NULL, '2024-01-01', '2024-01-01')",
                )
                .unwrap();
            let mut own = tx
                .prepare(
                    "INSERT INTO owned (id, item_id, location, date_added, modified)
                     VALUES (?1, ?2, 'Shelf', '2024-01-01', '2024-01-01')",
                )
                .unwrap();
            let mut link = tx
                .prepare("INSERT OR IGNORE INTO item_tags (item_id, tag_id) VALUES (?1, ?2)")
                .unwrap();
            for i in 0..n {
                let id = format!("i{i}");
                let title = format!("{} {}{}", rng.pick(ADJ), rng.pick(NOUN), rng.pick(SUFFIX));
                let author = format!("{}, {}", rng.pick(SURNAME), rng.pick(GIVEN));
                let pages = 100 + (rng.next() % 900) as i64;
                item.execute(params![id, OWNER, title, author, pages, format!("978{:010}", i)])
                    .unwrap();
                let finished = format!("{}-{:02}-{:02}", 1990 + rng.next() % 35, 1 + rng.next() % 12, 1 + rng.next() % 28);
                cons.execute(params![format!("c{i}"), id, finished, (1 + rng.next() % 5) as i64])
                    .unwrap();
                if i % 5 == 0 {
                    que.execute(params![format!("q{i}"), id, (i / 5 + 1) as i64]).unwrap();
                }
                if i % 2 == 0 {
                    own.execute(params![format!("o{i}"), id]).unwrap();
                }
                for _ in 0..2 {
                    link.execute(params![id, format!("t{}", rng.next() as usize % TAG_COUNT)]).unwrap();
                }
            }
        }
        tx.commit().unwrap();
    }

    fn ms(start: Instant) -> f64 {
        start.elapsed().as_secs_f64() * 1000.0
    }

    // Best of three, so one cold-cache outlier doesn't dominate.
    fn best<T>(mut f: impl FnMut() -> T) -> (f64, T) {
        let mut best_ms = f64::MAX;
        let mut out = None;
        for _ in 0..3 {
            let t = Instant::now();
            let v = f();
            best_ms = best_ms.min(ms(t));
            out = Some(v);
        }
        (best_ms, out.unwrap())
    }

    fn measure<R: serde::Serialize>(
        name: &str,
        conn: &Connection,
        tags_ms: f64,
        load: impl Fn(&Connection, &str) -> Result<Vec<R>, String>,
    ) {
        let (load_ms, rows) = best(|| load(conn, OWNER).unwrap());
        let (json_ms, json) = best(|| serde_json::to_string(&rows).unwrap());
        println!(
            "| {:<8} | {:>7} | {:>8.1} | {:>8.1} | {:>8.1} | {:>8.1} | {:>8.1} |",
            name,
            rows.len(),
            (load_ms - tags_ms).max(0.0),
            tags_ms,
            json_ms,
            load_ms + json_ms,
            json.len() as f64 / (1024.0 * 1024.0),
        );
    }

    #[test]
    #[ignore]
    fn stress_collection_loads() {
        let scales: Vec<usize> = std::env::var("COLLECTYX_STRESS_SCALES")
            .unwrap_or_else(|_| "1000,10000,50000,100000,250000".to_string())
            .split(',')
            .filter_map(|s| s.trim().parse().ok())
            .collect();

        for n in scales {
            let path = std::env::temp_dir().join(format!("collectyx-stress-{}-{n}.db", std::process::id()));
            let _ = std::fs::remove_file(&path);
            let mut conn = Connection::open(&path).unwrap();
            conn.execute_batch("PRAGMA foreign_keys = ON;").unwrap();
            migrations::run_migrations(&conn).unwrap();

            let t = Instant::now();
            seed(&mut conn, n);
            let seed_ms = ms(t);
            drop(conn);
            let file_mb = std::fs::metadata(&path).unwrap().len() as f64 / (1024.0 * 1024.0);

            let conn = Connection::open(&path).unwrap();
            let (tags_ms, _) = best(|| common::tags_by_item(&conn, OWNER).unwrap());

            println!("\n### {n} items (db file {file_mb:.1} MB, seeded in {:.1} s)\n", seed_ms / 1000.0);
            println!("| view     |    rows |  sql+map |     tags |     json | rust tot |  json MB |");
            println!("|----------|--------:|---------:|---------:|---------:|---------:|---------:|");
            measure("consumed", &conn, tags_ms, consumed::load_all);
            measure("queued", &conn, tags_ms, queued::load_all);
            measure("owned", &conn, tags_ms, owned::load_all);

            drop(conn);
            let _ = std::fs::remove_file(&path);
        }
    }
}
