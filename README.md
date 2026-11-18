# Collectyx
Keeping tracks of books read, books wanted, and on the shelf. Other media collections to be added soon.

## Web version

The web version runs at https://collectyx.astryx.tools. It is the `src/`
folder served as static files by Cloudflare (`wrangler.jsonc`), and it
redeploys automatically on every push to `main` through Cloudflare Workers
Builds. There is no build step.

- `src/_headers`: security response headers (CSP, anti-framing). Keep its
  CSP in sync with the `<meta>` CSP in `src/index.html`; `tests/csp-test.js`
  checks this.
- `src/.assetsignore`: files in `src/` that are never published.

Local preview: `npm run serve:web`.

## Desktop version

Desktop builds are produced by `.github/workflows/release.yml` when a
`v*` tag is pushed.
