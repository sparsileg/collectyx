# Collectyx — Security, Correctness, and Reliability Audit

**Application:** Collectyx — Media Tracker v0.1.0 **Scope:** `src/`
(HTML/CSS/JS frontend) and `src-tauri/` (Rust backend), as supplied
**Date:** 9 August 2026 **Reviewer role:** Principal software security
engineer / senior code reviewer

---

## Scope and Assumptions

### What was actually reviewed

The audit brief describes a multi-user REST application with per-user
API-key authentication. **That application does not exist in the
supplied code.** What was supplied is:

- A **Tauri v2 desktop app** — Rust backend, bundled SQLite, 30
  registered IPC commands
- A **parallel web build** — the same frontend against IndexedDB
  (`db-manager-web.js`)
- **Single-user, no network surface.** No HTTP server, no REST
  endpoints, no API keys, no sessions, no CORS, no CSRF surface, no
  rate-limiting surface

The brief's API-specific sections (authentication, API-key
enumeration, pagination safety, CORS, replay, brute force, session
handling) have no corresponding code to review and are addressed in
**§6, Readiness for the D1 Migration** rather than being reported as
findings.

The one section of the brief that *does* apply in an unexpected way is
authorization. The schema already carries an `owner` column on
`items`, `tags`, and `settings`, and an `app_meta.current_owner`
switch that selects which owner every query scopes to. The code
comments state this is deliberate groundwork so "a future multi-user
D1 sync doesn't require a migration" (`constants.rs`). That makes
owner-scoping a **live, testable authorization model today**, and it
is where the majority of the findings land.

### Assumptions

1. The Tauri IPC boundary is the trust boundary that matters
   today. Any script executing in the webview is treated as untrusted,
   because `withGlobalTauri: true` exposes the full command surface to
   it.
2. Backup/restore and CSV import are trust boundaries. Files arrive
   from outside and are parsed, previewed, and written to the
   database.
3. Where a finding is only exploitable under multi-user conditions,
   both the current severity and the post-D1 severity are stated.
4. `include/pako.min.js`, `include/chart.umd.js`, `package.json`, any
   lockfile, and `Cargo.lock` were **not** present in the
   tarballs. All dependency-version and supply-chain conclusions are
   marked *Requires Verification*.
5. No test suite was supplied, so no assertion is made about test
   coverage.

---

## Executive Summary

### Overall security rating: 5 / 10

This is careful, deliberate code. It carries an unusually strong
remediation trail — 40-odd prior findings referenced inline by ID,
each with a comment explaining what was wrong and why the fix takes
the shape it does. Parameterized SQL is used universally, HTML
escaping is applied at essentially every sink, the CSP omits
`'unsafe-inline'`, IDs come from the OS CSPRNG, and CSV formula
injection is handled on both export *and* re-import — a detail most
codebases miss entirely.

The rating is nonetheless a 5, for two reasons.

**One critical primitive.** `save_backup_file` accepts an arbitrary
path and arbitrary bytes from the webview and writes them to disk with
no validation whatsoever. Its own comment explains that it uses raw
`std::fs` specifically to *avoid* Tauri's capability system. That
reasoning is inverted: the capability system was bypassed because
declaring the needed scope felt too broad, and the result is a command
with a scope broader than any ACL entry could express. It is reachable
without code execution, via a malicious backup file that sets
`backupFolder`.

