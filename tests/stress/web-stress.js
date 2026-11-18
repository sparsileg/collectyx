/**
 * Issue #84 — web-version scale measurement, in a real headless Chromium
 * with real IndexedDB (fake-indexeddb's timings mean nothing here).
 *
 * Not part of run-all.js. Run it on demand:
 *
 *   cd tests/stress
 *   npm install            # playwright-core, only needed for this harness
 *   CHROME_PATH=/path/to/chrome node web-stress.js [--scales=1000,10000]
 *
 * CHROME_PATH can be any Chromium/Chrome binary, e.g. one under
 * ~/.cache/ms-playwright/. Without it, playwright-core's default lookup
 * is used.
 *
 * Each scale point gets a fresh browser profile (a throwaway IndexedDB),
 * so nothing touches real data, and the generated data never leaves the
 * browser — there is no fixture file to commit or clean up.
 *
 * Per scale point, Books Read view (the largest collection):
 *   cold get    DBManager.getCollection('consumed') right after a reload
 *               (empty in-memory cache): full-store load + join
 *   view load   ConsumedView.load() right after a reload, until painted —
 *               the nav-click-to-rendered cost (default 50 per page)
 *   render      CollectionView.render() alone, data already in memory —
 *               the part the desktop build shares with web
 *   search      quick-search filter + re-render per keystroke, mean / max
 *   unlimited   render with Records Per Page = Unlimited
 *   heap        JS heap growth from loading the view
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

let chromium;
try {
    ({ chromium } = require('playwright-core'));
} catch (e) {
    console.error('This harness needs playwright-core.  Run:  cd tests/stress && npm install');
    process.exit(1);
}

const SRC = path.resolve(__dirname, '../../src');
const scaleArg = process.argv.find(a => a.startsWith('--scales='));
const SCALES = (scaleArg ? scaleArg.slice(9) : '1000,10000,50000,100000,250000')
    .split(',').map(Number).filter(Boolean);
const UNLIMITED_MAX = 100000; // rendering every row past this just hangs

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.json': 'application/json', '.svg': 'image/svg+xml' };

function serve() {
    const server = http.createServer((req, res) => {
        const rel = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '') || 'index.html';
        const file = path.resolve(SRC, rel);
        if (!file.startsWith(SRC + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
            res.writeHead(404); res.end(); return;
        }
        res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
        fs.createReadStream(file).pipe(res);
    });
    return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server)));
}

// Runs inside the page: builds a backup-shaped dataset and restores it.
async function seedInPage(n) {
    const ADJ = ['Silent', 'Broken', 'Golden', 'Hidden', 'Last', 'Burning', 'Distant', 'Crimson', 'Forgotten', 'Iron', 'Quiet', 'Endless', 'Northern', 'Hollow', 'Bright', 'Shattered'];
    const NOUN = ['River', 'Empire', 'Garden', 'Mountain', 'Library', 'Winter', 'Harbor', 'Machine', 'Kingdom', 'Mirror', 'Forest', 'Station', 'Lantern', 'Ocean', 'Tower', 'Archive'];
    const SUFFIX = ['', ' of Ash', ' at Dawn', ' Returns', ' in Exile', ' and the Sea', ' Rising', ' Book II'];
    const GIVEN = ['Ada', 'Brian', 'Chen', 'Dolores', 'Emeka', 'Farah', 'Gustav', 'Hana', 'Ivan', 'Jun', 'Kofi', 'Lena', 'Mateo', 'Nadia', 'Oren', 'Priya'];
    const SURNAME = ['Abara', 'Bergstrom', 'Castillo', 'Dubois', 'Eriksen', 'Fujita', 'Gallagher', 'Haddad', 'Iwu', 'Jansen', 'Kowalski', 'Lindqvist', 'Moreau', 'Nakamura', 'Okafor', 'Petrov', 'Quinn', 'Rossi', 'Sato', 'Tanaka'];
    let s = 42;
    const rnd = () => { s = (s * 1103515245 + 12345) % 2147483648; return s; };
    const pick = (xs) => xs[rnd() % xs.length];
    const pad = (x) => String(x).padStart(2, '0');

    const data = { Header: {}, Items: [], Consumed: [], Queued: [], Owned: [], Tags: [], Settings: {} };
    for (let i = 0; i < n; i++) {
        const id = 'i' + i;
        const Title = `${pick(ADJ)} ${pick(NOUN)}${pick(SUFFIX)}`;
        const Author = `${pick(SURNAME)}, ${pick(GIVEN)}`;
        const Pages = 100 + rnd() % 900;
        const ISBN = '978' + String(i).padStart(10, '0');
        data.Items.push({ id, MediaTypeId: 1, Title, Author, Pages, ISBN });
        data.Consumed.push({
            ItemId: id, Title, Author, Pages, ISBN,
            Finished: `${1990 + rnd() % 35}-${pad(1 + rnd() % 12)}-${pad(1 + rnd() % 28)}`,
            Rating: 1 + rnd() % 5,
            Tags: ['tag-' + (rnd() % 200), 'tag-' + (rnd() % 200)],
        });
        if (i % 5 === 0) data.Queued.push({ ItemId: id, Title, Rank: i / 5 + 1, Source: 'stress' });
        if (i % 2 === 0) data.Owned.push({ ItemId: id, Title, Location: 'Shelf' });
    }
    const t = performance.now();
    await DBManager.restoreAll(data);
    return performance.now() - t;
}

const fmt = (ms) => ms == null ? 'n/a' : ms >= 10000 ? (ms / 1000).toFixed(1) + ' s' : ms.toFixed(1) + ' ms';

(async () => {
    const server = await serve();
    const url = `http://127.0.0.1:${server.address().port}/index.html`;
    const browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {});
    const t0 = Date.now();
    const phase = (n, what) => console.error(`[${((Date.now() - t0) / 1000).toFixed(0)}s] ${n} items: ${what}`);

    console.log('| items | seed | cold get | view load | render (50/page) | search mean / max | render unlimited | heap growth |');
    console.log('|------:|-----:|---------:|----------:|-----------------:|------------------:|-----------------:|------------:|');

    for (const n of SCALES) {
        const ctx = await browser.newContext();
        const page = await ctx.newPage();
        page.setDefaultTimeout(600000);
        const cdp = await ctx.newCDPSession(page);
        const ready = async () => {
            await page.goto(url);
            await page.waitForFunction(() => typeof ConsumedView === 'object' && typeof DBManager === 'object' && typeof AutoBackup === 'object');
            await page.waitForTimeout(500);
            // Keep the harness's own writes from triggering auto-backup downloads.
            await page.evaluate(() => { AutoBackup.schedule = async () => {}; AutoBackup.init = async () => {}; });
        };
        const heap = async () => {
            await cdp.send('HeapProfiler.collectGarbage');
            return (await cdp.send('Runtime.getHeapUsage')).usedSize;
        };

        await ready();
        phase(n, 'seeding');
        const seedMs = await page.evaluate(seedInPage, n);

        phase(n, 'cold get');
        await ready();
        const coldGet = await page.evaluate(async () => {
            const t = performance.now();
            const records = await DBManager.getCollection('consumed');
            return { ms: performance.now() - t, count: records.length };
        });
        if (coldGet.count !== n) throw new Error(`seeded ${n} items but Books Read has ${coldGet.count}`);

        phase(n, 'view load');
        await ready();
        const heapBefore = await heap();
        const viewLoad = await page.evaluate(async () => {
            document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
            document.getElementById('consumedView').classList.add('active');
            const t = performance.now();
            await ConsumedView.load('consumedView');
            await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
            return performance.now() - t;
        });
        const heapGrowth = (await heap()) - heapBefore;

        phase(n, 'render + search');
        const { render, search } = await page.evaluate(async () => {
            const records = await DBManager.getCollection('consumed');
            const paint = () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
            let t = performance.now();
            CollectionView.render('consumedView', 'consumed', records);
            await paint();
            const render = performance.now() - t;

            const typed = 'silent riv';
            const times = [];
            for (let i = 1; i <= typed.length; i++) {
                t = performance.now();
                CollectionView.filter('consumedView', typed.slice(0, i));
                await paint();
                times.push(performance.now() - t);
            }
            CollectionView.filter('consumedView', '');
            return { render, search: { mean: times.reduce((a, b) => a + b, 0) / times.length, max: Math.max(...times) } };
        });

        let unlimited = null;
        if (n <= UNLIMITED_MAX) {
            phase(n, 'render unlimited');
            unlimited = await page.evaluate(async () => {
                const records = await DBManager.getCollection('consumed');
                CollectionView.setRecordsPerPage(0);
                const t = performance.now();
                CollectionView.render('consumedView', 'consumed', records);
                await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
                const ms = performance.now() - t;
                CollectionView.setRecordsPerPage(CONSTANTS.DEFAULT_RECORDS_PER_PAGE);
                return ms;
            });
        }

        const r = { seedMs, coldGet: coldGet.ms, viewLoad, render, search, unlimited, heapMB: heapGrowth / (1024 * 1024) };
        console.log(`| ${n} | ${fmt(r.seedMs)} | ${fmt(r.coldGet)} | ${fmt(r.viewLoad)} | ${fmt(r.render)} | ${fmt(r.search.mean)} / ${fmt(r.search.max)} | ${r.unlimited == null ? 'skipped' : fmt(r.unlimited)} | ${r.heapMB.toFixed(1)} MB |`);
        await ctx.close();
    }

    await browser.close();
    server.close();
})().catch(e => {
    console.error('\nHARNESS ERROR:', e);
    process.exit(1);
});
