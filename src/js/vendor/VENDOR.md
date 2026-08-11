# Vendored files

These are copied out of the official `@tauri-apps/api` and
`@tauri-apps/plugin-dialog` npm packages, not written by hand. Needed
because `withGlobalTauri` is now `false` (#66 / CTX-SEC-116) — the app
imports `invoke`/`isTauri`/dialog `open` as real ES modules instead of
reading them off `window.__TAURI__`.

No bundler in this project, so these are committed as plain ESM files
rather than resolved from `node_modules` at build time. Re-copy and
re-verify on any future version bump — nothing here is npm-managed.

## tauri-api/ — from `@tauri-apps/api@2.11.1`

- `core.js` — unmodified copy of the package's `core.js` entry point.
  sha256: `b2187a1c0c0a25806dc64f8823757ce553c09d3bbe3e409bd05cab32e245f1c9`
- `external/tslib/tslib.es6.js` — unmodified copy, `core.js`'s only
  import.
  sha256: `88571c39817ebe327cfb45cf2d5ff9e68c544523d526f09ac2cc99acfc8fcf1b`

## tauri-plugin-dialog/ — from `@tauri-apps/plugin-dialog@2.7.2`

- `index.js` — copy of the package's `dist-js/index.js`, with one line
  changed: the bare specifier `import { invoke } from
  '@tauri-apps/api/core'` is rewritten to the relative vendor path
  `import { invoke } from '../tauri-api/core.js'`, since there's no
  bundler here to resolve bare specifiers. No other changes.
  sha256 (as vendored, post-rewrite): `fe166a46f74d453cda35416a5a699f20f56f71948075422841c9decdc5fb54bd`

## Verifying a re-vendor

```bash
npm view @tauri-apps/api@2 version
npm pack @tauri-apps/api@2 --dry-run   # or install into a scratch dir
sha256sum node_modules/@tauri-apps/api/core.js
```

Compare against the hash on npm's published tarball, not just against
this file — this manifest only proves internal consistency at the time
it was written, not upstream authenticity.