**One systematic pattern.** Six separate write paths take the `owner`
value — the entire authorization principal — from the request payload
rather than deriving it server-side. The codebase documents the
correct rule explicitly (`common.rs`: *"Ownership is set once, at
insert, from the active owner; it is never taken from the payload"*),
implements it correctly in `upsert_item` and in the web backend's
`saveItem`, and then violates it in `save_item`, `reconcile_tags`,
`save_tag`, and `replace_all_tags`. Separately, every membership-row
*delete* is correctly scoped through the item join and every
membership-row *save* is not — so the code currently enforces "you may
not delete another owner's row, but you may overwrite it."

Neither of these is a coding-standards problem. Both are places where
a correct invariant was written down, implemented in most places, and
missed in a consistent, identifiable set of others. The remediation
trail suggests prior reviews compared the two backends against each
other; these findings survived because the two backends are
*symmetrically* wrong (CTX-SEC-103) or because the check lives one
call deeper on one side (CTX-SEC-107).

Today, on a single-user desktop build, most of the owner findings are
low-impact — the user already owns the database file. **After the D1
migration they become cross-tenant read/write.** The window to fix
them cheaply is now, before the schema and API contract are frozen.

### Top five risks

| # | Risk | ID | Severity |
| --- | ------------------------------------------------------------------------------------------------------------ | -------------------------- | --------------- |
| 1 | Arbitrary file write to any path with any bytes, reachable from a restored backup file | CTX-SEC-101 | Critical |
| 2 | `owner` accepted from the request payload on six write paths | CTX-SEC-102, 104, 105, 106 | High |
| 3 | Membership-row `id` client-supplied and never ownership-checked on upsert (both backends) | CTX-SEC-103 | High |
| 4 | Web backend writes through to another owner's item row during restore | CTX-SEC-107 | High |
| 5 | Authorization principal (`current_owner`) is switchable by the client; the "build flag" gating it is UI-only | CTX-SEC-109 | Blocking for D1 |

### Most likely attack vectors

Ranked by how little the attacker needs.

1. **A shared backup file.** Restore is an advertised feature and the
   file format is documented by the
   export. `BackupRestore._validate()` checks structure and `Title`
   presence — it never inspects `Owner`, `id`, `Rank`, `MediaTypeId`,
   or any key inside `Settings`. A single crafted file reaches
   CTX-SEC-101, 102, 104, 105, 107, 111, 112, 114, 121, and 122. This
   is by a wide margin the highest-value vector and requires no code
   execution.
2. **Script execution in the webview.** With `withGlobalTauri: true`,
   any script reaching the page gets the full IPC surface, including
   the arbitrary-write primitive. CSP (`script-src 'self'`, no
   `'unsafe-inline'`) blocks the ordinary injected-handler path, which
   is why this ranks second rather than first — but the two vendored
   third-party scripts execute with the same access and could not be
   version-checked.
3. **Object-ID harvesting from exports.** Row IDs are UUIDv4 and
   unguessable, but they are not secret: they appear in exported JSON,
   in backup files, and in `data-id` DOM attributes. Anyone who has
   been sent an export holds the ids needed for CTX-SEC-103 and
   CTX-SEC-108.
4. **Direct IPC invocation.** Frontend validation is comprehensive and
   is mirrored in the backend for most fields — but `save_item` skips
   validation entirely, and `Recommend`, `MediaTypeId`, and `Rank`
   have no backend validator at all.

### Most severe vulnerabilities

- **CTX-SEC-101** (Critical) — unrestricted `fs::write` exposed to the
  webview. Converts any lesser frontend flaw into host-level
  persistence.
- **CTX-SEC-103** (High) — BOLA on all three membership tables, in
  both backends simultaneously. Destructive cross-owner write; the
  delete/save asymmetry makes it easy to miss.
- **CTX-SEC-102** (High) — `save_item` takes `Owner` from the payload
  *and* performs no validation *and* blanks stored titles on empty
  input. Three defects in 38 lines, on a command reachable from
  restore.

---

## Detailed Findings

Full write-ups — severity, confidence, location, explanation, attack
scenario, impact, recommended fix, and corrected code — are in
`issues/`, one file per finding.

### Critical

| ID | Title | Component |
| -------------------------------------------------------------------------- | -------------------------------------------------------- | ---------- |
| [CTX-SEC-101](issues/CTX-SEC-101-arbitrary-file-write-save-backup-file.md) | Unrestricted arbitrary file write via `save_backup_file` | Rust / IPC |

### High

| ID | Title | Component |
| --------------------------------------------------------------------------- | ---------------------------------------------------------------------- | ---------- |
| [CTX-SEC-102](issues/CTX-SEC-102-save-item-trusts-client-owner.md) | `save_item` trusts client-supplied `Owner` and performs no validation | Rust |
| [CTX-SEC-103](issues/CTX-SEC-103-membership-id-bola.md) | Membership-row `id` client-supplied and never ownership-checked (BOLA) | Rust + Web |
| [CTX-SEC-104](issues/CTX-SEC-104-reconcile-tags-payload-owner.md) | `reconcile_tags` scopes tag writes to a payload-supplied owner | Rust |
| [CTX-SEC-105](issues/CTX-SEC-105-replace-all-tags-cross-owner.md) | `replace_all_tags` / `replaceAllTags` overwrite other owners' tags | Rust + Web |
| [CTX-SEC-107](issues/CTX-SEC-107-web-replacecollection-cross-owner-item.md) | Web `replaceCollection` writes through to another owner's item row | Web |

### Medium

| ID | Title | Component |
| -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | ------------ |
| [CTX-SEC-106](issues/CTX-SEC-106-save-tag-payload-owner.md) | `save_tag` accepts a payload-supplied `Owner`; clash error is an enumeration oracle | Rust + Web |
| [CTX-SEC-108](issues/CTX-SEC-108-web-setcurrentlyreading-missing-owner-check.md) | Web `setCurrentlyReading` performs no ownership check | Web |
| [CTX-SEC-109](issues/CTX-SEC-109-authorization-principal-client-switchable.md) | Authorization principal is client-switchable; build flag is UI-only | Architecture |
| [CTX-SEC-110](issues/CTX-SEC-110-inconsistent-mutex-lock-poisoning.md) | Three commands use raw `.lock()`; poisoning cascades to silent settings loss | Rust |
| [CTX-SEC-111](issues/CTX-SEC-111-save-settings-unbounded-unvalidated.md) | `save_settings` accepts an unbounded, unvalidated JSON blob | Rust + Web |
| [CTX-SEC-112](issues/CTX-SEC-112-restore-owner-divergence.md) | Restore aborts after wiping on owner mismatch; backends disagree | Restore flow |
| [CTX-SEC-113](issues/CTX-SEC-113-no-sqlite-busy-timeout.md) | No `busy_timeout`; second instance causes write failures mid-restore | Rust / DB |

### Low

| ID | Title | Component |
| ---------------------------------------------------------------------------- | -------------------------------------------------------------------- | ---------- |
| [CTX-SEC-114](issues/CTX-SEC-114-dashboard-order-prototype-lookup.md) | `loadDashboardOrder` resolves prototype properties; breaks startup | Frontend |
| [CTX-SEC-115](issues/CTX-SEC-115-duplicate-csp-drift.md) | Two independent CSP definitions that can drift; no `frame-ancestors` | Config |
| [CTX-SEC-116](issues/CTX-SEC-116-with-global-tauri.md) | `withGlobalTauri: true` exposes the IPC bridge to every script | Config |
| [CTX-SEC-117](issues/CTX-SEC-117-restore-preview-unescaped-interpolation.md) | Restore preview interpolates backup-derived values unescaped | Frontend |
| [CTX-SEC-118](issues/CTX-SEC-118-csv-import-hardening.md) | CSV import: prototype-unsafe keys, unbounded rows, sequential writes | Frontend |
| [CTX-SEC-119](issues/CTX-SEC-119-dead-duplicate-shared-utils.md) | Dead duplicate `shared-utils.js` with a second `escapeHtml` | Frontend |
| [CTX-SEC-120](issues/CTX-SEC-120-panic-paths.md) | Panic in `today()` reachable while holding the DB lock | Rust |
| [CTX-SEC-121](issues/CTX-SEC-121-unvalidated-recommend-mediatypeid.md) | `Recommend` and `MediaTypeId` bypass the validation layer | Rust + Web |
| [CTX-SEC-122](issues/CTX-SEC-122-rank-unvalidated-overflow.md) | `rank` unvalidated on restore; overflow in reorder shifts | Rust + Web |

---

## Second-Pass Findings

A second pass was performed on the assumption the first had missed
subtle issues, concentrating on authorization bypass, TOCTOU,
concurrency, business-logic flaws, and frontend/backend assumption
mismatches. Newly discovered:

- **CTX-SEC-107** — Web `replaceCollection` has no equivalent of
  `_saveCollectionRecordImpl`'s ownership check, and `splitRecord`
  *preserves* a foreign `prevItem.owner` rather than rejecting
  it. Rust rejects the same payload one call deeper, in
  `assert_item_id_writable`, which is why a side-by-side backend
  comparison missed it.
- **CTX-SEC-108** — Web `setCurrentlyReading` bypasses
  `saveCollectionRecord` deliberately (to protect field semantics) and
  loses the ownership check along with it. Rust's equivalent is
  correctly scoped.
- **CTX-SEC-112** — The two backends treat the backup's `Owner` field
  oppositely, producing a restore that fails *after* `_wipeAll()` on
  desktop and succeeds in the browser.
- **CTX-SEC-113** — No `busy_timeout` plus DEFERRED transactions that
  begin with a `SELECT` and upgrade to a write. The lock-upgrade
  pattern in `reorder_queued` and `delete_queued` is the classic
  `SQLITE_BUSY_SNAPSHOT` shape.
- **CTX-SEC-114** — Prototype-chain lookup in `loadDashboardOrder`,
  reachable from a restored settings blob, throwing inside an
  unguarded `await` in `window.onload`.

### Explicitly checked and found sound

Recorded so these are not re-audited from scratch:

- **TOCTOU on ownership checks.** `assert_item_owned` → `execute`
  sequences in `delete_item`, `attach_tag`, and `detach_tag` all run
  under a single held `MutexGuard`. No in-process
  window. (Cross-process is CTX-SEC-113.)
- **`reconcile_tags` mutation safety.** The function is genuinely pure
  with respect to the `tags` slice it is passed — the `touched` copy
  pattern (`common.rs`) is correct, and the web equivalent's
  `Object.assign({}, existingTag, …)` matches it.
- **`_rawWrite` transaction discipline.** No `await` inside the ops
  loop, so the IndexedDB transaction cannot auto-close mid-write. The
  comment stating this is accurate.
- **`_writeQueue` serialization.** Chains on settled state via
  `.then(task, task)`, so a failed save cannot jam the queue. Correct.
- **`validate_date` byte slicing.** `value[0..4]` on a `&str` would
  panic on a non-char boundary, but `valid_shape` establishes all ten
  bytes are ASCII before any slicing, and `&&` short-circuits before
  the length check can be bypassed. Safe.
- **Year fill-loop bounds.** `MAX_YEARLY_FILL_SPAN` plus
  `getYearFromFinishedDate`'s 1000–2200 clamp closes the
  unbounded-iteration path properly.
- **Rank gap-closing atomicity.** `delete_queued` performs the delete
  and the shift in one transaction. The prior row-at-a-time JS loop
  was correctly eliminated.
- **`delete_tag` substitution.** Both the target and the substitute
  are ownership-checked, and `INSERT OR IGNORE` handles items already
  carrying the substitute.
- **`double_option` semantics.** The absent-vs-null-vs-value
  distinction is implemented correctly and the `CASE WHEN ?n` binding
  in `upsert_item` genuinely preserves stored values for absent keys —
  this is subtle and it is right.

---

## Positive Findings

Worth stating plainly, because several of these are things that go
wrong in most codebases:

1. **SQL injection: none.** Every statement in every command uses
   bound parameters. String formatting into SQL occurs only in
   `migrations.rs`, and only to concatenate developer-authored `const`
   schema strings — no user data enters that path. The `"rank"` column
   is consistently quoted to avoid the window-function keyword
   collision.
2. **Output encoding is near-complete.** `escapeHtml` is applied at
   every `innerHTML` interpolation of user or imported data across
   `collection-view.js`, all three row renderers, `tags.js`,
   `dashboard.js`, `sidebar.js`, and `backup-restore.js`. The single
   exception (CTX-SEC-117) is currently
   unreachable. `renderReadingGoals` deliberately uses `textContent`
   with a comment explaining why.
3. **No inline event handlers anywhere**, and CSP `script-src 'self'`
   without `'unsafe-inline'`. The migration away from `onclick`
   attributes was completed properly and the reasoning is documented
   (`sidebar.js`).
4. **No `unsafe` Rust. Three `unwrap`/`expect` calls in the entire
   backend.** For a codebase of this size that is excellent
   discipline.
5. **CSPRNG-backed IDs.** `uuid::Uuid::new_v4()` in Rust,
   `crypto.randomUUID()` in JS, with the prior clock-seeded generator
   explicitly removed. Object IDs are not guessable.
6. **CSV formula injection (CWE-1236) handled correctly in both
   directions.** `_field()` prefixes an apostrophe for `= + - @ \t \r`
   leaders, and `_unescapeFormulaGuard` reverses it on re-import so
   values round-trip without accumulating apostrophes. The round-trip
   half is very commonly missed.
7. **Uniform "not found" errors on ownership failures.**
   `assert_item_owned`, `assert_tag_owned`, and the scoped deletes
   deliberately return identical errors for missing and forbidden,
   with a comment stating the rule. Correct anti-enumeration practice
   — CTX-SEC-106 and CTX-SEC-108 are deviations from an otherwise
   sound policy.
8. **Mutex poison recovery exists and is documented**
   (`lock_db`). CTX-SEC-110 is about three call sites that missed it,
   not about the mechanism.
9. **Schema-version downgrade protection.** Refusing to migrate a
   database written by a newer build, and handling SQLite's signed-i32
   `user_version` explicitly, prevents a whole class of downgrade
   corruption.
10. **Restore validates before the wipe becomes reachable.**
    `_validate()` runs before the confirmation checkbox is enabled,
    and the comment identifying this as the real protection is correct
    reasoning.
11. **Foreign keys enabled, with `ON DELETE CASCADE` modelled
    deliberately**, and the web backend hand-implements the same
    cascade to keep the two consistent.
12. **Tag names are strictly allow-listed** to `[a-z0-9_-]` in both
    backends, which eliminates tags as an injection vector entirely.
13. **Decompression bomb guard.** The restore path checks size *after*
    inflation, not just the compressed file size.
14. **Capabilities are minimal** — `core:default`, `dialog:default`,
    `dialog:allow-open`.  The `fs` plugin is correctly
    withheld. (CTX-SEC-101 is precisely the problem of a hand-rolled
    command reinstating it.)

---

## Readiness for the D1 Migration

The stated plan is a Cloudflare D1 backend with per-user keys. The
current code is closer to ready than most single-user apps would be —
the `owner` column exists everywhere it needs to, and `app_meta` is
deliberately generic so auth state can live there. Six things must
change before that migration is safe.

**1. Strip `Owner` from every deserializable request type.** Not
"validate it" — remove it.  `ItemFields.owner`, `ItemRecord.owner`,
and `TagRecord.owner` should be `skip_deserializing`.  The tenant key
must be underivable from the request body. This closes CTX-SEC-102,
104, 105, and 106 structurally rather than one call site at a time.

**2. Add `owner` to the four tables that lack it.** `consumed`,
`queued`, `owned`, and `item_tags` currently inherit ownership through
a join to `items`. That works, but it means every query must remember
the join — and CTX-SEC-103 is exactly what happens when one
forgets. With a per-row `owner` and a query layer that appends the
predicate unconditionally, the class of bug disappears.

**3. Derive the principal from the credential, in constant time.**
Look up by an indexed, non-secret lookup ID; verify the secret against
a stored hash with a constant-time comparison. Never `SELECT ... WHERE
api_key = ?` on the raw secret, and never `==`. Return identical
errors and timing for "no such key" and "wrong key." Sketch in
CTX-SEC-109.

**4. Separate the tenant key from auth material.** `app_meta`
currently holds `current_owner` *and* has a client-callable write
command. Credentials must live in a table no client-facing command can
write, and `set_app_meta` must not survive into the hosted build.

**5. Make errors opaque.** Every command currently does `.map_err(|e|
e.to_string())`, propagating raw SQLite text to the client. Locally
that is harmless; over HTTP it discloses schema details. Map to
generic messages and log the detail server-side.

**6. Move the restore transaction into the backend.** The JS-level
snapshot-and-rollback is already acknowledged as not a real
transaction (filed as COLLECTYX-SEC-21). Over a network it becomes
materially worse — a dropped connection mid-restore leaves the wipe
applied and the rollback un-run, with the "last resort" being a
`console.error` dump of the user's library. One command taking the
whole backup and applying it in one D1 transaction removes the window
entirely.

Additionally, the following have no current implementation and will
need one: rate limiting and brute-force protection on key
verification, request size limits at the HTTP layer, pagination for
the `get_all_*` commands (which currently return entire collections
unbounded), and `frame-ancestors`/`X-Frame-Options` headers for the
hosted frontend (CTX-SEC-115).

---

## Recommended Remediation Order

1. **CTX-SEC-101** — the only Critical, and the only finding that
   reaches outside the app.
2. **CTX-SEC-102, 103, 104, 105, 106, 107, 108** — the owner/BOLA
   cluster. Fix as one piece of work; they share a root cause and the
   fixes reinforce each other.
3. **CTX-SEC-109** — gate `set_app_meta` behind a real Cargo feature
   before any hosted build.
4. **CTX-SEC-110, 112** — the two paths that currently lead to silent
   data loss.
5. **CTX-SEC-111, 113, 114** — restore/robustness hardening.
6. Remainder, at convenience. CTX-SEC-119 (delete the dead file) is a
   one-line change worth doing immediately.

---

## Appendix: Files Reviewed

**Rust** (`src-tauri/`, 20 files): `main.rs`, `lib.rs`,
`constants.rs`, `db/{mod,schema,migrations}.rs`,
`commands/{mod,common,items,consumed,queued,owned,tags,settings,app_meta,backup,media_types}.rs`,
`Cargo.toml`, `tauri.conf.json`, `capabilities/default.json`.

**Frontend** (`src/`, 25 files): `index.html`, all 24 files in `js/`,
and the CSS tree (reviewed for injection sinks only).

**Not supplied, not reviewed:** `include/pako.min.js`,
`include/chart.umd.js`, `package.json`, any lockfile, `Cargo.lock`,
`build.rs`, icons, and any test suite. All conclusions touching these
are marked *Requires Verification* in the relevant issue files.

**Note on naming:** issue IDs use a `CTX-SEC-1xx` series starting at
101 to avoid colliding with the existing `COLLECTYX-SEC-nn` series
referenced throughout the code comments (which runs at least to 41).
